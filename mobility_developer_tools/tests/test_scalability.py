"""Scalability: many terminals, many users, large output, bursts and long-running cleanup,
with real PTY host processes and Redis. ~30 s. Skip with:  tests.runner --quick
"""

from __future__ import annotations

import concurrent.futures
import os
import re
import subprocess
import sys
import time

import frappe

from mobility_developer_tools.studio.kv import RedisKeyValueStore
from mobility_developer_tools.studio.terminal import protocol as P
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.studio.terminal.manager import TerminalManager
from mobility_developer_tools.studio.terminal.spawner import DetachedProcessSpawner
from mobility_developer_tools.tests.base import StudioTestCase

USER = "stress.tester@example.com"  # terminals are namespaced per user; no real account needed
ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07")


class TerminalStressCase(StudioTestCase):
	max_terminals = 5
	idle_seconds = 120

	def setUp(self):
		self.store = RedisKeyValueStore.for_site(frappe.conf, frappe.local.site)
		self.manager = TerminalManager(
			self.store,
			self.config(max_terminals=self.max_terminals, terminal_idle_seconds=self.idle_seconds),
			DetachedProcessSpawner(),
			frappe.local.site,
		)
		self.addCleanup(self.close_all)

	def close_all(self):
		"""Close every terminal of the test user and wait until the hosts are gone."""
		ids = [meta["id"] for meta in self.manager.list_for(USER)]
		for term_id in ids:
			try:
				self.manager.close(USER, term_id)
			except Exception:
				pass
		deadline = time.monotonic() + 20
		while self.manager.list_for(USER) and time.monotonic() < deadline:
			time.sleep(0.25)

	def in_thread(self, fn):
		"""frappe.local is per thread: give worker threads their own Frappe context."""
		site, sites_path = frappe.local.site, frappe.local.sites_path

		def run(*args):
			frappe.init(site=site, sites_path=sites_path)
			try:
				return fn(*args)
			finally:
				frappe.destroy()

		return run

	def program(self, code: str, title="stress") -> dict:
		spec = LaunchSpec(argv=[sys.executable, "-u", "-c", code], title=title, kind="bench")
		return self.manager.create(USER, "/tmp", 120, 30, launch=spec)

	def wait_exit(self, term_id, timeout=90) -> dict:
		deadline = time.monotonic() + timeout
		while time.monotonic() < deadline:
			result = self.manager.read(USER, term_id)
			if result["status"] == "exited":
				return result
			time.sleep(0.25)
		self.fail(f"terminal {term_id} did not exit within {timeout}s")

	def host_alive(self, term_id) -> bool:
		out = subprocess.run(["pgrep", "-f", f"terminal.host .*--id {term_id}"], capture_output=True, text=True)
		return bool(out.stdout.strip())


class TestTerminalThroughput(TerminalStressCase):
	def test_large_output_is_ordered_capped_and_host_survives(self):
		lines = 200_000  # ~20 MB through the pty
		started = time.monotonic()
		term = self.program(
			f"import sys\nfor i in range({lines}): sys.stdout.write(f'{{i:08d}} ' + 'x' * 90 + '\\n')\nprint('DONE-MARKER')"
		)
		result = self.wait_exit(term["id"])
		elapsed = time.monotonic() - started

		seqs = [c["seq"] for c in result["chunks"]]
		self.assertLessEqual(len(seqs), P.BACKLOG_MAX_CHUNKS)
		self.assertEqual(seqs, list(range(seqs[0], seqs[0] + len(seqs))), "backlog has gaps or is out of order")
		tail = "".join(c["data"] for c in result["chunks"][-20:])
		self.assertIn(f"{lines - 1:08d}", tail)
		self.assertIn("DONE-MARKER", tail)
		self.assertEqual(result["exit_code"], 0)
		time.sleep(1)
		self.assertFalse(self.host_alive(term["id"]), "host process leaked")
		print(f"\n    throughput: {lines * 100 / 1e6:.0f} MB in {elapsed:.1f}s ({lines * 100 / 1e6 / elapsed:.1f} MB/s)")

	def test_rapid_input_keeps_order(self):
		count = 300
		term = self.program(
			"import sys\nfor line in sys.stdin:\n    line = line.strip()\n    print('ECHO', line, flush=True)\n"
			"    if line == 'end': break"
		)
		time.sleep(1.0)
		for i in range(count):
			self.manager.send_input(USER, term["id"], f"{i}\r")
		self.manager.send_input(USER, term["id"], "end\r")
		result = self.wait_exit(term["id"], timeout=60)
		text = ANSI.sub("", "".join(c["data"] for c in result["chunks"]))
		echoed = [int(m) for m in re.findall(r"ECHO (\d+)", text)]
		self.assertEqual(echoed, list(range(count)), "input reordered or lost")


