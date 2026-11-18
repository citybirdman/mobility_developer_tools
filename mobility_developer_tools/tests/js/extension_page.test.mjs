// Tests for the page-side extension logic (themes, icons, keybindings, converters, decorations).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/extensions");
const load = (name) => import(`data:text/javascript;base64,${Buffer.from(readFileSync(join(DIR, name), "utf8")).toString("base64")}`);

const themes = await load("theme_mapping.js");
const icons = await load("icon_resolver.js");
const keys = await load("keybindings.js");
const conv = await load("converters.js");
const deco = await load("decoration_styles.js");

test("color theme -> Monaco theme", () => {
	const t = themes.toMonacoTheme(
		{
			colors: { "editor.background": "#282A36", "editor.foreground": "#f8f8f2", bad: "red;}" },
			tokenColors: [
				{ scope: ["comment", "punctuation.definition.comment"], settings: { foreground: "#6272A4", fontStyle: "italic" } },
				{ scope: ["source.python keyword.control"], settings: { foreground: "#ff79c6" } },
				{ scope: [], settings: { foreground: "#abc" } },
				{ scope: ["string"], settings: {} },
			],
		},
		"vs-dark"
	);
	assert.equal(t.base, "vs-dark");
	assert.deepEqual(t.rules[0], { token: "comment", foreground: "6272a4", fontStyle: "italic" });
	assert.equal(t.rules[2].token, "keyword.control"); // descendant selector -> most specific part
	assert.deepEqual(t.rules[3], { token: "", foreground: "aabbcc" });
	assert.equal(t.rules.length, 4);
	assert.deepEqual(t.colors, { "editor.background": "#282A36", "editor.foreground": "#f8f8f2" });
	assert.equal(themes.modeOf("vs"), "light");
	assert.equal(themes.modeOf("hc-black"), "dark");
});

test("theme colors -> studio CSS variables and terminal", () => {
	const colors = { "sideBar.background": "#21222c", "statusBar.background": "#191a21", "terminal.ansiRed": "#ff5555", "list.hoverBackground": "url(x)" };
	const vars = themes.cssVarsFromColors(colors);
	assert.equal(vars["--mdt-bg-side"], "#21222c");
	assert.equal(vars["--mdt-statusbar"], "#191a21");
	assert.equal(vars["--mdt-bg-hover"], undefined); // invalid value never reaches CSS
	const term = themes.terminalThemeFromColors(colors, { background: "#000000", red: "#aa0000" });
	assert.equal(term.red, "#ff5555");
	assert.equal(term.background, "#21222c");
});

test("icon theme resolution follows VS Code precedence", () => {
	const theme = {
		definitions: { file: {}, py: {}, test: {}, pkg: {}, folder: {}, folderOpen: {}, src: {}, srcOpen: {}, langPy: {}, dts: {}, ts: {} },
		file: "file",
		folder: "folder",
		folderExpanded: "folderOpen",
		fileExtensions: { py: "py", "test.py": "test", "d.ts": "dts", ts: "ts" },
		fileNames: { "package.json": "pkg" },
		folderNames: { src: "src" },
		folderNamesExpanded: { src: "srcOpen" },
		languageIds: { python: "langPy" },
		light: { fileExtensions: { py: "file" } },
	};
	const id = (e) => icons.resolveIconId(theme, e);
	assert.equal(id({ name: "Package.JSON", type: "file" }), "pkg");
	assert.equal(id({ name: "a.test.py", type: "file" }), "test");
	assert.equal(id({ name: "a.py", type: "file" }), "py");
	assert.equal(id({ name: "types.d.ts", type: "file" }), "dts");
	assert.equal(id({ name: "Makefile", type: "file", languageId: "python" }), "langPy");
	assert.equal(id({ name: "README", type: "file" }), "file");
	assert.equal(id({ name: "src", type: "folder" }), "src");
	assert.equal(id({ name: "src", type: "folder", expanded: true }), "srcOpen");
	assert.equal(id({ name: "other", type: "folder", expanded: true }), "folderOpen");
	assert.equal(id({ name: "a.py", type: "file", light: true }), "file");
	assert.equal(icons.fontCharacter("\\E001"), "");
});

const fakeMonaco = {
	KeyMod: { CtrlCmd: 1 << 11, Shift: 1 << 10, Alt: 1 << 9, WinCtrl: 1 << 8, chord: (a, b) => a | (b << 16) },
	KeyCode: { KeyK: 41, KeyC: 33, Enter: 3, DownArrow: 18, F5: 63, Slash: 90, Digit1: 22 },
};

