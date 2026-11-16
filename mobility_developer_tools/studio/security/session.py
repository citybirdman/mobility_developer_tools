"""Password re-authentication and studio session tokens.

* The user must type their password again to unlock the studio.
* Failed attempts are counted per user; after MAX_FAILED_UNLOCKS the user is
  locked out for UNLOCK_LOCKOUT_SECONDS.
* On success a random token is issued. It is bound to the user AND the Frappe
  session id (sid), kept only in the browser's memory, sent in the
  ``X-Studio-Token`` header and expires after ``session_seconds`` of inactivity.
"""

import secrets
import time
from collections.abc import Callable

import frappe
from frappe import _

from mobility_developer_tools.studio.config import (
	MAX_FAILED_UNLOCKS,
	UNLOCK_LOCKOUT_SECONDS,
	StudioConfig,
)
from mobility_developer_tools.studio.exceptions import StudioAuthError, StudioLockedError
from mobility_developer_tools.studio.kv import KeyValueStore

TOKEN_HEADER = "X-Studio-Token"

PasswordVerifier = Callable[[str, str], None]  # raises on wrong password


def frappe_password_verifier(user: str, password: str) -> None:
	from frappe.utils.password import check_password

	check_password(user, password, delete_tracker_cache=False)


class StudioSessionService:
	def __init__(
		self,
		store: KeyValueStore,
		config: StudioConfig,
		verify_password: PasswordVerifier = frappe_password_verifier,
	):
		self._store = store
		self._config = config
		self._verify_password = verify_password

	# -- unlock -------------------------------------------------------------

	def unlock(self, user: str, sid: str, password: str) -> dict:
		fail_key = f"unlock_failures:{user}"
		failures = int(self._store.get_json(fail_key) or 0)
		if failures >= MAX_FAILED_UNLOCKS:
			raise StudioAuthError(
				_("Too many failed attempts. Try again in {0} minutes.").format(UNLOCK_LOCKOUT_SECONDS // 60)
			)

		try:
			self._verify_password(user, password or "")
		except frappe.AuthenticationError:
			self._store.set_json(fail_key, failures + 1, ttl=UNLOCK_LOCKOUT_SECONDS)
			left = MAX_FAILED_UNLOCKS - failures - 1
			raise StudioAuthError(_("Incorrect password. {0} attempt(s) left.").format(left))

		self._store.delete(fail_key)
		token = secrets.token_urlsafe(32)
		self._store.set_json(
			self._token_key(token),
			{"user": user, "sid": sid, "created": time.time()},
			ttl=self._config.session_seconds,
		)
		return {"token": token, "expires_in": self._config.session_seconds}

	def lock(self, token: str | None) -> None:
		if token:
			self._store.delete(self._token_key(token))

	# -- validation ---------------------------------------------------------

	def validate(self, token: str | None, user: str, sid: str) -> None:
		"""Raise StudioLockedError unless token is valid for this user+session. Slides expiry."""
		data = self._store.get_json(self._token_key(token)) if token else None
		if not data or data.get("user") != user or data.get("sid") != sid:
			raise StudioLockedError(_("Developer Studio is locked. Enter your password to continue."))
		self._store.expire(self._token_key(token), self._config.session_seconds)

	def is_unlocked(self, token: str | None, user: str, sid: str) -> bool:
		try:
			self.validate(token, user, sid)
			return True
		except StudioLockedError:
			return False

	@staticmethod
	def _token_key(token: str) -> str:
		return f"token:{token}"
