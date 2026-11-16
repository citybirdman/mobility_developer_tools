"""Composition root (Dependency Inversion): the only place that knows which
concrete classes implement each abstraction. Endpoints ask the container for
services and never instantiate them directly."""

import frappe

from mobility_developer_tools.studio.ai_tools.registry import default_ai_registry
from mobility_developer_tools.studio.ai_tools.service import AiToolService
from mobility_developer_tools.studio.audit import DocTypeAuditLogger
from mobility_developer_tools.studio.config import StudioConfig
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import LocalFileService
from mobility_developer_tools.studio.kv import RedisKeyValueStore
from mobility_developer_tools.studio.runners.registry import default_registry
from mobility_developer_tools.studio.security.access import AccessPolicy
from mobility_developer_tools.studio.security.session import StudioSessionService
from mobility_developer_tools.studio.terminal.manager import TerminalManager
from mobility_developer_tools.studio.terminal.spawner import DetachedProcessSpawner


class StudioContainer:
	def __init__(self):
		self.config = StudioConfig.from_site()
		self.store = RedisKeyValueStore.for_site(frappe.conf, frappe.local.site)
		# other sites' folders and stored AI sign-ins are never reachable from the explorer
		self.guard = PathGuard(self.config.root, [*self.config.other_site_paths(), self.config.data_dir])

	@property
	def access(self) -> AccessPolicy:
		return AccessPolicy(self.config)

	@property
	def sessions(self) -> StudioSessionService:
		return StudioSessionService(self.store, self.config)

	@property
	def files(self) -> LocalFileService:
		return LocalFileService(self.guard)

	@property
	def runners(self):
		return default_registry()

	@property
	def terminals(self) -> TerminalManager:
		return TerminalManager(self.store, self.config, DetachedProcessSpawner(), frappe.local.site)

	@property
	def ai_tools(self) -> AiToolService:
		return AiToolService(default_ai_registry(), self.config, frappe.local.site)

	@property
	def audit(self) -> DocTypeAuditLogger:
		return DocTypeAuditLogger()


def get_container() -> StudioContainer:
	if not getattr(frappe.local, "_mdt_studio_container", None):
		frappe.local._mdt_studio_container = StudioContainer()
	return frappe.local._mdt_studio_container
