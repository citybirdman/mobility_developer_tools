"""Key/value store abstraction (Dependency Inversion).

Services depend on ``KeyValueStore``; ``RedisKeyValueStore`` is the concrete
implementation. It uses its own raw redis client (not ``frappe.cache``) because
the terminal host process needs blocking list operations (BLPOP) and must not
depend on a request context. All keys are namespaced per site.
"""

import json
from typing import Any, Protocol

import redis


class KeyValueStore(Protocol):
	def get_json(self, key: str) -> Any: ...
	def set_json(self, key: str, value: Any, ttl: int | None = None) -> None: ...
	def delete(self, *keys: str) -> None: ...
	def expire(self, key: str, ttl: int) -> bool: ...
	def exists(self, key: str) -> bool: ...
	def incr(self, key: str, ttl: int | None = None) -> int: ...
	def push(self, key: str, value: Any, max_len: int | None = None, ttl: int | None = None) -> None: ...
	def range(self, key: str, start: int = 0, end: int = -1) -> list: ...
	def pop_blocking(self, key: str, timeout: int) -> Any: ...
	def add_member(self, key: str, member: str) -> None: ...
	def remove_member(self, key: str, member: str) -> None: ...
	def members(self, key: str) -> set[str]: ...


class RedisKeyValueStore:
	def __init__(self, client: redis.Redis, namespace: str):
		self._r = client
		self._ns = namespace

	@classmethod
	def for_site(cls, conf: dict, site: str) -> "RedisKeyValueStore":
		client = redis.Redis.from_url(conf.get("redis_cache") or "redis://127.0.0.1:13000")
		return cls(client, f"mobility_developer_studio|{site}|")

	def _k(self, key: str) -> str:
		return self._ns + key

	def get_json(self, key):
		raw = self._r.get(self._k(key))
		return json.loads(raw) if raw else None

	def set_json(self, key, value, ttl=None):
		self._r.set(self._k(key), json.dumps(value), ex=ttl)

	def delete(self, *keys):
		if keys:
			self._r.delete(*[self._k(k) for k in keys])

	def expire(self, key, ttl):
		return bool(self._r.expire(self._k(key), ttl))

	def exists(self, key):
		return bool(self._r.exists(self._k(key)))

	def incr(self, key, ttl=None):
		pipe = self._r.pipeline()
		pipe.incr(self._k(key))
		if ttl:
			pipe.expire(self._k(key), ttl)
		return int(pipe.execute()[0])

	def push(self, key, value, max_len=None, ttl=None):
		pipe = self._r.pipeline()
		pipe.rpush(self._k(key), json.dumps(value))
		if max_len:
			pipe.ltrim(self._k(key), -max_len, -1)
		if ttl:
			pipe.expire(self._k(key), ttl)
		pipe.execute()

	def range(self, key, start=0, end=-1):
		return [json.loads(v) for v in self._r.lrange(self._k(key), start, end)]

	def pop_blocking(self, key, timeout):
		item = self._r.blpop([self._k(key)], timeout=timeout)
		return json.loads(item[1]) if item else None

	def add_member(self, key, member):
		self._r.sadd(self._k(key), member)

	def remove_member(self, key, member):
		self._r.srem(self._k(key), member)

	def members(self, key):
		return {m.decode() if isinstance(m, bytes) else m for m in self._r.smembers(self._k(key))}
