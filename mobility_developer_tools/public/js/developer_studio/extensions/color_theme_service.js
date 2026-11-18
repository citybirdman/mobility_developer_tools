import { EDITOR_THEMES } from "../ui/editor_area";
import { TERMINAL_THEMES } from "../terminal/terminal_session";
import { cssVarsFromColors, modeOf, terminalThemeFromColors, toMonacoTheme } from "./theme_mapping";

const STUDIO_VARS = [
	"--mdt-bg", "--mdt-bg-side", "--mdt-bg-activity", "--mdt-bg-hover", "--mdt-bg-selected", "--mdt-bg-input",
	"--mdt-border", "--mdt-fg", "--mdt-fg-strong", "--mdt-fg-muted", "--mdt-accent", "--mdt-accent-strong",
	"--mdt-danger", "--mdt-warning", "--mdt-success", "--mdt-shadow-color",
];

/**
 * Owns the studio's look: the built-in dark/light themes (following Frappe) or a
 * color theme from an installed extension. Everyone else listens to
 *   appearance:changed {mode, monacoTheme, terminalTheme}
 * instead of deciding colors themselves.
 */
export class ColorThemeService {
	constructor({ root, bus, api, baseMode }) {
		this.root = root;
		this.bus = bus;
		this.api = api;
		this.baseMode = baseMode; // from Frappe (ThemeService)
		this.themes = new Map(); // key "<ext>/<id>" -> {ext, id, label, base, resource}
		this.selected = "";
		this.loaded = new Map(); // key -> {monacoName, mode, cssVars, colors}
		this.appliedVars = [];
		bus.on("theme:changed", (mode) => {
			this.baseMode = mode;
			if (!this.selected) this.apply();
		});
	}

	register(ext, theme) {
		this.themes.set(`${ext}/${theme.id}`, { ext, ...theme });
	}

	clearExtension(ext) {
		for (const key of [...this.themes.keys()]) if (key.startsWith(`${ext}/`)) this.themes.delete(key);
		if (this.selected.startsWith(`${ext}/`)) this.select("", { persist: false });
	}

	list() {
		return [...this.themes.entries()].map(([key, t]) => ({ key, label: t.label, ext: t.ext }));
	}

	async select(key, { persist = true } = {}) {
		if (key && !this.themes.has(key)) key = "";
		if (key) {
			try {
				await this.load(key);
			} catch (e) {
				console.error(e);
				key = "";
			}
		}
		this.selected = key;
		if (persist) this.api.call("ext_set_preference", { key: "color_theme", value: key }).catch(() => {});
		this.apply();
	}

	async load(key) {
		if (this.loaded.has(key)) return this.loaded.get(key);
		const theme = this.themes.get(key);
		const files = await this.api.call("ext_files", { ext_id: theme.ext, paths: [theme.resource] });
		const data = JSON.parse(files[theme.resource] || "{}");
		const monacoName = `mdt-ext-${key.replace(/[^\w-]+/g, "-")}`.slice(0, 120);
		monaco.editor.defineTheme(monacoName, toMonacoTheme(data, theme.base));
		const entry = { monacoName, mode: modeOf(theme.base), cssVars: cssVarsFromColors(data.colors || {}), colors: data.colors || {} };
		this.loaded.set(key, entry);
		return entry;
	}

	current() {
		const entry = this.selected ? this.loaded.get(this.selected) : null;
		if (!entry) {
			const mode = this.baseMode;
			return { mode, monacoTheme: EDITOR_THEMES[mode], terminalTheme: TERMINAL_THEMES[mode], colors: {} };
		}
		return {
			mode: entry.mode,
			monacoTheme: entry.monacoName,
			terminalTheme: terminalThemeFromColors(entry.colors, TERMINAL_THEMES[entry.mode]),
			colors: entry.colors,
		};
	}

	apply() {
		const appearance = this.current();
		for (const name of this.appliedVars) this.root.style.removeProperty(name);
		this.appliedVars = [];
		const entry = this.selected ? this.loaded.get(this.selected) : null;
		if (entry) {
			for (const [name, value] of Object.entries(entry.cssVars)) {
				this.root.style.setProperty(name, value);
				this.appliedVars.push(name);
			}
		}
		this.root.classList.toggle("mdt-theme-light", appearance.mode === "light");
		this.root.classList.toggle("mdt-theme-dark", appearance.mode === "dark");
		this.mirrorToBody();
		this.bus.emit("appearance:changed", appearance);
	}

	/**
	 * Frappe dialogs / msgprint / alerts are rendered outside the studio root: copy the
	 * studio's resolved colors onto <body> so the dialog styles (see SCSS) can use them.
	 */
	mirrorToBody() {
		const computed = getComputedStyle(this.root);
		for (const name of STUDIO_VARS) {
			const value = computed.getPropertyValue(name).trim();
			if (value) document.body.style.setProperty(name, value);
		}
	}

	/** Hex color for a vscode.ThemeColor id in the current theme (used by decorations). */
	themeColor(id) {
		return this.current().colors[id];
	}
}
