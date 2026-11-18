"""Find / replace in files (the studio's Search view, like VS Code's).

Single Responsibility split:
  * ``SearchQuery``   - the user's query + options, compiled to one regex
  * ``GlobFilter``    - "files to include / exclude" (VS Code glob syntax)
  * ``TextSearcher``  - walks the root and collects matches (read only)
  * ``TextReplacer``  - rewrites one file, refusing when it changed since the search

Every path goes through ``PathGuard`` so blocked folders (other sites, stored
sign-ins) are never searched or modified.

Columns are UTF-16 code units (what Monaco / JavaScript count), lines are 1-based.
"""

from __future__ import annotations

import bisect
import os
import re
import time
from dataclasses import dataclass, field

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioConflictError, StudioPathError, StudioSearchError
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import SEARCH_SKIP_DIRS, _atomic_write, file_version

MAX_PATTERN_LENGTH = 1000
MAX_GLOB_LENGTH = 2000
MAX_SEARCH_FILE_SIZE = 2 * 1024 * 1024
MAX_MATCHES = 5000
MAX_FILES_WITH_MATCHES = 1000
MAX_FILES_VISITED = 200_000
TIME_BUDGET_SECONDS = 15.0
PREVIEW_BEFORE = 40  # characters of context kept before a match
PREVIEW_MAX = 250  # characters of a preview line


# -- query --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class SearchQuery:
	pattern: str
	is_regex: bool = False
	match_case: bool = False
	whole_word: bool = False

	def compile(self) -> re.Pattern:
		if not self.pattern:
			raise StudioSearchError(_("Type something to search for"))
		if len(self.pattern) > MAX_PATTERN_LENGTH:
			raise StudioSearchError(_("Search text is too long"))
		source = self.pattern if self.is_regex else re.escape(self.pattern)
		if self.whole_word:
			source = rf"(?<!\w)(?:{source})(?!\w)"
		flags = re.MULTILINE if self.is_regex else 0
		if not self.match_case:
			flags |= re.IGNORECASE
		try:
			regex = re.compile(source, flags)
		except re.error as e:
			raise StudioSearchError(_("Invalid regular expression: {0}").format(e)) from e
		return regex

	def literal_bytes(self) -> bytes | None:
		"""Cheap pre-filter for literal searches: skip decoding files that cannot match."""
		if self.is_regex:
			return None
		needle = self.pattern if self.match_case else self.pattern.lower()
		if not self.match_case and not needle.isascii():
			return None  # bytes.lower() only folds ASCII
		return needle.encode("utf-8")

	def expand(self, match: re.Match, replacement: str) -> str:
		"""Replacement text for one match. Regex mode understands $1, $<name>, $& and $$
		(JavaScript / VS Code syntax) plus \\n and \\t."""
		if not self.is_regex:
			return replacement
		return _expand_template(match, replacement)


_TEMPLATE = re.compile(r"\$(\$|&|\d{1,2}|<[A-Za-z_]\w*>)|\\([nt\\])")


def _expand_template(match: re.Match, template: str) -> str:
	def sub(m: re.Match) -> str:
		token, escape = m.group(1), m.group(2)
		if escape:
			return {"n": "\n", "t": "\t", "\\": "\\"}[escape]
		if token == "$":
			return "$"
		if token == "&":
			return match.group(0)
		if token.startswith("<"):
			try:
				return match.group(token[1:-1]) or ""
			except IndexError:
				return m.group(0)
		index = int(token)
		if index > (match.re.groups or 0):
			if len(token) == 2 and int(token[0]) <= (match.re.groups or 0):
				return (match.group(int(token[0])) or "") + token[1]  # "$12" with one group = "$1" + "2"
			return m.group(0)
		return match.group(index) or ""

	return _TEMPLATE.sub(sub, template)


# -- include / exclude ----------------------------------------------------------------------------


class GlobFilter:
	"""Comma separated VS Code style globs. ``*.py`` matches at any depth, ``apps/frappe``
	matches that folder and everything below it, ``**`` crosses folders, ``{a,b}`` alternates."""

	def __init__(self, include: str = "", exclude: str = ""):
		if len(include or "") > MAX_GLOB_LENGTH or len(exclude or "") > MAX_GLOB_LENGTH:
			raise StudioSearchError(_("File patterns are too long"))
		self.include = [_glob_regex(g) for g in _split_globs(include)]
		self.exclude = [_glob_regex(g) for g in _split_globs(exclude)]

	def wants_file(self, rel: str) -> bool:
		if any(r.match(rel) for r in self.exclude):
			return False
		return not self.include or any(r.match(rel) for r in self.include)

	def skips_dir(self, rel: str) -> bool:
		return any(r.match(rel) for r in self.exclude)


