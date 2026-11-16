"""Web-side terminal management. Talks to PTY host processes only through the
key/value store (see protocol.py); never touches the pty directly, so it works
from any web worker."""

from __future__ import annotations

import os
import time

import frappe
from frappe import _

from mobility_developer_tools.studio.config import StudioConfig
from mobility_developer_tools.studio.kv import KeyValueStore
from mobility_developer_tools.studio.terminal import protocol as P
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.studio.terminal.spawner import ProcessSpawner

MAX_INPUT_CHARS = 64 * 1024


class TerminalManager:
	def __init__(self, store: KeyValueStore, config: StudioConfig, spawner: ProcessSpawner, site: str):
		self._store = store
		self._config = config
		self._spawner = spawner
		self._site = site

	def create(
		self, user: str, cwd: str, cols: int = 120, rows: int = 30, launch: LaunchSpec | None = None
	) -> dict:
		active = self.list_for(user)
		if len(active) >= self._config.max_terminals:
			frappe.throw(_("You can open at most {0} terminals").format(self._config.max_terminals))

		launch = launch or LaunchSpec()
		term_id = frappe.generate_hash(length=16)
		meta = {
			"id": term_id,
			"user": user,
			"cwd": cwd,
			"title": launch.title or os.path.basename(self._config.shell),
			"kind": launch.kind,
			"created": time.time(),
			"status": "starting",
		}
		self._store.set_json(P.meta_key(term_id), meta, ttl=P.META_TTL)
		self._store.set_json(P.alive_key(term_id), 1, ttl=self._config.terminal_idle_seconds)
		self._store.add_member(P.user_terms_key(user), term_id)

		self._spawner.spawn(
			[
				self._config.python,
				"-m",
				"mobility_developer_tools.studio.terminal.host",
				"--site", self._site,
				"--sites-path", self._config.sites_path,
				"--id", term_id,
				"--user", user,
				"--cwd", cwd,
				"--shell", self._config.shell,
				"--bench-path", self._config.bench_path,
				"--cols", str(int(cols or 120)),
				"--rows", str(int(rows or 30)),
				"--idle", str(self._config.terminal_idle_seconds),
				"--spec", launch.encode(),
			],
			cwd=self._config.sites_path,
			log_path=os.path.join(self._config.bench_path, "logs", "developer_studio_terminal.log"),
		)
		return meta

	def list_for(self, user: str) -> list[dict]:
		terminals = []
		for term_id in self._store.members(P.user_terms_key(user)):
			meta = self._store.get_json(P.meta_key(term_id))
			if not meta or meta.get("status") == "exited":
				self._store.remove_member(P.user_terms_key(user), term_id)
				continue
			terminals.append(meta)
		return sorted(terminals, key=lambda m: m.get("created", 0))

	def send_input(self, user: str, term_id: str, data: str) -> None:
		self._owned(user, term_id)
		if len(data or "") > MAX_INPUT_CHARS:
			frappe.throw(_("Input too large"))
		self._store.push(P.input_key(term_id), {"type": "input", "data": data}, ttl=300)
		self._touch(term_id)

	def resize(self, user: str, term_id: str, cols: int, rows: int) -> None:
		self._owned(user, term_id)
		self._store.push(P.input_key(term_id), {"type": "resize", "cols": int(cols), "rows": int(rows)}, ttl=300)

	def close(self, user: str, term_id: str) -> None:
		self._owned(user, term_id)
		self._store.push(P.input_key(term_id), {"type": "close"}, ttl=300)

	def read(self, user: str, term_id: str, after_seq: int = 0) -> dict:
		"""Backlog for re-attaching or when socket.io is unavailable (polling)."""
		meta = self._owned(user, term_id, allow_exited=True)
		self._touch(term_id)
		chunks = [c for c in self._store.range(P.output_key(term_id)) if c["seq"] > int(after_seq or 0)]
		return {"chunks": chunks, "status": meta.get("status"), "exit_code": meta.get("exit_code")}

	def keepalive(self, user: str, term_ids: list[str]) -> list[str]:
		"""Refresh idle timers; returns ids that are still alive."""
		alive = []
		for term_id in term_ids or []:
			meta = self._store.get_json(P.meta_key(term_id))
			if meta and meta.get("user") == user and meta.get("status") != "exited":
				self._touch(term_id)
				alive.append(term_id)
		return alive

	def _touch(self, term_id: str) -> None:
		self._store.set_json(P.alive_key(term_id), 1, ttl=self._config.terminal_idle_seconds)

	def _owned(self, user: str, term_id: str, allow_exited: bool = False) -> dict:
		meta = self._store.get_json(P.meta_key(term_id))
		if not meta or meta.get("user") != user:
			raise frappe.PermissionError(_("Terminal not found"))
		if meta.get("status") == "exited" and not allow_exited:
			frappe.throw(_("Terminal has exited"))
		return meta
