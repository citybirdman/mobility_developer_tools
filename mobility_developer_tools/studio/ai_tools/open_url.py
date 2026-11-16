"""Browser shim used by AI tools (installed as xdg-open / x-www-browser / ...).

The server has no screen, so instead of starting a browser here the URL is sent
to the user's Developer Studio page, which offers to open it. The shim then
exits with an error so the tool also prints the link / manual-code flow.
"""

import os
import sys
from urllib.parse import parse_qs, urlparse

from mobility_developer_tools.studio.terminal.protocol import OPEN_URL_EVENT


LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"}


def redirects_to_local_machine(url: str) -> bool:
	"""OAuth links whose redirect_uri is localhost only work in a browser on the
	server itself (e.g. Claude Code's automatic login). In the user's browser they
	end on *their* localhost, so they must not be offered; the CLI also prints a
	remote-friendly link (code to paste back) in the terminal."""
	for value in parse_qs(urlparse(url).query).get("redirect_uri", []):
		host = (urlparse(value).hostname or "").lower()
		if host in LOCAL_HOSTS:
			return True
	return False


def main() -> int:
	url = next((a for a in sys.argv[1:] if not a.startswith("-")), "")
	if urlparse(url).scheme not in ("http", "https"):
		return 1
	local_redirect = redirects_to_local_machine(url)

	site, sites_path, user = (os.environ.get(k) for k in ("MDT_SITE", "MDT_SITES_PATH", "MDT_USER"))
	if not (site and sites_path and user):
		return 1

	import frappe

	try:
		os.chdir(sites_path)
		frappe.init(site=site, sites_path=sites_path)
		frappe.publish_realtime(
			OPEN_URL_EVENT,
			{
				# a localhost-redirect URL is never sent to the browser
				"url": None if local_redirect else url,
				"local_redirect": local_redirect,
				"tool": os.environ.get("MDT_TOOL_LABEL", ""),
				"term_id": os.environ.get("MDT_TERM_ID"),
			},
			user=user,
		)
	finally:
		frappe.destroy()
	return 1  # "could not open a browser": the tool falls back to printing the URL


if __name__ == "__main__":
	sys.exit(main())
