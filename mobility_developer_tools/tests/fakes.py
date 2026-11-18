"""Test doubles for the studio's abstractions (KeyValueStore, ProcessSpawner, verifier)."""

from __future__ import annotations

import copy
import json
import threading
import time


class InMemoryStore:
	"""KeyValueStore implementation for unit tests (thread-safe, honours TTLs)."""

	def __init__(self):
		self._data: dict[str, tuple[object, float | None]] = {}
		self._cond = threading.Condition()

	def _get(self, key):
		item = self._data.get(key)
		if not item:
			return None
		value, expires = item
		if expires and expires < time.monotonic():
			del self._data[key]
			return None
		return value

	def _set(self, key, value, ttl=None):
		self._data[key] = (value, time.monotonic() + ttl if ttl else None)

	def get_json(self, key):
		with self._cond:
			return copy.deepcopy(self._get(key))

	def set_json(self, key, value, ttl=None):
		with self._cond:
			self._set(key, json.loads(json.dumps(value)), ttl)

	def delete(self, *keys):
		with self._cond:
			for key in keys:
				self._data.pop(key, None)

	def expire(self, key, ttl):
		with self._cond:
			value = self._get(key)
			if value is None:
				return False
			self._set(key, value, ttl)
			return True

	def exists(self, key):
		with self._cond:
			return self._get(key) is not None

	def incr(self, key, ttl=None):
		with self._cond:
			value = int(self._get(key) or 0) + 1
			self._set(key, value, ttl)
			return value

	def push(self, key, value, max_len=None, ttl=None):
		with self._cond:
			items = list(self._get(key) or [])
			items.append(json.loads(json.dumps(value)))
			if max_len:
				items = items[-max_len:]
			self._set(key, items, ttl)
			self._cond.notify_all()

	def range(self, key, start=0, end=-1):
		with self._cond:
			items = list(self._get(key) or [])
			return items[start:] if end == -1 else items[start : end + 1]

	def pop_blocking(self, key, timeout):
		deadline = time.monotonic() + timeout
		with self._cond:
			while True:
				items = list(self._get(key) or [])
				if items:
					self._set(key, items[1:])
					return items[0]
				left = deadline - time.monotonic()
				if left <= 0:
					return None
				self._cond.wait(left)

	def add_member(self, key, member):
		with self._cond:
			members = set(self._get(key) or [])
			members.add(member)
			self._set(key, sorted(members))

	def remove_member(self, key, member):
		with self._cond:
			members = set(self._get(key) or [])
			members.discard(member)
			self._set(key, sorted(members))

	def members(self, key):
		with self._cond:
			return set(self._get(key) or [])


class RecordingSpawner:
	"""ProcessSpawner that records instead of starting processes."""

	def __init__(self):
		self.calls: list[dict] = []

	def spawn(self, argv, cwd, log_path):
		self.calls.append({"argv": list(argv), "cwd": cwd, "log_path": log_path})


def password_verifier(correct: str):
	"""Stand-in for frappe's check_password."""

	def verify(user, password):
		import frappe

		if password != correct:
			raise frappe.AuthenticationError("wrong password")

	return verify
