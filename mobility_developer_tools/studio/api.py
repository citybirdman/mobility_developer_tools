"""Whitelisted endpoints. Kept thin: check access, delegate to a service, audit.

Every endpoint except ``status``/``unlock`` requires an unlocked studio session
(``X-Studio-Token`` header) on top of the System Manager role.
"""

import os
from functools import wraps

import frappe

from mobility_developer_tools.studio.container import get_container
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

	return wrapper


def has_app_permission() -> bool:
	"""Used by the apps screen tile."""
	return get_container().access.is_allowed()


# -- session ------------------------------------------------------------------


@frappe.whitelist(methods=["POST"])
def status():
	c = get_container()
	c.access.ensure_allowed()
	return {
		"user": frappe.session.user,
		"unlocked": c.sessions.is_unlocked(_token(), frappe.session.user, frappe.session.sid),
	}


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
	return {
		**result,
		"root": c.config.root,
		"root_name": c.config.root.rstrip("/").rsplit("/", 1)[-1],
		"site": frappe.local.site,
	}


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
def write_file(path: str, content: str, expected_mtime: float | None = None):
	c = get_container()
	result = c.files.write(path, content, expected_mtime)
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
