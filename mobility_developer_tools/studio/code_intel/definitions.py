"""Go to Definition (F12 / Ctrl+click) for the studio editor.

Two strategies (Strategy pattern, tried in order):
  * DottedPathStrategy - the cursor is on a dotted path inside a string, as Frappe uses
    everywhere: hooks.py ("app.module.function"), frappe.call({method: "..."}),
    frappe.get_attr("..."). Works in Python and JavaScript files.
  * JediStrategy - Python static analysis (Jedi) with the bench's own sys.path, so
    `import frappe` and every installed app resolve. Nothing is imported or executed.

Every result passes through the PathGuard: definitions outside the studio root (or in
blocked folders such as other sites) are dropped, so nothing leaks about them.
"""

from __future__ import annotations

import os
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioPathError
from mobility_developer_tools.studio.files.path_guard import PathGuard

MAX_SOURCE_CHARS = 2 * 1024 * 1024
DOTTED = re.compile(r"^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$")
STRING = re.compile(r"""(?P<q>["'])(?P<s>(?:\\.|(?!(?P=q)).)*)(?P=q)""")


@dataclass(frozen=True)
class Definition:
	path: str  # absolute
	line: int  # 1-based
	column: int  # 0-based


class DefinitionStrategy(ABC):
	@abstractmethod
	def find(self, source: str, abs_path: str, line: int, column: int, language: str) -> list[Definition]: ...


class JediStrategy(DefinitionStrategy):
	"""Python only. Uses the running interpreter's environment (the bench env)."""

	def __init__(self, project_path: str):
		self.project_path = project_path

	def find(self, source, abs_path, line, column, language):
		if language != "python":
			return []
		return self.goto(source, abs_path, line, column)

	def goto(self, source, abs_path, line, column) -> list[Definition]:
		import jedi

		script = jedi.Script(
			source, path=abs_path, environment=jedi.InterpreterEnvironment(), project=jedi.Project(self.project_path)
		)
		try:
			names = script.goto(line, column, follow_imports=True)
		except Exception:  # jedi raises on positions inside strings/comments etc.
			return []
		return [Definition(str(n.module_path), n.line, n.column) for n in names if n.module_path and n.line]


class DottedPathStrategy(DefinitionStrategy):
	"""'app.module.function' inside a string -> that function (resolved with Jedi, no import)."""

	def __init__(self, jedi_strategy: JediStrategy):
		self.jedi = jedi_strategy

	def find(self, source, abs_path, line, column, language):
		dotted = dotted_string_at(source, line, column)
		if not dotted:
			return []
		parts = dotted.split(".")
		# try "from a.b import c" with the longest module first
		for split in range(len(parts) - 1, 0, -1):
			module, name, rest = ".".join(parts[:split]), parts[split], parts[split + 1 :]
			snippet = f"from {module} import {name}\n" + (f"{name}.{'.'.join(rest)}" if rest else name)
			last_line = snippet.split("\n")[-1]
			found = self.jedi.goto(snippet, os.path.join(self.jedi.project_path, "__studio_goto__.py"), 2, max(len(last_line) - 1, 0))
			found = [d for d in found if not d.path.endswith("__studio_goto__.py")]
			if found:
				return found
		return []


class DefinitionFinder:
	def __init__(self, guard: PathGuard, strategies: list[DefinitionStrategy]):
		self._guard = guard
		self._strategies = strategies

	def find(self, path: str, source: str, line: int, column: int, language: str = "python") -> list[dict]:
		if not isinstance(source, str) or len(source) > MAX_SOURCE_CHARS:
			raise StudioPathError(_("File is too large for Go to Definition"))
		lines = source.split("\n")
		line, column = int(line), int(column)
		if not 1 <= line <= len(lines) or not 0 <= column <= len(lines[line - 1]):
			return []
		abs_path = self._guard.resolve(path, must_exist=False)
		for strategy in self._strategies:
			results = self._visible(strategy.find(source, abs_path, line, column, language), abs_path)
			if results:
				return results
		return []

	def _visible(self, definitions: list[Definition], current: str) -> list[dict]:
		out, seen = [], set()
		for d in definitions:
			real = os.path.realpath(d.path)
			if real == current:  # the file being edited (it may not be saved yet)
				key = (real, d.line, d.column)
				if key not in seen:
					seen.add(key)
					out.append({"path": self._guard.relative(real), "line": d.line, "column": d.column})
				continue
			try:
				# same rules as the explorer: inside the root, not in blocked folders
				resolved = self._guard.resolve(os.path.relpath(real, self._guard.root))
			except (StudioPathError, ValueError):
				continue
			key = (resolved, d.line, d.column)
			if key in seen or not os.path.isfile(resolved):
				continue
			seen.add(key)
			out.append({"path": self._guard.relative(resolved), "line": d.line, "column": d.column})
		return out[:20]


def dotted_string_at(source: str, line: int, column: int) -> str | None:
	"""The dotted path in the string literal under the cursor (1-based line, 0-based column)."""
	text = source.split("\n")[line - 1]
	for m in STRING.finditer(text):
		if m.start("s") <= column <= m.end("s"):
			value = m.group("s").strip()
			return value if DOTTED.match(value) else None
	return None
