"""Builds terminal launch specs for AI tools (install / start) and reports their status.

Everything is stored in the site folder, so it belongs to this site only and
survives redeploys of the bench (e.g. on Frappe Cloud):

    <site>/private/mobility_developer_tools/
        tools-home/            installed CLIs (+ their auto-updates), shared by this site's users
        profiles/<user>/       each user's sign-in, settings and history
        shims/                 browser shim (sign-in links -> studio page)
"""

from __future__ import annotations

import hashlib
import os
import pwd
import re
import shlex

from frappe import _

from mobility_developer_tools.studio.ai_tools.base import AiProfile, AiTool
from mobility_developer_tools.studio.ai_tools.registry import AiToolRegistry
from mobility_developer_tools.studio.config import StudioConfig
from mobility_developer_tools.studio.exceptions import StudioPathError
from mobility_developer_tools.studio.terminal.launch import LaunchSpec

BROWSER_SHIMS = ("xdg-open", "x-www-browser", "www-browser", "sensible-browser", "gnome-open")


class AiToolService:
	def __init__(self, registry: AiToolRegistry, config: StudioConfig, site: str):
		self._registry = registry
		self._config = config
		self._site = site
		self._real_home = pwd.getpwuid(os.getuid()).pw_dir
		self._data_dir = config.data_dir

	@property
	def tools_home(self) -> str:
		return self._private_dir("tools-home")

	# -- status ---------------------------------------------------------------

	def status(self) -> list[dict]:
		env = dict(os.environ, PATH=self._search_path(), HOME=self.tools_home)
		tools = []
		for tool in self._registry.all():
			binary = tool.find_binary(env["PATH"])
			tools.append(
				{
					"key": tool.key,
					"label": tool.label,
					"icon": tool.icon,
					"installed": bool(binary),
					# "site": stored in this site's folder; "server": only installed for the Linux user
					"location": None if not binary else ("site" if self._in_site(binary) else "server"),
					"version": tool.version(binary, env) if binary else None,
					"install_command": tool.install_command,
					"docs_url": tool.docs_url,
					"sign_in_hint": tool.sign_in_hint,
				}
			)
		return tools

	# -- launch specs ---------------------------------------------------------

	def start_spec(self, key: str, user: str) -> LaunchSpec:
		tool = self._registry.get(key)
		binary = tool.find_binary(self._search_path())
		if not binary:
			raise StudioPathError(_("{0} is not installed yet. Click Install first.").format(tool.label))

		env = {
			**self._git_env(),
			**tool.env(self._profile(user)),
			"BROWSER": os.path.join(self._shim_dir(), "xdg-open"),
			"MDT_SITE": self._site,
			"MDT_SITES_PATH": self._config.sites_path,
			"MDT_USER": user,
			"MDT_TOOL_LABEL": tool.label,
		}
		return LaunchSpec(
			argv=tool.argv(binary),
			env=env,
			path_prepend=[self._shim_dir(), *self._bin_dirs()],
			title=tool.label,
			kind="ai",
		)

	def install_spec(self, key: str) -> LaunchSpec:
		"""Runs the official installer with HOME set to the site's tools folder, so the
		CLI is installed into the site (installers write to ~/.local)."""
		tool = self._registry.get(key)
		home = self.tools_home
		script = (
			f"echo {shlex.quote(_('Installing into this site: {0}').format(home))}; "
			f"echo {shlex.quote('$ ' + tool.install_command)}; {tool.install_command}; status=$?; echo; "
			f"if [ $status -eq 0 ]; then echo {shlex.quote(_('Installed. Close this tab and open {0} from the AI panel.').format(tool.label))}; "
			f"else echo {shlex.quote(_('Installation failed with exit code'))} $status; fi; "
			f"read -r -p {shlex.quote(_('Press Enter to close'))} _"
		)
		return LaunchSpec(
			argv=["bash", "-c", script],  # not a login shell: keep HOME pointing to the site
			env={
				**self._git_env(),
				"HOME": home,
				"XDG_CONFIG_HOME": os.path.join(home, ".config"),
				"XDG_DATA_HOME": os.path.join(home, ".local", "share"),
				"XDG_CACHE_HOME": os.path.join(home, ".cache"),
			},
			path_prepend=[os.path.join(home, ".local", "bin")],
			title=_("Install {0}").format(tool.label),
			kind="install",
		)

	def tool(self, key: str) -> AiTool:
		return self._registry.get(key)

	# -- helpers --------------------------------------------------------------

	def _bin_dirs(self) -> list[str]:
		"""Site install first; then a server-wide install of the Linux user, if any."""
		return [
			os.path.join(self.tools_home, ".local", "bin"),
			os.path.join(self._real_home, ".local", "bin"),
		]

	def _search_path(self) -> str:
		return ":".join([*self._bin_dirs(), os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")])

	def _in_site(self, binary: str) -> bool:
		path = os.path.realpath(binary)
		return os.path.commonpath([path, self._data_dir]) == self._data_dir

	def _git_env(self) -> dict:
		"""Keep the server's git identity although HOME points into the site."""
		gitconfig = os.path.join(self._real_home, ".gitconfig")
		return {"GIT_CONFIG_GLOBAL": gitconfig} if os.path.exists(gitconfig) else {}

	def _private_dir(self, *parts: str) -> str:
		os.makedirs(self._data_dir, mode=0o700, exist_ok=True)
		os.chmod(self._data_dir, 0o700)
		path = os.path.join(self._data_dir, *parts)
		os.makedirs(path, mode=0o700, exist_ok=True)
		return path

	def _profile(self, user: str) -> AiProfile:
		slug = re.sub(r"[^a-z0-9]+", "-", user.lower()).strip("-")[:40]
		digest = hashlib.sha1(user.encode()).hexdigest()[:8]
		root = self._private_dir("profiles", f"{slug}-{digest}")
		return AiProfile(root=root, tools_home=self.tools_home, real_home=self._real_home)

	def _shim_dir(self) -> str:
		"""Browser shims that forward URLs to the studio page (see open_url.py)."""
		shim_dir = self._private_dir("shims")
		content = (
			"#!/bin/sh\n"
			f'exec {shlex.quote(self._config.python)} -m mobility_developer_tools.studio.ai_tools.open_url "$@"\n'
		)
		for name in BROWSER_SHIMS:
			path = os.path.join(shim_dir, name)
			current = open(path).read() if os.path.exists(path) else None
			if current != content:
				with open(path, "w") as f:
					f.write(content)
				os.chmod(path, 0o700)
		return shim_dir
