"""Performance budgets. Each test measures one user-visible operation, prints the
numbers and fails if it exceeds a budget. Budgets are generous on purpose (shared
dev servers are noisy); a failure means a real regression, not jitter.

Skip with:  tests.runner --quick
"""

from __future__ import annotations

import concurrent.futures
import os
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from unittest.mock import patch

import frappe

from mobility_developer_tools.studio.files.path_guard import PathGuard
from mobility_developer_tools.studio.files.service import LocalFileService
from mobility_developer_tools.studio.files.watch import FileChangeDetector
from mobility_developer_tools.studio.kv import RedisKeyValueStore
from mobility_developer_tools.studio.terminal import protocol as P
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.studio.terminal.manager import TerminalManager
from mobility_developer_tools.studio.terminal.spawner import DetachedProcessSpawner
from mobility_developer_tools.tests.base import StudioTestCase

USER = "perf.tester@example.com"


def measure(fn, runs: int) -> dict:
	samples = []
	for _ in range(runs):
		started = time.perf_counter()
		fn()
		samples.append(time.perf_counter() - started)
	samples.sort()
	return {
		"median": statistics.median(samples),
		"p95": samples[max(int(len(samples) * 0.95) - 1, 0)],
		"max": samples[-1],
	}


def report(name: str, stats: dict, budget: float, key: str = "p95"):
	print(
		f"\n    {name}: median {stats['median'] * 1000:.1f} ms, p95 {stats['p95'] * 1000:.1f} ms, "
		f"max {stats['max'] * 1000:.1f} ms  (budget {key} < {budget * 1000:.0f} ms)"
	)


