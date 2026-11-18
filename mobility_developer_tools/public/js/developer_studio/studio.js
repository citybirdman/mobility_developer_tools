import { StudioApi, notifyError } from "./core/api_client";
import { loadStudioAssets } from "./core/asset_loader";
import { EventBus } from "./core/event_bus";
import { FileWatcher } from "./core/file_watcher";
import { CodeNavigation } from "./core/code_navigation";
import { ConsoleService } from "./core/console_service";
import { RunService } from "./core/run_service";
import { ThemeService } from "./core/theme";
import { TokenStore } from "./core/token_store";
import { ColorThemeService } from "./extensions/color_theme_service";
import { CommandRegistry } from "./extensions/command_registry";
import { createConverters } from "./extensions/converters";
import { DecorationManager } from "./extensions/decoration_manager";
import { DocumentSync } from "./extensions/document_sync";
import { ExtensionManager } from "./extensions/extension_manager";
import { ExtensionUi } from "./extensions/extension_ui";
import { IconThemeService } from "./extensions/icon_theme_service";
import { OutputLog } from "./extensions/output_log";
import { TextMateEngine } from "./extensions/textmate";
import { TerminalPanel } from "./terminal/terminal_panel";
import { AiToolsView } from "./ui/ai_tools_view";
import { BenchView } from "./ui/bench_view";
import { CommandPalette } from "./ui/command_palette";
import { ContextMenu } from "./ui/context_menu";
import { EditorArea } from "./ui/editor_area";
import { ExtensionsView } from "./ui/extensions_view";
import { FileExplorer } from "./ui/file_explorer";
import { LockScreen } from "./ui/lock_screen";
import { OpenUrlNotifier } from "./ui/open_url_notifier";
import { QuickOpen } from "./ui/quick_open";
import { SearchView } from "./ui/search_view";
import { StatusBar } from "./ui/status_bar";
import { StudioDialog, normalizeMsgprint } from "./ui/studio_dialog";
import { WorkbenchLayout } from "./ui/workbench_layout";

/**
 * Composition root of the front end: creates every component, injects shared
 * dependencies (api, event bus, services) and owns the lock/unlock flow and the
 * global keyboard shortcuts. Components only talk to each other via the bus.
 */
export class DeveloperStudio {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.api = new StudioApi({ tokenStore: new TokenStore(frappe.session.user) });
		this.bus = new EventBus();
		this.workbench = null;

		this.root = document.createElement("div");
		this.root.className = "mdt-studio";
		this.root.innerHTML = `<div class="mdt-loading"><div class="mdt-spinner"></div>${__("Loading Developer Studio...")}</div>`;
		wrapper.innerHTML = "";
		wrapper.appendChild(this.root);

		const frappeTheme = new ThemeService(this.root, this.bus);
		this.colorThemes = new ColorThemeService({ root: this.root, bus: this.bus, api: this.api, baseMode: frappeTheme.mode });
		this.colorThemes.apply();
		this.lockScreen = new LockScreen(this.root, this.api);
		this.dialogs = new StudioDialog(this.root);
		this.installDialogs();
		this.api.onLocked(() => this.lock({ notifyServer: false }));
		this.installKeyboard();
		this.positionBelowNavbar();
		window.addEventListener("resize", () => this.positionBelowNavbar());
		window.addEventListener("beforeunload", (e) => {
			if (this.workbench?.editor.hasUnsaved()) e.preventDefault();
		});

