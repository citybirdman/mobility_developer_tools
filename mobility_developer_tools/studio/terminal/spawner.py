import os
import subprocess
from typing import Protocol


class ProcessSpawner(Protocol):
	def spawn(self, argv: list[str], cwd: str, log_path: str) -> None: ...


class DetachedProcessSpawner:
	"""Starts a fully detached background process (double fork through sh), so it
	is not a child of the web worker: no zombies and it survives worker restarts."""

	def spawn(self, argv, cwd, log_path):
		os.makedirs(os.path.dirname(log_path), exist_ok=True)
		env = dict(os.environ, MDT_LOG=log_path)
		subprocess.Popen(
			["/bin/sh", "-c", '"$@" </dev/null >>"$MDT_LOG" 2>&1 &', "sh", *argv],
			cwd=cwd,
			env=env,
			stdin=subprocess.DEVNULL,
			stdout=subprocess.DEVNULL,
			stderr=subprocess.DEVNULL,
			start_new_session=True,
			close_fds=True,
		).wait(timeout=10)
