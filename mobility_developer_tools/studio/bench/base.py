"""Frappe / bench commands offered in the studio's Bench panel.

Design:
* every command is a ``BenchCommand`` (one class per command, Open/Closed via a registry)
* commands describe their inputs with ``CommandField`` (the UI renders the form)
* ``build`` returns an argv list that is executed directly (no shell), so values
  can never inject shell syntax; values are additionally validated per field
* site commands always target the current site; there is no "site" input
"""

from __future__ import annotations

import json
import re
from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass, field

from frappe import _

from mobility_developer_tools.studio.exceptions import StudioCommandError

APP_NAME_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
GIT_URL_RE = re.compile(r"^(https://[\w.-]+(:\d+)?/[\w./~%+-]+|git@[\w.-]+:[\w./~%+-]+)$")
GIT_REF_RE = re.compile(r"^[\w][\w./-]{0,99}$")
MAX_LIST_ITEMS = 20


@dataclass(frozen=True)
class CommandField:
	fieldname: str
	label: str
	fieldtype: str = "Data"  # Data | Select | Check | MultiCheck (list of options) | Lines (one entry per line)
	options: list[str] = field(default_factory=list)
	reqd: bool = False
	default: str | int | None = None
	description: str = ""

	def as_dict(self) -> dict:
		return asdict(self)


@dataclass(frozen=True)
class BenchContext:
	site: str
	sites_path: str
	bench_path: str
	python: str
	bench_cli: str | None  # path of the `bench` CLI, None where it is not installed (e.g. some clouds)
	bench_apps: tuple[str, ...]  # apps present in this bench
	installed_apps: tuple[str, ...]  # apps installed on this site


@dataclass(frozen=True)
class CommandLine:
	argv: list[str]
	cwd: str


class BenchCommand(ABC):
	key: str = ""
	label: str = ""
	group: str = "Site"
	icon: str = "terminal"
	description: str = ""
	danger: bool = False  # the UI asks for confirmation

	def fields(self, ctx: BenchContext) -> list[CommandField]:
		return []

	def is_available(self, ctx: BenchContext) -> bool:
		return True

	@abstractmethod
	def build(self, ctx: BenchContext, values: dict) -> CommandLine: ...

	# -- shared helpers --------------------------------------------------------

	def clean(self, ctx: BenchContext, values: dict | None) -> dict:
		"""Validate raw values against fields(): unknown keys, types, required, select options."""
		values = dict(values or {})
		fields = {f.fieldname: f for f in self.fields(ctx)}
		unknown = set(values) - set(fields)
		if unknown:
			raise StudioCommandError(_("Unknown input: {0}").format(", ".join(sorted(unknown))))

		cleaned = {}
		for name, f in fields.items():
			value = values.get(name, f.default)
			if f.fieldtype == "Check":
				cleaned[name] = value in (1, True, "1", "true", "True")
				continue
			if f.fieldtype in ("MultiCheck", "Lines"):
				cleaned[name] = self._clean_list(f, value)
				continue
			value = "" if value is None else str(value).strip()
			if f.reqd and not value:
				raise StudioCommandError(_("{0} is required").format(f.label))
			if value and f.fieldtype == "Select" and value not in f.options:
				raise StudioCommandError(_("Invalid value for {0}").format(f.label))
			if value.startswith("-"):
				raise StudioCommandError(_("{0} cannot start with '-'").format(f.label))
			cleaned[name] = value
		return cleaned

	@staticmethod
	def _clean_list(f: CommandField, value) -> list[str]:
		if value is None or value == "":
			items = []
		elif isinstance(value, list):
			items = value
		elif isinstance(value, str) and f.fieldtype == "Lines":
			items = value.splitlines()
		elif isinstance(value, str):
			items = value.split(",")
		else:
			raise StudioCommandError(_("Invalid value for {0}").format(f.label))
		cleaned = list(dict.fromkeys(str(i).strip() for i in items if str(i).strip()))
		if len(cleaned) > MAX_LIST_ITEMS:
			raise StudioCommandError(_("At most {0} entries for {1}").format(MAX_LIST_ITEMS, f.label))
		if f.reqd and not cleaned:
			raise StudioCommandError(_("{0} is required").format(f.label))
		for item in cleaned:
			if item.startswith("-"):
				raise StudioCommandError(_("{0} cannot start with '-'").format(f.label))
			if f.fieldtype == "MultiCheck" and item not in f.options:
				raise StudioCommandError(_("Invalid value for {0}: {1}").format(f.label, item))
		return cleaned

	@staticmethod
	def sequence(ctx: BenchContext, lines: list[CommandLine]) -> CommandLine:
		"""Several commands in one terminal, one after another (stops at the first failure). No shell."""
		if len(lines) == 1:
			return lines[0]
		steps = [{"argv": line.argv, "cwd": line.cwd} for line in lines]
		return CommandLine(argv=[ctx.python, "-m", "mobility_developer_tools.studio.bench.sequence", json.dumps(steps)], cwd=ctx.bench_path)

	@staticmethod
	def frappe_cli(ctx: BenchContext, *args: str, site: bool = True) -> CommandLine:
		"""`bench [--site <site>] <args>` for Frappe's own commands, without needing the bench CLI."""
		argv = [ctx.python, "-m", "frappe.utils.bench_helper", "frappe"]
		if site:
			argv += ["--site", ctx.site]
		return CommandLine(argv=[*argv, *args], cwd=ctx.sites_path)

	@staticmethod
	def bench_cli(ctx: BenchContext, *args: str) -> CommandLine:
		if not ctx.bench_cli:
			raise StudioCommandError(_("The bench CLI is not available on this server"))
		return CommandLine(argv=[ctx.bench_cli, *args], cwd=ctx.bench_path)

	def describe(self, ctx: BenchContext) -> dict:
		return {
			"key": self.key,
			"label": self.label,
			"group": self.group,
			"icon": self.icon,
			"description": self.description,
			"danger": self.danger,
			"fields": [f.as_dict() for f in self.fields(ctx)],
		}


def validate_app_name(name: str, allowed: tuple[str, ...] | list[str]) -> str:
	if not APP_NAME_RE.match(name or "") or name not in allowed:
		raise StudioCommandError(_("Invalid app {0}").format(name))
	return name
