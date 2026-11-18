"""Extension management for one site: search, check, install, configure, serve."""

from __future__ import annotations

import base64
import binascii

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioCommandError
from mobility_developer_tools.studio.extensions.checker import CheckResult, CompatibilityChecker
from mobility_developer_tools.studio.extensions.openvsx import OpenVsxClient
from mobility_developer_tools.studio.extensions.store import ExtensionStore
from mobility_developer_tools.studio.extensions.vsix import MAX_ARCHIVE_BYTES, VsixArchive

MAX_UPLOAD_BYTES = 18 * 1024 * 1024  # base64 inside a 25 MB request


class ExtensionService:
	def __init__(self, store: ExtensionStore, registry: OpenVsxClient, checker: CompatibilityChecker):
		self._store = store
		self._registry = registry
		self._checker = checker

	# -- discovery ----------------------------------------------------------------------------

	def search(self, query: str) -> list[dict]:
		installed = {i: self._store.manifest(i).get("version") for i in self._store.ids()}
		results = self._registry.search(query)
		for item in results:
			item["installed_version"] = installed.get(f"{item['namespace']}.{item['name']}".lower())
		return results

	def check_remote(self, namespace: str, name: str, version: str | None = None) -> dict:
		archive, _meta = self._download(namespace, name, version)
		return self._public_report(self._checker.check(archive))

	def check_upload(self, data_b64: str) -> dict:
		return self._public_report(self._checker.check(self._decode_upload(data_b64)))

	# -- install ------------------------------------------------------------------------------

	def install_remote(self, namespace: str, name: str, version: str | None = None) -> dict:
		archive, _meta = self._download(namespace, name, version)
		return self._install(archive)

	def install_upload(self, data_b64: str) -> dict:
		return self._install(self._decode_upload(data_b64))

	def _install(self, archive: VsixArchive) -> dict:
		result = self._checker.check(archive)
		if result.report["verdict"] == "unsupported":
			raise StudioCommandError(_("Nothing in {0} can work in the studio, so it was not installed").format(result.manifest["display_name"]))
		self._store.install(archive, result)
		return self._public_report(result)

	def uninstall(self, ext_id: str) -> None:
		self._store.remove(ext_id)

	def set_enabled(self, ext_id: str, enabled: bool) -> None:
		self._store.set_enabled(ext_id, enabled)

	def set_settings(self, ext_id: str, settings: dict) -> None:
		self._store.set_settings(ext_id, settings)

	# -- use ------------------------------------------------------------------------------------

	def installed(self) -> list[dict]:
		items = []
		for ext_id in self._store.ids():
			manifest, state = self._store.manifest(ext_id), self._store.state(ext_id)
			report = self._store.report(ext_id)
			items.append(
				{
					**{k: manifest.get(k) for k in ("id", "display_name", "description", "version", "publisher", "icon")},
					"enabled": state.get("enabled", True),
					"has_settings": bool(manifest["contributes"].get("configuration")),
					"configuration": manifest["contributes"].get("configuration") or {},
					"settings": state.get("settings") or {},
					"has_code": bool(manifest.get("browser")),
					"verdict": report.get("verdict"),
					"level": report.get("level"),
					"report": report,
				}
			)
		return items

	def runtime(self) -> list[dict]:
		"""Everything the browser needs to apply the enabled extensions."""
		bundle = []
		for ext_id in self._store.ids():
			state = self._store.state(ext_id)
			if state.get("enabled", True):
				bundle.append({**self._store.manifest(ext_id), "settings": state.get("settings") or {}})
		return bundle

	def read_files(self, ext_id: str, paths: list[str], encoding: str = "text") -> dict:
		if encoding not in ("text", "base64"):
			raise StudioCommandError(_("Invalid encoding"))
		return self._store.read_files(ext_id, paths, encoding)

	# -- helpers --------------------------------------------------------------------------------

	def _download(self, namespace, name, version):
		data, meta = self._registry.download(namespace, name, version)
		return VsixArchive(data), meta

	@staticmethod
	def _decode_upload(data_b64: str) -> VsixArchive:
		if not isinstance(data_b64, str) or len(data_b64) > MAX_UPLOAD_BYTES * 4 // 3 + 4:
			raise StudioCommandError(_("The file is too large to upload (max {0} MB); install it from Open VSX instead").format(MAX_UPLOAD_BYTES // (1024 * 1024)))
		try:
			data = base64.b64decode(data_b64.split(",", 1)[-1], validate=True)
		except (binascii.Error, ValueError):
			raise StudioCommandError(_("Invalid upload"))
		if len(data) > MAX_ARCHIVE_BYTES:
			raise StudioCommandError(_("Extension package is too large"))
		return VsixArchive(data)

	@staticmethod
	def _public_report(result: CheckResult) -> dict:
		m = result.manifest
		return {
			"id": result.extension_id,
			"display_name": m["display_name"],
			"version": m["version"],
			"description": m["description"],
			**result.report,
		}
