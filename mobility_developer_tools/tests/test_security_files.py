"""Security: the explorer/editor can never reach files outside the root or in blocked folders."""

import os

from mobility_developer_tools.studio.config import MAX_FILE_SIZE
from mobility_developer_tools.studio.exceptions import StudioConflictError, StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import LocalFileService
from mobility_developer_tools.tests.base import StudioTestCase

TRAVERSALS = (
	"../outside/secret.txt",
	"../../etc/passwd",
	"/etc/passwd",
	"sub/../../outside/secret.txt",
	"sub/../../../../../../etc/passwd",
	"..\\outside\\secret.txt",
	"./../outside/secret.txt",
	"sub/./../..//outside/secret.txt",
)


class TestPathGuard(StudioTestCase):
	def setUp(self):
		self.root = self.make_tree()
		self.guard = PathGuard(self.root, blocked=[os.path.join(self.root, "sub")])
		self.files = LocalFileService(self.guard)

	def test_traversal_is_rejected(self):
		for path in TRAVERSALS:
			with self.subTest(path=path):
				with self.assertRaises(StudioPathError):
					self.files.read(path)

	def test_absolute_paths_are_relative_to_root(self):
		# "/a.py" means <root>/a.py, never the filesystem root
		self.assertEqual(self.files.read("/a.py")["path"], "a.py")

	def test_null_byte_rejected(self):
		with self.assertRaises(StudioPathError):
			self.guard.resolve("a.py\x00.txt")

	def test_symlink_escape_rejected_but_internal_symlink_allowed(self):
		outside = os.path.join(os.path.dirname(self.root), "outside")
		os.symlink(outside, os.path.join(self.root, "escape"))
		os.symlink(os.path.join(self.root, "a.py"), os.path.join(self.root, "alias.py"))
		with self.assertRaises(StudioPathError):
			self.files.read("escape/secret.txt")
		with self.assertRaises(StudioPathError):
			self.files.list_dir("escape")
		self.assertIn("print", self.files.read("alias.py")["content"])

	def test_blocked_folder_and_children(self):
		with self.assertRaises(StudioPathError):
			self.files.list_dir("sub")
		with self.assertRaises(StudioPathError):
			self.files.read("sub/b.txt")
		self.assertNotIn("sub", [e["name"] for e in self.files.list_dir("")])
		self.assertEqual(self.files.find("b.txt"), [])

	def test_blocked_prefix_does_not_block_sibling_with_same_prefix(self):
		os.makedirs(os.path.join(self.root, "sub2"))
		self.assertEqual(self.files.list_dir("sub2"), [])

	def test_writes_cannot_escape(self):
		for op in (
			lambda: self.files.write("../outside/x.txt", "x"),
			lambda: self.files.create_file("../outside/new.txt"),
			lambda: self.files.create_folder("../../tmp-escape"),
			lambda: self.files.rename("a.py", "../outside/a.py"),
			lambda: self.files.rename("a.py", "sub/a.py"),  # into a blocked folder
			lambda: self.files.write("sub/b.txt", "overwrite"),
			lambda: self.files.delete("../outside/secret.txt"),
		):
			with self.assertRaises(StudioPathError):
				op()
		with open(os.path.join(os.path.dirname(self.root), "outside", "secret.txt")) as f:
			self.assertEqual(f.read(), "secret\n")

	def test_root_cannot_be_deleted_or_renamed(self):
		for op in (lambda: self.files.delete(""), lambda: self.files.delete("/"), lambda: self.files.rename("", "x")):
			with self.assertRaises(StudioPathError):
				op()
		self.assertTrue(os.path.isdir(self.root))

	def test_binary_and_large_files_refused(self):
		with self.assertRaises(StudioPathError):
			self.files.read("data.bin")
		with open(os.path.join(self.root, "big.txt"), "w") as f:
			f.write("x" * (MAX_FILE_SIZE + 1))
		with self.assertRaises(StudioPathError):
			self.files.read("big.txt")

	def test_stale_write_is_a_conflict(self):
		version = self.files.read("a.py")["version"]
		self.files.write("a.py", "v2\n", expected_version=version)
		with self.assertRaises(StudioConflictError):
			self.files.write("a.py", "v3\n", expected_version=version)

	def test_writes_within_one_clock_tick_are_still_detected(self):
		"""Regression: mtime-only checks missed a change made within the same few ms."""
		for _ in range(50):
			version = self.files.read("a.py")["version"]
			self.files.write("a.py", "outside change\n")  # e.g. another tab or git, immediately after
			with self.assertRaises(StudioConflictError):
				self.files.write("a.py", "mine\n", expected_version=version)

	def test_outside_in_place_edit_is_detected(self):
		version = self.files.read("a.py")["version"]
		with open(os.path.join(self.root, "a.py"), "a") as f:  # in-place append (same inode)
			f.write("more\n")
		with self.assertRaises(StudioConflictError):
			self.files.write("a.py", "mine\n", expected_version=version)

	def test_write_keeps_file_mode(self):
		path = os.path.join(self.root, "a.py")
		os.chmod(path, 0o750)
		self.files.write("a.py", "changed\n")
		self.assertEqual(os.stat(path).st_mode & 0o777, 0o750)
		self.assertFalse(any(name.endswith(".studio-tmp") for name in os.listdir(self.root)))


class TestSiteIsolation(StudioTestCase):
	"""On a bench with several sites, the explorer of one site hides the others and the AI sign-ins."""

	def test_container_blocks_other_sites_and_credentials(self):
		from mobility_developer_tools.studio.container import StudioContainer

		c = StudioContainer()
		others = c.config.other_site_paths()
		self.assertNotIn(c.config.site_path, others)
		for path in [*others, c.config.data_dir]:
			with self.subTest(path=path):
				self.assertTrue(c.guard.is_blocked(path))
				self.assertTrue(c.guard.is_blocked(os.path.join(path, "site_config.json")))
		self.assertFalse(c.guard.is_blocked(os.path.join(c.config.site_path, "site_config.json")))
