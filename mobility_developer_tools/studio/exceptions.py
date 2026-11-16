import frappe


class StudioLockedError(frappe.ValidationError):
	"""The studio session is locked / expired: the client must ask for the password again."""

	http_status_code = 423


class StudioAuthError(frappe.ValidationError):
	"""Wrong password or too many attempts."""

	http_status_code = 403


class StudioDisabledError(frappe.ValidationError):
	http_status_code = 403


class StudioPathError(frappe.ValidationError):
	"""Path is outside the studio root or otherwise invalid."""

	http_status_code = 400


class StudioConflictError(frappe.ValidationError):
	"""File changed on disk since it was opened."""

	http_status_code = 409
