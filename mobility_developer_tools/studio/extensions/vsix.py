"""Safe reading and extraction of .vsix packages (zip files).

Defends against: path traversal ("zip slip"), absolute paths, symlinks and
special files, zip bombs (total size, file count, compression ratio), and
files that are not VS Code extensions.
"""

from __future__ import annotations

import io
import os
import posixpath
import shutil
import stat
import tempfile
import zipfile

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioCommandError
from mobility_developer_tools.studio.extensions import jsonc

PREFIX = "extension/"  # files of the extension live under this folder in a .vsix
MAX_ARCHIVE_BYTES = 100 * 1024 * 1024
MAX_UNPACKED_BYTES = 300 * 1024 * 1024
MAX_FILES = 25_000
MAX_RATIO = 200  # uncompressed / compressed, per file


class VsixError(StudioCommandError):
	pass


class VsixArchive:
	def __init__(self, data: bytes):
		if len(data) > MAX_ARCHIVE_BYTES:
			raise VsixError(_("Extension package is too large"))
		try:
			self._zip = zipfile.ZipFile(io.BytesIO(data))
		except zipfile.BadZipFile:
			raise VsixError(_("Not a valid .vsix file"))
		self._members = self._validate()
		self.package_json = self._read_package_json()

	# -- validation -------------------------------------------------------------

	def _validate(self) -> dict[str, zipfile.ZipInfo]:
		infos = self._zip.infolist()
		if len(infos) > MAX_FILES:
			raise VsixError(_("Extension package has too many files"))
		total = 0
		members: dict[str, zipfile.ZipInfo] = {}
		for info in infos:
			name = info.filename
			if not name.startswith(PREFIX) or name.endswith("/"):
				continue
			rel = name[len(PREFIX) :]
			if not safe_relative_path(rel):
				raise VsixError(_("Unsafe path in extension package: {0}").format(name))
			mode = info.external_attr >> 16
			if mode and (stat.S_ISLNK(mode) or not (stat.S_ISREG(mode) or mode & 0o170000 == 0)):
				raise VsixError(_("Links and special files are not allowed: {0}").format(name))
			if info.compress_size and info.file_size / info.compress_size > MAX_RATIO and info.file_size > 1024 * 1024:
				raise VsixError(_("Suspicious compression ratio: {0}").format(name))
			total += info.file_size
			if total > MAX_UNPACKED_BYTES:
				raise VsixError(_("Extension package is too large when unpacked"))
			members[rel] = info
		if "package.json" not in members:
			raise VsixError(_("Not a VS Code extension (no extension/package.json)"))
		return members

	def _read_package_json(self) -> dict:
		try:
			data = jsonc.loads(self.read("package.json"))
		except ValueError:
			raise VsixError(_("package.json is not valid JSON"))
		if not isinstance(data, dict) or not data.get("name") or not data.get("publisher"):
			raise VsixError(_("package.json has no name/publisher"))
		return data

	# -- access -------------------------------------------------------------------

	@property
	def files(self) -> list[str]:
		return sorted(self._members)

	def exists(self, rel: str) -> bool:
		return normalize(rel) in self._members

	def read(self, rel: str, limit: int = 20 * 1024 * 1024) -> bytes:
		info = self._members.get(normalize(rel))
		if info is None:
			raise FileNotFoundError(rel)
		if info.file_size > limit:
			raise VsixError(_("{0} is too large").format(rel))
		with self._zip.open(info) as f:
			data = f.read(limit + 1)
		if len(data) > limit:
			raise VsixError(_("{0} is too large").format(rel))
		return data

	def extract_to(self, target: str, extra_files: dict[str, bytes] | None = None) -> None:
		"""Extract (plus generated `extra_files`) into a new folder, atomically replacing `target`."""
		parent = os.path.dirname(target)
		os.makedirs(parent, mode=0o700, exist_ok=True)
		staging = tempfile.mkdtemp(prefix=".install-", dir=parent)
		try:
			for rel, info in self._members.items():
				dest = os.path.join(staging, *rel.split("/"))
				os.makedirs(os.path.dirname(dest), exist_ok=True)
				with self._zip.open(info) as src, open(dest, "wb") as out:
					shutil.copyfileobj(src, out, 1024 * 1024)
			for rel, data in (extra_files or {}).items():
				dest = os.path.join(staging, *rel.split("/"))
				os.makedirs(os.path.dirname(dest), exist_ok=True)
				with open(dest, "wb") as out:
					out.write(data)
			old = None
			if os.path.exists(target):
				old = target + ".old"
				shutil.rmtree(old, ignore_errors=True)
				os.replace(target, old)
			os.replace(staging, target)
			if old:
				shutil.rmtree(old, ignore_errors=True)
		except BaseException:
			shutil.rmtree(staging, ignore_errors=True)
			raise


def normalize(rel: str) -> str:
	rel = (rel or "").replace("\\", "/")
	while rel.startswith("./"):
		rel = rel[2:]
	return posixpath.normpath(rel) if rel else rel


def safe_relative_path(rel: str) -> bool:
	if not rel or "\x00" in rel or rel.startswith("/") or "\\" in rel or ":" in rel.split("/")[0]:
		return False
	parts = rel.split("/")
	return all(part not in ("", ".", "..") for part in parts)
