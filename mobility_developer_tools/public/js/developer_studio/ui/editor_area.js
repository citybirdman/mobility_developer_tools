import { notifyError } from "../core/api_client";
import { fileChangeAction } from "../core/change_policy";
import { languageForPath } from "../core/languages";

export const EDITOR_THEMES = { dark: "mdt-dark", light: "mdt-light" };

export function defineEditorThemes() {
	monaco.editor.defineTheme(EDITOR_THEMES.light, {
		base: "vs",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "a0a1a7", fontStyle: "italic" },
			{ token: "keyword", foreground: "a626a4" },
			{ token: "string", foreground: "50a14f" },
			{ token: "number", foreground: "986801" },
			{ token: "type", foreground: "c18401" },
			{ token: "delimiter", foreground: "383a42" },
		],
		colors: {
			"editor.background": "#fafafa",
			"editor.foreground": "#383a42",
			"editorLineNumber.foreground": "#9d9d9f",
			"editorLineNumber.activeForeground": "#383a42",
			"editor.lineHighlightBackground": "#f0f0f1",
			"editor.selectionBackground": "#d7e3f4",
			"editorCursor.foreground": "#2f74c0",
			"editorIndentGuide.background1": "#e3e4e6",
			"editorWidget.background": "#f3f3f4",
			"editorWidget.border": "#d4d4d8",
			"minimap.background": "#fafafa",
		},
	});
	monaco.editor.defineTheme(EDITOR_THEMES.dark, {
		base: "vs-dark",
		inherit: true,
		rules: [
			{ token: "comment", foreground: "7f848e", fontStyle: "italic" },
			{ token: "keyword", foreground: "c678dd" },
			{ token: "string", foreground: "98c379" },
			{ token: "number", foreground: "d19a66" },
			{ token: "type", foreground: "e5c07b" },
			{ token: "delimiter", foreground: "abb2bf" },
		],
		colors: {
			"editor.background": "#282c34",
			"editor.foreground": "#abb2bf",
			"editorLineNumber.foreground": "#5c6370",
			"editorLineNumber.activeForeground": "#abb2bf",
			"editor.lineHighlightBackground": "#2c313c",
			"editor.selectionBackground": "#3e4451",
			"editorCursor.foreground": "#61afef",
			"editorIndentGuide.background1": "#3b4048",
			"editorWidget.background": "#21252b",
			"editorWidget.border": "#3a3f4b",
			"minimap.background": "#282c34",
			"scrollbarSlider.background": "#4e566680",
		},
	});
}

/** Editor tabs + a single Monaco editor with one model per open file. */
export class EditorArea {
	constructor(host, { api, bus, icons, monacoTheme = EDITOR_THEMES.dark }) {
		this.icons = icons;
		this.api = api;
		this.bus = bus;
		this.tabs = new Map(); // path -> tab
		this.preloaded = new Map(); // path -> file data of models created without a tab
		this.active = null;

		this.el = document.createElement("div");
		this.el.className = "mdt-editor-area";
		this.el.innerHTML = `
			<div class="mdt-tabs-bar">
				<div class="mdt-tabs"></div>
				<div class="mdt-editor-actions">
					<span class="codicon codicon-play mdt-run-btn" title="${__("Run File")} (F5)"></span>
					<span class="codicon codicon-save" data-action="save" title="${__("Save")} (Ctrl+S)"></span>
				</div>
			</div>
			<div class="mdt-breadcrumbs"></div>
			<div class="mdt-editor-banner"></div>
			<div class="mdt-editor-host"></div>
			<div class="mdt-welcome">
				<img src="/assets/mobility_developer_tools/images/logo.svg" alt="">
				<div class="mdt-welcome-title">${__("Developer Studio")}</div>
				<table>
					<tr><td>${__("Quick Open")}</td><td><kbd>Ctrl</kbd>+<kbd>P</kbd></td></tr>
					<tr><td>${__("Save")}</td><td><kbd>Ctrl</kbd>+<kbd>S</kbd></td></tr>
					<tr><td>${__("Run File")}</td><td><kbd>F5</kbd></td></tr>
					<tr><td>${__("Toggle Terminal")}</td><td><kbd>Ctrl</kbd>+<kbd>\`</kbd></td></tr>
					<tr><td>${__("Command Palette")}</td><td><kbd>F1</kbd></td></tr>
				</table>
			</div>`;
		host.appendChild(this.el);
		this.tabsEl = this.el.querySelector(".mdt-tabs");
		this.breadcrumbs = this.el.querySelector(".mdt-breadcrumbs");
		this.banner = this.el.querySelector(".mdt-editor-banner");
		this.banner.addEventListener("click", (e) => this.onBannerAction(e.target.closest("[data-action]")?.dataset.action));
		this.runButton = this.el.querySelector(".mdt-run-btn");
		this.runButton.addEventListener("click", () => this.active && bus.emit("run:request", { path: this.active.path }));
		this.el.querySelector('[data-action="save"]').addEventListener("click", () => this.save());

		defineEditorThemes();
		this.editor = monaco.editor.create(this.el.querySelector(".mdt-editor-host"), {
			model: null,
			theme: monacoTheme,
			automaticLayout: true,
			fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
			fontSize: 13,
			lineHeight: 20,
			minimap: { enabled: true },
			smoothScrolling: true,
			cursorBlinking: "smooth",
			bracketPairColorization: { enabled: true },
			renderWhitespace: "selection",
			scrollBeyondLastLine: false,
			tabSize: 4,
			insertSpaces: false,
			detectIndentation: true,
		});
		this.editor.onDidChangeCursorPosition((e) =>
			bus.emit("editor:cursor", { line: e.position.lineNumber, column: e.position.column })
		);

		bus.on("file:open", ({ path }) => this.open(path));
		bus.on("appearance:changed", ({ monacoTheme: theme }) => monaco.editor.setTheme(theme));
		bus.on("icons:changed", () => this.render());
		bus.on("entry:renamed", ({ from, to }) => this.handleRename(from, to));
		bus.on("entry:deleted", ({ path }) => this.handleDelete(path));
		bus.on("fs:file-stat", (event) => this.onFileStat(event));
		this.render();
	}

