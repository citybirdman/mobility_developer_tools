"""Search view: find / replace in files - correctness, security and limits."""

import os

from mobility_developer_tools.studio.exceptions import StudioConflictError, StudioPathError, StudioSearchError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.search import (
	GlobFilter,
	SearchLimits,
	SearchQuery,
	TextReplacer,
	TextSearcher,
)
from mobility_developer_tools.tests.base import StudioTestCase


class TestTextSearch(StudioTestCase):
	def setUp(self):
		self.root = self.make_tree()
		self.write("app/hooks.py", "app_name = 'demo'\nApp_Name = 1\nmy_app_name = 2\n")
		self.write("app/public/x.js", "const appName = 'é😀 app_name';\n")
		self.write("node_modules/lib/app_name.js", "app_name\n")
		self.write(".git/config", "app_name\n")
		self.guard = PathGuard(self.root, blocked=[os.path.join(self.root, "sub")])
		self.searcher = TextSearcher(self.guard)

	def write(self, rel, content):
		path = os.path.join(self.root, rel)
		os.makedirs(os.path.dirname(path), exist_ok=True)
		with open(path, "w", encoding="utf-8") as f:
			f.write(content)

	def read(self, rel):
		with open(os.path.join(self.root, rel), encoding="utf-8") as f:
			return f.read()

	def find(self, pattern, include="", exclude="", **options):
		return self.searcher.search(SearchQuery(pattern, **options), GlobFilter(include, exclude))

	def paths(self, result):
		return [f["path"] for f in result["files"]]

	# -- options --------------------------------------------------------------------------------

	def test_case_insensitive_by_default(self):
		result = self.find("app_name")
		self.assertEqual(self.paths(result), ["app/hooks.py", "app/public/x.js"])
		self.assertEqual(result["match_count"], 4)

	def test_match_case_and_whole_word(self):
		self.assertEqual(self.find("app_name", match_case=True)["match_count"], 3)
		hooks = self.find("app_name", whole_word=True, include="hooks.py")["files"][0]["matches"]
		self.assertEqual([m["line"] for m in hooks], [1, 2])

	def test_regex(self):
		result = self.find(r"(\w+)_name\s*=", is_regex=True, match_case=True, include="*.py")
		self.assertEqual([m["match"] for m in result["files"][0]["matches"]], ["app_name =", "my_app_name ="])

	def test_invalid_regex_and_empty_query(self):
		with self.assertRaises(StudioSearchError):
			self.find("(unclosed", is_regex=True)
		with self.assertRaises(StudioSearchError):
			self.find("")

	def test_regex_special_chars_are_literal_without_regex(self):
		self.write("p.txt", "a.b axb (x)\n")
		self.assertEqual(self.find("a.b", include="p.txt")["match_count"], 1)
		self.assertEqual(self.find("(x)", include="p.txt")["match_count"], 1)

	def test_columns_are_utf16_and_preview(self):
		m = self.find("app_name", include="x.js")["files"][0]["matches"][0]
		line = "const appName = 'é😀 app_name';"
		start = line.index("app_name")
		self.assertEqual(m["col"], len(line[:start].encode("utf-16-le")) // 2)  # 😀 counts as 2
		self.assertEqual((m["before"] + m["match"] + m["after"]), line)

	def test_long_line_preview_is_trimmed(self):
		self.write("long.txt", "x" * 5000 + "needle" + "y" * 5000)
		m = self.find("needle", include="long.txt")["files"][0]["matches"][0]
		self.assertTrue(m["before"].startswith("…"))
		self.assertLess(len(m["before"]) + len(m["match"]) + len(m["after"]), 400)
		self.assertEqual(m["col"], 5000)

	def test_multiline_regex(self):
		self.write("m.txt", "start\nend\n")
		m = self.find(r"start\nend", is_regex=True, include="m.txt")["files"][0]["matches"][0]
		self.assertEqual((m["line"], m["end_line"], m["end_col"], m["multiline"]), (1, 2, 3, True))

	def test_single_file(self):
		result = self.searcher.search(SearchQuery("app_name"), GlobFilter(exclude="*.py"), folder="app/hooks.py")
		self.assertEqual(self.paths(result), ["app/hooks.py"])

	# -- include / exclude ------------------------------------------------------------------------

	def test_globs(self):
		self.assertEqual(self.paths(self.find("app_name", include="*.js")), ["app/public/x.js"])
		self.assertEqual(self.paths(self.find("app_name", exclude="app/public")), ["app/hooks.py"])
		self.assertEqual(self.paths(self.find("app_name", include="app/**/*.{py,js}")), ["app/hooks.py", "app/public/x.js"])
		self.assertEqual(self.paths(self.find("app_name", include="*.txt, *.py")), ["app/hooks.py"])
		self.write("lib/app/x.py", "app_name\n")
		self.assertEqual(self.paths(self.find("app_name", include="./app")), ["app/hooks.py", "app/public/x.js"])
		self.assertEqual(len(self.find("app_name", include="app")["files"]), 3)  # any folder named app

	def test_skips_vendored_hidden_binary_files(self):
		with open(os.path.join(self.root, "bin.dat"), "wb") as f:
			f.write(b"\x00app_name")
		self.assertNotIn("bin.dat", self.paths(self.find("app_name")))
		self.assertTrue(all("node_modules" not in p and ".git" not in p for p in self.paths(self.find("app_name"))))

	# -- security -----------------------------------------------------------------------------------

	def test_blocked_folders_and_symlink_escape_are_never_searched(self):
		self.write("sub/secret.txt", "TOPSECRET\n")
		os.symlink(os.path.join(os.path.dirname(self.root), "outside", "secret.txt"), os.path.join(self.root, "link.txt"))
		os.symlink(os.path.join(self.root, "sub", "secret.txt"), os.path.join(self.root, "link2.txt"))
		os.symlink(os.path.join(os.path.dirname(self.root), "outside"), os.path.join(self.root, "outdir"))
		self.assertEqual(self.find("secret")["files"], [])
		self.assertEqual(self.find("TOPSECRET")["files"], [])
		with self.assertRaises(StudioPathError):
			self.searcher.search(SearchQuery("x"), GlobFilter(), folder="../outside")
		with self.assertRaises(StudioPathError):
			self.searcher.search(SearchQuery("x"), GlobFilter(), folder="sub")

	def test_replace_cannot_touch_blocked_or_outside_files(self):
		replacer = TextReplacer(self.guard)
		self.write("sub/secret.txt", "secret\n")
		for path in ("sub/secret.txt", "../outside/secret.txt", "/etc/passwd", ""):
			with self.subTest(path=path):
				with self.assertRaises(StudioPathError):
					replacer.replace(path, SearchQuery("secret"), "x", None)
		self.assertEqual(self.read("sub/secret.txt"), "secret\n")

	# -- limits ---------------------------------------------------------------------------------

	def test_match_limit(self):
		self.write("many.txt", "hit\n" * 100)
		searcher = TextSearcher(self.guard, SearchLimits(max_matches=10))
		result = searcher.search(SearchQuery("hit"), GlobFilter())
		self.assertEqual(result["match_count"], 10)
		self.assertTrue(result["limit_hit"])

	def test_time_budget(self):
		ticks = iter(range(0, 10**6, 100))
		for i in range(450):
			self.write(f"bulk/f{i}.txt", "x\n")
		searcher = TextSearcher(self.guard, SearchLimits(time_budget=1), clock=lambda: next(ticks))
		self.assertTrue(searcher.search(SearchQuery("x"), GlobFilter())["timed_out"])

	def test_big_files_skipped(self):
		self.write("big.txt", "needle " * 10)
		searcher = TextSearcher(self.guard, SearchLimits(max_file_size=20))
		self.assertEqual(searcher.search(SearchQuery("needle"), GlobFilter())["files"], [])

	# -- replace ------------------------------------------------------------------------------------

	def test_replace_all_in_file(self):
		version = self.find("app_name", include="hooks.py")["files"][0]["version"]
		result = TextReplacer(self.guard).replace("app/hooks.py", SearchQuery("app_name", whole_word=True), "app_title", version)
		self.assertEqual(result["replaced"], 2)
		self.assertEqual(self.read("app/hooks.py"), "app_title = 'demo'\napp_title = 1\nmy_app_name = 2\n")

	def test_replace_single_match_with_regex_groups(self):
		query = SearchQuery(r"(\w+)_name", is_regex=True, match_case=True)
		match = self.find(query.pattern, is_regex=True, match_case=True, include="hooks.py")["files"][0]["matches"][1]
		TextReplacer(self.guard).replace("app/hooks.py", query, "$1Name<$&>$$", None, only=[match])
		self.assertEqual(self.read("app/hooks.py"), "app_name = 'demo'\nApp_Name = 1\nmy_appName<my_app_name>$ = 2\n")

	def test_replace_utf16_column_targets_right_match(self):
		self.write("u.txt", "😀 ab ab\n")
		matches = self.find("ab", include="u.txt")["files"][0]["matches"]
		self.assertEqual([m["col"] for m in matches], [3, 6])
		TextReplacer(self.guard).replace("u.txt", SearchQuery("ab"), "X", None, only=[matches[1]])
		self.assertEqual(self.read("u.txt"), "😀 ab X\n")

	def test_replace_refuses_when_file_changed_since_search(self):
		version = self.find("app_name", include="hooks.py")["files"][0]["version"]
		self.write("app/hooks.py", "app_name changed\n")
		with self.assertRaises(StudioConflictError):
			TextReplacer(self.guard).replace("app/hooks.py", SearchQuery("app_name"), "x", version)

	def test_replace_keeps_file_mode_and_literal_dollar(self):
		os.chmod(os.path.join(self.root, "a.py"), 0o750)
		TextReplacer(self.guard).replace("a.py", SearchQuery("'a'"), "'$1'", None)
		self.assertEqual(self.read("a.py"), "print('$1')\n")
		self.assertEqual(os.stat(os.path.join(self.root, "a.py")).st_mode & 0o777, 0o750)

	def test_replace_refuses_non_utf8(self):
		with open(os.path.join(self.root, "latin.txt"), "wb") as f:
			f.write("caf\xe9 x\n".encode("latin-1"))
		with self.assertRaises(StudioPathError):
			TextReplacer(self.guard).replace("latin.txt", SearchQuery("x"), "y", None)
