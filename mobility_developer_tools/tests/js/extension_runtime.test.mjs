// Tests for the VS Code API runtime that runs extension code in the sandboxed worker.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME = readFileSync(join(HERE, "../../public/js/extension_runtime/runtime.js"), "utf8");
const SUPPORT = JSON.parse(readFileSync(join(HERE, "../../studio/extensions/api_support.json"), "utf8"));

/** Boot the runtime in a fresh fake worker scope. */
function boot() {
	const sent = [];
	const scope = {
		postMessage: (m) => sent.push(JSON.parse(JSON.stringify(m))),
		addEventListener() {},
		TextEncoder,
		TextDecoder,
		atob,
		queueMicrotask,
		console,
		setTimeout,
	};
	scope.self = scope;
	vm.createContext(scope);
	vm.runInContext(RUNTIME, scope);
	let callId = 1;
	const call = async (method, params) => {
		const id = callId++;
		await scope.onmessage({ data: { type: "call", id, method, params } });
		const reply = sent.find((m) => m.type === "response" && m.id === id);
		if (reply.error) throw new Error(reply.error);
		return reply.result;
	};
	// answer every runtime -> page request automatically
	const answers = {};
	const pump = async () => {
		for (const m of sent.filter((x) => x.type === "request" && !x.answered)) {
			m.answered = true;
			await scope.onmessage({ data: { type: "response", id: m.id, result: answers[m.method] ? answers[m.method](m.params) : null } });
		}
	};
	const event = (name, data) => scope.onmessage({ data: { type: "event", name, data } });
	return { scope, sent, call, event, answers, pump, vscode: scope.__studioVscode };
}

const DOC = { uri: "file:///bench/apps/x/a.py", languageId: "python", version: 1, text: "import frappe\n\ndef run(value):\n    return value + 1\n" };

test("runtime implements every API listed as supported", () => {
	const { scope } = boot();
	for (const [ns, { supported }] of Object.entries(SUPPORT.namespaces)) {
		for (const member of supported) {
			assert.ok(member in scope.__studioImpl[ns], `vscode.${ns}.${member} is listed as supported but not implemented`);
		}
	}
	for (const type of SUPPORT.types) assert.ok(scope.__studioVscode[type] !== undefined, `vscode.${type} missing`);
});

test("unsupported APIs: events are inert, calls fail with a clear message", () => {
	const { vscode, sent } = boot();
	const d = vscode.debug.onDidStartDebugSession(() => {});
	assert.equal(typeof d.dispose, "function");
	assert.throws(() => vscode.debug.startDebugging(), /not supported in Developer Studio/);
	assert.throws(() => vscode.window.createWebviewPanel("x"), /not supported/);
	assert.ok(sent.some((m) => m.method === "log" && /createWebviewPanel/.test(m.params.message)));
});

test("text document maths", async () => {
	const { call, vscode, scope } = boot();
	await call("init", { extension: { id: "a.b" }, code: "", entry: "x.js", documents: [DOC] });
	const doc = (await vscode.workspace.textDocuments)[0];
	assert.equal(doc.lineCount, 5);
	assert.equal(doc.lineAt(2).text, "def run(value):");
	assert.equal(doc.lineAt(3).firstNonWhitespaceCharacterIndex, 4);
	const pos = new vscode.Position(3, 11);
	assert.deepEqual(doc.positionAt(doc.offsetAt(pos)), pos);
	assert.equal(doc.getText(doc.getWordRangeAtPosition(pos)), "value");
	assert.equal(doc.getText(new vscode.Range(0, 0, 0, 6)), "import");
	assert.ok(doc.validatePosition(new vscode.Position(99, 99)).isEqual(new vscode.Position(4, 0)));
	assert.equal(scope.__studioPath.join("a", "../b", "c.js"), "b/c.js");
});

test("a sample extension activates and its features reach the page", async () => {
	const t = boot();
	const code = `
		const vscode = require("vscode");
		exports.activate = (context) => {
			context.subscriptions.push(vscode.commands.registerCommand("sample.hello", async () => {
				const pick = await vscode.window.showInformationMessage("Hello " + vscode.workspace.getConfiguration("sample").get("name", "?"), "Again");
				return pick;
			}));
			vscode.languages.registerCompletionItemProvider("python", {
				provideCompletionItems(doc, pos) {
					const item = new vscode.CompletionItem("frappe.get_doc", vscode.CompletionItemKind.Function);
					item.insertText = new vscode.SnippetString("frappe.get_doc(\\"$1\\")");
					return [item];
				}
			}, ".");
			const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 10);
			status.text = "$(check) ready"; status.command = "sample.hello"; status.show();
			const diags = vscode.languages.createDiagnosticCollection("sample");
			diags.set(vscode.Uri.parse(${JSON.stringify(DOC.uri)}), [new vscode.Diagnostic(new vscode.Range(0, 0, 0, 6), "imported", vscode.DiagnosticSeverity.Warning)]);
			return { api: 1 };
		};`;
	await t.call("init", { extension: { id: "pub.sample" }, code, entry: "ext.js", settings: { "sample.name": "Studio" }, documents: [DOC] });
	assert.deepEqual(await t.call("activate", {}), { activated: true });

	const reg = t.sent.find((m) => m.method === "registerProvider");
	assert.equal(reg.params.kind, "completion");
	assert.deepEqual(reg.params.meta.triggerCharacters, ["."]);
	const result = await t.call("provide", { handle: reg.params.handle, uri: DOC.uri, args: { position: [3, 4] } });
	assert.equal(result.items[0].label, "frappe.get_doc");
	assert.deepEqual(result.items[0].insert, { snippet: 'frappe.get_doc("$1")' });

	const status = t.sent.filter((m) => m.method === "statusBar").pop();
	assert.equal(status.params.text, "$(check) ready");
	assert.equal(status.params.visible, true);
	assert.equal(status.params.command.id, "sample.hello");

	const diag = t.sent.find((m) => m.method === "diagnostics");
	assert.deepEqual(diag.params.items[0].range, [0, 0, 0, 6]);
	assert.equal(diag.params.items[0].severity, 1);

	t.answers.showMessage = (p) => (p.message === "Hello Studio" ? 0 : -1);
	const running = t.call("executeCommand", { id: "sample.hello" });
	await new Promise((r) => setTimeout(r, 0));
	await t.pump();
	assert.equal(await running, "Again");
});

