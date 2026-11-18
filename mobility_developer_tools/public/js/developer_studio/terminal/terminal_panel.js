import { notifyError } from "../core/api_client";
import { TerminalSession } from "./terminal_session";

const KEEPALIVE_MS = 30 * 1000;
const KIND_ICONS = {
	shell: "terminal",
	ai: "sparkle",
	install: "cloud-download",
	bench: "tools",
	console: "debug-console",
};

/**
 * Bottom panel holding several terminal sessions (tabs).
 *
 * Other components open terminals through the bus:
 *   terminal:open   {cwd}                              -> login shell
 *   terminal:launch {method, args, maximize, banner}   -> any server endpoint returning terminal meta
 */
export class TerminalPanel {
	constructor(host, { api, bus, contextMenu, theme = "dark" }) {
		this.api = api;
		this.bus = bus;
		this.menu = contextMenu;
		this.theme = theme;
		bus.on("appearance:changed", ({ terminalTheme }) => {
			this.theme = terminalTheme;
			this.sessions.forEach((s) => s.setTheme(terminalTheme));
		});
		this.sessions = [];
		this.active = null;
		this.counter = 0;

		this.el = document.createElement("div");
		this.el.className = "mdt-panel";
		this.el.innerHTML = `
			<div class="mdt-panel-header">
				<span class="mdt-panel-title">${__("Terminal")}</span>
				<div class="mdt-term-tabs"></div>
				<span class="mdt-panel-actions">
					<span class="codicon codicon-add" data-action="new" title="${__("New Terminal")}"></span>
					<span class="codicon codicon-trash" data-action="kill" title="${__("Kill Terminal")}"></span>
					<span class="codicon codicon-chevron-up" data-action="maximize" title="${__("Maximize Panel")}"></span>
					<span class="codicon codicon-close" data-action="hide" title="${__("Hide Panel")}"></span>
				</span>
			</div>
			<div class="mdt-term-body">
				<div class="mdt-term-empty">${__("No open terminals.")} <a data-action="new">${__("Open a terminal")}</a></div>
			</div>`;
		host.appendChild(this.el);
		this.tabsEl = this.el.querySelector(".mdt-term-tabs");
		this.body = this.el.querySelector(".mdt-term-body");

		this.el.querySelector(".mdt-panel-header").addEventListener("click", (e) => this.onAction(e.target.dataset.action));
		this.el.querySelector(".mdt-term-empty").addEventListener("click", (e) => this.onAction(e.target.dataset.action));

		bus.on("terminal:open", ({ cwd }) => this.create(cwd));
		bus.on("terminal:launch", (options) => this.launch(options));
		bus.on("panel:maximized", (maximized) => {
			const icon = this.el.querySelector('[data-action="maximize"]');
			icon.classList.toggle("codicon-chevron-up", !maximized);
			icon.classList.toggle("codicon-chevron-down", maximized);
		});
	}

	onAction(action) {
		if (action === "new") this.create();
		if (action === "kill" && this.active) this.active.kill();
		if (action === "maximize") this.bus.emit("panel:maximize");
		if (action === "hide") this.bus.emit("panel:toggle", false);
	}

	/** Re-attach to terminals that are still running on the server (after reload/unlock). */
	async attach() {
		try {
			const terminals = await this.api.call("terminal_list");
			for (const meta of terminals) {
				const existing = this.sessions.find((s) => s.id === meta.id);
				if (existing) existing.resync();
				else this.add(meta);
			}
		} catch (e) {
			notifyError(e);
		}
		this.startKeepalive();
		this.render();
	}

	create(cwd = "") {
		return this.launch({ method: "terminal_create", args: { cwd } });
	}

	async launch({ method, args = {}, maximize = false, banner = "" }) {
		this.bus.emit("panel:toggle", true);
		if (maximize) this.bus.emit("panel:maximize", true);
		const { cols, rows } = this.active?.size || { cols: 120, rows: 30 };
		try {
			const meta = await this.api.call(method, { cols, rows, ...args });
			const session = this.add(meta, banner);
			this.activate(session);
			return session;
		} catch (e) {
			notifyError(e);
		}
	}

