// msgprint argument normalization for the VS Code-style dialog.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

globalThis.__ = (s) => s;
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/ui/studio_dialog.js"), "utf8");
const { normalizeMsgprint } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);

test("plain message and title", () => {
	assert.deepEqual(normalizeMsgprint("Saved", "Message"), { type: "info", title: "", html: "Saved", primaryAction: null });
	assert.equal(normalizeMsgprint("x", "Uninstall app").title, "Uninstall app");
});

test("object, JSON string and indicators", () => {
	assert.equal(normalizeMsgprint({ message: "Bad", indicator: "red" }).type, "error");
	assert.equal(normalizeMsgprint({ message: "Careful", indicator: "orange" }).type, "warning");
	assert.equal(normalizeMsgprint({ message: "Done", indicator: "green" }).type, "success");
	assert.equal(normalizeMsgprint('{"message": "From server", "indicator": "red"}').html, "From server");
});

test("lists", () => {
	assert.equal(normalizeMsgprint({ message: ["a", "b"], as_list: 1 }).html, "<ul><li>a</li><li>b</li></ul>");
	assert.equal(normalizeMsgprint({ message: ["a", "b"] }).html, "a<br>b");
});

test("unsupported features fall back to Frappe's dialog", () => {
	assert.equal(normalizeMsgprint({ message: [["a", "b"]], as_table: 1 }), null);
	assert.equal(normalizeMsgprint({ message: "x", primary_action: { server_action: "app.do" } }), null);
	assert.equal(normalizeMsgprint({ message: "x", wide: true }), null);
	assert.equal(normalizeMsgprint(""), null);
	const action = () => {};
	assert.equal(normalizeMsgprint({ message: "x", primary_action: { label: "Go", action } }).primaryAction.action, action);
});
