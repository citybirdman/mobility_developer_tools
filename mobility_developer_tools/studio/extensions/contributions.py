"""Readers for `package.json > contributes` sections (one class per contribution point).

Each reader validates and normalizes its section into data the browser can apply
directly, and reports how well the studio supports it. Readers never execute
extension code. Add support for a new point by registering another reader.
"""

from __future__ import annotations

import plistlib
import posixpath
import re
from abc import ABC, abstractmethod
from dataclasses import dataclass, field

from mobility_developer_tools.studio.extensions import jsonc
from mobility_developer_tools.studio.extensions.vsix import VsixArchive, normalize, safe_relative_path

HEX_COLOR = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
SUPPORTED, PARTIAL, UNSUPPORTED, IGNORED = "supported", "partial", "unsupported", "ignored"
MAX_TOKEN_RULES = 5000
MAX_SNIPPETS = 5000
MAX_SETTINGS = 500


@dataclass
class PointReport:
	point: str
	status: str
	count: int = 0
	detail: str = ""
	needs_code: bool = False

	def as_dict(self):
		return {"point": self.point, "status": self.status, "count": self.count, "detail": self.detail}


@dataclass
class PackageView:
	"""Read-only view of an extension package plus generated resources."""

	archive: VsixArchive
	resources: dict[str, object] = field(default_factory=dict)  # name -> JSON, written to .studio/<name>

	def resolve(self, base_file: str, rel: str) -> str | None:
		"""Path of `rel` relative to `base_file`, normalized to the extension root (None if unsafe/missing)."""
		if not isinstance(rel, str) or not rel:
			return None
		path = normalize(posixpath.join(posixpath.dirname(normalize(base_file)), rel))
		return path if safe_relative_path(path) and self.archive.exists(path) else None

	def read_json(self, path: str):
		return jsonc.loads(self.archive.read(path))

	def add_resource(self, name: str, data) -> str:
		self.resources[name] = data
		return f".studio/{name}"


class ContributionReader(ABC):
	point: str = ""

	@abstractmethod
	def read(self, value, pkg: PackageView) -> tuple[object, PointReport]:
		"""Return (normalized data, report)."""


# -- level 1: declarative ------------------------------------------------------------------


class ThemesReader(ContributionReader):
	point = "themes"
	UI_THEMES = {"vs": "vs", "vs-dark": "vs-dark", "hc-black": "hc-black", "hc-light": "hc-light"}

	def read(self, value, pkg):
		themes, skipped = [], 0
		for index, entry in enumerate(_as_list(value)):
			path = pkg.resolve("package.json", entry.get("path"))
			if not path:
				skipped += 1
				continue
			try:
				colors, token_colors = self._load(pkg, path, depth=0)
			except Exception:
				skipped += 1
				continue
			label = str(entry.get("label") or entry.get("id") or f"Theme {index + 1}")[:100]
			themes.append(
				{
					"id": str(entry.get("id") or label)[:100],
					"label": label,
					"base": self.UI_THEMES.get(entry.get("uiTheme"), "vs-dark"),
					"resource": pkg.add_resource(
						f"theme-{index}.json", {"colors": colors, "tokenColors": token_colors[:MAX_TOKEN_RULES]}
					),
				}
			)
		status = SUPPORTED if themes and not skipped else (PARTIAL if themes else UNSUPPORTED)
		detail = ", ".join(t["label"] for t in themes[:5]) + (f" ({skipped} could not be read)" if skipped else "")
		return themes, PointReport(self.point, status, len(themes), detail)

	def _load(self, pkg, path, depth):
		if depth > 5:
			raise ValueError("include depth")
		if path.lower().endswith((".tmtheme", ".plist")):
			return _tmtheme(pkg.archive.read(path))
		data = pkg.read_json(path)
		colors, token_colors = {}, []
		if isinstance(data.get("include"), str):
			include = pkg.resolve(path, data["include"])
			if include:
				colors, token_colors = self._load(pkg, include, depth + 1)
		colors.update(_valid_colors(data.get("colors")))
		tc = data.get("tokenColors")
		if isinstance(tc, str):
			tm_path = pkg.resolve(path, tc)
			if tm_path:
				extra_colors, rules = _tmtheme(pkg.archive.read(tm_path))
				colors = {**extra_colors, **colors}
				token_colors += rules
		elif isinstance(tc, list):
			token_colors += _token_rules(tc)
		return colors, token_colors