	// -- open / close ---------------------------------------------------------

	async open(path) {
		if (this.tabs.has(path)) return this.activate(path);
		let file = this.preloaded.get(path);
		if (!file) {
			try {
				file = await this.api.call("read_file", { path });
			} catch (e) {
				return notifyError(e);
			}
		}
		if (this.tabs.has(path)) return this.activate(path);

		const language = languageForPath(path);
		const uri = monaco.Uri.from({ scheme: "studio", path: `/${path}` });
		// a model may already exist without a tab (loaded for Go to Definition)
		const model = monaco.editor.getModel(uri) || monaco.editor.createModel(file.content, language, uri);
		this.preloaded.delete(path);
		const tab = {
			path,
			model,
			language,
			version: file.version,
			readonly: file.readonly,
			savedVersion: model.getAlternativeVersionId(),
			viewState: null,
		};
		model.onDidChangeContent(() => this.renderTab(tab));
		this.tabs.set(path, tab);
		this.activate(path);
	}

	/** Model of a file without opening a tab (Monaco needs it to show a definition in another file). */
	async ensureModel(path) {
		const uri = monaco.Uri.from({ scheme: "studio", path: `/${path}` });
		const existing = monaco.editor.getModel(uri);
		if (existing) return existing;
		try {
			const file = await this.api.call("read_file", { path });
			this.preloaded.set(path, file);
			return monaco.editor.getModel(uri) || monaco.editor.createModel(file.content, languageForPath(path), uri);
		} catch (e) {
			return null;
		}
	}

	/** Move the cursor of the active tab to a Monaco selection / position and show it. */
	reveal(target) {
		if (!target) return;
		if ("startLineNumber" in target) {
			this.editor.setSelection(target);
			this.editor.revealRangeInCenterIfOutsideViewport(target);
		} else if ("lineNumber" in target) {
			this.editor.setPosition(target);
			this.editor.revealPositionInCenterIfOutsideViewport(target);
		}
		this.editor.focus();
	}

	/** A tab that is not a file on disk (e.g. the bench console buffer). Never dirty: onChange persists it. */
	openVirtual({ key, title, language, content, hint, onChange }) {
		if (this.tabs.has(key)) return this.activate(key);
		const model = monaco.editor.createModel(content || "", language, monaco.Uri.from({ scheme: "studio-console", path: `/${key.replace(/[^\w.-]+/g, "_")}` }));
		const tab = { path: key, model, language, virtual: true, title, hint, readonly: false, savedVersion: model.getAlternativeVersionId(), viewState: null };
		model.onDidChangeContent(() => onChange?.(model.getValue()));
		this.tabs.set(key, tab);
		this.activate(key);
	}

	activate(path) {
		const tab = this.tabs.get(path);
		if (!tab) return;
		if (this.active && this.active !== tab) this.active.viewState = this.editor.saveViewState();
		this.active = tab;
		this.editor.setModel(tab.model);
		this.editor.updateOptions({ readOnly: tab.readonly });
		if (tab.viewState) this.editor.restoreViewState(tab.viewState);
		this.editor.focus();
		this.render();
		this.bus.emit("editor:active", { path, language: tab.language, readonly: tab.readonly });
	}

