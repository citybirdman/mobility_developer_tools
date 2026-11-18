"""Security: password re-authentication, lockout, session tokens, role / feature-flag checks."""

import time
from unittest.mock import patch

import frappe

from mobility_developer_tools.studio.config import MAX_FAILED_UNLOCKS
from mobility_developer_tools.studio.exceptions import StudioAuthError, StudioDisabledError, StudioLockedError
from mobility_developer_tools.studio.security.access import AccessPolicy
from mobility_developer_tools.studio.security.session import StudioSessionService
from mobility_developer_tools.tests.base import StudioTestCase
from mobility_developer_tools.tests.fakes import InMemoryStore, password_verifier

USER, SID = "studio.tester@example.com", "sid-1"


class TestStudioSession(StudioTestCase):
	def setUp(self):
		self.store = InMemoryStore()
		self.sessions = StudioSessionService(self.store, self.config(session_seconds=60), password_verifier("right"))

	def unlock(self, password="right", user=USER, sid=SID):
		return self.sessions.unlock(user, sid, password)

	def test_wrong_password_rejected_and_counted(self):
		with self.assertRaises(StudioAuthError):
			self.unlock("wrong")
		self.assertEqual(self.store.get_json(f"unlock_failures:{USER}"), 1)

	def test_lockout_after_max_failures_even_with_right_password(self):
		for _ in range(MAX_FAILED_UNLOCKS):
			with self.assertRaises(StudioAuthError):
				self.unlock("wrong")
		with self.assertRaises(StudioAuthError):
			self.unlock("right")

	def test_success_resets_failures(self):
		with self.assertRaises(StudioAuthError):
			self.unlock("wrong")
		self.unlock("right")
		self.assertIsNone(self.store.get_json(f"unlock_failures:{USER}"))

	def test_empty_password_rejected(self):
		with self.assertRaises(StudioAuthError):
			self.sessions.unlock(USER, SID, None)

	def test_token_is_random_and_long(self):
		tokens = {self.unlock()["token"] for _ in range(50)}
		self.assertEqual(len(tokens), 50)
		self.assertTrue(all(len(t) >= 40 for t in tokens))

	def test_token_bound_to_user_and_session(self):
		token = self.unlock()["token"]
		self.sessions.validate(token, USER, SID)
		for user, sid in ((USER, "other-sid"), ("other@example.com", SID)):
			with self.assertRaises(StudioLockedError):
				self.sessions.validate(token, user, sid)

	def test_missing_or_forged_token_locked(self):
		for token in (None, "", "forged-token", "token:" + "x" * 40):
			with self.assertRaises(StudioLockedError):
				self.sessions.validate(token, USER, SID)

	def test_lock_revokes_token(self):
		token = self.unlock()["token"]
		self.sessions.lock(token)
		with self.assertRaises(StudioLockedError):
			self.sessions.validate(token, USER, SID)

	def test_token_expires_after_inactivity(self):
		sessions = StudioSessionService(self.store, self.config(session_seconds=1), password_verifier("right"))
		token = sessions.unlock(USER, SID, "right")["token"]
		time.sleep(1.2)
		with self.assertRaises(StudioLockedError):
			sessions.validate(token, USER, SID)


class TestAccessPolicy(StudioTestCase):
	def test_system_manager_allowed(self):
		self.assertTrue(AccessPolicy(self.config(enabled=True)).is_allowed("Administrator"))

	def test_guest_denied(self):
		self.assertFalse(AccessPolicy(self.config(enabled=True)).is_allowed("Guest"))

	def test_user_without_system_manager_denied(self):
		with patch("frappe.get_roles", return_value=["Accounts User", "All"]):
			policy = AccessPolicy(self.config(enabled=True))
			self.assertFalse(policy.is_allowed("someone@example.com"))
			frappe.set_user("Guest")
			try:
				with self.assertRaises(frappe.PermissionError):
					policy.ensure_allowed()
			finally:
				frappe.set_user("Administrator")

	def test_disabled_feature_flag_blocks_everyone(self):
		policy = AccessPolicy(self.config(enabled=False))
		self.assertFalse(policy.is_allowed("Administrator"))
		with self.assertRaises(StudioDisabledError):
			policy.ensure_allowed()