		this.assets = loadStudioAssets();
		this.start();
	}

	async start() {
		let status;
		try {
			status = await this.api.call("status");
		} catch (e) {
			this.root.querySelector(".mdt-loading").innerHTML = `<div class="mdt-error"></div>`;
			this.root.querySelector(".mdt-error").textContent = e.message;
			return;
		}
		this.root.querySelector(".mdt-loading")?.remove();
		// a remembered, still valid unlock skips the password (asked only on first entry)
		if (status.unlocked) return this.open(status);
		this.api.setToken(null);
		await this.unlock();
	}

	async unlock() {
		this.open(await this.lockScreen.prompt());
	}

	async open(context) {
		try {
			await this.assets;
		} catch (e) {
			return notifyError(e);
		}
		const firstTime = !this.workbench;
		if (firstTime) this.buildWorkbench(context);
		this.bus.emit("studio:unlocked");
		await Promise.all([
			this.workbench.explorer.load(),
			this.workbench.terminals.attach(),
			this.workbench.aiTools.load(),
			firstTime ? this.workbench.extensions.load() : null,
		]);
		this.workbench.editor.layout();
		this.workbench.watcher.start();
	}

	async lock({ notifyServer = true } = {}) {
		if (this.lockScreen.visible) return;
		if (notifyServer) {
			try {
				await this.api.call("lock");
			} catch (e) {
				// already locked
			}
		}
		this.api.setToken(null);
		this.workbench?.terminals.stopKeepalive();
		this.workbench?.watcher.stop();
		this.bus.emit("studio:locked");
		this.unlock();
	}

	buildWorkbench(context) {
		const { api, bus, colorThemes } = this;
		const menu = new ContextMenu(this.root);
		const icons = new IconThemeService({ bus, api });
		const layout = new WorkbenchLayout(this.root, {
			onResize: () => {
				this.workbench?.editor.layout();
				this.workbench?.terminals.fit();
			},
			onMaximize: (maximized) => bus.emit("panel:maximized", maximized),
			onViewShown: (view) => {
				if (view === "ai") this.workbench?.aiTools.load();
				if (view === "bench") this.workbench?.bench.load();
				if (view === "extensions") this.workbench?.extensionsView.load();
			},
		});
		const explorer = new FileExplorer(layout.addView("explorer"), { api, bus, contextMenu: menu, icons });
		const searchSlot = layout.addView("search");
		const aiTools = new AiToolsView(layout.addView("ai"), { api, bus });
		const bench = new BenchView(layout.addView("bench"), { api, bus });
		const extensionsSlot = layout.addView("extensions");
		const urlNotifier = new OpenUrlNotifier(this.root);
		const editor = new EditorArea(layout.editorSlot, { api, bus, icons, monacoTheme: colorThemes.current().monacoTheme });
		const terminals = new TerminalPanel(layout.panelSlot, { api, bus, contextMenu: menu, theme: colorThemes.current().terminalTheme });
		const quickOpen = new QuickOpen(this.root, { api, bus, icons });
		const status = new StatusBar(layout.statusSlot, { bus, onLock: () => this.lock() });
		const runner = new RunService({ api, bus, editor, terminals, contextMenu: menu });
		const benchConsole = new ConsoleService({ bus, editorArea: editor, terminals, site: context.site });
		const navigation = new CodeNavigation({ api, editorArea: editor });
		const search = new SearchView(searchSlot, { api, bus, editorArea: editor, icons, dialogs: this.dialogs });
		const palette = new CommandPalette({ host: this.root, editor: editor.editor });

		// -- extensions -------------------------------------------------------------------------
		const sync = new DocumentSync({ editor: editor.editor, root: context.root, isDirty: (path) => editor.isDirtyPath(path) });
		const output = new OutputLog();
		const decorations = new DecorationManager({ themeColor: (id) => colorThemes.themeColor(id), mode: colorThemes.current().mode });
		bus.on("appearance:changed", ({ mode }) => decorations.setMode(mode));
		bus.on("file:saved", ({ path }) => sync.notifySaved(path));
		const extensions = new ExtensionManager({
			api,
			bus,
			handlerContext: {
				api,
				colorThemes,
				iconThemes: icons,
				textmate: new TextMateEngine({
					readFile: async (grammar) => (await api.call("ext_files", { ext_id: grammar.ext, paths: [grammar.path] }))[grammar.path],
				}),
			},
			hostServices: {
				api,
				bus,
				sync,
				editor: editor.editor,
				editorArea: editor,
				root: context.root,
				commands: new CommandRegistry({ editor: editor.editor, editorArea: editor, sync }),
				decorations,
				output,
				ui: new ExtensionUi({ host: this.root }),
				statusBar: status,
				colorThemes,
				converters: createConverters(monaco, {
					toModelUri: (docUri) => sync.modelFor(docUri)?.uri || null,
					toDocUri: (modelUri) => `file://${context.root}${modelUri.path}`,
				}),
			},
		});
		const extensionsView = new ExtensionsView(extensionsSlot, { api, bus, manager: extensions, colorThemes, iconThemes: icons, output });

		explorer.setRoot(context.root, context.root_name);
		status.setContext({ site: context.site, root: context.root });
		bus.on("panel:toggle", (visible) => layout.togglePanel(visible));
		bus.on("panel:maximize", (maximized) => layout.toggleMaximize(maximized));
		layout.onActivity((action, target) => {
			if (["explorer", "search", "ai", "bench", "extensions"].includes(action)) layout.showView(action);
			if (action === "search" && layout.currentView === "search" && layout.state.sidebarVisible) search.focus();
			if (action === "terminal") this.toggleTerminal();
			if (action === "lock") this.lock();
			if (action === "account") this.showAccountMenu(menu, target);
			if (action === "desk") frappe.set_route("/app");
		});

		const watcher = new FileWatcher({ api, bus });
		watcher.watchFiles(() => editor.openPaths());
		watcher.watchFolders(() => explorer.watchedFolders());
		bus.on("search:in-folder", ({ path }) => {
			layout.showView("search", { toggle: false });
			search.findInFolder(path);
		});
		bus.on("search:replaced", () => watcher.pollSoon(0)); // open editors pick up the replaced text now

		this.workbench = { layout, explorer, search, aiTools, bench, extensions, extensionsView, urlNotifier, watcher, editor, terminals, quickOpen, status, runner, sync, benchConsole, navigation, palette };
		const studioCommands = this.studioCommands();
		palette.addSource(() => studioCommands);
		palette.addSource(() => extensions.paletteCommands());
		palette.registerInEditor(studioCommands);
		this.lockScreen.el.parentNode.appendChild(this.lockScreen.el); // keep lock overlay on top
	}

	showAccountMenu(menu, target) {
		const rect = target.getBoundingClientRect();
		menu.show(rect.right + 4, rect.top - 150, [
			{ label: frappe.session.user_fullname || frappe.session.user, icon: "account", action: () => frappe.set_route("Form", "User", frappe.session.user) },
			"-",
			{ label: __("Back to Desk"), icon: "home", action: () => frappe.set_route("/app") },
			{ label: __("Lock Studio"), icon: "lock", shortcut: "Ctrl+Shift+L", action: () => this.lock() },
			"-",
			{ label: __("Log Out"), icon: "sign-out", danger: true, action: () => frappe.app.logout() },
		]);
	}

	/** Commands of the studio itself (palette + Monaco's F1 when a file is open). */
	studioCommands() {
		const { layout, quickOpen, terminals } = this.workbench;
		return [
			{ id: "quickOpen", label: __("Go to File..."), keys: "Ctrl+P", run: () => quickOpen.show() },
			{ id: "search", label: __("Search: Find in Files"), keys: "Ctrl+Shift+F", run: () => this.showSearch() },
			{ id: "replace", label: __("Search: Replace in Files"), keys: "Ctrl+Shift+H", run: () => this.showSearch({ replace: true }) },
			{ id: "toggleTerminal", label: __("Toggle Terminal"), keys: "Ctrl+`", run: () => this.toggleTerminal() },
			{ id: "newTerminal", label: __("Terminal: New Terminal"), run: () => terminals.create() },
			{ id: "console", label: __("Bench: Open Console"), run: () => this.bus.emit("console:open") },
			{ id: "explorer", label: __("View: Show Explorer"), run: () => layout.showView("explorer") },
			{ id: "extensions", label: __("View: Show Extensions"), keys: "Ctrl+Shift+X", run: () => layout.showView("extensions") },
			{ id: "bench", label: __("View: Show Frappe & Bench"), run: () => layout.showView("bench") },
			{ id: "ai", label: __("View: Show AI Assistants"), run: () => layout.showView("ai") },
			{ id: "lock", label: __("Studio: Lock"), keys: "Ctrl+Shift+L", run: () => this.lock() },
			{ id: "desk", label: __("Studio: Back to Desk"), run: () => frappe.set_route("/app") },
		];
	}

	/** Ctrl+Shift+F / Ctrl+Shift+H: the Search view, seeded with the editor's selected text. */
	showSearch({ replace = false } = {}) {
		const { layout, search, editor } = this.workbench;
		const selection = editor.active ? editor.editor.getModel()?.getValueInRange(editor.editor.getSelection()) : "";
		layout.showView("search", { toggle: false });
		search.focus({ seed: selection || "", replace });
	}

	toggleTerminal() {
		const { layout, terminals } = this.workbench;
		layout.togglePanel();
		if (layout.state.panelVisible) {
			if (!terminals.sessions.length) terminals.create();
			else terminals.focus();
		}
	}

	/** The studio page is on screen (Frappe's other pages keep Frappe's own dialogs). */
	isShown() {
		return document.body.classList.contains("mdt-fullscreen") && this.root.isConnected && this.root.getClientRects().length > 0;
	}

	/**
	 * While the studio is shown, frappe.msgprint / confirm / warn use the VS Code-style
	 * StudioDialog. Anything it does not support falls back to Frappe's own dialog.
	 */
	installDialogs() {
		const original = { msgprint: frappe.msgprint, confirm: frappe.confirm, warn: frappe.warn };
		const dialogs = this.dialogs;

		frappe.msgprint = (msg, title, ...rest) => {
			const options = this.isShown() ? normalizeMsgprint(msg, title) : null;
			if (!options) return original.msgprint.call(frappe, msg, title, ...rest);
			const buttons = options.primaryAction
				? [
						{ label: options.primaryAction.label || __("OK"), value: "primary", primary: true },
						{ label: __("Close"), value: undefined },
				  ]
				: null;
			const promise = dialogs.show({ type: options.type, title: options.title, html: options.html, buttons, merge: !buttons });
			if (options.primaryAction) promise.then((v) => v === "primary" && options.primaryAction.action());
			return dialogs.handle(promise);
		};

		frappe.confirm = (message, onYes, onNo, primaryLabel, secondaryLabel) => {
			if (!this.isShown()) return original.confirm.call(frappe, message, onYes, onNo, primaryLabel, secondaryLabel);
			const promise = dialogs.show({
				type: "question",
				html: String(message),
				buttons: [
					{ label: primaryLabel || __("Yes"), value: true, primary: true },
					{ label: secondaryLabel || __("No"), value: false },
				],
				cancelValue: false,
			});
			promise.then((yes) => (yes ? onYes?.() : onNo?.()));
			return dialogs.handle(promise);
		};

		frappe.warn = (title, messageHtml, proceed, primaryLabel, ...rest) => {
			if (!this.isShown()) return original.warn.call(frappe, title, messageHtml, proceed, primaryLabel, ...rest);
			const promise = dialogs.show({
				type: "warning",
				title,
				html: String(messageHtml),
				buttons: [
					{ label: primaryLabel || __("Continue"), value: true, primary: true },
					{ label: __("Cancel"), value: false },
				],
				cancelValue: false,
			});
			promise.then((go) => go && proceed?.());
			return dialogs.handle(promise);
		};
	}

	/** Is the key event meant for the studio? (focus inside it, or nothing focused while it is shown) */
	ownsKeyEvent(e) {
		// the root is position:fixed (offsetParent is always null): visible = it renders boxes
		if (!this.root.isConnected || this.root.getClientRects().length === 0) return false;
		const target = e.target;
		return this.root.contains(target) || target === document.body || target === document.documentElement;
	}

	installKeyboard() {
		// window capture phase: works with nothing focused (welcome screen) and wins over Monaco / xterm / browser
		window.addEventListener(
			"keydown",
			(e) => {
				if (!this.workbench || this.lockScreen.visible || !this.ownsKeyEvent(e)) return;
				const ctrl = e.ctrlKey || e.metaKey;
				const key = e.key.toLowerCase();
				const inTerminal = !!e.target.closest?.(".mdt-terminal-view");
				let handled = true;

				if (ctrl && key === "s") this.workbench.editor.save();
				else if (ctrl && !e.shiftKey && key === "p" && !inTerminal) this.workbench.quickOpen.show();
				else if (ctrl && e.code === "Backquote") this.toggleTerminal();
				else if (e.key === "F5") this.bus.emit("run:request", {});
				else if (e.key === "F12" && !e.altKey && !e.shiftKey && !ctrl) {
					if (e.target.closest?.(".monaco-editor")) this.workbench.navigation.goToDefinition();
				}
				else if (ctrl && e.shiftKey && key === "l") this.lock();
				else if (ctrl && e.shiftKey && key === "x") this.workbench.layout.showView("extensions");
				else if (ctrl && e.shiftKey && key === "f" && !inTerminal) this.showSearch();
				else if (ctrl && e.shiftKey && key === "h" && !inTerminal) this.showSearch({ replace: true });
				else if (e.key === "F1" && !ctrl && !e.altKey) this.workbench.palette.open();
				else handled = false;

				if (handled) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			true
		);
		// F12 never opens the browser's developer tools while the studio is shown, wherever the focus is
		window.addEventListener(
			"keydown",
			(e) => {
				if (e.key === "F12" && document.body.classList.contains("mdt-fullscreen")) e.preventDefault();
			},
			true
		);
		// bubble phase: keep Frappe's global desk shortcuts out of the studio
		this.root.addEventListener("keydown", (e) => e.stopPropagation());
		this.root.addEventListener("keyup", (e) => e.stopPropagation());
	}

	/** The studio is full screen: Frappe's header is hidden while it is shown (see page js). */
	positionBelowNavbar() {
		const navbar = document.querySelector(".navbar");
		const bottom = navbar && navbar.offsetParent !== null ? navbar.getBoundingClientRect().bottom : 0;
		this.root.style.top = `${Math.max(bottom, 0)}px`;
	}

	on_show() {
		this.positionBelowNavbar();
		if (this.workbench) {
			this.workbench.editor.layout();
			this.workbench.terminals.fit();
		}
	}
}
