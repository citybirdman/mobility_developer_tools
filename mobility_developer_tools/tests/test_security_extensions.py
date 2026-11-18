"""Security of the extension pipeline: untrusted .vsix packages, registry downloads,
extension files served to the page, and values that end up in CSS."""

import base64
import json
import os
import shutil
import tempfile
import zipfile

from mobility_developer_tools.studio.exceptions import StudioCommandError, StudioPathError
from mobility_developer_tools.studio.extensions import jsonc
from mobility_developer_tools.studio.extensions.checker import CompatibilityChecker, scan_api_usage
from mobility_developer_tools.studio.extensions.openvsx import OpenVsxClient, _check_url
from mobility_developer_tools.studio.extensions.service import ExtensionService
from mobility_developer_tools.studio.extensions.store import ExtensionStore
from mobility_developer_tools.studio.extensions.vsix import VsixArchive, VsixError
from mobility_developer_tools.tests.base import StudioTestCase
from mobility_developer_tools.tests.vsix_factory import make_vsix, symlink_entry, theme_package, web_package


class TestVsixSafety(StudioTestCase):
	def test_rejects_traversal_and_absolute_paths(self):
		for name in ("extension/../../evil.sh", "extension/a/../../evil", "extension//etc/passwd", "extension/C:/x"):
			with self.subTest(name=name), self.assertRaises(VsixError):
				VsixArchive(make_vsix({}, raw_entries=[(zipfile.ZipInfo(name), b"x")]))

	def test_rejects_symlinks(self):
		with self.assertRaises(VsixError):
			VsixArchive(make_vsix({}, raw_entries=[symlink_entry("extension/link", "/etc/passwd")]))

	def test_rejects_zip_bombs(self):
		bomb = zipfile.ZipInfo("extension/bomb.txt")
		bomb.compress_type = zipfile.ZIP_DEFLATED
		with self.assertRaises(VsixError):
			VsixArchive(make_vsix({}, raw_entries=[(bomb, b"0" * (20 * 1024 * 1024))]))

	def test_rejects_non_extensions(self):
		for data in (b"not a zip", make_vsix({})[:100]):
			with self.subTest(), self.assertRaises(VsixError):
				VsixArchive(data)
		buffer = __import__("io").BytesIO()
		with zipfile.ZipFile(buffer, "w") as z:
			z.writestr("readme.txt", "no package.json")
		with self.assertRaises(VsixError):
			VsixArchive(buffer.getvalue())

	def test_files_outside_extension_folder_are_ignored(self):
		archive = VsixArchive(make_vsix({"a.json": {}}, raw_entries=[(zipfile.ZipInfo("../../outside.txt"), b"x")]))
		self.assertNotIn("../../outside.txt", archive.files)
		self.assertEqual(sorted(archive.files), ["a.json", "package.json"])

	def test_jsonc(self):
		self.assertEqual(jsonc.loads('{"a": "// not a comment", /* c */ "b": [1, 2,], // x\n}'), {"a": "// not a comment", "b": [1, 2]})
		self.assertEqual(jsonc.loads('{"url": "http://x/*y*/", }'), {"url": "http://x/*y*/"})


