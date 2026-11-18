"""Whitelisted endpoints. Kept thin: check access, delegate to a service, audit.

Every endpoint except ``status``/``unlock`` requires an unlocked studio session
(``X-Studio-Token`` header) on top of the System Manager role.
"""

import os
from functools import wraps

import frappe
from frappe.utils import cint

from mobility_developer_tools.studio.container import get_container
from mobility_developer_tools.studio.files.search import GlobFilter, SearchQuery
from mobility_developer_tools.studio.runners.base import RunContext
from mobility_developer_tools.studio.security.session import TOKEN_HEADER


def _token() -> str | None:
	return frappe.get_request_header(TOKEN_HEADER)


def studio_endpoint(fn):
	"""Role + feature flag + unlocked session, for every protected endpoint."""

	@wraps(fn)
	def wrapper(*args, **kwargs):
		c = get_container()
		c.access.ensure_allowed()
		c.sessions.validate(_token(), frappe.session.user, frappe.session.sid)
		return fn(*args, **kwargs)

	wrapper.studio_protected = True  # checked by tests: every endpoint must be guarded
	return wrapper


# endpoints that are intentionally reachable while locked (still role + feature-flag checked)
UNLOCKED_ENDPOINTS = ("status", "unlock")


def has_app_permission() -> bool:
	"""Used by the apps screen tile."""
	return get_container().access.is_allowed()


# -- session ------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
def status():
	c = get_container()
	c.access.ensure_allowed()
	unlocked = c.sessions.is_unlocked(_token(), frappe.session.user, frappe.session.sid)
	result = {"user": frappe.session.user, "unlocked": unlocked}
	if unlocked:
		# a still-valid unlock (remembered by the browser) skips the password prompt
		result.update(_studio_context(c))
	return result


def _studio_context(c) -> dict:
	return {"root": c.config.root, "root_name": c.config.root.rstrip("/").rsplit("/", 1)[-1], "site": frappe.local.site}


@frappe.whitelist(methods=["POST"])
def unlock(password: str):
	c = get_container()
	c.access.ensure_allowed()
	try:
		result = c.sessions.unlock(frappe.session.user, frappe.session.sid, password)
	except Exception:
		c.audit.log("Unlock Failed", commit=True)
		raise
	c.audit.log("Unlock")
	return {**result, **_studio_context(c)}


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def lock():
	get_container().sessions.lock(_token())
	get_container().audit.log("Lock")


# -- files --------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def list_dir(path: str = ""):
	return get_container().files.list_dir(path)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def read_file(path: str):
	return get_container().files.read(path)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def find_files(query: str):
	return get_container().files.find(query)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def search_text(
	query: str,
	is_regex: int = 0,
	match_case: int = 0,
	whole_word: int = 0,
	include: str = "",
	exclude: str = "",
	folder: str = "",
):
	"""Search view: matches of ``query`` in the files under the root (or ``folder``)."""
	return get_container().searcher.search(
		_search_query(query, is_regex, match_case, whole_word), GlobFilter(include, exclude), folder
	)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def replace_text(
	path: str,
	query: str,
	replacement: str = "",
	is_regex: int = 0,
	match_case: int = 0,
	whole_word: int = 0,
	expected_version: str | None = None,
	matches: str | list | None = None,
):
	"""Replace all matches in one file, or only ``matches`` ([{line, col}]) from the search result."""
	c = get_container()
	only = frappe.parse_json(matches) if isinstance(matches, str) else matches
	result = c.replacer.replace(
		path, _search_query(query, is_regex, match_case, whole_word), replacement or "", expected_version, only
	)
	if result["replaced"]:
		c.audit.log("Replace in File", f"{path} ({result['replaced']})")
	return result


