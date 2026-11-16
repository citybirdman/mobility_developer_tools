import os

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioPathError


class PathGuard:
	"""Maps client paths (always relative to the root) to absolute paths and
	guarantees the result stays inside the root (symlinks resolved) and outside
	the blocked folders (other sites, stored credentials)."""

	def __init__(self, root: str, blocked: list[str] | None = None):
		self.root = os.path.realpath(root)
		self.blocked = [os.path.realpath(p) for p in blocked or []]

	def resolve(self, rel_path: str | None, must_exist: bool = True) -> str:
		rel_path = (rel_path or "").replace("\\", "/").lstrip("/")
		if "\x00" in rel_path:
			raise StudioPathError(_("Invalid path"))

		abs_path = os.path.realpath(os.path.join(self.root, rel_path))
		if not _inside(abs_path, self.root):
			raise StudioPathError(_("Path is outside the studio root"))
		if self.is_blocked(abs_path):
			raise StudioPathError(_("This folder is not available from this site"))
		if must_exist and not os.path.lexists(abs_path):
			raise StudioPathError(_("{0} does not exist").format(rel_path or "/"))
		return abs_path

	def is_blocked(self, abs_path: str) -> bool:
		abs_path = os.path.realpath(abs_path)
		return any(_inside(abs_path, blocked) for blocked in self.blocked)

	def relative(self, abs_path: str) -> str:
		rel = os.path.relpath(abs_path, self.root)
		return "" if rel == "." else rel.replace(os.sep, "/")

	def ensure_not_root(self, abs_path: str) -> None:
		if abs_path == self.root:
			raise StudioPathError(_("This operation is not allowed on the root folder"))


def _inside(path: str, folder: str) -> bool:
	return path == folder or os.path.commonpath([folder, path]) == folder
