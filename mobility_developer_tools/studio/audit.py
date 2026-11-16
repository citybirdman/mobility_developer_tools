from typing import Protocol

import frappe

LOG_DOCTYPE = "Developer Studio Log"


class AuditLogger(Protocol):
	def log(self, action: str, target: str = "", details: str = "", commit: bool = False) -> None: ...


class DocTypeAuditLogger:
	"""Writes studio actions to the "Developer Studio Log" doctype."""

	def log(self, action, target="", details="", commit=False):
		try:
			frappe.get_doc(
				{
					"doctype": LOG_DOCTYPE,
					"user": frappe.session.user,
					"action": action,
					"target": (target or "")[:1000],
					"details": (details or "")[:5000],
					"ip_address": getattr(frappe.local, "request_ip", None),
				}
			).insert(ignore_permissions=True)
			if commit:
				# used before raising, so the entry survives the request rollback
				frappe.db.commit()
		except Exception:
			frappe.log_error(title="Developer Studio audit log failed")