def _search_query(query, is_regex, match_case, whole_word) -> SearchQuery:
	return SearchQuery(query or "", bool(cint(is_regex)), bool(cint(match_case)), bool(cint(whole_word)))


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def watch(files: str | list | None = None, folders: str | list | None = None):
	"""State of the open files / expanded folders, polled by the browser to pick up outside changes."""
	files = frappe.parse_json(files) if isinstance(files, str) else files
	folders = frappe.parse_json(folders) if isinstance(folders, str) else folders
	return get_container().watcher.snapshot(files, folders)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def write_file(path: str, content: str, expected_version: str | None = None):
	c = get_container()
	result = c.files.write(path, content, expected_version)
	c.audit.log("Save File", path)
	return result


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def create_entry(path: str, entry_type: str = "file"):
	c = get_container()
	result = c.files.create_folder(path) if entry_type == "folder" else c.files.create_file(path)
	c.audit.log("Create Folder" if entry_type == "folder" else "Create File", path)
	return result


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def rename_entry(path: str, new_path: str):
	c = get_container()
	result = c.files.rename(path, new_path)
	c.audit.log("Rename", f"{path} -> {new_path}")
	return result


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def delete_entry(path: str):
	c = get_container()
	c.files.delete(path)
	c.audit.log("Delete", path)


# -- run ----------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def get_runners(path: str):
	return [{"key": r.key, "label": r.label} for r in get_container().runners.for_path(path)]


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def get_run_command(path: str, runner: str):
	c = get_container()
	abs_path = c.guard.resolve(path)
	ctx = RunContext(
		python=c.config.python,
		bench_path=c.config.bench_path,
		sites_path=c.config.sites_path,
		site=frappe.local.site,
		user=frappe.session.user,
	)
	command = c.runners.build_command(runner, abs_path, ctx)
	c.audit.log("Run File", path, command)
	return {"command": command}


# -- terminals ----------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_create(cwd: str = "", cols: int = 120, rows: int = 30):
	c = get_container()
	abs_cwd = c.guard.resolve(cwd)
	if not os.path.isdir(abs_cwd):
		abs_cwd = os.path.dirname(abs_cwd)
	meta = c.terminals.create(frappe.session.user, abs_cwd, int(cols), int(rows))
	c.audit.log("Open Terminal", c.guard.relative(abs_cwd) or "/")
	return meta


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_list():
	return get_container().terminals.list_for(frappe.session.user)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_input(term_id: str, data: str):
	get_container().terminals.send_input(frappe.session.user, term_id, data)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_resize(term_id: str, cols: int, rows: int):
	get_container().terminals.resize(frappe.session.user, term_id, cols, rows)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_read(term_id: str, after_seq: int = 0):
	return get_container().terminals.read(frappe.session.user, term_id, after_seq)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_close(term_id: str):
	c = get_container()
	c.terminals.close(frappe.session.user, term_id)
	c.audit.log("Close Terminal", term_id)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def terminal_keepalive(term_ids: str | list | None = None):
	if isinstance(term_ids, str):
		term_ids = frappe.parse_json(term_ids)
	return get_container().terminals.keepalive(frappe.session.user, term_ids or [])


# -- AI tools -------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ai_tools():
	return get_container().ai_tools.status()


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ai_tool_start(key: str, cwd: str = "", cols: int = 120, rows: int = 30):
	c = get_container()
	abs_cwd = c.guard.resolve(cwd)
	if not os.path.isdir(abs_cwd):
		abs_cwd = os.path.dirname(abs_cwd)
	spec = c.ai_tools.start_spec(key, frappe.session.user)
	meta = c.terminals.create(frappe.session.user, abs_cwd, int(cols), int(rows), launch=spec)
	c.audit.log("Start AI Tool", spec.title, c.guard.relative(abs_cwd) or "/")
	return meta


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ai_tool_install(key: str, cols: int = 120, rows: int = 30):
	c = get_container()
	spec = c.ai_tools.install_spec(key)
	meta = c.terminals.create(frappe.session.user, c.ai_tools.tools_home, int(cols), int(rows), launch=spec)
	c.audit.log("Install AI Tool", c.ai_tools.tool(key).label, c.ai_tools.tool(key).install_command)
	return meta


