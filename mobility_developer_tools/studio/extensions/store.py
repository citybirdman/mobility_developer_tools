"""Per-site storage of installed extensions.

    <site>/private/mobility_developer_tools/extensions/
        <publisher.name>/               files of the extension (from the .vsix)
        <publisher.name>/.studio/       manifest.json, report.json, normalized resources
        state.json                      {id: {"enabled": bool, "settings": {...}}}
"""

from __future__ import annotations

import base64
import json
import os
import shutil
import tempfile

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioCommandError, StudioPathError
from mobility_developer_tools.studio.extensions.checker import ID_RE, CheckResult
from mobility_developer_tools.studio.extensions.vsix import VsixArchive
from mobility_developer_tools.studio.files.path_guard import PathGuard

MAX_READ_BYTES = 20 * 1024 * 1024
MAX_BATCH_BYTES = 30 * 1024 * 1024
MAX_SETTINGS_BYTES = 256 * 1024


class ExtensionStore:
	def __init__(self, root: str):
		self.root = root

	# -- install / remove ----------------------------------------------------------------

	def install(self, archive: VsixArchive, result: CheckResult) -> None:
		extra = {f".studio/{name}": _json_bytes(data) for name, data in result.resources.items()}
		extra[".studio/manifest.json"] = _json_bytes(result.manifest)
		extra[".studio/report.json"] = _json_bytes(result.report)
		self._ensure_root()
		archive.extract_to(self._dir(result.extension_id, must_exist=False), extra_files=extra)
		state = self._state()
		state.setdefault(result.extension_id, {"enabled": True, "settings": {}})
		self._save_state(state)

	def remove(self, ext_id: str) -> None:
		shutil.rmtree(self._dir(ext_id))
		state = self._state()
		state.pop(ext_id, None)
		self._save_state(state)

	# -- queries ------------------------------------------------------------------------------

	def ids(self) -> list[str]:
		if not os.path.isdir(self.root):
			return []
		return sorted(
			name
			for name in os.listdir(self.root)
			if ID_RE.match(name) and os.path.isfile(os.path.join(self.root, name, ".studio", "manifest.json"))
		)

	def manifest(self, ext_id: str) -> dict:
		return self._read_json(ext_id, ".studio/manifest.json")

	def report(self, ext_id: str) -> dict:
		return self._read_json(ext_id, ".studio/report.json")

	def state(self, ext_id: str) -> dict:
		return self._state().get(ext_id, {"enabled": True, "settings": {}})

	def set_enabled(self, ext_id: str, enabled: bool) -> None:
		self._dir(ext_id)
		state = self._state()
		state.setdefault(ext_id, {"settings": {}})["enabled"] = bool(enabled)
		self._save_state(state)

	def set_settings(self, ext_id: str, settings: dict) -> None:
		self._dir(ext_id)
		if not isinstance(settings, dict):
			raise StudioCommandError(_("Settings must be a JSON object"))
		if len(json.dumps(settings)) > MAX_SETTINGS_BYTES:
			raise StudioCommandError(_("Settings are too large"))
		state = self._state()
		state.setdefault(ext_id, {"enabled": True})["settings"] = settings
		self._save_state(state)

	# -- files ----------------------------------------------------------------------------------

	def read_files(self, ext_id: str, paths: list[str], encoding: str = "text") -> dict:
		"""Batch read of extension files (icons, grammars, code). Paths are confined to the extension."""
		if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths) or len(paths) > 300:
			raise StudioPathError(_("Invalid file list"))
		guard = PathGuard(self._dir(ext_id))
		out, total = {}, 0
		for rel in dict.fromkeys(paths):
			try:
				path = guard.resolve(rel)
				size = os.path.getsize(path)
			except (StudioPathError, OSError):
				out[rel] = None
				continue
			if size > MAX_READ_BYTES or total + size > MAX_BATCH_BYTES or not os.path.isfile(path):
				out[rel] = None
				continue
			total += size
			with open(path, "rb") as f:
				data = f.read()
			out[rel] = base64.b64encode(data).decode() if encoding == "base64" else data.decode("utf-8", errors="replace")
		return out

	# -- internals -------------------------------------------------------------------------------

	def _ensure_root(self):
		os.makedirs(self.root, mode=0o700, exist_ok=True)

	def _dir(self, ext_id: str, must_exist: bool = True) -> str:
		if not isinstance(ext_id, str) or not ID_RE.match(ext_id):
			raise StudioPathError(_("Invalid extension id"))
		path = os.path.join(self.root, ext_id)
		if must_exist and not os.path.isdir(path):
			raise StudioPathError(_("Extension {0} is not installed").format(ext_id))
		return path

	def _read_json(self, ext_id: str, rel: str) -> dict:
		with open(os.path.join(self._dir(ext_id), rel)) as f:
			return json.load(f)

	def _state(self) -> dict:
		try:
			with open(os.path.join(self.root, "state.json")) as f:
				state = json.load(f)
			return state if isinstance(state, dict) else {}
		except (OSError, ValueError):
			return {}

	def _save_state(self, state: dict) -> None:
		self._ensure_root()
		fd, tmp = tempfile.mkstemp(dir=self.root, prefix=".state-")
		with os.fdopen(fd, "w") as f:
			json.dump(state, f)
		os.replace(tmp, os.path.join(self.root, "state.json"))


def _json_bytes(data) -> bytes:
	return json.dumps(data, separators=(",", ":")).encode()