class IconThemesReader(ContributionReader):
	point = "iconThemes"
	MAP_KEYS = ("fileExtensions", "fileNames", "folderNames", "folderNamesExpanded", "languageIds")
	SINGLE_KEYS = ("file", "folder", "folderExpanded", "rootFolder", "rootFolderExpanded")

	def read(self, value, pkg):
		themes = []
		for index, entry in enumerate(_as_list(value)):
			path = pkg.resolve("package.json", entry.get("path"))
			if not path:
				continue
			try:
				data = self._normalize(pkg, path, pkg.read_json(path))
			except Exception:
				continue
			label = str(entry.get("label") or entry.get("id") or f"Icons {index + 1}")[:100]
			themes.append(
				{"id": str(entry.get("id") or label)[:100], "label": label, "resource": pkg.add_resource(f"icon-theme-{index}.json", data)}
			)
		status = SUPPORTED if themes else UNSUPPORTED
		return themes, PointReport(self.point, status, len(themes), ", ".join(t["label"] for t in themes))

	def _normalize(self, pkg, path, data):
		definitions = {}
		for key, d in (data.get("iconDefinitions") or {}).items():
			if not isinstance(d, dict):
				continue
			if d.get("iconPath"):
				icon = pkg.resolve(path, d["iconPath"])
				if icon:
					definitions[key] = {"path": icon}
			elif d.get("fontCharacter"):
				definitions[key] = {
					"char": str(d["fontCharacter"])[:8],
					"color": d.get("fontColor") if HEX_COLOR.match(str(d.get("fontColor", ""))) else None,
					"font": str(d.get("fontId") or "")[:60] or None,
					"size": str(d.get("fontSize") or "")[:10] or None,
				}
		fonts = []
		for font in data.get("fonts") or []:
			sources = [
				{"path": src_path, "format": str(src.get("format") or "woff")[:20]}
				for src in font.get("src") or []
				if (src_path := pkg.resolve(path, src.get("path")))
			]
			if sources:
				fonts.append({"id": str(font.get("id"))[:60], "src": sources, "size": str(font.get("size") or "")[:10] or None})

		def section(source):
			out = {k: source[k] for k in self.SINGLE_KEYS if isinstance(source.get(k), str) and source[k] in definitions}
			for k in self.MAP_KEYS:
				mapping = source.get(k) or {}
				out[k] = {str(name).lower(): icon for name, icon in mapping.items() if icon in definitions}
			return out

		normalized = {"definitions": definitions, "fonts": fonts, **section(data)}
		if isinstance(data.get("light"), dict):
			normalized["light"] = section(data["light"])
		normalized["hidesExplorerArrows"] = bool(data.get("hidesExplorerArrows"))
		return normalized


class GrammarsReader(ContributionReader):
	point = "grammars"

	def read(self, value, pkg):
		grammars = []
		for entry in _as_list(value):
			path = pkg.resolve("package.json", entry.get("path"))
			scope = entry.get("scopeName")
			if not path or not isinstance(scope, str):
				continue
			grammars.append(
				{
					"language": entry.get("language") if isinstance(entry.get("language"), str) else None,
					"scopeName": scope[:200],
					"path": path,
					"embeddedLanguages": _str_dict(entry.get("embeddedLanguages")),
					"injectTo": [s for s in _as_list(entry.get("injectTo")) if isinstance(s, str)],
				}
			)
		status = SUPPORTED if grammars else UNSUPPORTED
		return grammars, PointReport(self.point, status, len(grammars), ", ".join(sorted({g["scopeName"] for g in grammars})[:6]))


