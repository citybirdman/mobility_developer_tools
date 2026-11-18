import { notifyError } from "../core/api_client";
import { languageForPath } from "../core/languages";
import {
	dismiss,
	loadSearchState,
	matchRange,
	previewReplacement,
	saveSearchState,
	searchArgs,
	summarize,
	updateFile,
} from "../core/search_model";

const STORAGE_KEY = "mdt_search_state";
const TYPE_DELAY_MS = 300;
const AUTO_EXPAND_LIMIT = 10; // like VS Code's "auto": files with more matches start collapsed
const REPLACE_CONCURRENCY = 4;

/**
 * Side bar Search view (VS Code's Ctrl+Shift+F): search as you type with match case /
 * whole word / regex toggles, files to include / exclude, a results tree, and replace
 * (one match, one file or everything). It only talks to the server through the api and
 * to the editor through EditorArea (open + reveal).
 */
export class SearchView {
	constructor(host, { api, bus, editorArea, icons, dialogs, storage = window.localStorage }) {
		Object.assign(this, { api, bus, editorArea, icons, dialogs, storage });
		this.state = loadSearchState(storage, STORAGE_KEY);
		this.result = null;
		this.collapsed = new Set();
		this.seq = 0;
		this.timer = null;
		this.focusIndex = -1;

		this.el = document.createElement("div");
		this.el.className = "mdt-search-view";
		this.el.innerHTML = `
			<div class="mdt-sidebar-title">
				<span>${__("Search")}</span>
				<span class="mdt-search-title-actions">
					<span class="codicon codicon-refresh" data-action="refresh" title="${__("Refresh")}"></span>
					<span class="codicon codicon-clear-all" data-action="clear" title="${__("Clear Search Results")}"></span>
					<span class="codicon codicon-collapse-all" data-action="collapse" title="${__("Collapse All")}"></span>
				</span>
			</div>
			<div class="mdt-search-form">
				<span class="codicon mdt-search-replace-toggle" data-action="toggle-replace" title="${__("Toggle Replace")} (Ctrl+Shift+H)"></span>
				<div class="mdt-search-fields">
					<div class="mdt-search-box">
						<textarea class="mdt-search-input" data-field="query" rows="1" spellcheck="false" placeholder="${__("Search")}" aria-label="${__("Search")}"></textarea>
						<span class="mdt-search-options">
							<span class="codicon codicon-case-sensitive" data-option="matchCase" title="${__("Match Case")} (Alt+C)"></span>
							<span class="codicon codicon-whole-word" data-option="wholeWord" title="${__("Match Whole Word")} (Alt+W)"></span>
							<span class="codicon codicon-regex" data-option="isRegex" title="${__("Use Regular Expression")} (Alt+R)"></span>
						</span>
					</div>
					<div class="mdt-search-box mdt-search-replace-box">
						<textarea class="mdt-search-input" data-field="replace" rows="1" spellcheck="false" placeholder="${__("Replace")}" aria-label="${__("Replace")}"></textarea>
						<span class="mdt-search-options">
							<span class="codicon codicon-replace-all" data-action="replace-all" title="${__("Replace All")} (Ctrl+Alt+Enter)"></span>
						</span>
					</div>
				</div>
			</div>
			<div class="mdt-search-details-toggle"><span class="codicon codicon-ellipsis" data-action="toggle-details" title="${__("Toggle Search Details")}"></span></div>
			<div class="mdt-search-details">
				<label>${__("files to include")}</label>
				<input class="mdt-search-input" data-field="include" spellcheck="false" placeholder="${__("e.g. *.py, apps/frappe/**")}">
				<label>${__("files to exclude")}</label>
				<input class="mdt-search-input" data-field="exclude" spellcheck="false" placeholder="${__("e.g. *.min.js, **/tests")}">
			</div>
			<div class="mdt-search-progress"></div>
			<div class="mdt-search-message"></div>
			<div class="mdt-search-results mdt-tree" tabindex="0" role="tree"></div>`;
		host.appendChild(this.el);

		this.inputs = Object.fromEntries([...this.el.querySelectorAll("[data-field]")].map((i) => [i.dataset.field, i]));
		this.message = this.el.querySelector(".mdt-search-message");
		this.progress = this.el.querySelector(".mdt-search-progress");
		this.tree = this.el.querySelector(".mdt-search-results");
		for (const [field, input] of Object.entries(this.inputs)) {
			input.value = this.state[field] || "";
			input.addEventListener("input", () => this.onInput(field));
			input.addEventListener("keydown", (e) => this.onInputKey(e, field));
		}
		this.el.addEventListener("click", (e) => this.onClick(e));
		this.tree.addEventListener("keydown", (e) => this.onTreeKey(e));
		this.renderForm();
		this.autosize();
	}

