"""Security of everything that builds a command line or handles external input."""

import shlex

from mobility_developer_tools.studio.ai_tools.open_url import redirects_to_local_machine
from mobility_developer_tools.studio.bench.base import BenchContext
from mobility_developer_tools.studio.bench.service import BenchCommandRegistry, BenchService, default_bench_registry
from mobility_developer_tools.studio.exceptions import StudioCommandError
from mobility_developer_tools.studio.runners.base import RunContext
from mobility_developer_tools.studio.runners.registry import default_registry
from mobility_developer_tools.studio.terminal.launch import LaunchSpec
from mobility_developer_tools.tests.base import StudioTestCase

CTX = BenchContext(
	site="site-a.local",
	sites_path="/bench/sites",
	bench_path="/bench",
	python="/bench/env/bin/python",
	bench_cli="/usr/local/bin/bench",
	bench_apps=("frappe", "erpnext", "hrms", "mobility_developer_tools"),
	installed_apps=("frappe", "erpnext", "mobility_developer_tools"),
)


class TestBenchCommands(StudioTestCase):
	def setUp(self):
		self.service = BenchService(default_bench_registry(), CTX)

	def argv(self, key, values=None):
		spec, line = self.service.run_spec(key, values or {})
		return line.argv

	def test_site_commands_always_target_the_current_site_only(self):
		for key, values in (("migrate", {}), ("clear-cache", {}), ("backup", {"with_files": 1}), ("install-app", {"apps": ["hrms"]})):
			with self.subTest(key=key):
				argv = self.argv(key, values)
				self.assertEqual(argv[argv.index("--site") + 1], "site-a.local")
				self.assertEqual(argv.count("--site"), 1)

	def test_expected_command_lines(self):
		self.assertEqual(self.argv("migrate", {"skip_failing": 1})[-2:], ["migrate", "--skip-failing"])
		self.assertEqual(self.argv("install-app", {"apps": ["hrms"]})[-2:], ["install-app", "hrms"])
		self.assertEqual(self.argv("build", {"app": "erpnext"})[-3:], ["build", "--app", "erpnext"])
		self.assertNotIn("--site", self.argv("build", {"app": "All apps"}))
		self.assertEqual(
			self.argv("get-app", {"repos": "https://github.com/frappe/hrms version-15"}),
			["/usr/local/bin/bench", "get-app", "https://github.com/frappe/hrms", "--branch", "version-15"],
		)

	def test_multiple_apps(self):
		ctx = BenchContext(**{**CTX.__dict__, "bench_apps": ("frappe", "erpnext", "hrms", "payments", "mobility_developer_tools")})
		service = BenchService(default_bench_registry(), ctx)
		spec, line = service.run_spec("install-app", {"apps": ["hrms", "payments", "hrms"]})  # duplicates collapse
		self.assertEqual(line.argv[-3:], ["install-app", "hrms", "payments"])
		self.assertEqual(line.argv[line.argv.index("--site") + 1], "site-a.local")

	def test_multiple_repositories_run_in_sequence_without_a_shell(self):
		import json

		spec, line = self.service.run_spec("get-app", {"repos": "https://github.com/frappe/hrms version-15\n\n  git@github.com:frappe/payments.git  \n"})
		self.assertEqual(line.argv[1:3], ["-m", "mobility_developer_tools.studio.bench.sequence"])
		steps = json.loads(line.argv[3])
		self.assertEqual([s["argv"][1:] for s in steps], [
			["get-app", "https://github.com/frappe/hrms", "--branch", "version-15"],
			["get-app", "git@github.com:frappe/payments.git"],
		])
		with self.assertRaises(StudioCommandError):  # at most 20 entries
			self.service.run_spec("get-app", {"repos": "\n".join(f"https://github.com/o/app{i}" for i in range(21))})

	def test_sequence_runner_stops_at_first_failure(self):
		import json
		import subprocess
		import sys

		steps = [
			{"argv": [sys.executable, "-c", "print('one')"], "cwd": "/tmp"},
			{"argv": [sys.executable, "-c", "import sys; print('two'); sys.exit(3)"], "cwd": "/tmp"},
			{"argv": [sys.executable, "-c", "print('three')"], "cwd": "/tmp"},
		]
		run = subprocess.run([sys.executable, "-m", "mobility_developer_tools.studio.bench.sequence", json.dumps(steps)], capture_output=True, text=True)
		self.assertEqual(run.returncode, 3)
		self.assertIn("one", run.stdout)
		self.assertIn("two", run.stdout)
		self.assertNotIn("three", run.stdout)
		self.assertIn("step 2 failed", run.stdout)

	def test_no_shell_is_involved(self):
		for command in default_bench_registry().all():
			if command.fields(CTX) or not command.is_available(CTX):
				continue
			with self.subTest(command=command.key):
				argv = self.argv(command.key)
				self.assertNotIn(argv[0], ("sh", "bash", "/bin/sh", "/bin/bash"))

	def test_invalid_inputs(self):
		bad = [
			("install-app", {"apps": ["erpnext"]}),  # already installed
			("install-app", {"apps": ["unknown_app"]}),
			("install-app", {"apps": ["hrms", "-rf"]}),
			("install-app", {"apps": []}),  # required
			("install-app", {"apps": {"hrms": 1}}),  # wrong type
			("uninstall-app", {"app": "frappe"}),
			("uninstall-app", {"app": "mobility_developer_tools"}),
			("uninstall-app", {"app": "hrms"}),  # not installed
			("scheduler", {"state": "drop"}),
			("maintenance-mode", {"state": "on; reboot"}),
			("migrate", {"unexpected": "x"}),
			("build", {"app": "../../etc"}),
			("get-app", {"repos": "file:///etc/passwd"}),
			("get-app", {"repos": "ext::sh -c id"}),
			("get-app", {"repos": "https://github.com/x/y; rm -rf /"}),
			("get-app", {"repos": "-uhttps://x"}),
			("get-app", {"repos": "https://github.com/x/y a b"}),
			("get-app", {"repos": "https://github.com/x/y $(id)"}),
			("get-app", {"repos": "https://github.com/x/y\nhttps://evil/;id"}),
			("unknown", {}),
		]
		for key, values in bad:
			with self.subTest(key=key, values=values):
				with self.assertRaises(StudioCommandError):
					self.service.run_spec(key, values)

	def test_commands_needing_bench_cli_are_hidden_without_it(self):
		ctx = BenchContext(**{**CTX.__dict__, "bench_cli": None})
		keys = {c["key"] for c in BenchService(default_bench_registry(), ctx).commands()["commands"]}
		self.assertNotIn("get-app", keys)
		self.assertNotIn("restart", keys)
		self.assertIn("migrate", keys)
		with self.assertRaises(StudioCommandError):
			BenchService(default_bench_registry(), ctx).run_spec("restart", {})

	def test_registry_is_open_for_extension(self):
		from mobility_developer_tools.studio.bench.base import BenchCommand

		class Hello(BenchCommand):
			key, label = "hello", "Hello"

			def build(self, ctx, values):
				self.clean(ctx, values)
				return self.frappe_cli(ctx, "list-apps")

		registry = BenchCommandRegistry([Hello()])
		spec, line = BenchService(registry, CTX).run_spec("hello", {})
		self.assertEqual(spec.kind, "bench")
		self.assertIn("list-apps", line.argv)


