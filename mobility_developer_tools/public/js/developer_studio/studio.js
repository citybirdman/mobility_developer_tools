import { StudioApi, notifyError } from "./core/api_client";
import { loadStudioAssets } from "./core/asset_loader";
import { EventBus } from "./core/event_bus";
import { RunService } from "./core/run_service";
import { TerminalPanel } from "./terminal/terminal_panel";
import { AiToolsView } from "./ui/ai_tools_view";
import { ContextMenu } from "./ui/context_menu";
import { OpenUrlNotifier } from "./ui/open_url_notifier";
import { EditorArea } from "./ui/editor_area";
import { FileExplorer } from "./ui/file_explorer";
import { LockScreen } from "./ui/lock_screen";
import { QuickOpen } from "./ui/quick_open";
import { StatusBar } from "./ui/status_bar";
import { WorkbenchLayout } from "./ui/workbench_layout";
import { ThemeService } from "./core/theme";

/**
 * Composition root of the front end: creates every component, injects shared
 * dependencies (api, event bus, context menu) and owns the lock/unlock flow and
 * the global keyboard shortcuts. Components only talk to each other via the bus.
 */
export class DeveloperStudio {
	constructor(wrapper) {
		this.wrapper = wrapper;
		this.api = new StudioApi();
		this.bus = new EventBus();
		this.workbench = null;

		this.root = document.createElement("div");
		this.root.className = "mdt-studio";
		this.root.innerHTML = `<div class="mdt-loading"><div class="mdt-spinner"></div>${__("Loading Developer Studio...")}</div>`;
		wrapper.innerHTML = "";
		wrapper.appendChild(this.root);

		this.theme = new ThemeService(this.root, this.bus);
		this.lockScreen = new LockScreen(this.root, this.api);
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
		try {
			await this.api.call("status");
		} catch (e) {
			this.root.querySelector(".mdt-loading").innerHTML = `<div class="mdt-error"></div>`;
			this.root.querySelector(".mdt-error").textContent = e.message;
			return;
		}
		this.root.querySelector(".mdt-loading")?.remove();
		await this.unlock();
	}

	async unlock() {
		const context = await this.lockScreen.prompt();
		try {
			await this.assets;
		} catch (e) {
			return notifyError(e);
		}
		if (!this.workbench) this.buildWorkbench(context);
		this.bus.emit("studio:unlocked");
		await Promise.all([
			this.workbench.explorer.load(),
			this.workbench.terminals.attach(),
			this.workbench.aiTools.load(),
		]);
		this.workbench.editor.layout();
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
		this.bus.emit("studio:locked");
		this.unlock();
	}

	buildWorkbench(context) {
		const { api, bus } = this;
		const menu = new ContextMenu(this.root);
		const layout = new WorkbenchLayout(this.root, {
			onResize: () => {
				this.workbench?.editor.layout();
				this.workbench?.terminals.fit();
			},
			onMaximize: (maximized) => bus.emit("panel:maximized", maximized),
			onViewShown: (view) => view === "ai" && this.workbench?.aiTools.load(),
		});
		const explorer = new FileExplorer(layout.addView("explorer"), { api, bus, contextMenu: menu });
		const aiTools = new AiToolsView(layout.addView("ai"), { api, bus });
		const urlNotifier = new OpenUrlNotifier(this.root);
		const editor = new EditorArea(layout.editorSlot, { api, bus, theme: this.theme.mode });
		const terminals = new TerminalPanel(layout.panelSlot, { api, bus, theme: this.theme.mode });
		const quickOpen = new QuickOpen(this.root, { api, bus });
		const status = new StatusBar(layout.statusSlot, { bus, onLock: () => this.lock() });
		const runner = new RunService({ api, bus, editor, terminals, contextMenu: menu });

		explorer.setRoot(context.root, context.root_name);
		status.setContext({ site: context.site, root: context.root });
		bus.on("panel:toggle", (visible) => layout.togglePanel(visible));
		bus.on("panel:maximize", (maximized) => layout.toggleMaximize(maximized));
		layout.onActivity((action) => {
			if (action === "explorer" || action === "ai") layout.showView(action);
			if (action === "quick-open") quickOpen.show();
			if (action === "terminal") this.toggleTerminal();
			if (action === "lock") this.lock();
		});

		this.workbench = { layout, explorer, aiTools, urlNotifier, editor, terminals, quickOpen, status, runner };
		this.lockScreen.el.parentNode.appendChild(this.lockScreen.el); // keep lock overlay on top
	}

	toggleTerminal() {
		const { layout, terminals } = this.workbench;
		layout.togglePanel();
		if (layout.state.panelVisible) {
			if (!terminals.sessions.length) terminals.create();
			else terminals.focus();
		}
	}

	installKeyboard() {
		// capture phase: studio shortcuts win over Monaco / xterm / browser
		this.root.addEventListener(
			"keydown",
			(e) => {
				if (!this.workbench || this.lockScreen.visible) return;
				const ctrl = e.ctrlKey || e.metaKey;
				const key = e.key.toLowerCase();
				const inTerminal = !!e.target.closest?.(".mdt-terminal-view");
				let handled = true;

				if (ctrl && key === "s") this.workbench.editor.save();
				else if (ctrl && !e.shiftKey && key === "p" && !inTerminal) this.workbench.quickOpen.show();
				else if (ctrl && e.code === "Backquote") this.toggleTerminal();
				else if (e.key === "F5") this.bus.emit("run:request", {});
				else if (ctrl && e.shiftKey && key === "l") this.lock();
				else handled = false;

				if (handled) {
					e.preventDefault();
					e.stopPropagation();
				}
			},
			true
		);
		// bubble phase: keep Frappe's global desk shortcuts out of the studio
		this.root.addEventListener("keydown", (e) => e.stopPropagation());
		this.root.addEventListener("keyup", (e) => e.stopPropagation());
	}

	positionBelowNavbar() {
		const navbar = document.querySelector(".navbar");
		this.root.style.top = `${navbar ? navbar.getBoundingClientRect().bottom : 48}px`;
	}

	on_show() {
		this.positionBelowNavbar();
		if (this.workbench) {
			this.workbench.editor.layout();
			this.workbench.terminals.fit();
		}
	}
}