class LanguagesReader(ContributionReader):
	point = "languages"

	def read(self, value, pkg):
		languages = []
		for entry in _as_list(value):
			lang_id = entry.get("id")
			if not isinstance(lang_id, str) or not re.match(r"^[\w.+#-]{1,80}$", lang_id):
				continue
			config = None
			config_path = pkg.resolve("package.json", entry.get("configuration"))
			if config_path:
				try:
					config = pkg.read_json(config_path)
				except Exception:
					config = None
			languages.append(
				{
					"id": lang_id,
					"aliases": [a for a in _as_list(entry.get("aliases")) if isinstance(a, str)][:10],
					"extensions": [e for e in _as_list(entry.get("extensions")) if isinstance(e, str)][:50],
					"filenames": [f for f in _as_list(entry.get("filenames")) if isinstance(f, str)][:50],
					"firstLine": entry.get("firstLine") if isinstance(entry.get("firstLine"), str) else None,
					"configuration": config if isinstance(config, dict) else None,
				}
			)
		status = SUPPORTED if languages else UNSUPPORTED
		return languages, PointReport(self.point, status, len(languages), ", ".join(l["id"] for l in languages[:8]))


class SnippetsReader(ContributionReader):
	point = "snippets"

	def read(self, value, pkg):
		files, total = [], 0
		for index, entry in enumerate(_as_list(value)):
			path = pkg.resolve("package.json", entry.get("path"))
			if not path:
				continue
			try:
				raw = pkg.read_json(path)
			except Exception:
				continue
			snippets = []
			for name, snip in (raw or {}).items():
				if not isinstance(snip, dict) or "body" not in snip or total >= MAX_SNIPPETS:
					continue
				prefixes = [p for p in _as_list(snip.get("prefix", name)) if isinstance(p, str)]
				body = snip["body"]
				body = "\n".join(str(b) for b in body) if isinstance(body, list) else str(body)
				snippets.append({"name": str(name)[:200], "prefix": prefixes[:10], "body": body[:20000], "description": str(snip.get("description") or "")[:500]})
				total += 1
			languages = [entry["language"]] if isinstance(entry.get("language"), str) else ["*"]
			files.append({"languages": languages, "count": len(snippets), "resource": pkg.add_resource(f"snippets-{index}.json", snippets)})
		status = SUPPORTED if total else UNSUPPORTED
		return files, PointReport(self.point, status, total, ", ".join(sorted({l for f in files for l in f["languages"]})[:8]))


class ConfigurationReader(ContributionReader):
	point = "configuration"

	def read(self, value, pkg):
		settings = {}
		for block in _as_list(value):
			for key, schema in ((block or {}).get("properties") or {}).items():
				if len(settings) >= MAX_SETTINGS or not isinstance(schema, dict):
					continue
				settings[str(key)[:200]] = {
					"type": schema.get("type"),
					"default": schema.get("default"),
					"description": str(schema.get("description") or schema.get("markdownDescription") or "")[:500],
					"enum": schema.get("enum") if isinstance(schema.get("enum"), list) else None,
				}
		return settings, PointReport(self.point, SUPPORTED if settings else IGNORED, len(settings), "editable in the extension's Settings")


# -- needs the extension's code -----------------------------------------------------------


class CommandsReader(ContributionReader):
	point = "commands"

	def read(self, value, pkg):
		commands = []
		for entry in _as_list(value):
			if not isinstance(entry.get("command"), str):
				continue
			commands.append(
				{
					"command": entry["command"][:200],
					"title": _text(entry.get("title"))[:200] or entry["command"],
					"category": _text(entry.get("category"))[:100],
				}
			)
		return commands, PointReport(self.point, SUPPORTED, len(commands), "in the command palette (F1)", needs_code=True)