class TestFilePerformance(StudioTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		cls.root = tempfile.mkdtemp(prefix="mdt-perf-")
		os.makedirs(os.path.join(cls.root, "big"))
		for i in range(5000):
			open(os.path.join(cls.root, "big", f"file_{i:05d}.py"), "w").close()
		for i in range(50):
			os.makedirs(os.path.join(cls.root, "dirs", f"d{i}"))
			with open(os.path.join(cls.root, "dirs", f"d{i}", "x.py"), "w") as f:
				f.write("x = 1\n")
		with open(os.path.join(cls.root, "large.py"), "w") as f:
			f.write("# " + "x" * 78 + "\n" * 1 + ("value = 'abcdefghijklmnopqrstuvwxyz'\n" * 110_000))  # ~4 MB
		guard = PathGuard(cls.root)
		cls.files = LocalFileService(guard)
		cls.detector = FileChangeDetector(guard, cls.files)

	@classmethod
	def tearDownClass(cls):
		shutil.rmtree(cls.root, ignore_errors=True)
		super().tearDownClass()

	def test_change_detection_poll(self):
		files = [f"big/file_{i:05d}.py" for i in range(200)]
		folders = [f"dirs/d{i}" for i in range(50)] + ["", "dirs"]
		stats = measure(lambda: self.detector.snapshot(files, folders), runs=40)
		report("watch poll (200 files + 52 folders)", stats, 0.15)
		self.assertLess(stats["p95"], 0.15)

	def test_list_large_folder(self):
		stats = measure(lambda: self.files.list_dir("big"), runs=10)
		report("list folder with 5,000 entries", stats, 0.5)
		self.assertLess(stats["p95"], 0.5)

	def test_open_and_save_large_file(self):
		read = measure(lambda: self.files.read("large.py"), runs=10)
		report("open 4 MB file", read, 0.3)
		content = self.files.read("large.py")["content"]
		write = measure(lambda: self.files.write("large.py", content), runs=10)
		report("save 4 MB file (atomic)", write, 0.5)
		self.assertLess(read["p95"], 0.3)
		self.assertLess(write["p95"], 0.5)

	def test_quick_open_on_the_bench(self):
		from mobility_developer_tools.studio.container import StudioContainer

		bench_files = LocalFileService(StudioContainer().guard)
		stats = measure(lambda: bench_files.find("hooks"), runs=3)
		report("quick open search over the whole bench", stats, 15, key="max")
		self.assertLess(stats["max"], 15)

	def test_concurrent_file_operations(self):
		from mobility_developer_tools.studio.container import StudioContainer

		bench_files = LocalFileService(StudioContainer().guard)
		operations = [
			lambda: bench_files.list_dir(""),
			lambda: bench_files.list_dir("apps/frappe/frappe"),
			lambda: bench_files.read("apps/frappe/frappe/__init__.py"),
			lambda: bench_files.read("sites/apps.txt"),
		] * 50

		def timed(op):
			started = time.perf_counter()
			op()
			return time.perf_counter() - started

		with concurrent.futures.ThreadPoolExecutor(max_workers=16) as pool:
			samples = sorted(pool.map(timed, operations))
		stats = {"median": statistics.median(samples), "p95": samples[int(len(samples) * 0.95) - 1], "max": samples[-1]}
		report("200 file operations from 16 threads", stats, 1.0)
		self.assertLess(stats["p95"], 1.0)


class TestApiOverhead(StudioTestCase):
	def test_guarded_endpoint_overhead(self):
		"""Role check + token validation (Redis) + path guard, per request."""
		from mobility_developer_tools.studio import api
		from mobility_developer_tools.studio.container import get_container
		from mobility_developer_tools.studio.security.session import StudioSessionService

		frappe.local._mdt_studio_container = None
		c = get_container()
		sessions = StudioSessionService(c.store, c.config, verify_password=lambda u, p: None)
		token = sessions.unlock(frappe.session.user, frappe.session.sid, "x")["token"]
		self.addCleanup(sessions.lock, token)
		with patch.object(api, "_token", return_value=token):
			stats = measure(lambda: api.watch(["sites/apps.txt"], ["sites"]), runs=200)
		report("guarded API call (watch, in-process)", stats, 0.05)
		self.assertLess(stats["p95"], 0.05)


class TestTerminalPerformance(StudioTestCase):
	def setUp(self):
		self.store = RedisKeyValueStore.for_site(frappe.conf, frappe.local.site)
		self.manager = TerminalManager(self.store, self.config(max_terminals=5), DetachedProcessSpawner(), frappe.local.site)

	def start_echo(self):
		code = "import sys\nfor line in sys.stdin:\n    print('ACK', line.strip(), flush=True)"
		term = self.manager.create(USER, "/tmp", 120, 30, launch=LaunchSpec(argv=[sys.executable, "-u", "-c", code], kind="bench"))
		self.addCleanup(self.manager.close, USER, term["id"])
		deadline = time.monotonic() + 15
		while (self.store.get_json(P.meta_key(term["id"])) or {}).get("status") != "running":
			self.assertLess(time.monotonic(), deadline, "terminal did not start")
			time.sleep(0.05)
		return term

	def test_keystroke_round_trip_latency(self):
		"""Input -> Redis -> PTY -> program -> PTY -> backlog, i.e. what a user feels when typing."""
		term = self.start_echo()
		time.sleep(0.5)

		def round_trip(i):
			marker = f"ACK m{i}"
			before = len(self.store.range(P.output_key(term["id"])))
			started = time.perf_counter()
			self.manager.send_input(USER, term["id"], f"m{i}\r")
			while True:
				chunks = self.store.range(P.output_key(term["id"]), before)
				if any(marker in c["data"] for c in chunks):
					return time.perf_counter() - started
				if time.perf_counter() - started > 5:
					self.fail("no echo within 5s")
				time.sleep(0.002)

		samples = sorted(round_trip(i) for i in range(50))
		stats = {"median": statistics.median(samples), "p95": samples[int(len(samples) * 0.95) - 1], "max": samples[-1]}
		report("keystroke round trip", stats, 0.1)
		self.assertLess(stats["median"], 0.04)  # regression guard: was ~51 ms before the batching fix
		self.assertLess(stats["p95"], 0.1)

	def test_terminal_start_time_and_memory(self):
		started = time.perf_counter()
		term = self.start_echo()
		start_time = time.perf_counter() - started
		pid = subprocess.run(["pgrep", "-f", f"terminal.host .*--id {term['id']}"], capture_output=True, text=True).stdout.split()
		self.assertTrue(pid, "host process not found")
		with open(f"/proc/{pid[0]}/status") as f:
			rss_mb = next(int(line.split()[1]) for line in f if line.startswith("VmRSS")) / 1024
		print(f"\n    terminal start: {start_time * 1000:.0f} ms (budget 3000), host memory: {rss_mb:.0f} MB (budget 120)")
		self.assertLess(start_time, 3.0)
		self.assertLess(rss_mb, 120)


class TestExtensionPerformance(StudioTestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		import base64

		from mobility_developer_tools.studio.extensions.checker import CompatibilityChecker
		from mobility_developer_tools.studio.extensions.openvsx import OpenVsxClient
		from mobility_developer_tools.studio.extensions.service import ExtensionService
		from mobility_developer_tools.studio.extensions.store import ExtensionStore
		from mobility_developer_tools.tests.vsix_factory import make_vsix, theme_package

		cls.root = tempfile.mkdtemp(prefix="mdt-ext-perf-")
		cls.store = ExtensionStore(cls.root)
		cls.service = ExtensionService(cls.store, OpenVsxClient(lambda *a: b"{}"), CompatibilityChecker())
		# a large web extension: 3,000 files + 5 MB minified bundle
		code = "var v=require('vscode');" + ";".join(f"v.window.showInformationMessage('m{i}')" for i in range(120_000))
		files = {f"assets/f{i}.svg": "<svg/>" for i in range(3000)}
		files["dist/web.js"] = code
		cls.large = make_vsix(files, {"name": "large", "browser": "./dist/web.js", "contributes": {}})
		for i in range(20):
			cls.service.install_upload(base64.b64encode(theme_package(name=f"t{i}")).decode())
		cls.service.install_upload(base64.b64encode(cls.large).decode())

	@classmethod
	def tearDownClass(cls):
		shutil.rmtree(cls.root, ignore_errors=True)
		super().tearDownClass()

	def test_check_large_extension(self):
		from mobility_developer_tools.studio.extensions.checker import CompatibilityChecker
		from mobility_developer_tools.studio.extensions.vsix import VsixArchive

		stats = measure(lambda: CompatibilityChecker().check(VsixArchive(self.large)), runs=3)
		report(f"check a {len(self.large) // 1024} KB extension (3,000 files, 5 MB code)", stats, 3.0, key="max")
		self.assertLess(stats["max"], 3.0)

	def test_startup_runtime_bundle(self):
		stats = measure(lambda: self.service.runtime(), runs=20)
		report("extensions runtime bundle (21 installed)", stats, 0.3)
		self.assertLess(stats["p95"], 0.3)

	def test_icon_batch(self):
		paths = [f"assets/f{i}.svg" for i in range(150)]
		stats = measure(lambda: self.store.read_files("tester.large", paths, "base64"), runs=20)
		report("load 150 icons (one batch)", stats, 0.2)
		self.assertLess(stats["p95"], 0.2)