	// -- public -----------------------------------------------------------------------------------

	/** Ctrl+Shift+F / Ctrl+Shift+H: focus the search box, seeded with the editor selection. */
	focus({ seed = "", replace = false } = {}) {
		if (seed && !seed.includes("\n")) {
			this.inputs.query.value = seed;
			this.onInput("query", { immediate: true });
		}
		if (replace && !this.state.showReplace) this.toggle("showReplace");
		const input = replace ? this.inputs.replace : this.inputs.query;
		setTimeout(() => {
			input.focus();
			input.select();
		});
	}

	/** Explorer "Find in Folder...": limit the search to a folder through "files to include". */
	findInFolder(path) {
		this.state.showDetails = true;
		this.inputs.include.value = path ? `./${path}` : "";
		this.renderForm();
		this.onInput("include", { immediate: true });
		this.focus();
	}

	// -- input --------------------------------------------------------------------------------------

	onInput(field, { immediate = false } = {}) {
		this.state[field] = this.inputs[field].value;
		this.save();
		this.autosize();
		if (field === "replace") return this.renderResults(); // only the preview changes
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.search(), immediate ? 0 : TYPE_DELAY_MS);
	}

	onInputKey(e, field) {
		e.stopPropagation(); // keep Frappe / studio shortcuts out of typing (window shortcuts still run first)
		const alt = e.altKey && !e.ctrlKey && !e.metaKey;
		const key = e.key.toLowerCase();
		if (alt && key === "c") return this.prevent(e, () => this.toggleOption("matchCase"));
		if (alt && key === "w") return this.prevent(e, () => this.toggleOption("wholeWord"));
		if (alt && key === "r") return this.prevent(e, () => this.toggleOption("isRegex"));
		if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.altKey) return this.prevent(e, () => this.replaceAll());
		if (e.key === "Enter" && !e.shiftKey) {
			if (field === "replace") return this.prevent(e, () => this.replaceAll());
			return this.prevent(e, () => {
				clearTimeout(this.timer);
				this.search();
			});
		}
		if (e.key === "ArrowDown" && field !== "replace" && this.rows().length && isCaretOnLastLine(e.target)) {
			return this.prevent(e, () => this.focusRow(0));
		}
		if (e.key === "Escape" && field === "query" && this.inputs.query.value) {
			return this.prevent(e, () => this.clear());
		}
	}

	prevent(e, fn) {
		e.preventDefault();
		fn();
	}

	onClick(e) {
		const action = e.target.closest("[data-action]")?.dataset.action;
		const option = e.target.closest("[data-option]")?.dataset.option;
		if (option) return this.toggleOption(option);
		if (action === "toggle-replace") return this.toggle("showReplace");
		if (action === "toggle-details") return this.toggle("showDetails");
		if (action === "refresh") return this.search();
		if (action === "clear") return this.clear();
		if (action === "collapse") return this.toggleCollapseAll();
		if (action === "replace-all") return this.replaceAll();

		const row = e.target.closest(".mdt-search-row");
		if (!row) return;
		const { file, match } = this.rowData(row);
		if (action === "dismiss") return this.setResult(dismiss(this.result, file.path, match));
		if (action === "replace-file") return this.replaceIn(file, file.matches);
		if (action === "replace-match") return this.replaceIn(file, [match]);
		this.focusRow(this.rows().indexOf(row), { scroll: false });
		if (match) this.openMatch(file, match, { focusEditor: e.detail > 1 });
		else this.toggleFile(file.path);
	}

	toggle(flag) {
		this.state[flag] = !this.state[flag];
		this.save();
		this.renderForm();
		this.renderResults();
	}

	toggleOption(option) {
		this.state[option] = !this.state[option];
		this.save();
		this.renderForm();
		this.search();
	}

	clear() {
		this.seq++;
		clearTimeout(this.timer);
		this.inputs.query.value = this.state.query = "";
		this.save();
		this.autosize();
		this.setBusy(false);
		this.setResult(null);
		this.inputs.query.focus();
	}

	// -- search ---------------------------------------------------------------------------------------

	async search() {
		const seq = ++this.seq;
		if (!this.state.query) {
			this.setBusy(false);
			return this.setResult(null);
		}
		this.setBusy(true);
		try {
			const result = await this.api.call("search_text", searchArgs(this.state));
			if (seq !== this.seq) return; // a newer search started while this one ran
			this.collapsed = new Set(result.files.filter((f) => f.matches.length > AUTO_EXPAND_LIMIT).map((f) => f.path));
			this.setResult(result);
		} catch (e) {
			if (seq !== this.seq) return;
			this.setResult(null, e.message || String(e));
		} finally {
			if (seq === this.seq) this.setBusy(false);
		}
	}

	/** Matches of one file again (after a replace in it). */
	async refreshFile(path) {
		const fresh = await this.api.call("search_text", { ...searchArgs(this.state), folder: path });
		if (this.result) this.setResult(updateFile(this.result, path, fresh));
	}

	setBusy(busy) {
		this.progress.classList.toggle("active", busy);
	}

	setResult(result, error = "") {
		this.result = result;
		this.message.classList.toggle("error", !!error);
		this.message.textContent = error || summarize(result);
		this.focusIndex = -1;
		this.renderResults();
	}

	// -- open ------------------------------------------------------------------------------------------

	async openMatch(file, match, { focusEditor = false } = {}) {
		await this.editorArea.open(file.path);
		if (this.editorArea.active?.path !== file.path) return;
		this.editorArea.reveal(matchRange(match));
		if (!focusEditor) this.focusRow(this.focusIndex, { scroll: false }); // keep browsing results with the keyboard
	}

	// -- replace ------------------------------------------------------------------------------------------

	async replaceIn(file, matches) {
		if (!this.ensureNotDirty([file])) return;
		try {
			await this.replaceFile(file, matches);
			await this.refreshFile(file.path);
		} catch (e) {
			notifyError(e);
			this.refreshFile(file.path).catch(() => {});
		}
		this.bus.emit("search:replaced", { paths: [file.path] });
	}

	async replaceAll() {
		const files = this.result?.files || [];
		if (!this.state.showReplace) return this.toggle("showReplace");
		if (!files.length) return;
		const dirty = files.filter((f) => this.editorArea.isDirtyPath(f.path));
		const targets = files.filter((f) => !this.editorArea.isDirtyPath(f.path));
		if (!targets.length) return this.ensureNotDirty(files);

		const count = targets.reduce((n, f) => n + f.matches.length, 0);
		const yes = await this.dialogs.show({
			type: "warning",
			title: __("Replace All"),
			text: this.state.replace
				? __("Replace {0} occurrences across {1} files with '{2}'?", [count, targets.length, this.state.replace])
				: __("Replace {0} occurrences across {1} files with nothing?", [count, targets.length]),
			detail: dirty.length ? __("{0} files with unsaved changes are skipped. Save them first to include them.", [dirty.length]) : "",
			buttons: [
				{ label: __("Replace"), value: true, primary: true },
				{ label: __("Cancel"), value: false },
			],
			cancelValue: false,
		});
		if (!yes) return;

		this.setBusy(true);
		const failures = [];
		let replaced = 0;
		const queue = [...targets];
		const worker = async () => {
			for (let file = queue.shift(); file; file = queue.shift()) {
				try {
					replaced += (await this.replaceFile(file, file.matches)).replaced;
				} catch (e) {
					failures.push(`${file.path}: ${e.message || e}`);
				}
			}
		};
		await Promise.all(Array.from({ length: Math.min(REPLACE_CONCURRENCY, queue.length) }, worker));
		this.bus.emit("search:replaced", { paths: targets.map((f) => f.path) });
		frappe.show_alert({ message: __("Replaced {0} occurrences", [replaced]), indicator: failures.length ? "orange" : "green" });
		if (failures.length) {
			this.dialogs.show({
				type: "error",
				title: __("Some files were not changed"),
				html: failures.slice(0, 20).map((f) => frappe.utils.escape_html(f)).join("<br>"),
			});
		}
		await this.search();
	}

	replaceFile(file, matches) {
		return this.api.call("replace_text", {
			...searchArgs(this.state),
			path: file.path,
			replacement: this.state.replace,
			expected_version: file.version,
			matches: JSON.stringify(matches.map((m) => ({ line: m.line, col: m.col }))),
		});
	}

	ensureNotDirty(files) {
		const dirty = files.filter((f) => this.editorArea.isDirtyPath(f.path));
		if (!dirty.length) return true;
		this.dialogs.show({
			type: "warning",
			title: __("Unsaved changes"),
			text: __("Save {0} before replacing in it.", [dirty.map((f) => f.path.split("/").pop()).join(", ")]),
		});
		return false;
	}

	// -- tree -------------------------------------------------------------------------------------------

	toggleFile(path) {
		if (this.collapsed.has(path)) this.collapsed.delete(path);
		else this.collapsed.add(path);
		this.renderResults();
	}

	toggleCollapseAll() {
		const files = this.result?.files || [];
		const allCollapsed = files.length && files.every((f) => this.collapsed.has(f.path));
		this.collapsed = allCollapsed ? new Set() : new Set(files.map((f) => f.path));
		this.renderResults();
	}

	rows() {
		return [...this.tree.querySelectorAll(".mdt-search-row")];
	}

	rowData(row) {
		const file = this.result.files[Number(row.dataset.file)];
		const match = row.dataset.match !== undefined ? file.matches[Number(row.dataset.match)] : null;
		return { file, match };
	}

	focusRow(index, { scroll = true } = {}) {
		const rows = this.rows();
		if (!rows.length) return;
		this.focusIndex = Math.max(0, Math.min(index, rows.length - 1));
		rows.forEach((r, i) => r.classList.toggle("selected", i === this.focusIndex));
		if (scroll) rows[this.focusIndex].scrollIntoView({ block: "nearest" });
		this.tree.focus({ preventScroll: true });
	}

	onTreeKey(e) {
		const rows = this.rows();
		const row = rows[this.focusIndex];
		if (!row) return;
		const { file, match } = this.rowData(row);
		const handled = () => {
			e.preventDefault();
			e.stopPropagation();
		};
		if (e.key === "ArrowDown") return handled(), this.focusRow(this.focusIndex + 1);
		if (e.key === "ArrowUp") {
			handled();
			if (this.focusIndex === 0) return this.inputs.query.focus();
			return this.focusRow(this.focusIndex - 1);
		}
		if (e.key === "ArrowRight" && !match && this.collapsed.has(file.path)) return handled(), this.toggleFile(file.path);
		if (e.key === "ArrowLeft") {
			handled();
			if (match) return this.focusRow(rows.indexOf(this.tree.querySelector(`.mdt-search-row[data-file="${row.dataset.file}"]:not([data-match])`)));
			if (!this.collapsed.has(file.path)) this.toggleFile(file.path);
			return;
		}
		if (e.key === "Enter" || e.key === " ") {
			handled();
			if (match) return this.openMatch(file, match, { focusEditor: e.key === "Enter" });
			return this.toggleFile(file.path);
		}
		if (e.key === "Delete") return handled(), this.setResult(dismiss(this.result, file.path, match));
		if (this.state.showReplace && e.key === "1" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
			return handled(), this.replaceIn(file, match ? [match] : file.matches);
		}
	}

	// -- render ------------------------------------------------------------------------------------------

	renderForm() {
		this.el.classList.toggle("show-replace", this.state.showReplace);
		this.el.classList.toggle("show-details", this.state.showDetails);
		const toggle = this.el.querySelector(".mdt-search-replace-toggle");
		toggle.classList.toggle("codicon-chevron-down", this.state.showReplace);
		toggle.classList.toggle("codicon-chevron-right", !this.state.showReplace);
		for (const el of this.el.querySelectorAll("[data-option]")) {
			el.classList.toggle("active", !!this.state[el.dataset.option]);
			el.setAttribute("aria-pressed", String(!!this.state[el.dataset.option]));
		}
	}

	renderResults() {
		const keep = this.focusIndex;
		this.tree.innerHTML = "";
		if (!this.result?.files.length) return;
		const replacing = this.state.showReplace;
		const fragment = document.createDocumentFragment();

		this.result.files.forEach((file, fi) => {
			const name = file.path.split("/").pop();
			const collapsed = this.collapsed.has(file.path);
			const row = document.createElement("div");
			row.className = "mdt-search-row mdt-search-file";
			row.dataset.file = fi;
			row.title = file.path;
			row.innerHTML = `
				<span class="codicon codicon-chevron-${collapsed ? "right" : "down"} mdt-twisty"></span>
				<span data-base="mdt-tree-icon"></span>
				<span class="mdt-search-name"></span>
				<span class="mdt-search-dir"></span>
				<span class="mdt-search-actions">
					${replacing ? `<span class="codicon codicon-replace-all" data-action="replace-file" title="${__("Replace All")}"></span>` : ""}
					<span class="codicon codicon-close" data-action="dismiss" title="${__("Dismiss")}"></span>
				</span>
				<span class="mdt-search-badge">${file.matches.length}</span>`;
			this.icons.render(row.querySelector("[data-base]"), { name, path: file.path, type: "file", languageId: languageForPath(file.path) });
			row.querySelector(".mdt-search-name").textContent = name;
			row.querySelector(".mdt-search-dir").textContent = file.path.slice(0, -name.length - 1);
			fragment.appendChild(row);
			if (collapsed) return;

			file.matches.forEach((match, mi) => {
				const line = document.createElement("div");
				line.className = "mdt-search-row mdt-search-match";
				line.dataset.file = fi;
				line.dataset.match = mi;
				line.title = `${__("Line")} ${match.line}${match.multiline ? `-${match.end_line}` : ""}: ${match.before}${match.match}${match.after}`;
				line.innerHTML = `
					<span class="mdt-search-preview"><span></span><mark></mark><ins></ins><span></span></span>
					<span class="mdt-search-actions">
						${replacing ? `<span class="codicon codicon-replace" data-action="replace-match" title="${__("Replace")}"></span>` : ""}
						<span class="codicon codicon-close" data-action="dismiss" title="${__("Dismiss")}"></span>
					</span>`;
				const [before, mark, ins, after] = line.querySelector(".mdt-search-preview").children;
				before.textContent = match.before;
				mark.textContent = match.match + (match.multiline ? "⏎" : "");
				after.textContent = match.after;
				if (replacing) {
					line.classList.add("replacing");
					ins.textContent = previewReplacement(this.state, match.match);
				}
				fragment.appendChild(line);
			});
		});
		this.tree.appendChild(fragment);
		if (keep >= 0) {
			const rows = this.rows();
			this.focusIndex = Math.min(keep, rows.length - 1);
			rows[this.focusIndex]?.classList.add("selected");
		}
	}

	/** The query box grows with multi-line text (Shift+Enter), like VS Code. */
	autosize() {
		for (const field of ["query", "replace"]) {
			const input = this.inputs[field];
			const lines = Math.min(input.value.split("\n").length, 6);
			input.style.height = `${lines * 18 + 8}px`;
		}
	}

	save() {
		saveSearchState(this.storage, STORAGE_KEY, this.state);
	}
}

function isCaretOnLastLine(input) {
	return !input.value.slice(input.selectionEnd).includes("\n");
}