test("configuration: defaults, nesting and change events", async () => {
	const t = boot();
	await t.call("init", { extension: { id: "a.b" }, code: "", entry: "x.js", settings: { "fmt.tabs": true, "fmt.rules.max": 80 } });
	const cfg = t.vscode.workspace.getConfiguration("fmt");
	assert.equal(cfg.get("tabs"), true);
	assert.equal(JSON.stringify(cfg.get("rules")), JSON.stringify({ max: 80 })); // object from another realm (vm)
	assert.equal(cfg.get("missing", 7), 7);
	assert.equal(t.vscode.workspace.getConfiguration("editor").get("tabSize"), 4);
	let affected = null;
	t.vscode.workspace.onDidChangeConfiguration((e) => (affected = e.affectsConfiguration("fmt")));
	await t.event("configuration", { settings: { "fmt.tabs": false } });
	assert.equal(affected, true);
	assert.equal(t.vscode.workspace.getConfiguration("fmt").get("tabs"), false);
});

test("workspace.fs only reads the extension's own files", async () => {
	const t = boot();
	await t.call("init", { extension: { id: "pub.ext" }, code: "", entry: "x.js" });
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.file("/etc/passwd")), /NoPermissions|FileSystemError/);
	await assert.rejects(t.vscode.workspace.fs.writeFile(t.vscode.Uri.parse("studio-ext://pub.ext/a"), new Uint8Array()), /not allowed/);
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.parse("studio-ext://other.ext/a.json")), /NoPermissions|FileSystemError/);
});

test("Range and Position semantics", () => {
	const { vscode } = boot();
	const r = new vscode.Range(2, 5, 1, 0); // reversed input is normalized
	assert.equal(r.start.line, 1);
	assert.ok(r.contains(new vscode.Position(1, 3)));
	assert.ok(!r.contains(new vscode.Position(3, 0)));
	assert.equal(r.intersection(new vscode.Range(2, 0, 4, 0)).start.line, 2);
	assert.equal(vscode.Uri.parse("studio-ext://a.b/x/../y.json").path, "/x/../y.json");
	assert.equal(vscode.Uri.joinPath(vscode.Uri.parse("studio-ext://a.b/"), "x", "../y.json").path, "/y.json");
	assert.equal(vscode.l10n.t("Hello {0}, {1}", "A", 2), "Hello A, 2");
	assert.equal(vscode.l10n.t("Hi {name}", { name: "B" }), "Hi B");
});

test("extensions.all exposes studio language configs; only virtual extension files are readable", async () => {
	const t = boot();
	await t.call("init", { extension: { id: "pub.ext" }, code: "", entry: "x.js", languages: { python: { comments: { lineComment: "#" } } } });
	const all = t.vscode.extensions.all;
	assert.equal(JSON.stringify(all.map((e) => e.id)), JSON.stringify(["pub.ext", "studio.languages"])); // array from the vm realm
	const lang = all[1].packageJSON.contributes.languages[0];
	assert.equal(lang.id, "python");
	// what Better Comments does: path.join(extensionPath, configuration) -> workspace.fs.readFile(Uri.file(...))
	const path = t.scope.__studioPath.join(all[1].extensionPath, lang.configuration);
	const bytes = await t.vscode.workspace.fs.readFile(t.vscode.Uri.file(path));
	assert.equal(JSON.parse(new TextDecoder().decode(bytes)).comments.lineComment, "#");
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.file("/__studio_ext/studio.languages/languages/nope.json")), /FileNotFound|FileSystemError/);
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.file("/__studio_ext/other.ext/package.json")), /NoPermissions|FileSystemError/);
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.file("/__studio_ext/pub.ext/../other.ext/x")), /NoPermissions|FileSystemError/);
	await assert.rejects(t.vscode.workspace.fs.readFile(t.vscode.Uri.file("/home/frappe/.ssh/id_rsa")), /NoPermissions|FileSystemError/);
	assert.equal(t.vscode.extensions.all[0].extensionPath, "/__studio_ext/pub.ext");
});