def _split_globs(text: str) -> list[str]:
	"""Split on commas that are not inside {...}."""
	parts, depth, current = [], 0, ""
	for ch in text or "":
		if ch == "{":
			depth += 1
		elif ch == "}":
			depth = max(depth - 1, 0)
		if ch == "," and depth == 0:
			parts.append(current)
			current = ""
		else:
			current += ch
	parts.append(current)
	return [p.strip().replace("\\", "/").strip("/") for p in parts if p.strip().strip("/")]


def _glob_regex(glob: str) -> re.Pattern:
	anchored = glob.startswith(("./", "**/")) or "/" in glob
	if glob.startswith("./"):
		glob = glob[2:]
	body = _glob_body(glob)
	prefix = "" if anchored else "(?:.*/)?"
	# a glob naming a folder also covers everything inside it
	return re.compile(rf"^{prefix}{body}(?:/.*)?$", re.IGNORECASE)


def _glob_body(glob: str) -> str:
	out, i = [], 0
	while i < len(glob):
		ch = glob[i]
		if glob.startswith("**/", i):
			out.append("(?:.*/)?")
			i += 3
			continue
		if glob.startswith("**", i):
			out.append(".*")
			i += 2
			continue
		if ch == "*":
			out.append("[^/]*")
		elif ch == "?":
			out.append("[^/]")
		elif ch == "{":
			end = glob.find("}", i)
			if end < 0:
				out.append(re.escape(ch))
			else:
				out.append("(?:" + "|".join(_glob_body(p) for p in glob[i + 1 : end].split(",")) + ")")
				i = end + 1
				continue
		elif ch == "[":
			end = glob.find("]", i)
			if end < 0:
				out.append(re.escape(ch))
			else:
				inner = glob[i + 1 : end].replace("\\", "\\\\")
				out.append(f"[{'^' + inner[1:] if inner.startswith('!') else inner}]")
				i = end + 1
				continue
		else:
			out.append(re.escape(ch))
		i += 1
	return "".join(out)


# -- search ----------------------------------------------------------------------------------------


@dataclass
class SearchLimits:
	max_matches: int = MAX_MATCHES
	max_files: int = MAX_FILES_WITH_MATCHES
	max_visited: int = MAX_FILES_VISITED
	max_file_size: int = MAX_SEARCH_FILE_SIZE
	time_budget: float = TIME_BUDGET_SECONDS


@dataclass
class SearchResult:
	files: list[dict] = field(default_factory=list)
	match_count: int = 0
	limit_hit: bool = False
	timed_out: bool = False
	visited: int = 0

	def as_dict(self) -> dict:
		return {
			"files": self.files,
			"file_count": len(self.files),
			"match_count": self.match_count,
			"limit_hit": self.limit_hit,
			"timed_out": self.timed_out,
		}


class TextSearcher:
	def __init__(self, guard: PathGuard, limits: SearchLimits | None = None, clock=time.monotonic):
		self._guard = guard
		self._limits = limits or SearchLimits()
		self._clock = clock

	def search(self, query: SearchQuery, globs: GlobFilter, folder: str = "") -> dict:
		regex = query.compile()
		needle = query.literal_bytes()
		start_dir = self._guard.resolve(folder) if folder else self._guard.root
		result = SearchResult()
		deadline = self._clock() + self._limits.time_budget
		if os.path.isfile(start_dir):
			# one file (refreshing its matches after a replace): include / exclude do not apply
			self._search_file(start_dir, self._guard.relative(start_dir), regex, needle, result)
			return result.as_dict()

		for dirpath, dirnames, filenames in os.walk(start_dir):
			dirnames[:] = sorted(d for d in dirnames if self._enter_dir(dirpath, d, globs))
			for name in sorted(filenames):
				if result.limit_hit or result.timed_out:
					return result.as_dict()
				result.visited += 1
				if result.visited > self._limits.max_visited:
					result.limit_hit = True
					break
				if result.visited % 200 == 0 and self._clock() > deadline:
					result.timed_out = True
					break
				abs_path = os.path.join(dirpath, name)
				rel = self._guard.relative(abs_path)
				if not globs.wants_file(rel):
					continue
				self._search_file(abs_path, rel, regex, needle, result)
		return result.as_dict()

	def _enter_dir(self, dirpath: str, name: str, globs: GlobFilter) -> bool:
		if name in SEARCH_SKIP_DIRS or name.startswith("."):
			return False
		abs_path = os.path.join(dirpath, name)
		return not self._guard.is_blocked(abs_path) and not globs.skips_dir(self._guard.relative(abs_path))

	def _search_file(self, abs_path, rel, regex, needle, result: SearchResult) -> None:
		try:
			if os.path.islink(abs_path) and not self._link_allowed(abs_path):
				return
			st = os.stat(abs_path)
			if st.st_size > self._limits.max_file_size or not os.path.isfile(abs_path):
				return
			with open(abs_path, "rb") as f:
				raw = f.read()
		except OSError:
			return
		if b"\x00" in raw[:8192]:
			return
		if needle is not None and needle not in (raw if _case_sensitive(regex) else raw.lower()):
			return

		text = raw.decode("utf-8", errors="replace")
		lines = LineIndex(text)
		matches = []
		budget = self._limits.max_matches - result.match_count
		for m in regex.finditer(text):
			if m.end() == m.start():
				continue
			matches.append(describe_match(text, m, lines))
			if len(matches) >= budget:
				result.limit_hit = True
				break
		if not matches:
			return
		result.files.append({"path": rel, "version": file_version(st), "matches": matches})
		result.match_count += len(matches)
		if len(result.files) >= self._limits.max_files:
			result.limit_hit = True

	def _link_allowed(self, abs_path: str) -> bool:
		real = os.path.realpath(abs_path)
		inside = real == self._guard.root or real.startswith(self._guard.root + os.sep)
		return inside and not self._guard.is_blocked(real)


