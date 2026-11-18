"""Change detection for open files and expanded folders (polled by the browser).

Why polling instead of inotify: requests are served by several web worker
processes (a watcher in one cannot reach a browser connected through another),
inotify watch limits are easily exhausted on a bench with node_modules, and the
same code must behave identically on hosted benches. A bounded stat() of the
files and folders the user actually has open costs a few milliseconds.
"""

from __future__ import annotations

import hashlib
import os

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import FileReader, file_version

MAX_WATCHED_FILES = 200
MAX_WATCHED_FOLDERS = 200

MISSING = {"exists": False, "version": None, "mtime": None, "size": None}


class FileChangeDetector:
	def __init__(self, guard: PathGuard, reader: FileReader):
		self._guard = guard
		self._reader = reader

	def snapshot(self, files: list[str] | None, folders: list[str] | None) -> dict:
		files = _unique(files, MAX_WATCHED_FILES, _("files"))
		folders = _unique(folders, MAX_WATCHED_FOLDERS, _("folders"))
		return {
			"files": {path: self._file_state(path) for path in files},
			"folders": {path: self._folder_signature(path) for path in folders},
		}

	def _file_state(self, path: str) -> dict:
		# outside the root / blocked / missing all look the same: nothing leaks about them
		try:
			abs_path = self._guard.resolve(path, must_exist=False)
			st = os.stat(abs_path)
		except (StudioPathError, OSError):
			return dict(MISSING)
		if not os.path.isfile(abs_path):
			return dict(MISSING)
		return {"exists": True, "version": file_version(st), "mtime": st.st_mtime, "size": st.st_size}

	def _folder_signature(self, path: str) -> str | None:
		"""Changes when an entry is added, removed, renamed or changes type."""
		try:
			entries = self._reader.list_dir(path)
		except (StudioPathError, OSError):
			return None
		digest = hashlib.sha1()
		for entry in entries:
			digest.update(f"{entry['type']}:{entry['name']}\n".encode())
		return digest.hexdigest()


def _unique(paths, limit: int, label: str) -> list[str]:
	if paths is None:
		return []
	if not isinstance(paths, list) or not all(isinstance(p, str) for p in paths):
		raise StudioPathError(_("Invalid watch list"))
	unique = list(dict.fromkeys(paths))
	if len(unique) > limit:
		raise StudioPathError(_("Too many {0} to watch (max {1})").format(label, limit))
	return unique
