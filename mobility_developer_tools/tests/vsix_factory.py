"""Builds .vsix packages in memory for tests."""

from __future__ import annotations

import io
import json
import stat
import zipfile


def make_vsix(files: dict[str, str | bytes | dict], package: dict | None = None, raw_entries: list | None = None) -> bytes:
	"""files: path (inside extension/) -> content (dict = JSON). raw_entries: (ZipInfo, bytes) added as-is."""
	pkg = {"name": "sample", "publisher": "tester", "version": "1.0.0", "displayName": "Sample", **(package or {})}
	buffer = io.BytesIO()
	with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as z:
		z.writestr("extension.vsixmanifest", "<PackageManifest/>")
		z.writestr("extension/package.json", json.dumps(pkg))
		for path, content in files.items():
			if isinstance(content, dict | list):
				content = json.dumps(content)
			z.writestr(f"extension/{path}", content)
		for info, data in raw_entries or []:
			z.writestr(info, data)
	return buffer.getvalue()


def symlink_entry(name: str, target: str):
	info = zipfile.ZipInfo(name)
	info.external_attr = (stat.S_IFLNK | 0o777) << 16
	return info, target.encode()


THEME = {
	"colors": {"editor.background": "#282a36", "sideBar.background": "#21222c"},
	"tokenColors": [{"scope": ["comment"], "settings": {"foreground": "#6272a4", "fontStyle": "italic"}}],
}


def theme_package(**pkg):
	return make_vsix(
		{"themes/t.json": THEME},
		{"contributes": {"themes": [{"label": "Test Dark", "uiTheme": "vs-dark", "path": "./themes/t.json"}]}, **pkg},
	)


def web_package(code: str, contributes: dict | None = None, **pkg):
	return make_vsix({"dist/web.js": code}, {"browser": "./dist/web.js", "contributes": contributes or {}, **pkg})