def _case_sensitive(regex: re.Pattern) -> bool:
	return not regex.flags & re.IGNORECASE


def _u16(text: str) -> int:
	return len(text) if text.isascii() else len(text.encode("utf-16-le")) // 2


class LineIndex:
	"""Line number / line start of an offset in O(log n) (many matches in a big file)."""

	def __init__(self, text: str):
		self.text = text
		self.starts = [0]
		find, pos = text.find, text.find("\n")
		while pos >= 0:
			self.starts.append(pos + 1)
			pos = find("\n", pos + 1)

	def line_of(self, offset: int) -> int:
		return bisect.bisect_right(self.starts, offset)  # 1-based

	def position(self, offset: int) -> tuple[int, int]:
		"""(1-based line, UTF-16 column)"""
		line = self.line_of(offset)
		return line, _u16(self.text[self.starts[line - 1] : offset])


def describe_match(text: str, m: re.Match, lines: LineIndex | None = None) -> dict:
	"""Position (1-based line, UTF-16 columns) + a short preview of the first line."""
	lines = lines or LineIndex(text)
	start, end = m.start(), m.end()
	line_no, col16 = lines.position(start)
	end_line_no, end_col16 = lines.position(end)
	line_start = lines.starts[line_no - 1]
	line_end = text.find("\n", start)
	if line_end < 0:
		line_end = len(text)

	line = text[line_start:line_end].rstrip("\r")
	col, match_end_in_line = start - line_start, min(end, line_start + len(line)) - line_start
	cut = max(0, col - PREVIEW_BEFORE)
	before = line[cut:col]
	if cut:
		before = "…" + before.lstrip()
	matched = line[col:match_end_in_line][:PREVIEW_MAX]
	after = line[match_end_in_line : match_end_in_line + max(0, PREVIEW_MAX - len(before) - len(matched))]
	return {
		"line": line_no,
		"col": col16,
		"end_line": end_line_no,
		"end_col": end_col16,
		"before": before,
		"match": matched,
		"after": after,
		"multiline": end_line_no != line_no,
	}


# -- replace ----------------------------------------------------------------------------------------


class TextReplacer:
	def __init__(self, guard: PathGuard, max_file_size: int = MAX_SEARCH_FILE_SIZE):
		self._guard = guard
		self._max_file_size = max_file_size

	def replace(
		self,
		path: str,
		query: SearchQuery,
		replacement: str,
		expected_version: str | None,
		only: list[dict] | None = None,
	) -> dict:
		"""Replace every match in ``path``, or only the ones whose start ({line, col}) is in ``only``."""
		regex = query.compile()
		abs_path = self._guard.resolve(path)
		self._guard.ensure_not_root(abs_path)
		if not os.path.isfile(abs_path):
			raise StudioPathError(_("{0} is not a file").format(path))
		st = os.stat(abs_path)
		if expected_version and file_version(st) != expected_version:
			raise StudioConflictError(_("{0} changed after the search. Search again before replacing.").format(path))
		if st.st_size > self._max_file_size:
			raise StudioPathError(_("{0} is too large").format(path))
		with open(abs_path, "rb") as f:
			raw = f.read()
		try:
			text = raw.decode("utf-8")
		except UnicodeDecodeError as e:
			raise StudioPathError(_("{0} is not UTF-8 text and cannot be changed here").format(path)) from e

		wanted = {(int(m["line"]), int(m["col"])) for m in only} if only is not None else None
		lines = LineIndex(text) if wanted is not None else None
		count = 0

		def sub(m: re.Match) -> str:
			nonlocal count
			if m.end() == m.start():
				return m.group(0)
			if wanted is not None:
				if lines.position(m.start()) not in wanted:
					return m.group(0)
			count += 1
			return query.expand(m, replacement)

		new_text = regex.sub(sub, text)
		if count:
			_atomic_write(abs_path, new_text)
			st = os.stat(abs_path)
		return {"path": self._guard.relative(abs_path), "replaced": count, "version": file_version(st)}
