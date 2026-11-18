// Search view helpers: replace preview, result bookkeeping, request arguments.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

globalThis.__ = (s, args = []) => s.replace(/\{(\d)\}/g, (_, i) => args[i]);
const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/core/search_model.js"), "utf8");
const m = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);

const state = (over) => ({ ...m.DEFAULT_SEARCH_STATE, ...over });

test("request arguments", () => {
	assert.deepEqual(m.searchArgs(state({ query: "x", isRegex: true, wholeWord: true, include: "*.py" })), {
		query: "x", is_regex: 1, match_case: 0, whole_word: 1, include: "*.py", exclude: "",
	});
});

test("literal replace preview", () => {
	assert.equal(m.previewReplacement(state({ query: "a.b", replace: "$1" }), "a.b"), "$1");
});

test("regex replace preview: groups, named groups, $& and $$", () => {
	const s = state({ query: "(\\w+)_(?<rest>\\w+)", isRegex: true, replace: "$2-$1 [$&] $<rest> $$ $9" });
	assert.equal(m.previewReplacement(s, "app_name"), "name-app [app_name] name $ $9");
	assert.equal(m.previewReplacement(state({ query: "(a)", isRegex: true, replace: "$12" }), "a"), "a2");
	assert.equal(m.previewReplacement(state({ query: "x", isRegex: true, replace: "a\\nb" }), "x"), "a\nb");
	assert.equal(m.previewReplacement(state({ query: "A", isRegex: true, replace: "[$&]" }), "a"), "[a]"); // case-insensitive
	assert.equal(m.previewReplacement(state({ query: "(", isRegex: true, replace: "r" }), "("), "r"); // bad regex: plain text
});

const result = () => ({
	files: [
		{ path: "a.py", version: "1", matches: [{ line: 1, col: 0 }, { line: 2, col: 4 }] },
		{ path: "b.py", version: "1", matches: [{ line: 9, col: 1 }] },
	],
	file_count: 2,
	match_count: 3,
});

test("dismiss a match, the last match of a file, and a file", () => {
	let r = m.dismiss(result(), "a.py", { line: 2, col: 4 });
	assert.equal(r.match_count, 2);
	r = m.dismiss(r, "b.py", { line: 9, col: 1 });
	assert.deepEqual(r.files.map((f) => f.path), ["a.py"]);
	assert.equal(m.dismiss(result(), "a.py").file_count, 1);
});

test("update one file after a replace (in place, or gone)", () => {
	const fresh = { files: [{ path: "a.py", version: "2", matches: [{ line: 5, col: 0 }] }] };
	const r = m.updateFile(result(), "a.py", fresh);
	assert.deepEqual(r.files.map((f) => f.path), ["a.py", "b.py"]);
	assert.equal(r.match_count, 2);
	assert.equal(m.updateFile(result(), "a.py", { files: [] }).file_count, 1);
});

test("summary and Monaco range", () => {
	assert.equal(m.summarize({ match_count: 3, file_count: 2 }), "3 results in 2 files");
	assert.equal(m.summarize({ match_count: 1, file_count: 1 }), "1 result in 1 file");
	assert.match(m.summarize({ match_count: 0, file_count: 0 }), /No results/);
	assert.match(m.summarize({ match_count: 5, file_count: 1, limit_hit: true }), /subset/);
	assert.deepEqual(m.matchRange({ line: 3, col: 4, end_line: 3, end_col: 9 }), { startLineNumber: 3, startColumn: 5, endLineNumber: 3, endColumn: 10 });
});

test("state persistence survives broken storage", () => {
	const broken = { getItem: () => "{nope", setItem: () => { throw new Error("quota"); } };
	assert.deepEqual(m.loadSearchState(broken, "k"), m.DEFAULT_SEARCH_STATE);
	m.saveSearchState(broken, "k", {});
	const mem = new Map();
	const store = { getItem: (k) => mem.get(k), setItem: (k, v) => mem.set(k, v) };
	m.saveSearchState(store, "k", state({ query: "q", matchCase: true }));
	assert.equal(m.loadSearchState(store, "k").matchCase, true);
});
