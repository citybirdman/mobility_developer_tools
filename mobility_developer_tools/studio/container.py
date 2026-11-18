"""Composition root (Dependency Inversion): the only place that knows which
concrete classes implement each abstraction. Endpoints ask the container for
services and never instantiate them directly."""

import os

import frappe

from mobility_developer_tools.studio.ai_tools.registry import default_ai_registry
from mobility_developer_tools.studio.ai_tools.service import AiToolService
from mobility_developer_tools.studio.audit import DocTypeAuditLogger
from mobility_developer_tools.studio.bench.service import BenchService, current_bench_context, default_bench_registry
from mobility_developer_tools.studio.config import StudioConfig
from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.search import TextReplacer, TextSearcher
from mobility_developer_tools.studio.files.service import LocalFileService
from mobility_developer_tools.studio.files.watch import FileChangeDetector
from mobility_developer_tools.studio.code_intel.definitions import DefinitionFinder, DottedPathStrategy, JediStrategy
from mobility_developer_tools.studio.extensions.checker import CompatibilityChecker
from mobility_developer_tools.studio.extensions.openvsx import OpenVsxClient
from mobility_developer_tools.studio.extensions.service import ExtensionService
from mobility_developer_tools.studio.extensions.store import ExtensionStore
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
	def searcher(self) -> TextSearcher:
		return TextSearcher(self.guard)

	@property
	def replacer(self) -> TextReplacer:
		return TextReplacer(self.guard)

	@property
	def watcher(self) -> FileChangeDetector:
		return FileChangeDetector(self.guard, self.files)

	@property
	def definitions(self) -> DefinitionFinder:
		jedi_strategy = JediStrategy(self.config.bench_path)
		return DefinitionFinder(self.guard, [DottedPathStrategy(jedi_strategy), jedi_strategy])

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
	def bench(self) -> BenchService:
		return BenchService(default_bench_registry(), current_bench_context(self.config))

	@property
	def extensions(self) -> ExtensionService:
		store = ExtensionStore(os.path.join(self.config.data_dir, "extensions"))
		return ExtensionService(store, OpenVsxClient(), CompatibilityChecker())

	@property
	def audit(self) -> DocTypeAuditLogger:
		return DocTypeAuditLogger()


def get_container() -> StudioContainer:
	if not getattr(frappe.local, "_mdt_studio_container", None):
		frappe.local._mdt_studio_container = StudioContainer()
	return frappe.local._mdt_studio_container
