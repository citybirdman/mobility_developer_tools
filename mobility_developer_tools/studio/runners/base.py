import os
import shlex
from abc import ABC, abstractmethod
from dataclasses import dataclass


@dataclass(frozen=True)
class RunContext:
	python: str  # bench env python
	bench_path: str
	sites_path: str
	site: str
	user: str


class ScriptRunner(ABC):
	"""A way to execute a file. Every runner returns a shell command string that the
	studio sends to an interactive terminal (like VS Code's "Run File")."""

	key: str = ""
	label: str = ""
	extensions: tuple[str, ...] = ()

	def supports(self, path: str) -> bool:
		return os.path.splitext(path)[1].lower() in self.extensions

	@abstractmethod
	def build_args(self, abs_path: str, ctx: RunContext) -> list[str]:
		"""argv of the command that runs ``abs_path``."""

	def build_command(self, abs_path: str, ctx: RunContext) -> str:
		return shlex.join(self.build_args(abs_path, ctx))