	close(path, force = false) {
		const tab = this.tabs.get(path);
		if (!tab) return;
		if (!force && this.isDirty(tab)) {
			frappe.confirm(__("'{0}' has unsaved changes. Close and discard them?", [tab.path.split("/").pop()]), () =>
				this.close(path, true)
			);
			return;
		}
		const paths = [...this.tabs.keys()];
		const index = paths.indexOf(path);
		this.tabs.delete(path);
		tab.model.dispose();

		if (this.active === tab) {
			this.active = null;
			const next = paths[index + 1] || paths[index - 1];
			if (next && this.tabs.has(next)) this.activate(next);
			else {
				this.editor.setModel(null);
				this.bus.emit("editor:active", null);
			}
		}
		this.render();
	}

	// -- save -----------------------------------------------------------------

	isDirty(tab) {
		if (tab.virtual) return false;
		return tab.model.getAlternativeVersionId() !== tab.savedVersion;
	}

	hasUnsaved() {
		return [...this.tabs.values()].some((t) => this.isDirty(t));
	}

	async save(path = this.active?.path, { overwrite = false } = {}) {
		const tab = this.tabs.get(path);
		if (!tab || tab.readonly || tab.virtual) return;
		const version = tab.model.getAlternativeVersionId();
		tab.saving = true;
		try {
			const result = await this.api.call("write_file", {
				path: tab.path,
				content: tab.model.getValue(),
				expected_version: overwrite ? null : tab.version,
			});
			tab.version = result.version;
			tab.savedVersion = version;
			tab.lastSavedAt = Date.now();
			this.bus.emit("file:saved", { path: tab.path });
			tab.deleted = false;
			tab.conflictVersion = null;
			this.renderTab(tab);
			this.renderBanner();
			frappe.show_alert({ message: __("Saved {0}", [frappe.utils.escape_html(tab.path)]), indicator: "green" }, 2);
			return true;
		} catch (e) {
			if (e.type === "StudioConflictError") {
				frappe.confirm(
					__("{0} was changed on disk after you opened it. Overwrite it with your version?", [
						frappe.utils.escape_html(tab.path),
					]),
					() => this.save(path, { overwrite: true })
				);
			} else notifyError(e);
			return false;
		} finally {
			tab.saving = false;
		}
	}

	// -- changes made outside this editor ----------------------------------------

	isDirtyPath(path) {
		const tab = this.tabs.get(path);
		return !!tab && this.isDirty(tab);
	}

	/** Paths the file watcher should check. */
	openPaths() {
		return [...this.tabs.values()].filter((t) => !t.virtual).map((t) => t.path);
	}

	onFileStat({ path, stat, requestedAt }) {
		const tab = this.tabs.get(path);
		if (!tab) return;
		switch (fileChangeAction(tab, stat, requestedAt, this.isDirty(tab))) {
			case "deleted":
				tab.deleted = true;
				break;
			case "restored":
				tab.deleted = false;
				break;
			case "reload":
				return this.reloadFromDisk(tab);
			case "conflict":
				tab.conflictVersion = stat.version;
				break;
			default:
				return;
		}
		this.renderTab(tab);
		this.renderBanner();
	}

	/** Replace the content with the disk version, keeping undo history, cursor and scroll. */
	async reloadFromDisk(tab, { discardLocal = false } = {}) {
		tab.reloading = true;
		let file;
		try {
			file = await this.api.call("read_file", { path: tab.path });
		} catch (e) {
			tab.reloading = false;
			return notifyError(e);
		}
		tab.reloading = false;
		if (!this.tabs.has(tab.path)) return;
		if (this.isDirty(tab) && !discardLocal) {
			// the user started typing while we were fetching: ask instead of overwriting
			tab.conflictVersion = file.version;
			return this.renderBanner();
		}

		if (tab.model.getValue() !== file.content) {
			const isActive = tab === this.active;
			const viewState = isActive ? this.editor.saveViewState() : tab.viewState;
			tab.model.pushEditOperations([], [{ range: tab.model.getFullModelRange(), text: file.content }], () => null);
			if (isActive && viewState) this.editor.restoreViewState(viewState);
		}
		Object.assign(tab, { version: file.version, readonly: file.readonly, deleted: false, conflictVersion: null });
		tab.savedVersion = tab.model.getAlternativeVersionId();
		if (tab === this.active) this.editor.updateOptions({ readOnly: tab.readonly });
		this.renderTab(tab);
		this.renderBanner();
	}

