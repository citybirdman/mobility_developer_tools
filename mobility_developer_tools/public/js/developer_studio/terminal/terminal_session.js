import { notifyError } from "../core/api_client";
import { TerminalTransport } from "./terminal_transport";
import { WrappedLinkProvider } from "./wrapped_link_provider";

const DARK_THEME = {
	background: "#21252b",
	foreground: "#abb2bf",
	cursor: "#61afef",
	cursorAccent: "#21252b",
	selectionBackground: "#3e4451",
	black: "#3f4451",
	red: "#e06c75",
	green: "#98c379",
	yellow: "#e5c07b",
	blue: "#61afef",
	magenta: "#c678dd",
	cyan: "#56b6c2",
	white: "#d7dae0",
	brightBlack: "#5c6370",
	brightRed: "#ef7b85",
	brightGreen: "#a9d48a",
	brightYellow: "#f0cf8f",
	brightBlue: "#74bdf7",
	brightMagenta: "#d48ae9",
	brightCyan: "#67c7d3",
	brightWhite: "#ffffff",
};

const LIGHT_THEME = {
	background: "#f3f3f4",
	foreground: "#383a42",
	cursor: "#2f74c0",
	cursorAccent: "#f3f3f4",
	selectionBackground: "#cfdcf0",
	black: "#383a42",
	red: "#c8414b",
	green: "#3f8a3a",
	yellow: "#a46a00",
	blue: "#2f74c0",
	magenta: "#9a3fb5",
	cyan: "#0e8090",
	white: "#9a9ca3",
	brightBlack: "#6b6f78",
	brightRed: "#d4505a",
	brightGreen: "#4e9a47",
	brightYellow: "#b77a0d",
	brightBlue: "#3b82d0",
	brightMagenta: "#a54fc0",
	brightCyan: "#1a8f9f",
	brightWhite: "#383a42",
};

export const TERMINAL_THEMES = { dark: DARK_THEME, light: LIGHT_THEME };

/** Opens http(s) links in a new browser tab (never javascript: or other schemes). */
export function openExternal(uri) {
	try {
		const url = new URL(uri);
		if (url.protocol === "http:" || url.protocol === "https:") window.open(url.href, "_blank", "noopener");
	} catch (e) {
		// not a URL
	}
}

/** One xterm.js view bound to one PTY on the server. */
export class TerminalSession {
	constructor(container, api, meta, { onExit, banner, theme = "dark" }) {
		this.meta = meta;
		this.id = meta.id;
		this.exited = false;

		this.el = document.createElement("div");
		this.el.className = "mdt-terminal-view";
		container.appendChild(this.el);

		const FitAddon = window.FitAddon.FitAddon || window.FitAddon;
		this.fit = new FitAddon();
		this.term = new window.Terminal({
			cursorBlink: true,
			fontFamily: "'JetBrains Mono', 'Fira Code', Menlo, Consolas, 'DejaVu Sans Mono', monospace",
			fontSize: 13,
			lineHeight: 1.2,
			scrollback: 5000,
			allowProposedApi: false,
			theme: TERMINAL_THEMES[theme] || DARK_THEME,
			// OSC 8 hyperlinks (CLIs print the full URL this way even when the text wraps)
			linkHandler: { activate: (event, uri) => openExternal(uri), allowNonHttpProtocols: false },
		});
		this.term.loadAddon(this.fit);
		this.term.registerLinkProvider(new WrappedLinkProvider(this.term, openExternal));
		this.term.open(this.el);
		this.installClipboardKeys();
		if (banner) this.term.write(`\x1b[90m${banner}\x1b[0m\r\n\r\n`);

		this.transport = new TerminalTransport(api, this.id, {
			onData: (data) => this.term.write(data),
			onExit: (code) => {
				this.exited = true;
				this.term.write(`\r\n\x1b[90m[${__("process exited")}${code != null ? ` (${code})` : ""}]\x1b[0m\r\n`);
				onExit?.(this);
			},
			onError: notifyError,
		});
		this.term.onData((data) => this.transport.send(data));
		this.term.onResize(({ cols, rows }) => this.transport.resize(cols, rows));

		this.resizeObserver = new ResizeObserver(() => this.fitNow());
		this.resizeObserver.observe(this.el);
		this.transport.fetchBacklog();
	}

	installClipboardKeys() {
		this.term.attachCustomKeyEventHandler((e) => {
			if (e.type !== "keydown") return true;
			const key = e.key.toLowerCase();
			if (e.ctrlKey && e.shiftKey && key === "c") {
				navigator.clipboard?.writeText(this.term.getSelection());
				return false;
			}
			if (e.ctrlKey && e.shiftKey && key === "v") {
				navigator.clipboard?.readText().then((text) => text && this.transport.send(text));
				return false;
			}
			return true;
		});
	}

	setTheme(mode) {
		this.term.options.theme = TERMINAL_THEMES[mode] || DARK_THEME;
	}

	fitNow() {
		if (!this.el.offsetParent) return; // hidden
		try {
			this.fit.fit();
		} catch (e) {
			// container not measurable yet
		}
	}

	get size() {
		return { cols: this.term.cols, rows: this.term.rows };
	}

	send(text) {
		this.transport.send(text);
	}

	resync() {
		return this.transport.fetchBacklog();
	}

	show(visible) {
		this.el.style.display = visible ? "" : "none";
		if (visible) {
			this.fitNow();
			this.term.focus();
		}
	}

	async kill() {
		try {
			await this.transport.close();
		} catch (e) {
			notifyError(e);
		}
	}

	dispose() {
		this.resizeObserver.disconnect();
		this.transport.dispose();
		this.term.dispose();
		this.el.remove();
	}
}