test("keybindings", () => {
	const { KeyMod, KeyCode } = fakeMonaco;
	assert.equal(keys.parseKeybinding("ctrl+shift+k", fakeMonaco), KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyK);
	assert.equal(keys.parseKeybinding("alt+down", fakeMonaco), KeyMod.Alt | KeyCode.DownArrow);
	assert.equal(keys.parseKeybinding("ctrl+/", fakeMonaco), KeyMod.CtrlCmd | KeyCode.Slash);
	assert.equal(keys.parseKeybinding("f5", fakeMonaco), KeyCode.F5);
	assert.equal(keys.parseKeybinding("ctrl+k ctrl+c", fakeMonaco), KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyMod.CtrlCmd | KeyCode.KeyC));
	assert.equal(keys.parseKeybinding("ctrl+numpad_add", fakeMonaco), null);
	assert.equal(keys.parseKeybinding("", fakeMonaco), null);
});

class FakeRange {
	constructor(a, b, c, d) {
		Object.assign(this, { startLineNumber: a, startColumn: b, endLineNumber: c, endColumn: d });
	}
}
const monacoLike = {
	Range: FakeRange,
	MarkerSeverity: { Hint: 1, Info: 2, Warning: 4, Error: 8 },
	languages: {
		CompletionItemKind: { Method: 0, Function: 1, Text: 18, Snippet: 27, Keyword: 17 },
		CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
		FoldingRangeKind: { Comment: "comment", Imports: "imports", Region: "region" },
	},
};
const uris = { toModelUri: (u) => (u.startsWith("file:///bench/") ? `model:${u.slice(14)}` : null), toDocUri: (m) => m };

test("converters: ranges, completions, markers, links, edits", () => {
	const c = conv.createConverters(monacoLike, uris);
	assert.deepEqual({ ...c.range([0, 0, 2, 5]) }, { startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 6 });
	assert.deepEqual(c.position({ lineNumber: 4, column: 7 }), [3, 6]);
	const item = c.completionItem({ label: "x", kind: 2, insert: { snippet: "x($1)" }, documentation: { text: "*a*" } }, undefined);
	assert.equal(item.kind, 1);
	assert.equal(item.insertTextRules, 4);
	assert.equal(item.documentation.isTrusted, false); // extension markdown never trusted
	assert.equal(item.documentation.value, "\\*a\\*");
	assert.equal(c.marker({ range: [0, 0, 0, 1], message: "m", severity: 1 }).severity, 4);
	assert.equal(c.link({ range: [0, 0, 0, 1], target: "javascript:alert(1)" }), null);
	assert.equal(c.link({ range: [0, 0, 0, 1], target: "https://example.com" }).url, "https://example.com");
	const we = c.workspaceEdit([
		{ uri: "file:///bench/a.py", edits: [{ range: [0, 0, 0, 0], text: "x" }] },
		{ uri: "file:///etc/passwd", edits: [{ range: [0, 0, 0, 0], text: "x" }] }, // not open -> dropped
	]);
	assert.equal(we.edits.length, 1);
	assert.equal(we.edits[0].resource, "model:a.py");
	assert.equal(c.location({ uri: "file:///elsewhere/x", range: [0, 0, 0, 0] }), null);
});

test("activation plan", () => {
	assert.equal(conv.activationPlan({ activation_events: ["onStartupFinished"] }).atStartup, true);
	const p = conv.activationPlan({ activation_events: ["onLanguage:python", "onCommand:x.run"], contributes: { commands: [{ command: "x.other" }] } });
	assert.equal(p.atStartup, false);
	assert.ok(p.languages.has("python"));
	assert.ok(p.commands.has("x.run") && p.commands.has("x.other"));
	assert.equal(conv.activationPlan({ activation_events: [], contributes: {} }).atStartup, true);
});

test("decoration CSS rejects injection", () => {
	const css = deco.decorationCss({
		color: "#ff0000",
		backgroundColor: "url(https://evil/x.png)",
		fontWeight: "bold; } body { display:none",
		textDecoration: "line-through",
		border: "1px solid #fff",
		before: { contentText: "▶", color: "expression(alert(1))" },
		dark: { color: { id: "editorWarning.foreground" } },
	}, (id) => (id === "editorWarning.foreground" ? "#cca700" : undefined));
	assert.match(css.inline, /color: #ff0000/);
	assert.doesNotMatch(css.inline, /url|display|expression/);
	assert.match(css.inline, /text-decoration: line-through/);
	assert.match(css.inline, /border: 1px solid #fff/);
	assert.equal(css.before.text, "▶");
	assert.doesNotMatch(css.before.css, /expression/);
	assert.match(css.dark.inline, /color: #cca700/);
});
