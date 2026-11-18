"""Security of the change-detection endpoint: no information about files outside the
root or in blocked folders, bounded work per request, strict input types."""

import os
from unittest.mock import patch

import frappe

from mobility_developer_tools.studio import api
from mobility_developer_tools.studio.container import get_container
from mobility_developer_tools.studio.exceptions import StudioLockedError, StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import LocalFileService
from mobility_developer_tools.studio.files.watch import MAX_WATCHED_FILES, MAX_WATCHED_FOLDERS, FileChangeDetector
from mobility_developer_tools.tests.base import StudioTestCase

HIDDEN = {"exists": False, "version": None, "mtime": None, "size": None}


class TestWatchSecurity(StudioTestCase):
	def setUp(self):
		self.root = self.make_tree()
		guard = PathGuard(self.root, blocked=[os.path.join(self.root, "sub")])
		self.detector = FileChangeDetector(guard, LocalFileService(guard))

	def test_outside_paths_reveal_nothing(self):
		paths = ["../outside/secret.txt", "/etc/passwd", "../../etc/shadow", "sub/b.txt", "a.py\x00", "nope.txt"]
		result = self.detector.snapshot(paths, [])["files"]
		for path in paths:
			with self.subTest(path=path):
				self.assertEqual(result[path], HIDDEN)  # existing-but-forbidden looks exactly like missing

	def test_outside_folders_reveal_nothing(self):
		folders = ["..", "../outside", "/etc", "sub", "sub/..//../outside"]
		self.assertEqual(set(self.detector.snapshot([], folders)["folders"].values()), {None})

	def test_folders_are_not_reported_as_files(self):
		os.makedirs(os.path.join(self.root, "dir"))
		self.assertEqual(self.detector.snapshot(["dir"], [])["files"]["dir"], HIDDEN)

	def test_symlink_to_outside_reveals_nothing(self):
		os.symlink(os.path.join(os.path.dirname(self.root), "outside", "secret.txt"), os.path.join(self.root, "link.txt"))
		self.assertEqual(self.detector.snapshot(["link.txt"], [])["files"]["link.txt"], HIDDEN)

	def test_work_per_request_is_bounded(self):
		with self.assertRaises(StudioPathError):
			self.detector.snapshot([f"f{i}" for i in range(MAX_WATCHED_FILES + 1)], [])
		with self.assertRaises(StudioPathError):
			self.detector.snapshot([], [f"d{i}" for i in range(MAX_WATCHED_FOLDERS + 1)])
		# duplicates do not count twice
		self.detector.snapshot(["a.py"] * 10_000, [""] * 10_000)

	def test_input_types_are_strict(self):
		for files in ("a.py", {"a.py": 1}, [1, 2], [None], [["a.py"]]):
			with self.subTest(files=files), self.assertRaises(StudioPathError):
				self.detector.snapshot(files, [])

	def test_detects_changes(self):
		before = self.detector.snapshot(["a.py"], [""])
		os.utime(os.path.join(self.root, "a.py"), (1, 1))
		open(os.path.join(self.root, "new.txt"), "w").close()
		after = self.detector.snapshot(["a.py"], [""])
		self.assertNotEqual(before["files"]["a.py"]["version"], after["files"]["a.py"]["version"])
		self.assertNotEqual(before["folders"][""], after["folders"][""])


class TestWatchEndpoint(StudioTestCase):
	def test_requires_unlocked_session(self):
		frappe.local._mdt_studio_container = None
		with patch.object(api, "_token", return_value=None), self.assertRaises(StudioLockedError):
			api.watch(["sites/apps.txt"], [""])

	def test_endpoint_hides_other_sites(self):
		c = get_container()
		others = c.config.other_site_paths()
		if not others:
			self.skipTest("single-site bench")
		rel = os.path.relpath(os.path.join(others[0], "site_config.json"), c.config.root)
		folder = os.path.relpath(others[0], c.config.root)
		result = c.watcher.snapshot([rel], [folder])
		self.assertEqual(result["files"][rel], HIDDEN)
		self.assertIsNone(result["folders"][folder])