class TestCheckerSafety(StudioTestCase):
	def check(self, data):
		return CompatibilityChecker().check(VsixArchive(data))

	def test_theme_colors_cannot_inject_css(self):
		theme = {
			"colors": {"editor.background": "red;} body{display:none", "sideBar.background": "url(https://evil)", "ok": "#123456"},
			"tokenColors": [{"scope": "x", "settings": {"foreground": "expression(alert(1))", "fontStyle": "italic; color:red"}}],
		}
		result = self.check(make_vsix({"t.json": theme}, {"contributes": {"themes": [{"label": "Evil", "path": "t.json"}]}}))
		data = result.resources["theme-0.json"]
		self.assertEqual(data["colors"], {"ok": "#123456"})
		self.assertEqual(data["tokenColors"], [])

	def test_contribution_paths_cannot_escape_the_extension(self):
		icons = {
			"iconDefinitions": {"a": {"iconPath": "../../../../etc/passwd"}, "b": {"iconPath": "./ok.svg"}},
			"fonts": [{"id": "f", "src": [{"path": "../../secret.woff", "format": "woff"}]}],
			"file": "a",
			"fileExtensions": {"py": "b"},
		}
		pkg = {
			"contributes": {
				"iconThemes": [{"id": "i", "label": "I", "path": "icons/theme.json"}],
				"grammars": [{"language": "x", "scopeName": "source.x", "path": "../../etc/passwd"}],
				"themes": [{"label": "T", "path": "/etc/passwd"}],
			}
		}
		result = self.check(make_vsix({"icons/theme.json": icons, "icons/ok.svg": "<svg/>"}, pkg))
		normalized = result.resources["icon-theme-0.json"]
		self.assertEqual(normalized["definitions"], {"b": {"path": "icons/ok.svg"}})
		self.assertEqual(normalized["fonts"], [])
		self.assertNotIn("file", normalized)  # pointed at a dropped definition
		self.assertEqual(result.manifest["contributes"].get("grammars", []), [])  # escaping grammar dropped
		self.assertEqual(result.manifest["contributes"].get("themes"), [])

	def test_browser_entry_must_stay_inside(self):
		result = self.check(make_vsix({}, {"browser": "../../../etc/passwd", "contributes": {}}))
		self.assertIsNone(result.manifest["browser"])
		self.assertEqual(result.report["code"]["status"], "cannot-run")

	def test_api_scan(self):
		code = "const v=require('vscode');v.window.showInformationMessage('x');v.window.createWebviewPanel();" \
			"ast.comments.push(1);v.debug.startDebugging();v.languages.registerHoverProvider();"
		apis = scan_api_usage(code)
		self.assertIn("window.showInformationMessage", apis["supported"])
		self.assertIn("languages.registerHoverProvider", apis["supported"])
		self.assertIn("window.createWebviewPanel", apis["unsupported"])
		self.assertIn("debug.startDebugging", apis["unsupported"])
		self.assertNotIn("comments.push", apis["unsupported"])  # an ordinary array, not vscode.comments

	def test_verdicts(self):
		self.assertEqual(self.check(theme_package()).report["verdict"], "works")
		web_ok = self.check(web_package("exports.activate=(c)=>{require('vscode').window.showInformationMessage('hi')}"))
		self.assertEqual((web_ok.report["verdict"], web_ok.report["level"]), ("works", 2))
		noop = self.check(web_package("exports.activate=async()=>{}", {"commands": [{"command": "x.run", "title": "Run"}]}))
		self.assertEqual(noop.report["code"]["status"], "noop")
		self.assertNotIn("commands", noop.manifest["contributes"])
		desktop = self.check(make_vsix({"main.js": "x"}, {"main": "./main.js", "contributes": {}}))
		self.assertEqual(desktop.report["verdict"], "unsupported")
		partial = self.check(web_package("v.window.createTerminal();v.window.showErrorMessage()"))
		self.assertEqual(partial.report["verdict"], "partial")

	def test_commands_only_counted_when_the_web_code_registers_them(self):
		code = "v.commands.registerCommand('x.one', ()=>{})"
		result = self.check(web_package(code, {"commands": [{"command": "x.one", "title": "One"}, {"command": "x.two", "title": "Two"}]}))
		self.assertEqual([c["command"] for c in result.manifest["contributes"]["commands"]], ["x.one"])

	def test_nls_placeholders(self):
		data = make_vsix(
			{"package.nls.json": {"cmd.title": "Say Hello"}, "dist/web.js": "v.commands.registerCommand('x.hi')"},
			{"browser": "./dist/web.js", "contributes": {"commands": [{"command": "x.hi", "title": "%cmd.title%"}]}},
		)
		self.assertEqual(self.check(data).manifest["contributes"]["commands"][0]["title"], "Say Hello")

	def test_invalid_extension_id(self):
		with self.assertRaises(VsixError):
			self.check(make_vsix({}, {"publisher": "../..", "name": "x"}))


class FakeRegistry:
	def __init__(self, files, download=b"", checksum=None):
		self.files, self.download, self.checksum = files, download, checksum

	def __call__(self, url, max_bytes):
		if url.endswith("/latest") or "/1.0.0" in url and "file" not in url:
			return json.dumps({"files": self.files, "version": "1.0.0"}).encode()
		if url == self.files.get("download"):
			return self.download
		if url == self.files.get("sha256"):
			return (self.checksum or "").encode()
		raise AssertionError(f"unexpected fetch {url}")


class TestRegistrySafety(StudioTestCase):
	def test_only_open_vsx_hosts(self):
		for url in ("http://open-vsx.org/x", "https://evil.example/x.vsix", "https://open-vsx.org.evil.com/x", "file:///etc/passwd", "https://169.254.169.254/latest"):
			with self.subTest(url=url), self.assertRaises(VsixError):
				_check_url(url)
		_check_url("https://open-vsx.org/api/x")
		_check_url("https://openvsx.eclipsecontent.org/x.vsix")

	def test_download_from_foreign_host_refused(self):
		files = {"download": "https://evil.example/x.vsix", "sha256": "https://open-vsx.org/x.sha256"}
		with self.assertRaises(VsixError):
			OpenVsxClient(FakeRegistry(files)).download("tester", "sample")

	def test_checksum_must_match(self):
		data = theme_package()
		files = {"download": "https://open-vsx.org/a.vsix", "sha256": "https://open-vsx.org/a.sha256"}
		with self.assertRaises(VsixError):
			OpenVsxClient(FakeRegistry(files, data, "0" * 64)).download("tester", "sample")
		with self.assertRaises(VsixError):
			OpenVsxClient(FakeRegistry({"download": files["download"]}, data)).download("tester", "sample")  # no checksum
		import hashlib

		good = OpenVsxClient(FakeRegistry(files, data, hashlib.sha256(data).hexdigest()))
		self.assertEqual(good.download("tester", "sample")[0], data)

	def test_names_are_validated(self):
		for ns, name in (("../x", "y"), ("a/b", "c"), ("ok", "x?y=1"), ("", "x"), ("ok", "%2e%2e")):
			with self.subTest(ns=ns, name=name), self.assertRaises(VsixError):
				OpenVsxClient(lambda *a: b"{}").metadata(ns, name)


