import frappe
from frappe import _

from mobility_developer_tools.studio.config import ALLOWED_ROLE, StudioConfig
from mobility_developer_tools.studio.exceptions import StudioDisabledError


class AccessPolicy:
	"""Who may open the studio at all (role + feature flag). Password is handled by StudioSessionService."""

	def __init__(self, config: StudioConfig):
		self._config = config

	def is_allowed(self, user: str | None = None) -> bool:
		user = user or frappe.session.user
		return (
			self._config.enabled and user != "Guest" and ALLOWED_ROLE in frappe.get_roles(user)
		)

	def ensure_allowed(self) -> None:
		if not self._config.enabled:
			raise StudioDisabledError(
				_("Developer Studio is disabled on this site. Set developer_studio_enabled in site config.")
			)
		if not self.is_allowed():
			raise frappe.PermissionError(_("Developer Studio is only available to {0}").format(ALLOWED_ROLE))
