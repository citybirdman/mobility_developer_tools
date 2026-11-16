"""AI tool registry (Open/Closed). Other apps can add tools with the hook
``developer_studio_ai_tools`` (dotted paths to AiTool subclasses)."""

import frappe
from frappe import _

from mobility_developer_tools.studio.ai_tools.base import AiTool
from mobility_developer_tools.studio.ai_tools.builtin import AntigravityTool, ClaudeCodeTool


class AiToolRegistry:
	def __init__(self, tools: list[AiTool] | None = None):
		self._tools: dict[str, AiTool] = {}
		for tool in tools or []:
			self.register(tool)

	def register(self, tool: AiTool) -> None:
		self._tools[tool.key] = tool

	def all(self) -> list[AiTool]:
		return list(self._tools.values())

	def get(self, key: str) -> AiTool:
		if key not in self._tools:
			frappe.throw(_("Unknown AI tool {0}").format(key))
		return self._tools[key]


def default_ai_registry() -> AiToolRegistry:
	registry = AiToolRegistry([ClaudeCodeTool(), AntigravityTool()])
	for path in frappe.get_hooks("developer_studio_ai_tools"):
		registry.register(frappe.get_attr(path)())
	return registry
