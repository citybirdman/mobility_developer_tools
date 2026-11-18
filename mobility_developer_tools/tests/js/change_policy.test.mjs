// Unit tests for the editor's reaction to changes made outside the studio.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../public/js/developer_studio/core/change_policy.js"), "utf8");
const { fileChangeAction } = await import(`data:text/javascript;base64,${Buffer.from(src).toString("base64")}`);

const tab = (extra = {}) => ({ version: "v100", lastSavedAt: 0, saving: false, reloading: false, deleted: false, conflictVersion: null, ...extra });
const on = (n) => ({ exists: true, version: `v${n}` });
const gone = { exists: false, version: null };
const NOW = 1_000;

test("unchanged file: nothing to do", () => assert.equal(fileChangeAction(tab(), on(100), NOW, false), "none"));
test("changed on disk, no local edits: reload", () => assert.equal(fileChangeAction(tab(), on(200), NOW, false), "reload"));
test("changed on disk with local edits: conflict, asked once per disk version", () => {
	assert.equal(fileChangeAction(tab(), on(200), NOW, true), "conflict");
	assert.equal(fileChangeAction(tab({ conflictVersion: "v200" }), on(200), NOW, true), "none");
	assert.equal(fileChangeAction(tab({ conflictVersion: "v200" }), on(300), NOW, true), "conflict");
});
test("our own save never triggers a reload", () => {
	assert.equal(fileChangeAction(tab({ saving: true }), on(200), NOW, false), "ignore");
	assert.equal(fileChangeAction(tab({ reloading: true }), on(200), NOW, false), "ignore");
	// poll started before the save finished: its (older) answer is stale
	assert.equal(fileChangeAction(tab({ lastSavedAt: NOW + 5 }), on(50), NOW, false), "ignore");
	assert.equal(fileChangeAction(tab({ lastSavedAt: NOW - 5 }), on(200), NOW, false), "reload");
});
test("deleted and restored", () => {
	assert.equal(fileChangeAction(tab(), gone, NOW, false), "deleted");
	assert.equal(fileChangeAction(tab({ deleted: true }), gone, NOW, false), "none");
	assert.equal(fileChangeAction(tab({ deleted: true }), on(100), NOW, false), "restored");
	assert.equal(fileChangeAction(tab({ deleted: true }), on(300), NOW, false), "reload");
	assert.equal(fileChangeAction(tab(), gone, NOW, true), "deleted"); // local edits are kept
});