	onBannerAction(action) {
		const tab = this.active;
		if (!tab || !action) return;
		if (action === "reload") this.reloadFromDisk(tab, { discardLocal: true });
		if (action === "keep") {
			// treat the disk version as seen: the next save overwrites it without asking
			tab.version = tab.conflictVersion;
			tab.conflictVersion = null;
			this.renderBanner();
		}
		if (action === "close") this.close(tab.path, true);
	}

	renderBanner() {
		const tab = this.active;
		this.banner.innerHTML = "";
		this.banner.className = "mdt-editor-banner";
		if (!tab || (!tab.deleted && !tab.conflictVersion)) return;

		this.banner.classList.add("visible", tab.deleted ? "deleted" : "conflict");
		const text = tab.deleted
			? __("This file was deleted on disk. Saving will create it again.")
			: __("This file was changed on disk, and you have unsaved changes here.");
		const buttons = tab.deleted
			? [[__("Close Tab"), "close", "ghost"]]
			: [
					[__("Reload (discard mine)"), "reload", "primary"],
					[__("Keep Mine"), "keep", "ghost"],
			  ];
		this.banner.innerHTML = `<span class="codicon codicon-${tab.deleted ? "trash" : "warning"}"></span><span class="mdt-banner-text"></span>
			${buttons.map(([label, action, variant]) => `<button class="mdt-btn mdt-btn-small mdt-btn-${variant}" data-action="${action}">${label}</button>`).join("")}`;
		this.banner.querySelector(".mdt-banner-text").textContent = text;
	}

	// -- rename / delete sync ---------------------------------------------------

	handleRename(from, to) {
		for (const tab of [...this.tabs.values()]) {
			if (tab.virtual || (tab.path !== from && !tab.path.startsWith(`${from}/`))) continue;
			const newPath = to + tab.path.slice(from.length);
			const wasActive = this.active === tab;
			const model = monaco.editor.createModel(tab.model.getValue(), languageForPath(newPath), monaco.Uri.from({ scheme: "studio", path: `/${newPath}` }));
			const dirty = this.isDirty(tab);
			tab.model.dispose();
			this.tabs.delete(tab.path);
			Object.assign(tab, { path: newPath, model, language: languageForPath(newPath) });
			tab.savedVersion = dirty ? -1 : model.getAlternativeVersionId();
			model.onDidChangeContent(() => this.renderTab(tab));
			this.tabs.set(newPath, tab);
			if (wasActive) {
				this.active = null;
				this.activate(newPath);
			}
		}
		this.render();
	}

	handleDelete(path) {
		for (const tab of [...this.tabs.values()]) {
			if (!tab.virtual && (tab.path === path || tab.path.startsWith(`${path}/`))) this.close(tab.path, true);
		}
	}

	// -- rendering --------------------------------------------------------------

	render() {
		this.tabsEl.innerHTML = "";
		for (const tab of this.tabs.values()) {
			tab.el = document.createElement("div");
			tab.el.className = "mdt-tab";
			tab.el.title = tab.path;
			tab.el.innerHTML = `
				<span class="mdt-tab-icon" data-base="mdt-tab-icon"></span>
				<span class="mdt-tab-label"></span>
				<span class="codicon codicon-close mdt-tab-close"></span>`;
			const icon = tab.el.querySelector(".mdt-tab-icon");
			if (tab.virtual) icon.className = "codicon codicon-debug-console mdt-tab-icon";
			else this.icons.render(icon, { name: tab.path.split("/").pop(), path: tab.path, type: "file", languageId: tab.language });
			tab.el.querySelector(".mdt-tab-label").textContent = tab.title || tab.path.split("/").pop();
			tab.el.addEventListener("click", () => this.activate(tab.path));
			tab.el.addEventListener("auxclick", (e) => e.button === 1 && this.close(tab.path));
			tab.el.querySelector(".mdt-tab-close").addEventListener("click", (e) => {
				e.stopPropagation();
				this.close(tab.path);
			});
			this.renderTab(tab);
			this.tabsEl.appendChild(tab.el);
		}

		const empty = !this.active;
		this.el.classList.toggle("empty", empty);
		this.breadcrumbs.innerHTML = "";
		if (!empty) {
			this.breadcrumbs.textContent = this.active.virtual ? this.active.hint || "" : this.active.path.split("/").join("  ›  ");
			if (this.active.readonly) this.breadcrumbs.append(`  (${__("read only")})`);
			this.active.el?.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
		this.renderBanner();
	}

	renderTab(tab) {
		if (!tab.el) return;
		tab.el.classList.toggle("active", tab === this.active);
		tab.el.classList.toggle("dirty", this.isDirty(tab));
		tab.el.classList.toggle("deleted", !!tab.deleted);
	}

	layout() {
		this.editor.layout();
	}
}
