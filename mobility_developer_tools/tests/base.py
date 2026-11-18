"""Shared test setup.

Tests run either under ``bench --site <site> run-tests --app mobility_developer_tools``
(Frappe already initialised) or with the standalone runner
``python -m mobility_developer_tools.tests.runner --site <site>``.
They never commit to the database; the runner rolls back at the end.
"""

from __future__ import annotations

import dataclasses
import os
import shutil
import tempfile
import unittest

import frappe

from mobility_developer_tools.studio.config import StudioConfig


def ensure_site():
	if getattr(frappe.local, "site", None):
		return
	site = os.environ.get("MDT_TEST_SITE")
	if not site:
		raise unittest.SkipTest("No Frappe site: run via bench run-tests or tests.runner --site")
	sites_path = os.environ.get("MDT_TEST_SITES_PATH", ".")
	frappe.init(site=site, sites_path=sites_path)
	frappe.connect()


class StudioTestCase(unittest.TestCase):
	@classmethod
	def setUpClass(cls):
		super().setUpClass()
		ensure_site()
		frappe.set_user("Administrator")

	def make_tree(self) -> str:
		"""Temporary root:  root/{a.py, sub/b.txt, data.bin}  + a sibling 'outside' folder."""
		base = tempfile.mkdtemp(prefix="mdt-test-")
		self.addCleanup(shutil.rmtree, base, ignore_errors=True)
		root = os.path.join(base, "root")
		os.makedirs(os.path.join(root, "sub"))
		os.makedirs(os.path.join(base, "outside"))
		with open(os.path.join(root, "a.py"), "w") as f:
			f.write("print('a')\n")
		with open(os.path.join(root, "sub", "b.txt"), "w") as f:
			f.write("b\n")
		with open(os.path.join(root, "data.bin"), "wb") as f:
			f.write(b"\x00\x01\x02")
		with open(os.path.join(base, "outside", "secret.txt"), "w") as f:
			f.write("secret\n")
		return root

	@staticmethod
	def config(**overrides) -> StudioConfig:
		return dataclasses.replace(StudioConfig.from_site(), **overrides)