class TestTerminalConcurrency(TerminalStressCase):
	def test_parallel_terminals_limit_and_cleanup(self):
		code = "import time, os\ntime.sleep(1.5)\nprint('FINISHED', os.getpid())"

		def start(_):
			try:
				return self.program(code)
			except frappe.ValidationError:
				return None

		with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
			created = [t for t in pool.map(self.in_thread(start), range(8)) if t]
		# reserve-then-count: a burst of 8 parallel requests never exceeds the limit
		self.assertLessEqual(len(created), self.max_terminals)
		self.assertGreaterEqual(len(created), 1)
		# after the burst, the limit is still exactly max_terminals
		while len(created) < self.max_terminals:
			created.append(self.program(code))
		with self.assertRaises(frappe.ValidationError):
			self.program(code)

		for term in created:
			result = self.wait_exit(term["id"], timeout=60)
			self.assertIn("FINISHED", "".join(c["data"] for c in result["chunks"]))
		time.sleep(1)
		self.assertEqual(self.manager.list_for(USER), [])
		for term in created:
			self.assertFalse(self.host_alive(term["id"]))
			self.assertFalse(self.store.exists(P.input_key(term["id"])))
			self.assertFalse(self.store.exists(P.alive_key(term["id"])))

	def test_reading_a_finished_terminal_does_not_revive_it(self):
		term = self.program("print('bye')")
		self.wait_exit(term["id"], timeout=30)
		for _ in range(3):
			self.manager.read(USER, term["id"])
		self.assertFalse(self.store.exists(P.alive_key(term["id"])))

	def test_open_close_cycles_do_not_leak(self):
		for _ in range(10):
			term = self.program("import time\ntime.sleep(30)")
			time.sleep(0.6)
			self.manager.close(USER, term["id"])
			self.wait_exit(term["id"], timeout=20)
		time.sleep(1)
		leftovers = subprocess.run(["pgrep", "-fc", "time.sleep\\(30\\)"], capture_output=True, text=True).stdout.strip()
		self.assertEqual(leftovers, "0", "shell/program processes survived close()")


class TestTerminalIdleTimeout(TerminalStressCase):
	idle_seconds = 3

	def test_abandoned_terminal_is_stopped(self):
		term = self.program("import time\ntime.sleep(300)")
		# watch Redis directly: manager.read() would count as an attached client and keep it alive
		deadline = time.monotonic() + P.HEARTBEAT_SECONDS * 2 + self.idle_seconds + 10
		while time.monotonic() < deadline:
			meta = self.store.get_json(P.meta_key(term["id"])) or {}
			if meta.get("status") == "exited":
				break
			time.sleep(0.5)
		else:
			self.fail("abandoned terminal was not stopped")
		output = "".join(c["data"] for c in self.store.range(P.output_key(term["id"])))
		self.assertIn("idle", output)
		time.sleep(1)
		self.assertFalse(self.host_alive(term["id"]))


class TestManyUsers(TerminalStressCase):
	max_terminals = 3

	def test_users_are_isolated_under_concurrent_load(self):
		users = [f"scale.user{i}@example.com" for i in range(4)]
		code = "import os, sys\nprint('OWNER', os.environ.get('MDT_PROBE', ''), flush=True)\nsys.stdin.readline()"

		def open_terminals(user):
			made = []
			for _ in range(self.max_terminals):
				spec = LaunchSpec(argv=[sys.executable, "-u", "-c", code], env={"MDT_PROBE": user}, title="u", kind="bench")
				made.append(self.manager.create(user, "/tmp", 80, 24, launch=spec))
			with self.assertRaises(frappe.ValidationError):
				self.manager.create(user, "/tmp", 80, 24)
			return user, made

		with concurrent.futures.ThreadPoolExecutor(max_workers=len(users)) as pool:
			results = list(pool.map(self.in_thread(open_terminals), users))
		try:
			time.sleep(2)
			for user, made in results:
				self.assertEqual({m["id"] for m in self.manager.list_for(user)}, {m["id"] for m in made})
				for term in made:
					out = "".join(c["data"] for c in self.manager.read(user, term["id"])["chunks"])
					self.assertIn(f"OWNER {user}", out)  # every terminal runs for its own user
					stranger = users[(users.index(user) + 1) % len(users)]
					with self.assertRaises(frappe.PermissionError):
						self.manager.send_input(stranger, term["id"], "x")
		finally:
			for user, made in results:
				for term in made:
					self.manager.close(user, term["id"])
			deadline = time.monotonic() + 20
			while any(self.manager.list_for(u) for u in users) and time.monotonic() < deadline:
				time.sleep(0.25)
		for user in users:
			self.assertEqual(self.manager.list_for(user), [])


