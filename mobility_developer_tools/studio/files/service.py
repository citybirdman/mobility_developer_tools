"""File system operations for the studio.

Interface Segregation: callers that only read depend on ``FileReader``; callers
that modify depend on ``FileWriter``. ``LocalFileService`` implements both and
delegates every path decision to ``PathGuard`` (Single Responsibility).
"""

import os
import shutil
from typing import Protocol

from frappe import _

from mobility_developer_tools.studio.config import MAX_FILE_SIZE
from mobility_developer_tools.studio.exceptions import StudioConflictError, StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard

HIDDEN_NAMES = {"__pycache__", ".DS_Store"}
SEARCH_SKIP_DIRS = {".git", "node_modules", "__pycache__", "env", ".venv", "assets", "logs", ".cache"}
MAX_SEARCH_RESULTS = 200
MAX_SEARCH_VISITED = 200_000


class FileReader(Protocol):
	def list_dir(self, path: str) -> list[dict]: ...
	def read(self, path: str) -> dict: ...
	def find(self, query: str) -> list[str]: ...


class FileWriter(Protocol):
	def write(self, path: str, content: str, expected_version: str | None = None) -> dict: ...
	def create_file(self, path: str) -> dict: ...
	def create_folder(self, path: str) -> dict: ...
	def rename(self, path: str, new_path: str) -> dict: ...
	def delete(self, path: str) -> None: ...


class LocalFileService:
	def __init__(self, guard: PathGuard):
		self._guard = guard

	# -- read ---------------------------------------------------------------

	def list_dir(self, path):
		abs_path = self._guard.resolve(path)
		if not os.path.isdir(abs_path):
			raise StudioPathError(_("{0} is not a folder").format(path))

		entries = []
		with os.scandir(abs_path) as it:
			for entry in it:
				if entry.name in HIDDEN_NAMES or self._guard.is_blocked(os.path.join(abs_path, entry.name)):
					continue
				try:
					is_dir = entry.is_dir()
				except OSError:
					is_dir = False
				entries.append(
					{
						"name": entry.name,
						"path": self._guard.relative(os.path.join(abs_path, entry.name)),
						"type": "folder" if is_dir else "file",
						"symlink": entry.is_symlink(),
					}
				)
		entries.sort(key=lambda e: (e["type"] != "folder", e["name"].lower()))
		return entries

	def read(self, path):
		abs_path = self._guard.resolve(path)
		if os.path.isdir(abs_path):
			raise StudioPathError(_("{0} is a folder").format(path))

		size = os.path.getsize(abs_path)
		if size > MAX_FILE_SIZE:
			raise StudioPathError(
				_("File is too large to open ({0} MB)").format(round(size / 1024 / 1024, 1))
			)

		with open(abs_path, "rb") as f:
			raw = f.read()
		if b"\x00" in raw[:8192]:
			raise StudioPathError(_("Binary files cannot be opened in the editor"))

		return {
			"path": self._guard.relative(abs_path),
			"content": raw.decode("utf-8", errors="replace"),
			"mtime": os.path.getmtime(abs_path),
			"version": file_version(os.stat(abs_path)),
			"size": size,
			"readonly": not os.access(abs_path, os.W_OK),
		}

	def find(self, query):
		"""Quick-open: files whose relative path contains all characters of query in order."""
		query = (query or "").lower().strip()
		if not query:
			return []

		results, visited = [], 0
		for dirpath, dirnames, filenames in os.walk(self._guard.root):
			dirnames[:] = [
				d
				for d in dirnames
				if d not in SEARCH_SKIP_DIRS
				and not d.startswith(".")
				and not self._guard.is_blocked(os.path.join(dirpath, d))
			]
			for name in filenames:
				visited += 1
				rel = self._guard.relative(os.path.join(dirpath, name))
				if _fuzzy_match(query, rel.lower()):
					results.append(rel)
					if len(results) >= MAX_SEARCH_RESULTS:
						return _rank(results, query)
			if visited > MAX_SEARCH_VISITED:
				break
		return _rank(results, query)

	# -- write --------------------------------------------------------------

	def write(self, path, content, expected_version=None):
		abs_path = self._guard.resolve(path, must_exist=False)
		if os.path.isdir(abs_path):
			raise StudioPathError(_("{0} is a folder").format(path))

		if expected_version and os.path.exists(abs_path):
			if file_version(os.stat(abs_path)) != expected_version:
				raise StudioConflictError(_("{0} was changed on disk after you opened it").format(path))

		_atomic_write(abs_path, content or "")
		st = os.stat(abs_path)
		return {"path": self._guard.relative(abs_path), "mtime": st.st_mtime, "version": file_version(st)}

	def create_file(self, path):
		abs_path = self._new_path(path)
		os.makedirs(os.path.dirname(abs_path), exist_ok=True)
		with open(abs_path, "x"):
			pass
		return {"path": self._guard.relative(abs_path), "type": "file"}

	def create_folder(self, path):
		abs_path = self._new_path(path)
		os.makedirs(abs_path)
		return {"path": self._guard.relative(abs_path), "type": "folder"}

	def rename(self, path, new_path):
		src = self._guard.resolve(path)
		self._guard.ensure_not_root(src)
		dst = self._new_path(new_path)
		os.makedirs(os.path.dirname(dst), exist_ok=True)
		os.rename(src, dst)
		return {"path": self._guard.relative(dst)}

	def delete(self, path):
		abs_path = self._guard.resolve(path)
		self._guard.ensure_not_root(abs_path)
		if os.path.isdir(abs_path) and not os.path.islink(abs_path):
			shutil.rmtree(abs_path)
		else:
			os.remove(abs_path)

	def _new_path(self, path):
		abs_path = self._guard.resolve(path, must_exist=False)
		self._guard.ensure_not_root(abs_path)
		if os.path.lexists(abs_path):
			raise StudioPathError(_("{0} already exists").format(path))
		return abs_path


def file_version(st: os.stat_result) -> str:
	"""Identifies one state of a file. mtime alone is not enough: the kernel updates it
	on a coarse clock tick, so two writes a few ms apart can share it. Atomic saves
	(ours, most editors, git) replace the inode, so they always change the version."""
	return f"{st.st_mtime_ns:x}-{st.st_size:x}-{st.st_ino:x}"


def _atomic_write(abs_path: str, content: str) -> None:
	"""Write via temp file + rename, keeping the original file mode."""
	tmp = f"{abs_path}.studio-tmp"
	mode = os.stat(abs_path).st_mode if os.path.exists(abs_path) else None
	with open(tmp, "w", encoding="utf-8", newline="") as f:
		f.write(content)
	if mode is not None:
		os.chmod(tmp, mode)
	os.replace(tmp, abs_path)


def _fuzzy_match(query: str, text: str) -> bool:
	pos = 0
	for ch in query:
		pos = text.find(ch, pos)
		if pos < 0:
			return False
		pos += 1
	return True


def _rank(paths: list[str], query: str) -> list[str]:
	def score(p):
		name = p.rsplit("/", 1)[-1].lower()
		return (query not in name, query not in p.lower(), len(p))

	return sorted(paths, key=score)
