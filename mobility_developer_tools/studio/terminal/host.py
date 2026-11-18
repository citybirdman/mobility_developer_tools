"""PTY host: one detached process per terminal.

    python -m mobility_developer_tools.studio.terminal.host --site S --sites-path P \
        --id ID --user U --cwd DIR --shell /bin/bash --bench-path B --cols 120 --rows 30 --idle 3600

* forks a login shell on a pseudo terminal
* reads input/resize/close messages from a redis list (BLPOP)
* pushes output to the browser (socket.io) and keeps a short backlog in redis
* exits when the shell exits, on close, or when no client kept it alive for --idle seconds
"""

import argparse
import codecs
import fcntl
import os
import pty
import pwd
import select
import signal
import struct
import sys
import termios
import threading
import time

from mobility_developer_tools.studio.kv import KeyValueStore
from mobility_developer_tools.studio.terminal import protocol as P
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.studio.terminal.publisher import OutputPublisher

FLUSH_INTERVAL = 0.015
FLUSH_BYTES = 32 * 1024
IDLE_WAIT = 0.05  # select timeout when nothing is pending


class PtyTerminalHost:
	def __init__(
		self,
		term_id: str,
		store: KeyValueStore,
		publisher: OutputPublisher,
		argv: list[str],
		cwd: str,
		env: dict,
		cols: int,
		rows: int,
		backlog_ttl: int,
	):
		self.term_id = term_id
		self.store = store
		self.publisher = publisher
		self.argv = argv
		self.cwd = cwd
		self.env = env
		self.cols, self.rows = cols, rows
		self.backlog_ttl = backlog_ttl
		self.stop = threading.Event()
		self.seq = 0
		self.pid = None
		self.fd = None
		self.exit_code = None

	# -- lifecycle ----------------------------------------------------------

	def run(self) -> None:
		pid, fd = pty.fork()
		if pid == 0:  # child: become the shell / program
			try:
				os.chdir(self.cwd)
			except OSError:
				pass
			try:
				os.execvpe(self.argv[0], self.argv, self.env)
			except OSError as e:
				os.write(1, f"\r\nCould not start {self.argv[0]}: {e}\r\n".encode())
				time.sleep(3)
				os._exit(127)

		self.pid, self.fd = pid, fd
		self._resize(self.cols, self.rows)
		self._update_meta(status="running")

		threading.Thread(target=self._input_loop, daemon=True).start()
		try:
			self._output_loop()
		finally:
			self._shutdown()

	def _shutdown(self) -> None:
		self.stop.set()
		self._kill_shell()
		self.publisher.exited(self.term_id, self.exit_code)
		self._update_meta(status="exited", ttl=60)
		meta = self.store.get_json(P.meta_key(self.term_id)) or {}
		if meta.get("user"):
			self.store.remove_member(P.user_terms_key(meta["user"]), self.term_id)
		self.store.delete(P.input_key(self.term_id), P.alive_key(self.term_id))
		try:
			os.close(self.fd)
		except OSError:
			pass

	# -- output -------------------------------------------------------------

	def _output_loop(self) -> None:
		decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
		pending = bytearray()
		first_at = 0.0
		last_heartbeat = 0.0

		while not self.stop.is_set():
			# with output pending, only wait for the rest of the batching window (keeps typing snappy)
			wait = max(0.0, FLUSH_INTERVAL - (time.monotonic() - first_at)) if pending else IDLE_WAIT
			readable, _, _ = select.select([self.fd], [], [], wait)
			if readable:
				try:
					chunk = os.read(self.fd, 65536)
				except OSError:  # EIO: shell closed the pty
					chunk = b""
				if not chunk:
					break
				if not pending:
					first_at = time.monotonic()
				pending += chunk

			if pending and (
				len(pending) >= FLUSH_BYTES or not readable or time.monotonic() - first_at >= FLUSH_INTERVAL
			):
				self._emit(decoder.decode(bytes(pending)))
				pending.clear()

			now = time.monotonic()
			if now - last_heartbeat >= P.HEARTBEAT_SECONDS:
				last_heartbeat = now
				if self._shell_exited():
					break
				if not self.store.exists(P.alive_key(self.term_id)):
					self._emit("\r\n\x1b[33m[terminal closed after being idle]\x1b[0m\r\n")
					break
				self._update_meta(status="running")

		if pending:
			self._emit(decoder.decode(bytes(pending), final=True))

	def _emit(self, data: str) -> None:
		if not data:
			return
		self.seq += 1
		self.store.push(
			P.output_key(self.term_id),
			{"seq": self.seq, "data": data},
			max_len=P.BACKLOG_MAX_CHUNKS,
			ttl=self.backlog_ttl,
		)
		self.publisher.output(self.term_id, self.seq, data)

	# -- input --------------------------------------------------------------

	def _input_loop(self) -> None:
		while not self.stop.is_set():
			try:
				msg = self.store.pop_blocking(P.input_key(self.term_id), timeout=2)
			except Exception:
				time.sleep(1)
				continue
			if not msg:
				continue

			kind = msg.get("type")
			if kind == "input":
				self._write(msg.get("data", "").encode())
			elif kind == "resize":
				self._resize(int(msg.get("cols") or 80), int(msg.get("rows") or 24))
			elif kind == "close":
				self.stop.set()

	def _write(self, data: bytes) -> None:
		while data:
			try:
				written = os.write(self.fd, data)
			except OSError:
				return
			data = data[written:]

	def _resize(self, cols: int, rows: int) -> None:
		cols, rows = max(cols, 2), max(rows, 1)
		try:
			fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
		except OSError:
			pass

	# -- process ------------------------------------------------------------

	def _shell_exited(self) -> bool:
		if self.exit_code is not None:
			return True
		try:
			pid, status = os.waitpid(self.pid, os.WNOHANG)
		except ChildProcessError:
			self.exit_code = -1
			return True
		if pid:
			self.exit_code = os.waitstatus_to_exitcode(status)
			return True
		return False

	def _kill_shell(self) -> None:
		if self._shell_exited():
			return
		for sig in (signal.SIGHUP, signal.SIGTERM, signal.SIGKILL):
			try:
				os.killpg(self.pid, sig)
			except ProcessLookupError:
				break
			for _ in range(10):
				time.sleep(0.1)
				if self._shell_exited():
					return

	def _update_meta(self, status: str, ttl: int = P.META_TTL) -> None:
		key = P.meta_key(self.term_id)
		meta = self.store.get_json(key) or {}
		meta.update({"status": status, "host_pid": os.getpid(), "exit_code": self.exit_code})
		self.store.set_json(key, meta, ttl=ttl)


