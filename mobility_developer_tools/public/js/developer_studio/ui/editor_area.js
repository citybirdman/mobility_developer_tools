import { notifyError } from "../core/api_client";
import { iconColorForPath, languageForPath } from "../core/languages";

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
	constructor(host, { api, bus, theme = "dark" }) {
		this.api = api;
		this.bus = bus;
		this.tabs = new Map(); // path -> tab
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
		this.runButton = this.el.querySelector(".mdt-run-btn");
		this.runButton.addEventListener("click", () => this.active && bus.emit("run:request", { path: this.active.path }));
		this.el.querySelector('[data-action="save"]').addEventListener("click", () => this.save());

		defineEditorThemes();
		this.editor = monaco.editor.create(this.el.querySelector(".mdt-editor-host"), {
			model: null,
			theme: EDITOR_THEMES[theme] || EDITOR_THEMES.dark,
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
		bus.on("theme:changed", (mode) => monaco.editor.setTheme(EDITOR_THEMES[mode]));
		bus.on("entry:renamed", ({ from, to }) => this.handleRename(from, to));
		bus.on("entry:deleted", ({ path }) => this.handleDelete(path));
		this.render();
	}

	// -- open / close ---------------------------------------------------------

	async open(path) {
		if (this.tabs.has(path)) return this.activate(path);
		let file;
		try {
			file = await this.api.call("read_file", { path });
		} catch (e) {
			return notifyError(e);
		}
		if (this.tabs.has(path)) return this.activate(path);

		const language = languageForPath(path);
		const model = monaco.editor.createModel(file.content, language, monaco.Uri.from({ scheme: "studio", path: `/${path}` }));
		const tab = {
			path,
			model,
			language,
			mtime: file.mtime,
			readonly: file.readonly,
			savedVersion: model.getAlternativeVersionId(),
			viewState: null,
		};
		model.onDidChangeContent(() => this.renderTab(tab));
		this.tabs.set(path, tab);
		this.activate(path);
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
		return tab.model.getAlternativeVersionId() !== tab.savedVersion;
	}

	hasUnsaved() {
		return [...this.tabs.values()].some((t) => this.isDirty(t));
	}

	async save(path = this.active?.path, { overwrite = false } = {}) {
		const tab = this.tabs.get(path);
		if (!tab || tab.readonly) return;
		const version = tab.model.getAlternativeVersionId();
		try {
			const result = await this.api.call("write_file", {
				path: tab.path,
				content: tab.model.getValue(),
				expected_mtime: overwrite ? null : tab.mtime,
			});
			tab.mtime = result.mtime;
			tab.savedVersion = version;
			this.renderTab(tab);
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
		}
	}

	// -- rename / delete sync ---------------------------------------------------

	handleRename(from, to) {
		for (const tab of [...this.tabs.values()]) {
			if (tab.path !== from && !tab.path.startsWith(`${from}/`)) continue;
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
			if (tab.path === path || tab.path.startsWith(`${path}/`)) this.close(tab.path, true);
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
				<span class="codicon codicon-file mdt-tab-icon"></span>
				<span class="mdt-tab-label"></span>
				<span class="codicon codicon-close mdt-tab-close"></span>`;
			tab.el.querySelector(".mdt-tab-icon").style.color = iconColorForPath(tab.path);
			tab.el.querySelector(".mdt-tab-label").textContent = tab.path.split("/").pop();
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
			this.breadcrumbs.textContent = this.active.path.split("/").join("  ›  ");
			if (this.active.readonly) this.breadcrumbs.append(`  (${__("read only")})`);
			this.active.el?.scrollIntoView({ block: "nearest", inline: "nearest" });
		}
	}

	renderTab(tab) {
		if (!tab.el) return;
		tab.el.classList.toggle("active", tab === this.active);
		tab.el.classList.toggle("dirty", this.isDirty(tab));
	}

	layout() {
		this.editor.layout();
	}
}
