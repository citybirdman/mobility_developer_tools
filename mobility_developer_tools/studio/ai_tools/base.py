import os
import shutil
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class AiProfile:
	"""Private folder of one Frappe user on one site: sign-ins are never shared
	between users or sites even though every tool runs as the same Linux user."""

	root: str  # <site>/private/mobility_developer_tools/profiles/<user-slug>
	tools_home: str  # <site>/private/mobility_developer_tools/tools-home (installed CLIs)
	real_home: str

	def dir(self, *parts: str) -> str:
		path = os.path.join(self.root, *parts)
		os.makedirs(path, mode=0o700, exist_ok=True)
		return path


@dataclass(frozen=True)
class ToolContext:
	"""Everything a tool needs to build its command line and environment."""

	site: str
	user: str
	profile: AiProfile


class AiTool(ABC):
	"""A CLI (e.g. an AI assistant) that runs inside a studio terminal."""

	key: str = ""
	label: str = ""
	icon: str = "sparkle"  # codicon name
	category: str = "ai"  # group heading in the Tools panel
	binary: str = ""
	install_command: str = ""
	docs_url: str = ""
	sign_in_hint: str = ""

	def find_binary(self, search_path: str) -> str | None:
		return shutil.which(self.binary, path=search_path)

	def version(self, binary: str, env: dict) -> str | None:
		try:
			out = subprocess.run(
				[binary, "--version"], capture_output=True, text=True, timeout=15, env=env, stdin=subprocess.DEVNULL
			)
		except (OSError, subprocess.SubprocessError):
			return None
		text = (out.stdout or out.stderr or "").strip().splitlines()
		return text[0][:80] if text else None

	def argv(self, binary: str, ctx: ToolContext) -> list[str]:
		return [binary]

	@abstractmethod
	def env(self, ctx: ToolContext) -> dict[str, str]:
		"""Environment for this tool, pointing its config/credentials into the user's profile."""
