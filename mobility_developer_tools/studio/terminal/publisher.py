from typing import Protocol

from mobility_developer_tools.studio.terminal.protocol import EXIT_EVENT, OUTPUT_EVENT


class OutputPublisher(Protocol):
	def output(self, term_id: str, seq: int, data: str) -> None: ...
	def exited(self, term_id: str, code: int | None) -> None: ...


class RealtimePublisher:
	"""Pushes terminal output to the owner's browser tabs via Frappe socket.io."""

	def __init__(self, user: str):
		self._user = user

	def output(self, term_id, seq, data):
		import frappe

		frappe.publish_realtime(OUTPUT_EVENT, {"id": term_id, "seq": seq, "data": data}, user=self._user)

	def exited(self, term_id, code):
		import frappe

		frappe.publish_realtime(EXIT_EVENT, {"id": term_id, "code": code}, user=self._user)