class TestRunnersAndLaunch(StudioTestCase):
	def test_run_commands_are_safely_quoted(self):
		ctx = RunContext("/env/bin/python", "/bench", "/bench/sites", "site-a.local", "Administrator")
		path = "/bench/apps/x/evil name; rm -rf ~ $(id) `id`.py"
		for key in ("python", "frappe"):
			with self.subTest(runner=key):
				command = default_registry().build_command(key, path, ctx)
				self.assertEqual(shlex.split(command)[-1], path)

	def test_launch_spec_roundtrip_with_hostile_values(self):
		spec = LaunchSpec(argv=["a", "b c", "'\"$(x)`;|&"], env={"K": "v\nX=1"}, title="t", kind="bench")
		self.assertEqual(LaunchSpec.decode(spec.encode()), spec)



class TestOpenUrl(StudioTestCase):
	def test_localhost_redirects_detected(self):
		for host in ("localhost:43045", "127.0.0.1:8085", "[::1]:9000", "LOCALHOST", "0.0.0.0:1"):
			with self.subTest(host=host):
				self.assertTrue(redirects_to_local_machine(f"https://idp.example/auth?redirect_uri=http://{host}/cb"))

	def test_remote_redirects_allowed(self):
		self.assertFalse(
			redirects_to_local_machine(
				"https://claude.com/cai/oauth/authorize?redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback"
			)
		)
		self.assertFalse(redirects_to_local_machine("https://example.com/docs"))

	def test_shim_ignores_non_http_urls(self):
		import sys
		from unittest.mock import patch

		from mobility_developer_tools.studio.ai_tools import open_url

		for url in ("javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "vbscript:x"):
			with self.subTest(url=url), patch.object(sys, "argv", ["xdg-open", url]):
				with patch("frappe.publish_realtime") as publish:
					self.assertEqual(open_url.main(), 1)
					publish.assert_not_called()