class TestStoreSafety(StudioTestCase):
	def setUp(self):
		self.root = tempfile.mkdtemp(prefix="mdt-ext-")
		self.addCleanup(shutil.rmtree, self.root, ignore_errors=True)
		self.store = ExtensionStore(self.root)
		self.service = ExtensionService(self.store, OpenVsxClient(lambda *a: b"{}"), CompatibilityChecker())
		self.service.install_upload(base64.b64encode(theme_package()).decode())

	def test_files_are_confined_to_the_extension(self):
		with open(os.path.join(self.root, "secret.txt"), "w") as f:
			f.write("secret")
		files = self.store.read_files("tester.sample", ["../secret.txt", "../state.json", "/etc/passwd", "package.json", "themes/t.json"])
		self.assertIsNone(files["../secret.txt"])
		self.assertIsNone(files["../state.json"])
		self.assertIsNone(files["/etc/passwd"])
		self.assertIn("tester", files["package.json"])

	def test_extension_ids_are_validated(self):
		for ext_id in ("../tester.sample", "tester.sample/../..", "TESTER.sample", "", "a"):
			with self.subTest(ext_id=ext_id), self.assertRaises(StudioPathError):
				self.store.read_files(ext_id, ["package.json"])

	def test_batch_limits(self):
		with self.assertRaises(StudioPathError):
			self.store.read_files("tester.sample", ["package.json"] * 301 + ["x"])
		with self.assertRaises(StudioPathError):
			self.store.read_files("tester.sample", "package.json")

	def test_settings_validation(self):
		with self.assertRaises(StudioCommandError):
			self.store.set_settings("tester.sample", ["not", "a", "dict"])
		with self.assertRaises(StudioCommandError):
			self.store.set_settings("tester.sample", {"x": "y" * 300_000})
		self.store.set_settings("tester.sample", {"a": 1})
		self.assertEqual(self.store.state("tester.sample")["settings"], {"a": 1})

	def test_upload_validation_and_refusal(self):
		with self.assertRaises(StudioCommandError):
			self.service.install_upload("not base64 !!!")
		with self.assertRaises(StudioCommandError):
			self.service.install_upload("A" * (19 * 1024 * 1024 * 4 // 3))
		desktop_only = make_vsix({"main.js": "x"}, {"name": "desk", "main": "./main.js", "contributes": {}})
		with self.assertRaises(StudioCommandError):
			self.service.install_upload(base64.b64encode(desktop_only).decode())  # nothing usable: refused
		self.assertNotIn("tester.desk", self.store.ids())

	def test_install_is_atomic_and_uninstall_cleans_up(self):
		self.service.install_upload(base64.b64encode(theme_package(version="2.0.0")).decode())
		self.assertEqual(self.store.manifest("tester.sample")["version"], "2.0.0")
		self.assertFalse(any(n.startswith(".install-") or n.endswith(".old") for n in os.listdir(self.root)))
		self.service.uninstall("tester.sample")
		self.assertEqual(self.store.ids(), [])
		self.assertNotIn("tester.sample", self.store._state())


class TestPreferenceEndpoint(StudioTestCase):
	def test_only_known_preferences(self):
		from unittest.mock import patch

		import frappe

		from mobility_developer_tools.studio import api
		from mobility_developer_tools.studio.container import get_container
		from mobility_developer_tools.studio.security.session import StudioSessionService

		frappe.local._mdt_studio_container = None
		c = get_container()
		sessions = StudioSessionService(c.store, c.config, verify_password=lambda u, p: None)
		token = sessions.unlock(frappe.session.user, frappe.session.sid, "x")["token"]
		self.addCleanup(sessions.lock, token)
		with patch.object(api, "_token", return_value=token):
			for key, value in (("password", "x"), ("color_theme", "x" * 301)):
				with self.subTest(key=key), self.assertRaises(frappe.ValidationError):
					api.ext_set_preference(key, value)