class KeybindingsReader(ContributionReader):
	point = "keybindings"

	def read(self, value, pkg):
		bindings = [
			{"command": e["command"][:200], "key": str(e.get("linux") or e.get("key") or "")[:60], "mac": str(e.get("mac") or "")[:60]}
			for e in _as_list(value)
			if isinstance(e, dict) and isinstance(e.get("command"), str) and (e.get("key") or e.get("linux"))
		]
		return bindings, PointReport(self.point, PARTIAL, len(bindings), "'when' conditions are ignored", needs_code=True)


class IgnoredReader(ContributionReader):
	"""Points that are harmless to skip: the rest of the extension still works."""

	def __init__(self, point: str, detail: str):
		self.point = point
		self.detail = detail

	def read(self, value, pkg):
		return None, PointReport(self.point, IGNORED, len(_as_list(value)) if not isinstance(value, dict) else len(value), self.detail)


def default_readers() -> list[ContributionReader]:
	return [
		ThemesReader(),
		IconThemesReader(),
		GrammarsReader(),
		LanguagesReader(),
		SnippetsReader(),
		ConfigurationReader(),
		CommandsReader(),
		KeybindingsReader(),
		IgnoredReader("configurationDefaults", "VS Code-specific defaults"),
		IgnoredReader("menus", "commands are available in the command palette instead"),
		IgnoredReader("submenus", "commands are available in the command palette instead"),
		IgnoredReader("htmlLanguageParticipants", "not needed"),
		IgnoredReader("jsonValidation", "JSON schema validation is not available"),
		IgnoredReader("yamlValidation", "YAML schema validation is not available"),
		IgnoredReader("breakpoints", "no debugger in the studio"),
		IgnoredReader("walkthroughs", "VS Code welcome pages"),
		IgnoredReader("viewsWelcome", "VS Code welcome pages"),
	]


# -- helpers --------------------------------------------------------------------------------


def _as_list(value) -> list:
	if value is None:
		return []
	return value if isinstance(value, list) else [value]


def _text(value) -> str:
	if isinstance(value, dict):
		value = value.get("value") or value.get("original")
	return str(value or "")


def _str_dict(value) -> dict:
	return {str(k)[:200]: str(v)[:80] for k, v in (value or {}).items()} if isinstance(value, dict) else {}


def _valid_colors(colors) -> dict:
	if not isinstance(colors, dict):
		return {}
	return {str(k)[:100]: v for k, v in colors.items() if isinstance(v, str) and HEX_COLOR.match(v)}


def _token_rules(rules) -> list[dict]:
	out = []
	for rule in rules:
		if not isinstance(rule, dict) or not isinstance(rule.get("settings"), dict):
			continue
		scope = rule.get("scope", "")
		scopes = scope if isinstance(scope, list) else [s for s in str(scope).split(",")]
		settings = {}
		for key in ("foreground", "background"):
			if isinstance(rule["settings"].get(key), str) and HEX_COLOR.match(rule["settings"][key]):
				settings[key] = rule["settings"][key]
		font_style = rule["settings"].get("fontStyle")
		if isinstance(font_style, str) and re.match(r"^[a-z ]{0,40}$", font_style):
			settings["fontStyle"] = font_style
		if settings:
			out.append({"scope": [s.strip()[:200] for s in scopes if isinstance(s, str) and s.strip()], "settings": settings})
	return out


def _tmtheme(data: bytes) -> tuple[dict, list]:
	"""TextMate .tmTheme (plist) -> (workbench colors, token rules)."""
	plist = plistlib.loads(data)
	colors, rules = {}, []
	for item in plist.get("settings", []):
		settings = item.get("settings") or {}
		if "scope" not in item:
			mapping = {
				"background": "editor.background",
				"foreground": "editor.foreground",
				"caret": "editorCursor.foreground",
				"selection": "editor.selectionBackground",
				"lineHighlight": "editor.lineHighlightBackground",
			}
			colors.update({mapping[k]: v for k, v in settings.items() if k in mapping and isinstance(v, str) and HEX_COLOR.match(v)})
		else:
			rules += _token_rules([{"scope": item.get("scope"), "settings": settings}])
	return colors, rules