# -- Frappe / bench commands -----------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def bench_commands():
	return get_container().bench.commands()


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def bench_run(key: str, values: str | dict | None = None, cols: int = 120, rows: int = 30):
	from mobility_developer_tools.studio.bench.service import display_command

	c = get_container()
	values = frappe.parse_json(values) if isinstance(values, str) else (values or {})
	if not isinstance(values, dict):
		frappe.throw(frappe._("Invalid values"))
	spec, line = c.bench.run_spec(key, values)
	meta = c.terminals.create(frappe.session.user, line.cwd, int(cols), int(rows), launch=spec)
	c.audit.log("Bench Command", key, display_command(line))
	return meta


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def bench_console(cols: int = 120, rows: int = 30):
	from mobility_developer_tools.studio.bench.service import display_command

	c = get_container()
	spec, line = c.bench.console_spec()
	meta = c.terminals.create(frappe.session.user, line.cwd, int(cols), int(rows), launch=spec)
	c.audit.log("Bench Console", frappe.local.site, display_command(line))
	return meta


# -- extensions (VS Code extensions from Open VSX or .vsix) ---------------------------------
#
# Installing, checking and configuring is guarded like every other studio endpoint.
# Extension code is never executed on the server: it is only parsed.


def _parse(value, default):
	return frappe.parse_json(value) if isinstance(value, str) else (value if value is not None else default)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_search(query: str = ""):
	return get_container().extensions.search(query)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_check(namespace: str, name: str, version: str | None = None):
	return get_container().extensions.check_remote(namespace, name, version)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_check_upload(data: str):
	return get_container().extensions.check_upload(data)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_install(namespace: str, name: str, version: str | None = None):
	c = get_container()
	report = c.extensions.install_remote(namespace, name, version)
	c.audit.log("Install Extension", report["id"], f"{report['version']} from Open VSX: {report['verdict']}")
	return report


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_install_upload(data: str):
	c = get_container()
	report = c.extensions.install_upload(data)
	c.audit.log("Install Extension", report["id"], f"{report['version']} from upload: {report['verdict']}")
	return report


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_uninstall(ext_id: str):
	c = get_container()
	c.extensions.uninstall(ext_id)
	c.audit.log("Uninstall Extension", ext_id)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_set_enabled(ext_id: str, enabled: int | bool = 1):
	c = get_container()
	c.extensions.set_enabled(ext_id, bool(frappe.utils.cint(enabled)))
	c.audit.log("Enable Extension" if frappe.utils.cint(enabled) else "Disable Extension", ext_id)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_set_settings(ext_id: str, settings: str | dict | None = None):
	get_container().extensions.set_settings(ext_id, _parse(settings, {}))


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_installed():
	return get_container().extensions.installed()


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_runtime():
	"""Enabled extensions + this user's theme choices, for the browser."""
	return {
		"extensions": get_container().extensions.runtime(),
		"preferences": {
			"color_theme": frappe.defaults.get_user_default("mdt_color_theme") or "",
			"icon_theme": frappe.defaults.get_user_default("mdt_icon_theme") or "",
		},
	}


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_files(ext_id: str, paths: str | list | None = None, encoding: str = "text"):
	return get_container().extensions.read_files(ext_id, _parse(paths, []), encoding)


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def ext_set_preference(key: str, value: str = ""):
	if key not in ("color_theme", "icon_theme"):
		frappe.throw(frappe._("Unknown preference"))
	if len(value or "") > 300:
		frappe.throw(frappe._("Invalid value"))
	frappe.defaults.set_user_default(f"mdt_{key}", value or "")


# -- code intelligence -------------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
@studio_endpoint
def goto_definition(path: str, source: str, line: int, column: int, language: str = "python"):
	"""F12 / Ctrl+click: definitions of the symbol (or dotted path string) at line (1-based), column (0-based)."""
	if language not in ("python", "javascript", "typescript", "json", "html"):
		return []
	return get_container().definitions.find(path, source, int(line), int(column), language)