	add(meta, banner = "") {
		meta.kind = meta.kind || "shell";
		meta.label = meta.kind === "shell" ? `${meta.title || "bash"} ${++this.counter}` : meta.title;
		const session = new TerminalSession(this.body, this.api, meta, {
			banner,
			theme: this.theme,
			onContextMenu: (s, e) => this.showMenu(s, e),
			onExit: (s) => this.onExit(s),
		});
		session.show(false);
		this.sessions.push(session);
		if (!this.active) this.activate(session);
		this.render();
		return session;
	}

	/** Shells close themselves; command / tool tabs stay so their output can be read. */
	onExit(session) {
		if (session.meta.kind === "shell") setTimeout(() => this.remove(session), 1500);
		else this.render();
		if (session.meta.kind === "install") this.bus.emit("ai:refresh");
	}

	showMenu(session, event) {
		if (!this.menu) return;
		this.activate(session);
		this.menu.show(event.clientX, event.clientY, [
			{ label: __("Copy"), icon: "copy", shortcut: "Ctrl+C", action: () => session.copy() },
			{ label: __("Paste"), icon: "clippy", shortcut: "Ctrl+V", action: () => session.paste() },
			{ label: __("Select All"), icon: "list-selection", shortcut: "Ctrl+Shift+A", action: () => session.selectAll() },
			"-",
			{ label: __("Clear"), icon: "clear-all", action: () => session.clear() },
			session.exited
				? { label: __("Close"), icon: "close", action: () => this.remove(session) }
				: { label: __("Kill"), icon: "trash", danger: true, action: () => session.kill() },
		]);
	}

	remove(session) {
		session.dispose();
		this.sessions = this.sessions.filter((s) => s !== session);
		if (this.active === session) {
			this.active = null;
			if (this.sessions.length) this.activate(this.sessions[this.sessions.length - 1]);
		}
		this.render();
	}

	activate(session) {
		this.active = session;
		for (const s of this.sessions) s.show(s === session);
		this.render();
	}

	/** Send a command line to the active shell terminal, opening one if needed. */
	async runCommand(command) {
		let session = this.active && !this.active.exited && this.active.meta.kind === "shell" ? this.active : null;
		session = session || this.sessions.find((s) => !s.exited && s.meta.kind === "shell") || (await this.create());
		if (!session) return;
		this.bus.emit("panel:toggle", true);
		this.activate(session);
		session.send(`${command}\r`);
	}

	focus() {
		this.active?.show(true);
	}

	fit() {
		this.active?.fitNow();
	}

	startKeepalive() {
		if (this.keepaliveTimer) return;
		this.keepaliveTimer = setInterval(() => {
			const ids = this.sessions.filter((s) => !s.exited).map((s) => s.id);
			if (ids.length && this.api.token) this.api.call("terminal_keepalive", { term_ids: ids }).catch(() => {});
		}, KEEPALIVE_MS);
	}

	stopKeepalive() {
		clearInterval(this.keepaliveTimer);
		this.keepaliveTimer = null;
	}

	render() {
		this.tabsEl.innerHTML = "";
		for (const session of this.sessions) {
			const tab = document.createElement("div");
			tab.className =
				`mdt-term-tab kind-${session.meta.kind}` +
				(session === this.active ? " active" : "") +
				(session.exited ? " exited" : "");
			tab.innerHTML = `<span class="codicon codicon-${KIND_ICONS[session.meta.kind] || "terminal"}"></span><span></span>
				<span class="codicon codicon-close" title="${__("Kill Terminal")}"></span>`;
			tab.children[1].textContent = session.meta.label;
			tab.addEventListener("click", () => this.activate(session));
			tab.querySelector(".codicon-close").addEventListener("click", (e) => {
				e.stopPropagation();
				session.exited ? this.remove(session) : session.kill();
			});
			this.tabsEl.appendChild(tab);
		}
		this.el.querySelector(".mdt-term-empty").style.display = this.sessions.length ? "none" : "";
	}
}
