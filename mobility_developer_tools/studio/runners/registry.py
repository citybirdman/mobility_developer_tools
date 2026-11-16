"""Runner registry (Open/Closed): add a runner by registering it, no existing code changes.

Other apps can contribute runners through the hook ``developer_studio_runners``
(list of dotted paths to ScriptRunner subclasses).
"""

import frappe
from frappe import _

from mobility_developer_tools.studio.runners.base import RunContext, ScriptRunner
from mobility_developer_tools.studio.runners.builtin import (
	FrappePythonRunner,
	NodeRunner,
	PythonRunner,
	ShellRunner,
)


class RunnerRegistry:
	def __init__(self, runners: list[ScriptRunner] | None = None):
		self._runners: dict[str, ScriptRunner] = {}
		for runner in runners or []:
			self.register(runner)

	def register(self, runner: ScriptRunner) -> None:
		self._runners[runner.key] = runner

	def for_path(self, path: str) -> list[ScriptRunner]:
		return [r for r in self._runners.values() if r.supports(path)]

	def get(self, key: str) -> ScriptRunner:
		if key not in self._runners:
			frappe.throw(_("Unknown runner {0}").format(key))
		return self._runners[key]

	def build_command(self, key: str, abs_path: str, ctx: RunContext) -> str:
		runner = self.get(key)
		if not runner.supports(abs_path):
			frappe.throw(_("{0} cannot run this file").format(runner.label))
		return runner.build_command(abs_path, ctx)


def default_registry() -> RunnerRegistry:
	registry = RunnerRegistry([FrappePythonRunner(), PythonRunner(), ShellRunner(), NodeRunner()])
	for path in frappe.get_hooks("developer_studio_runners"):
		registry.register(frappe.get_attr(path)())
	return registry