class TestConcurrentWatchers(StudioTestCase):
	"""Many open studio pages polling for changes at the same time."""

	def test_parallel_polls_stay_correct(self):
		import tempfile

		from mobility_developer_tools.studio.files.path_guard import PathGuard
		from mobility_developer_tools.studio.files.service import LocalFileService
		from mobility_developer_tools.studio.files.watch import FileChangeDetector

		root = tempfile.mkdtemp(prefix="mdt-watch-")
		self.addCleanup(__import__("shutil").rmtree, root, ignore_errors=True)
		for i in range(200):
			with open(os.path.join(root, f"f{i}.txt"), "w") as f:
				f.write(str(i))
		guard = PathGuard(root)
		detector = FileChangeDetector(guard, LocalFileService(guard))
		files = [f"f{i}.txt" for i in range(200)]

		def poll(_):
			result = detector.snapshot(files, [""])
			return all(result["files"][p]["exists"] for p in files)

		started = time.monotonic()
		with concurrent.futures.ThreadPoolExecutor(max_workers=32) as pool:
			outcomes = list(pool.map(poll, range(320)))  # 32 pages x 10 polls, 200 files each
		elapsed = time.monotonic() - started
		self.assertTrue(all(outcomes))
		print(f"\n    320 polls x 200 files from 32 threads: {elapsed:.2f}s ({320 / elapsed:.0f} polls/s)")
		self.assertLess(elapsed, 30)


class TestExtensionScale(StudioTestCase):
	"""Many installed extensions, huge icon themes, concurrent icon loading."""

	def setUp(self):
		import base64
		import shutil
		import tempfile

		from mobility_developer_tools.studio.extensions.checker import CompatibilityChecker
		from mobility_developer_tools.studio.extensions.openvsx import OpenVsxClient
		from mobility_developer_tools.studio.extensions.service import ExtensionService
		from mobility_developer_tools.studio.extensions.store import ExtensionStore
		from mobility_developer_tools.tests.vsix_factory import make_vsix

		self.root = tempfile.mkdtemp(prefix="mdt-ext-scale-")
		self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
		self.store = ExtensionStore(self.root)
		self.service = ExtensionService(self.store, OpenVsxClient(lambda *a: b"{}"), CompatibilityChecker())
		self.b64 = lambda data: base64.b64encode(data).decode()
		self.make_vsix = make_vsix

	def big_icon_theme(self, name="icons", count=5000):
		files = {f"icons/i{i}.svg": f"<svg id='{i}'/>" for i in range(count)}
		files["icons/theme.json"] = {
			"iconDefinitions": {f"d{i}": {"iconPath": f"./i{i}.svg"} for i in range(count)},
			"file": "d0",
			"folder": "d1",
			"fileExtensions": {f"ext{i}": f"d{i}" for i in range(count)},
		}
		return self.make_vsix(files, {"name": name, "contributes": {"iconThemes": [{"id": "big", "label": "Big", "path": "./icons/theme.json"}]}})

	def test_many_extensions(self):
		from mobility_developer_tools.tests.vsix_factory import theme_package, web_package

		started = time.monotonic()
		for i in range(25):
			data = theme_package(name=f"theme{i}") if i % 2 else web_package("v.window.showInformationMessage('x')", name=f"web{i}")
			self.service.install_upload(self.b64(data))
		install_time = time.monotonic() - started
		self.assertEqual(len(self.store.ids()), 25)
		self.assertEqual(len(self.service.installed()), 25)
		self.assertEqual(len(self.service.runtime()), 25)
		for ext_id in self.store.ids()[:10]:
			self.service.set_enabled(ext_id, False)
		self.assertEqual(len(self.service.runtime()), 15)
		print(f"\n    25 extensions installed in {install_time:.2f}s")

	def test_huge_icon_theme_and_concurrent_icon_loading(self):
		started = time.monotonic()
		report = self.service.install_upload(self.b64(self.big_icon_theme()))
		print(f"\n    icon theme with 5,000 icons installed in {time.monotonic() - started:.2f}s ({report['verdict']})")
		ext_id = report["id"]
		theme = json_load(self.store.read_files(ext_id, [".studio/icon-theme-0.json"])[".studio/icon-theme-0.json"])
		self.assertEqual(len(theme["definitions"]), 5000)

		def load(batch):
			paths = [f"icons/i{i}.svg" for i in range(batch * 150, batch * 150 + 150)]
			files = self.store.read_files(ext_id, paths, "base64")
			return all(files[p] for p in paths)

		with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
			self.assertTrue(all(pool.map(load, range(33))))  # 4,950 icons from 16 threads


def json_load(text):
	import json

	return json.loads(text)