def build_env(shell: str, bench_path: str, launch: LaunchSpec) -> dict:
	env = build_shell_env(shell, bench_path)
	env.update(launch.env or {})
	if launch.path_prepend:
		env["PATH"] = ":".join([*launch.path_prepend, env["PATH"]])
	return env


def build_shell_env(shell: str, bench_path: str) -> dict:
	env = {k: v for k, v in os.environ.items() if not k.startswith(("MDT_", "GUNICORN", "SERVER_"))}
	account = pwd.getpwuid(os.getuid())
	env.update(
		{
			"HOME": env.get("HOME") or account.pw_dir,
			"USER": account.pw_name,
			"LOGNAME": account.pw_name,
			"SHELL": shell,
			"TERM": "xterm-256color",
			"COLORTERM": "truecolor",
			"LANG": env.get("LANG") or "C.UTF-8",
		}
	)
	if not env.get("HOME") or env["HOME"] == "/":
		env["HOME"] = account.pw_dir
	path = env.get("PATH") or "/usr/local/bin:/usr/bin:/bin"
	env_bin = os.path.join(bench_path, "env", "bin")
	env["PATH"] = f"{env_bin}:{path}" if os.path.isdir(env_bin) else path
	return env


def main() -> int:
	parser = argparse.ArgumentParser()
	for arg in ("--site", "--sites-path", "--id", "--user", "--cwd", "--shell", "--bench-path"):
		parser.add_argument(arg, required=True)
	parser.add_argument("--cols", type=int, default=120)
	parser.add_argument("--rows", type=int, default=30)
	parser.add_argument("--idle", type=int, default=3600)
	parser.add_argument("--spec", default="")
	args = parser.parse_args()
	launch = LaunchSpec.decode(args.spec)
	if launch.kind != "shell":
		launch.env["MDT_TERM_ID"] = args.id

	import frappe

	from mobility_developer_tools.studio.kv import RedisKeyValueStore
	from mobility_developer_tools.studio.terminal.publisher import RealtimePublisher

	os.chdir(args.sites_path)
	frappe.init(site=args.site, sites_path=args.sites_path)

	host = PtyTerminalHost(
		term_id=args.id,
		store=RedisKeyValueStore.for_site(frappe.conf, args.site),
		publisher=RealtimePublisher(args.user),
		argv=launch.argv or [args.shell, "-l"],
		cwd=args.cwd,
		env=build_env(args.shell, args.bench_path, launch),
		cols=args.cols,
		rows=args.rows,
		backlog_ttl=args.idle + 600,
	)
	signal.signal(signal.SIGTERM, lambda *_: host.stop.set())
	host.run()
	frappe.destroy()
	return 0


if __name__ == "__main__":
	sys.exit(main())
