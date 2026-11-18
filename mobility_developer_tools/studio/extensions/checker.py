"""Compatibility checker + manifest builder.

Given a .vsix it answers, before anything is installed: what will work in the
studio, what partly works and what will not, and why. The same analysis produces
the normalized manifest the browser uses after installation.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass, field

from mobility_developer_tools.studio.extensions.contributions import (
	IGNORED,
	PARTIAL,
	SUPPORTED,
	UNSUPPORTED,
	ContributionReader,
	PackageView,
	PointReport,
	default_readers,
)
from mobility_developer_tools.studio.extensions.vsix import VsixArchive, normalize, safe_relative_path

with open(os.path.join(os.path.dirname(__file__), "api_support.json")) as _f:
	API_SUPPORT = json.load(_f)
MAX_CODE_BYTES = 15 * 1024 * 1024
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9._-]*$")

NAMESPACE_RE = re.compile(
	r"\.(" + "|".join([*API_SUPPORT["namespaces"], *API_SUPPORT["unsupported_namespaces"]]) + r")\.([A-Za-z_$][\w$]*)"
)
BLOCKERS = [
	(re.compile(r"vscode-languageclient|new\s+[\w$.]*LanguageClient\s*\("), "starts a language server (not available in the studio)"),
	(re.compile(r"\bnew\s+Worker\s*\("), "starts background workers from its own files"),
	(re.compile(r"\brequire\(\s*[\"'](?:node:)?(fs|child_process|net|http|https|os|crypto|tls|dgram|worker_threads)[\"']\s*\)"), "uses Node.js modules"),
	(re.compile(r"\bimportScripts\s*\("), "loads extra scripts at runtime"),
]


@dataclass
class CheckResult:
	extension_id: str
	package: dict
	manifest: dict
	report: dict
	resources: dict = field(default_factory=dict)


class CompatibilityChecker:
	def __init__(self, readers: list[ContributionReader] | None = None):
		self._readers = {r.point: r for r in (readers or default_readers())}

	def check(self, archive: VsixArchive) -> CheckResult:
		pkg_json = _apply_nls(archive.package_json, archive)
		ext_id = f"{pkg_json['publisher']}.{pkg_json['name']}".lower()
		if not ID_RE.match(ext_id):
			from mobility_developer_tools.studio.extensions.vsix import VsixError

			raise VsixError(f"Invalid extension id: {ext_id}")

		view = PackageView(archive)
		contributions, points = {}, []
		for point, value in (pkg_json.get("contributes") or {}).items():
			reader = self._readers.get(point)
			if reader is None:
				points.append(PointReport(point, UNSUPPORTED, _count(value), "not available in the studio"))
				continue
			try:
				data, report = reader.read(value, view)
			except Exception as e:
				data, report = None, PointReport(point, UNSUPPORTED, _count(value), f"could not be read: {type(e).__name__}")
			if data is not None:
				contributions[point] = data
			points.append(report)

		code = self._check_code(archive, pkg_json)
		source = code.pop("source", "")
		runs = code["status"] in ("runs", "runs-partially")
		if runs:
			_keep_registered_commands(contributions, points, source)
		for report in points:
			if report.needs_code and not runs:
				report.status = UNSUPPORTED
				report.detail = "needs the extension's code, which cannot run here"
			elif report.point == "configuration" and not runs:
				report.status = IGNORED
				report.detail = "only used by the extension's code"
		if not runs:
			contributions.pop("commands", None)
			contributions.pop("keybindings", None)

		report = _verdict(points, code)
		manifest = {
			"id": ext_id,
			"publisher": str(pkg_json["publisher"])[:100],
			"name": str(pkg_json["name"])[:100],
			"display_name": _display(pkg_json.get("displayName")) or str(pkg_json["name"]),
			"description": _display(pkg_json.get("description"))[:500],
			"version": str(pkg_json.get("version") or "0.0.0")[:50],
			"icon": _safe_path(archive, pkg_json.get("icon")),
			"browser": code.get("entry") if code["status"] in ("runs", "runs-partially") else None,
			"activation_events": [e for e in pkg_json.get("activationEvents") or [] if isinstance(e, str)][:100],
			"contributes": contributions,
		}
		return CheckResult(ext_id, pkg_json, manifest, report, view.resources)

	def _check_code(self, archive: VsixArchive, pkg: dict) -> dict:
		browser, main = pkg.get("browser"), pkg.get("main")
		if not browser:
			if main:
				return {"status": "cannot-run", "entry": None, "detail": "only has a desktop (Node.js) build", "apis": {}, "blockers": []}
			return {"status": "none", "entry": None, "detail": "no code (declarative only)", "apis": {}, "blockers": []}

		entry = _find_entry(archive, browser)
		if not entry:
			return {"status": "cannot-run", "entry": None, "detail": f"browser entry {browser} is missing", "apis": {}, "blockers": []}
		try:
			source = archive.read(entry, limit=MAX_CODE_BYTES).decode("utf-8", errors="replace")
		except Exception:
			return {"status": "cannot-run", "entry": None, "detail": "browser code is too large", "apis": {}, "blockers": []}

		apis = scan_api_usage(source)
		blockers = sorted({message for pattern, message in BLOCKERS if pattern.search(source)})
		if not apis["supported"] and not apis["unsupported"]:
			# e.g. a stub `activate() {}`: the real code is desktop-only
			return {"status": "noop", "entry": None, "detail": "the web build does nothing in the browser", "apis": apis, "blockers": [], "source": source}
		status = "runs-partially" if apis["unsupported"] or blockers else "runs"
		return {"status": status, "entry": entry, "detail": "web build", "apis": apis, "blockers": blockers, "source": source}


def scan_api_usage(source: str) -> dict:
	"""Which vscode.* APIs a (possibly minified) bundle uses, split into supported / unsupported.

	Minifiers rename the `vscode` variable but keep property names, so we look for
	`.window.showInformationMessage`-style chains and only count known API names."""
	namespaces = API_SUPPORT["namespaces"]
	supported, unsupported = set(), set()
	for namespace, member in NAMESPACE_RE.findall(source):
		name = f"{namespace}.{member}"
		if namespace in API_SUPPORT["unsupported_namespaces"]:
			# only real API names: `.comments.push` on an ordinary array is not vscode.comments
			if member in API_SUPPORT["unsupported_namespaces"][namespace]:
				unsupported.add(name)
		elif namespace in namespaces and member in namespaces[namespace]["supported"]:
			supported.add(name)
		elif member in namespaces[namespace]["unsupported"]:
			unsupported.add(name)
	return {"supported": sorted(supported), "unsupported": sorted(unsupported)}


def _verdict(points: list[PointReport], code: dict) -> dict:
	usable = [p for p in points if p.status in (SUPPORTED, PARTIAL)]
	missing = [p for p in points if p.status == UNSUPPORTED]
	partial = [p for p in points if p.status == PARTIAL]
	code_ok = code["status"] in ("none", "runs")  # "noop" / "cannot-run" mean code features are lost
	code_runs = code["status"] in ("runs", "runs-partially")

	if (usable or code_runs) and not missing and not partial and code_ok:
		verdict = "works"
	elif usable or code_runs:
		verdict = "partial"
	else:
		verdict = "unsupported"

	level = 2 if code_runs else 1
	works = [_describe(p) for p in points if p.status in (SUPPORTED, PARTIAL)]
	language_server = any("language server" in b for b in code.get("blockers", []))
	if code_runs and language_server:
		works.append("Extension code starts, but its language server cannot run: most of its smart features will be missing")
	elif code_runs:
		works.append(f"Extension code runs in a sandbox (uses {len(code['apis'].get('supported', []))} supported API(s))")
	not_working = [_describe(p) for p in missing]
	if code["status"] in ("cannot-run", "noop"):
		not_working.append(f"Extension code: {code['detail']}")
	for api in code.get("apis", {}).get("unsupported", []):
		not_working.append(f"API not available: vscode.{api}")
	for blocker in code.get("blockers", []):
		not_working.append(f"The extension {blocker}")

	return {
		"verdict": verdict,
		"level": level,
		"summary": _summary(verdict, level, works, not_working),
		"works": works,
		"not_working": not_working,
		"points": [p.as_dict() for p in points if p.status != IGNORED] + [p.as_dict() for p in points if p.status == IGNORED],
		"code": code,
	}


def _summary(verdict, level, works, not_working) -> str:
	if verdict == "works":
		return "Everything in this extension works in the studio." + (" Its code runs in a sandbox." if level == 2 else "")
	if verdict == "partial":
		return f"Partly supported: {len(works)} feature(s) work, {len(not_working)} will not."
	return "Nothing in this extension can work in the studio."


def _describe(p: PointReport) -> str:
	label = {
		"themes": "Color themes",
		"iconThemes": "File icon themes",
		"grammars": "Syntax highlighting grammars",
		"languages": "Languages",
		"snippets": "Snippets",
		"configuration": "Settings",
		"commands": "Commands",
		"keybindings": "Keyboard shortcuts",
	}.get(p.point, p.point)
	text = f"{label} ({p.count})" if p.count else label
	return f"{text}: {p.detail}" if p.detail else text


def _count(value) -> int:
	return len(value) if isinstance(value, list | dict) else 1


def _find_entry(archive: VsixArchive, entry: str) -> str | None:
	base = normalize(entry)
	if not safe_relative_path(base):
		return None
	for candidate in (base, base + ".js", base + ".cjs", base + "/index.js"):
		if archive.exists(candidate):
			return candidate
	return None


def _safe_path(archive: VsixArchive, rel) -> str | None:
	if not isinstance(rel, str):
		return None
	path = normalize(rel)
	return path if safe_relative_path(path) and archive.exists(path) else None


def _display(value) -> str:
	return str(value or "")[:200]


def _apply_nls(pkg: dict, archive: VsixArchive) -> dict:
	"""Replace "%key%" placeholders with English strings from package.nls.json."""
	if not archive.exists("package.nls.json"):
		return pkg
	try:
		from mobility_developer_tools.studio.extensions import jsonc

		nls = jsonc.loads(archive.read("package.nls.json"))
	except Exception:
		return pkg

	def resolve(value):
		if isinstance(value, str) and len(value) > 2 and value.startswith("%") and value.endswith("%"):
			found = nls.get(value[1:-1], value)
			return found.get("message", value) if isinstance(found, dict) else found
		if isinstance(value, list):
			return [resolve(v) for v in value]
		if isinstance(value, dict):
			return {k: resolve(v) for k, v in value.items()}
		return value

	return resolve(pkg)


def _keep_registered_commands(contributions: dict, points: list[PointReport], source: str) -> None:
	"""A contributed command only works if the web build registers it (its id appears in the code)."""
	commands = contributions.get("commands") or []
	registered = [c for c in commands if c["command"] in source]
	if len(registered) == len(commands):
		return
	contributions["commands"] = registered
	ids = {c["command"] for c in registered}
	if "keybindings" in contributions:
		contributions["keybindings"] = [k for k in contributions["keybindings"] if k["command"] in ids]
	for report in points:
		if report.point == "commands":
			missing = len(commands) - len(registered)
			report.count = len(registered)
			report.status = PARTIAL if registered else UNSUPPORTED
			report.detail = f"{missing} command(s) exist only in the desktop build" + (", the rest are in the command palette (F1)" if registered else "")
