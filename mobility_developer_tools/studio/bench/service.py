"""Registry + service for bench commands. Other apps can add commands with the
hook ``developer_studio_bench_commands`` (dotted paths to BenchCommand subclasses)."""

from __future__ import annotations

import os
import shutil

import frappe
from frappe import _

from mobility_developer_tools.studio.bench.base import BenchCommand, BenchContext, CommandLine
from mobility_developer_tools.studio.bench.commands import BUILTIN_COMMANDS, console_command_line
from mobility_developer_tools.studio.config import StudioConfig
from mobility_developer_tools.studio.exceptions import StudioCommandError
from mobility_developer_tools.studio.terminal.launch import LaunchSpec


class BenchCommandRegistry:
	def __init__(self, commands: list[BenchCommand] | None = None):
		self._commands: dict[str, BenchCommand] = {}
		for command in commands or []:
			self.register(command)

	def register(self, command: BenchCommand) -> None:
		self._commands[command.key] = command

	def all(self) -> list[BenchCommand]:
		return list(self._commands.values())

	def get(self, key: str) -> BenchCommand:
		if key not in self._commands:
			raise StudioCommandError(_("Unknown command {0}").format(key))
		return self._commands[key]


def default_bench_registry() -> BenchCommandRegistry:
	registry = BenchCommandRegistry([cls() for cls in BUILTIN_COMMANDS])
	for path in frappe.get_hooks("developer_studio_bench_commands"):
		registry.register(frappe.get_attr(path)())
	return registry


def current_bench_context(config: StudioConfig) -> BenchContext:
	return BenchContext(
		site=frappe.local.site,
		sites_path=config.sites_path,
		bench_path=config.bench_path,
		python=config.python,
		bench_cli=shutil.which("bench"),
		bench_apps=tuple(frappe.get_all_apps(with_internal_apps=False) or ()),
		installed_apps=tuple(frappe.get_installed_apps()),
	)


class BenchService:
	def __init__(self, registry: BenchCommandRegistry, ctx: BenchContext):
		self._registry = registry
		self._ctx = ctx

	def commands(self) -> dict:
		return {
			"site": self._ctx.site,
			"commands": [c.describe(self._ctx) for c in self._registry.all() if c.is_available(self._ctx)],
		}

	def run_spec(self, key: str, values: dict | None) -> tuple[LaunchSpec, CommandLine]:
		command = self._registry.get(key)
		if not command.is_available(self._ctx):
			raise StudioCommandError(_("{0} is not available on this server").format(command.label))
		line = command.build(self._ctx, values or {})
		spec = LaunchSpec(argv=line.argv, title=f"{command.label} · {self._ctx.site}", kind="bench")
		return spec, line

	def console_spec(self) -> tuple[LaunchSpec, CommandLine]:
		line = console_command_line(self._ctx)
		return LaunchSpec(argv=line.argv, title=f"Console · {self._ctx.site}", kind="console"), line


def display_command(line: CommandLine) -> str:
	"""Readable form for the audit log: `bench ...` instead of the long python invocation."""
	argv = line.argv
	if len(argv) > 3 and argv[1:4] == ["-m", "frappe.utils.bench_helper", "frappe"]:
		argv = ["bench", *argv[4:]]
	elif argv and os.path.basename(argv[0]) == "bench":
		argv = ["bench", *argv[1:]]
	return " ".join(argv)
