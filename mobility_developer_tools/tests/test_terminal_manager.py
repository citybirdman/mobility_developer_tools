"""Terminal manager rules with fakes: ownership, limits, input size, launch arguments."""

import frappe

from mobility_developer_tools.studio.terminal import protocol as P
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.studio.terminal.manager import MAX_INPUT_CHARS, TerminalManager
from mobility_developer_tools.tests.base import StudioTestCase
from mobility_developer_tools.tests.fakes import InMemoryStore, RecordingSpawner

OWNER, OTHER = "owner@example.com", "other@example.com"


class TestTerminalManager(StudioTestCase):
	def setUp(self):
		self.store = InMemoryStore()
		self.spawner = RecordingSpawner()
		self.manager = TerminalManager(self.store, self.config(max_terminals=3), self.spawner, "site-a.local")

	def create(self, user=OWNER, launch=None):
		return self.manager.create(user, "/tmp", 80, 24, launch=launch)

	def test_other_users_cannot_touch_a_terminal(self):
		term = self.create()
		for op in (
			lambda: self.manager.send_input(OTHER, term["id"], "id\r"),
			lambda: self.manager.resize(OTHER, term["id"], 10, 10),
			lambda: self.manager.read(OTHER, term["id"]),
			lambda: self.manager.close(OTHER, term["id"]),
		):
			with self.assertRaises(frappe.PermissionError):
				op()
		self.assertEqual(self.manager.keepalive(OTHER, [term["id"]]), [])
		self.assertEqual(self.manager.list_for(OTHER), [])
		self.assertEqual(self.store.range(P.input_key(term["id"])), [])

	def test_unknown_terminal(self):
		with self.assertRaises(frappe.PermissionError):
			self.manager.send_input(OWNER, "does-not-exist", "x")

	def test_terminal_limit_per_user(self):
		for _ in range(3):
			self.create()
		with self.assertRaises(frappe.ValidationError):
			self.create()
		self.create(user=OTHER)  # limit is per user

	def test_input_size_limit(self):
		term = self.create()
		self.manager.send_input(OWNER, term["id"], "x" * MAX_INPUT_CHARS)
		with self.assertRaises(frappe.ValidationError):
			self.manager.send_input(OWNER, term["id"], "x" * (MAX_INPUT_CHARS + 1))

	def test_inputs_keep_order(self):
		term = self.create()
		for i in range(200):
			self.manager.send_input(OWNER, term["id"], f"{i}\r")
		received = [self.store.pop_blocking(P.input_key(term["id"]), 1)["data"] for _ in range(200)]
		self.assertEqual(received, [f"{i}\r" for i in range(200)])

	def test_exited_terminal_rejects_input_but_keeps_backlog(self):
		term = self.create()
		meta = self.store.get_json(P.meta_key(term["id"]))
		self.store.set_json(P.meta_key(term["id"]), {**meta, "status": "exited"})
		with self.assertRaises(frappe.ValidationError):
			self.manager.send_input(OWNER, term["id"], "x")
		self.assertEqual(self.manager.read(OWNER, term["id"])["status"], "exited")
		self.assertEqual(self.manager.list_for(OWNER), [])

	def test_launch_spec_reaches_the_host(self):
		spec = LaunchSpec(argv=["/bin/echo", "hi"], env={"A": "1"}, title="Echo", kind="bench")
		term = self.create(launch=spec)
		self.assertEqual((term["title"], term["kind"]), ("Echo", "bench"))
		argv = self.spawner.calls[-1]["argv"]
		self.assertEqual(LaunchSpec.decode(argv[argv.index("--spec") + 1]), spec)
		self.assertEqual(argv[argv.index("--site") + 1], "site-a.local")
