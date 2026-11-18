"""Open VSX registry client (https://open-vsx.org): search, metadata, verified download.

The Microsoft marketplace terms only allow its use from Microsoft products, so the
studio uses Open VSX. Downloads are accepted only from Open VSX hosts and only when
their SHA-256 matches the checksum published by the registry.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Callable
from urllib.parse import quote, urljoin, urlparse

from frappe import _

from mobility_developer_tools.studio.extensions.vsix import MAX_ARCHIVE_BYTES, VsixError

API = "https://open-vsx.org/api"
# the registry API, and the Eclipse Foundation hosts it redirects downloads to
ALLOWED_HOSTS = {"open-vsx.org", "openvsx.eclipsecontent.org", "openvsxorg.blob.core.windows.net"}
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
VERSION_RE = re.compile(r"^[0-9A-Za-z.+-]{1,64}$")

# fetch(url, max_bytes) -> bytes ; injectable for tests
Fetcher = Callable[[str, int], bytes]


def http_fetch(url: str, max_bytes: int) -> bytes:
	"""GET with a size cap. Redirects are followed manually so every hop is checked
	against the allow list (a registry redirect to another host is refused)."""
	import requests

	for _hop in range(6):
		response = requests.get(
			url, timeout=(10, 60), stream=True, allow_redirects=False, headers={"User-Agent": "frappe-developer-studio"}
		)
		try:
			if response.is_redirect:
				url = _check_url(urljoin(url, response.headers.get("location", "")))
				continue
			response.raise_for_status()
			chunks, size = [], 0
			for chunk in response.iter_content(256 * 1024):
				size += len(chunk)
				if size > max_bytes:
					raise VsixError(_("Download is larger than {0} MB").format(max_bytes // (1024 * 1024)))
				chunks.append(chunk)
			return b"".join(chunks)
		finally:
			response.close()
	raise VsixError(_("Too many redirects"))


def _check_url(url: str) -> str:
	parsed = urlparse(url)
	if parsed.scheme != "https" or (parsed.hostname or "").lower() not in ALLOWED_HOSTS:
		raise VsixError(_("Refusing to download from {0}").format(parsed.hostname or url))
	return url


class OpenVsxClient:
	def __init__(self, fetch: Fetcher = http_fetch):
		self._fetch = fetch

	def _json(self, url: str):
		import json

		return json.loads(self._fetch(_check_url(url), 5 * 1024 * 1024))

	def search(self, query: str, size: int = 30) -> list[dict]:
		query = (query or "").strip()[:100]
		url = f"{API}/-/search?query={quote(query)}&size={int(size)}&sortBy=relevance"
		results = []
		for item in self._json(url).get("extensions", []):
			results.append(
				{
					"namespace": item.get("namespace"),
					"name": item.get("name"),
					"version": item.get("version"),
					"display_name": item.get("displayName") or item.get("name"),
					"description": (item.get("description") or "")[:300],
					"downloads": item.get("downloadCount") or 0,
					"icon": _safe_icon(item.get("files", {}).get("icon")),
				}
			)
		return results

	def metadata(self, namespace: str, name: str, version: str | None = None) -> dict:
		validate_name(namespace)
		validate_name(name)
		if version and not VERSION_RE.match(version):
			raise VsixError(_("Invalid version"))
		return self._json(f"{API}/{quote(namespace)}/{quote(name)}/{quote(version or 'latest')}")

	def download(self, namespace: str, name: str, version: str | None = None) -> tuple[bytes, dict]:
		meta = self.metadata(namespace, name, version)
		files = meta.get("files") or {}
		data = self._fetch(_check_url(files.get("download", "")), MAX_ARCHIVE_BYTES)
		expected = self._fetch(_check_url(files.get("sha256", "")), 4096).decode().split()[0].lower() if files.get("sha256") else ""
		if not expected:
			raise VsixError(_("The registry did not publish a checksum for this extension"))
		if hashlib.sha256(data).hexdigest() != expected:
			raise VsixError(_("Checksum mismatch: the download was corrupted or tampered with"))
		return data, meta


def validate_name(value: str) -> str:
	if not NAME_RE.match(value or ""):
		raise VsixError(_("Invalid extension name"))
	return value


def _safe_icon(url):
	try:
		return _check_url(url) if url else None
	except VsixError:
		return None
