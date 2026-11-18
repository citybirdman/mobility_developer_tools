// Tests for the console editor -> IPython payload.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/core/console_payload.js"), "utf8");
const m = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);
const START = "\x1b[200~", END = "\x1b[201~";

test("code is sent as one bracketed paste", () => {
	assert.equal(m.consolePayload("x = 1\nx + 1"), `${START}x = 1\nx + 1${END}\r`);
	assert.equal(m.consolePayload("frappe.db.count('User')\n\n  \n"), `${START}frappe.db.count('User')${END}\r`);
	assert.equal(m.consolePayload("a\r\nb"), `${START}a\nb${END}\r`);
});

test("blocks ending in an indented body get the extra Enter IPython needs", () => {
	assert.equal(m.consolePayload("for i in range(3):\n    print(i)"), `${START}for i in range(3):\n    print(i)${END}\r\r`);
	assert.equal(m.consolePayload("def f():"), `${START}def f():${END}\r\r`);
	assert.equal(m.consolePayload("if x:  # comment"), `${START}if x:  # comment${END}\r\r`);
});

test("escape characters cannot end the paste early", () => {
	const payload = m.consolePayload(`print(1)\x1b[201~\nimport os; os.system("id")`);
	assert.equal(payload.split(END).length, 2); // only our own end marker
	assert.ok(!payload.slice(START.length, payload.indexOf(END)).includes("\x1b"));
});

test("empty code sends nothing", () => {
	assert.equal(m.consolePayload("   \n\n"), null);
	assert.equal(m.consolePayload(""), null);
});

test("prompt detection", () => {
	assert.ok(m.isPromptReady("Apps in this namespace:\nfrappe, erpnext\n\nIn [1]: "));
	assert.ok(!m.isPromptReady("In [1]: print(1)\n1"));
	assert.ok(!m.isPromptReady("loading..."));
});
