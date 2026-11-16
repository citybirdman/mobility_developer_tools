"""Studio configuration (Single Responsibility: read settings, nothing else).

All values can be overridden in site_config.json / common_site_config.json:

    developer_studio_enabled           1/0 (default: same as developer_mode)
    developer_studio_root              absolute path of the explorer root (default: bench folder)
    developer_studio_session_minutes   minutes an unlocked session stays valid without activity (default 30)
    developer_studio_terminal_idle_minutes  minutes a terminal survives without a connected client (default 60)
    developer_studio_max_terminals     max concurrent terminals per user (default 5)
    developer_studio_shell             shell used by terminals (default $SHELL or /bin/bash)
"""

import os
import sys
from dataclasses import dataclass

import frappe
from frappe.utils import cint, get_bench_path

ALLOWED_ROLE = "System Manager"
MAX_FILE_SIZE = 5 * 1024 * 1024  # bytes the editor will open
MAX_FAILED_UNLOCKS = 5
UNLOCK_LOCKOUT_SECONDS = 5 * 60


@dataclass(frozen=True)
class StudioConfig:
	enabled: bool
	root: str
	bench_path: str
	sites_path: str
	session_seconds: int
	terminal_idle_seconds: int
	max_terminals: int
	shell: str
	site_path: str = ""

	@property
	def data_dir(self) -> str:
		"""Per-site private folder for studio data (AI tools, sign-ins). Not web-served:
		nginx only serves <site>/public, and Frappe serves <site>/private/files only."""
		return os.path.join(self.site_path, "private", "mobility_developer_tools")

	def other_site_paths(self) -> list[str]:
		"""Folders of the other sites on this bench (hidden from this site's studio)."""
		paths = []
		for name in os.listdir(self.sites_path):
			path = os.path.realpath(os.path.join(self.sites_path, name))
			if path != self.site_path and os.path.isfile(os.path.join(path, "site_config.json")):
				paths.append(path)
		return paths

	@property
	def python(self) -> str:
		"""The bench virtualenv python (falls back to the current interpreter)."""
		env_python = os.path.join(self.bench_path, "env", "bin", "python")
		return env_python if os.path.exists(env_python) else sys.executable

	@classmethod
	def from_site(cls) -> "StudioConfig":
		conf = frappe.conf
		bench_path = os.path.realpath(get_bench_path())
		enabled = conf.get("developer_studio_enabled")
		if enabled is None:
			enabled = conf.get("developer_mode")

		return cls(
			enabled=bool(cint(enabled)),
			root=os.path.realpath(conf.get("developer_studio_root") or bench_path),
			bench_path=bench_path,
			sites_path=os.path.realpath(os.path.join(bench_path, "sites")),
			session_seconds=60 * (cint(conf.get("developer_studio_session_minutes")) or 30),
			terminal_idle_seconds=60 * (cint(conf.get("developer_studio_terminal_idle_minutes")) or 60),
			max_terminals=cint(conf.get("developer_studio_max_terminals")) or 5,
			shell=conf.get("developer_studio_shell") or os.environ.get("SHELL") or "/bin/bash",
			site_path=os.path.realpath(frappe.get_site_path()),
		)
