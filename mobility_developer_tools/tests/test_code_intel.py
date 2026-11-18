"""Go to Definition: correctness on real bench code, security of results, performance."""

import os
import time

from mobility_developer_tools.studio.code_intel.definitions import (
	DefinitionFinder,
	DottedPathStrategy,
	JediStrategy,
	dotted_string_at,
)
from mobility_developer_tools.studio.container import StudioContainer
from mobility_developer_tools.studio.exceptions import StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.tests.base import StudioTestCase


def position(source, needle, offset=1):
	for number, line in enumerate(source.split("\n"), 1):
		if needle in line:
			return number, line.index(needle) + offset
	raise AssertionError(needle)


class TestDefinitions(StudioTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.container = StudioContainer()
		cls.finder = cls.container.definitions

	def find(self, path, source, needle, language="python", offset=1):
		line, column = position(source, needle, offset)
		return self.finder.find(path, source, line, column, language)

	def test_frappe_api(self):
		result = self.find("apps/x.py", "import frappe\nfrappe.get_doc('User')\n", "get_doc")
		self.assertEqual(result[0]["path"], "apps/frappe/frappe/__init__.py")
		with open(os.path.join(self.container.config.root, result[0]["path"])) as f:
			self.assertIn("def get_doc", f.read().split("\n")[result[0]["line"] - 1])

	def test_reexported_import(self):
		result = self.find("apps/x.py", "from frappe.utils import cint\ncint(1)\n", "cint(1")
		self.assertTrue(result[0]["path"].startswith("apps/frappe/frappe/utils/"))

	def test_local_and_unsaved(self):
		result = self.find("apps/not_saved_yet.py", "def helper():\n    pass\n\nhelper()\n", "helper()")
		self.assertEqual(result, [{"path": "apps/not_saved_yet.py", "line": 1, "column": 4}])

	def test_dotted_paths_in_strings(self):
		hooks = 'doc_events = {"*": {"on_update": "frappe.client.get_list"}}\n'
		self.assertEqual(self.find("apps/a/hooks.py", hooks, "client.get_list")[0]["path"], "apps/frappe/frappe/client.py")
		js = 'frappe.call({ method: "frappe.client.get_list", args: {} });\n'
		self.assertEqual(self.find("apps/a/x.js", js, "client.get_list", "javascript")[0]["path"], "apps/frappe/frappe/client.py")
		self.assertEqual(dotted_string_at('x = "not a path"', 1, 6), None)
		self.assertEqual(dotted_string_at("a = 'a.b.c' + 'd.e'", 1, 6), "a.b.c")

	def test_nothing_for_plain_javascript(self):
		self.assertEqual(self.find("apps/a/x.js", "const a = 1;\nconsole.log(a);\n", "log", "javascript"), [])


class TestDefinitionSecurity(StudioTestCase):
	def test_results_outside_the_root_are_hidden(self):
		root = self.make_tree()
		finder = DefinitionFinder(PathGuard(root), [JediStrategy(root)])
		# os / json live in the Python installation, outside this root
		self.assertEqual(finder.find("a.py", "import os\nos.path.join('a')\n", 2, 9), [])
		self.assertEqual(finder.find("a.py", "import json\njson.dumps(1)\n", 2, 6), [])

	def test_blocked_folders_are_hidden(self):
		container = StudioContainer()
		jedi_strategy = JediStrategy(container.config.bench_path)
		blocked_frappe = PathGuard(container.config.root, [os.path.join(container.config.root, "apps", "frappe")])
		finder = DefinitionFinder(blocked_frappe, [DottedPathStrategy(jedi_strategy), jedi_strategy])
		self.assertEqual(finder.find("apps/x.py", "import frappe\nfrappe.get_doc('User')\n", 2, 9), [])

	def test_inputs_are_validated(self):
		finder = StudioContainer().definitions
		with self.assertRaises(StudioPathError):
			finder.find("../../etc/passwd", "x", 1, 0)
		with self.assertRaises(StudioPathError):
			finder.find("apps/x.py", "x" * (3 * 1024 * 1024), 1, 0)
		self.assertEqual(finder.find("apps/x.py", "x = 1", 99, 0), [])
		self.assertEqual(finder.find("apps/x.py", "x = 1", 1, 999), [])
		self.assertEqual(finder.find("apps/x.py", "x = 1", 0, 0), [])


class TestDefinitionPerformance(StudioTestCase):
	def test_warm_lookup_latency(self):
		finder = StudioContainer().definitions
		source = "import frappe\nfrappe.get_doc('User')\nfrappe.db.get_value('User', 'x')\n"
		finder.find("apps/x.py", source, 2, 9)  # warm Jedi's caches
		samples = []
		for _ in range(10):
			started = time.perf_counter()
			finder.find("apps/x.py", source, 2, 9)
			samples.append(time.perf_counter() - started)
		samples.sort()
		print(f"\n    go to definition (warm): median {samples[5] * 1000:.0f} ms, max {samples[-1] * 1000:.0f} ms (budget 1500 ms)")
		self.assertLess(samples[-1], 1.5)
