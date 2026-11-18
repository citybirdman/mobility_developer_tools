// Unit tests for pure terminal logic.  Run:  node --test apps/mobility_developer_tools/mobility_developer_tools/tests/js/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/terminal");
// the bundle sources use ES module syntax in .js files: load them as data: modules
const load = (name) =>
	import(`data:text/javascript;base64,${Buffer.from(readFileSync(join(SRC, name), "utf8")).toString("base64")}`);

const { terminalKeyAction } = await load("terminal_keys.js");
const { WrappedLinkProvider } = await load("wrapped_link_provider.js");

const key = (k, mods = {}) => ({ key: k, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods });

test("paste shortcuts use the browser's native paste", () => {
	assert.equal(terminalKeyAction(key("v", { ctrlKey: true }), false), "native-paste");
	assert.equal(terminalKeyAction(key("V", { ctrlKey: true, shiftKey: true }), false), "native-paste");
	assert.equal(terminalKeyAction(key("v", { metaKey: true }), false), "native-paste");
	assert.equal(terminalKeyAction(key("Insert", { shiftKey: true }), false), "native-paste");
});

test("Ctrl+C copies only with a selection, otherwise it is SIGINT", () => {
	assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), true), "copy");
	assert.equal(terminalKeyAction(key("c", { ctrlKey: true }), false), "terminal");
	assert.equal(terminalKeyAction(key("C", { ctrlKey: true, shiftKey: true }), false), "copy");
	assert.equal(terminalKeyAction(key("Insert", { ctrlKey: true }), true), "copy");
});

test("shell keys reach the program", () => {
	for (const k of ["r", "d", "l", "a", "e", "u", "w", "z", "k"]) {
		assert.equal(terminalKeyAction(key(k, { ctrlKey: true }), false), "terminal", `Ctrl+${k}`);
	}
	assert.equal(terminalKeyAction(key("a", { ctrlKey: true, shiftKey: true }), false), "select-all");
	assert.equal(terminalKeyAction(key("Tab"), false), "terminal");
	assert.equal(terminalKeyAction(key("b", { altKey: true }), false), "terminal");
});

function fakeTerm(lines, cols) {
	return {
		cols,
		buffer: {
			active: {
				getLine: (i) =>
					i >= 0 && i < lines.length
						? { isWrapped: false, translateToString: () => lines[i].replace(/\s+$/, "") }
						: undefined,
			},
		},
	};
}

const linksOn = (provider, y) => new Promise((resolve) => provider.provideLinks(y, resolve));

test("hard-wrapped URL is rebuilt on every line it spans", async () => {
	const cols = 30;
	const url = "https://claude.com/cai/oauth/authorize?code=true&redirect_uri=https%3A%2F%2Fplatform.claude.com&state=abc";
	const parts = url.match(new RegExp(`.{1,${cols}}`, "g"));
	const lines = ["Use the url below:", "", ...parts, "", "Paste code here >"];
	const provider = new WrappedLinkProvider(fakeTerm(lines, cols), () => {});
	for (let i = 0; i < parts.length; i++) {
		const links = await linksOn(provider, 3 + i);
		assert.equal(links.length, 1);
		assert.equal(links[0].text, url);
	}
	assert.equal(await linksOn(provider, 3 + parts.length + 1), undefined);
});

test("only http(s) links, trailing punctuation removed", async () => {
	const provider = new WrappedLinkProvider(fakeTerm(["see https://example.com/a). and javascript:alert(1)"], 80), () => {});
	const links = await linksOn(provider, 1);
	assert.deepEqual(links.map((l) => l.text), ["https://example.com/a"]);
});
