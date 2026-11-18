"""Security of the HTTP API: every endpoint guarded, POST only, token required, inputs validated."""

import inspect
import os
import unittest
from unittest.mock import patch

import frappe

from mobility_developer_tools.studio import api
from mobility_developer_tools.studio.container import get_container
from mobility_developer_tools.studio.exceptions import (
	StudioCommandError,
	StudioLockedError,
	StudioPathError,
)
from mobility_developer_tools.studio.security.session import StudioSessionService
from mobility_developer_tools.tests.base import StudioTestCase


def whitelisted_endpoints():
	for name, fn in inspect.getmembers(api, inspect.isfunction):
		if fn in frappe.whitelisted:
			yield name, fn


class TestEndpointGuards(StudioTestCase):
	def test_every_endpoint_requires_an_unlocked_session(self):
		names = []
		for name, fn in whitelisted_endpoints():
			names.append(name)
			if name in api.UNLOCKED_ENDPOINTS:
				continue
			with self.subTest(endpoint=name):
				self.assertTrue(getattr(fn, "studio_protected", False), f"{name} is not wrapped by @studio_endpoint")
		self.assertGreater(len(names), 15)

	def test_every_endpoint_is_post_only(self):
		for name, fn in whitelisted_endpoints():
			with self.subTest(endpoint=name):
				self.assertEqual(frappe.allowed_http_methods_for_whitelisted_func.get(fn), ["POST"])

	def test_no_endpoint_allows_guests(self):
		for name, fn in whitelisted_endpoints():
			with self.subTest(endpoint=name):
				self.assertNotIn(fn, frappe.guest_methods)


class TestEndpointBehaviour(StudioTestCase):
	"""Calls the real endpoint functions in-process (request header stubbed)."""

	def setUp(self):
		frappe.local._mdt_studio_container = None
		self.container = get_container()
		self.sid = frappe.session.sid
		sessions = StudioSessionService(self.container.store, self.container.config, verify_password=lambda u, p: None)
		self.token = sessions.unlock(frappe.session.user, self.sid, "x")["token"]
		self.addCleanup(sessions.lock, self.token)

	def with_token(self, token):
		return patch.object(api, "_token", return_value=token)

	def test_locked_without_token(self):
		with self.with_token(None), self.assertRaises(StudioLockedError):
			api.list_dir("")

	def test_token_of_another_session_is_rejected(self):
		original = frappe.local.session.sid
		frappe.local.session.sid = "another-session"  # same user, different login session
		try:
			with self.with_token(self.token), self.assertRaises(StudioLockedError):
				api.list_dir("")
		finally:
			frappe.local.session.sid = original

	def test_unlocked_session_works(self):
		with self.with_token(self.token):
			self.assertTrue(any(e["name"] == "apps" for e in api.list_dir("")))

	def test_guest_rejected_even_with_token(self):
		frappe.set_user("Guest")
		try:
			with self.with_token(self.token), self.assertRaises(frappe.PermissionError):
				api.list_dir("")
		finally:
			frappe.set_user("Administrator")

	def test_traversal_through_api(self):
		with self.with_token(self.token):
			for path in ("../../etc/passwd", "/../../../etc/shadow", "sites/../../.."):
				with self.subTest(path=path), self.assertRaises(StudioPathError):
					api.read_file(path)

	def test_other_site_unreachable_through_api(self):
		others = self.container.config.other_site_paths()
		if not others:
			self.skipTest("single-site bench")
		rel = os.path.relpath(os.path.join(others[0], "site_config.json"), self.container.config.root)
		with self.with_token(self.token), self.assertRaises(StudioPathError):
			api.read_file(rel)

	def test_bench_injection_rejected_before_anything_runs(self):
		before = len(self.container.terminals.list_for(frappe.session.user))
		attempts = [
			("migrate", {"skip_failing": 1, "site": "other.site"}),  # unknown field
			("install-app", {"apps": ["--site=other.site"]}),
			("install-app", {"apps": ["frappe; rm -rf /"]}),
			("install-app", {"apps": "hrms,--force"}),
			("uninstall-app", {"app": "frappe"}),  # protected
			("scheduler", {"state": "status --site other"}),
			("get-app", {"repos": "ext::sh -c touch% /tmp/pwned"}),
			("get-app", {"repos": "--upload-pack=touch /tmp/pwned"}),
			("get-app", {"repos": "https://github.com/frappe/hrms --exec=sh"}),
			("get-app", {"repos": "https://github.com/frappe/hrms\nhttps://x.example/y main extra"}),
			("build", {"app": "../frappe"}),
			("no-such-command", {}),
		]
		with self.with_token(self.token):
			for key, values in attempts:
				with self.subTest(key=key, values=values):
					with self.assertRaises((StudioCommandError, frappe.ValidationError)):
						api.bench_run(key, frappe.as_json(values))
		self.assertEqual(len(self.container.terminals.list_for(frappe.session.user)), before)


class TestHttpLayer(StudioTestCase):
	"""Against the running web server (skipped if it is not reachable)."""

	def request(self, method, endpoint, **kwargs):
		try:
			import requests

			port = frappe.conf.webserver_port or 8000
			return requests.request(
				method,
				f"http://127.0.0.1:{port}/api/method/mobility_developer_tools.studio.api.{endpoint}",
				headers={"Host": frappe.local.site},
				timeout=10,
				**kwargs,
			)
		except Exception as e:
			raise unittest.SkipTest(f"web server not reachable: {e}")

	def test_anonymous_requests_are_rejected(self):
		for endpoint in ("status", "unlock", "list_dir", "read_file", "terminal_create", "bench_run", "bench_console"):
			with self.subTest(endpoint=endpoint):
				response = self.request("POST", endpoint, json={"path": "sites/apps.txt", "password": "x"})
				self.assertIn(response.status_code, (401, 403))
				# sites/apps.txt lists the bench apps: its content must never come back
				self.assertNotIn("mobility_developer_tools\n", response.text)

	def test_get_is_not_accepted(self):
		response = self.request("GET", "list_dir")
		self.assertNotEqual(response.status_code, 200)
