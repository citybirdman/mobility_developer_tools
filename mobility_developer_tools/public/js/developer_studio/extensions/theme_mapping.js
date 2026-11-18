/**
 * Pure conversions from a VS Code color theme to what the studio uses (unit-tested):
 *  - Monaco editor theme (token rules + editor colors)
 *  - studio CSS variables (side bar, activity bar, status bar, ...)
 *  - xterm.js terminal theme
 * Colors were validated as hex on the server; they are re-checked here because
 * they end up in CSS.
 */

const HEX = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export function isHexColor(value) {
	return typeof value === "string" && HEX.test(value);
}

/** "#abc" / "#abcd" / "#aabbcc" / "#aabbccdd" -> "aabbcc" (Monaco token rules take 6 digits). */
export function sixDigits(value) {
	if (!isHexColor(value)) return undefined;
	let hex = value.slice(1);
	if (hex.length <= 4) hex = [...hex].map((c) => c + c).join("");
	return hex.slice(0, 6).toLowerCase();
}

export function modeOf(base) {
	return base === "vs" || base === "hc-light" ? "light" : "dark";
}

export function toMonacoTheme(data, base = "vs-dark") {
	const rules = [];
	for (const entry of data.tokenColors || []) {
		const settings = entry.settings || {};
		const rule = {};
		if (sixDigits(settings.foreground)) rule.foreground = sixDigits(settings.foreground);
		if (sixDigits(settings.background)) rule.background = sixDigits(settings.background);
		if (typeof settings.fontStyle === "string") rule.fontStyle = settings.fontStyle.trim();
		if (!Object.keys(rule).length) continue;
		const scopes = entry.scope && entry.scope.length ? entry.scope : [""];
		for (const selector of scopes) {
			// Monaco matches dotted prefixes only: use the most specific part of a descendant selector
			const token = String(selector).trim().split(/\s+/).pop().replace(/^-/, "") || "";
			rules.push({ token, ...rule });
		}
	}
	const colors = {};
	for (const [key, value] of Object.entries(data.colors || {})) if (isHexColor(value)) colors[key] = value;
	return { base, inherit: true, rules, colors };
}

const CSS_VARS = {
	"--mdt-bg": ["editor.background"],
	"--mdt-bg-side": ["sideBar.background", "panel.background", "editorGroupHeader.tabsBackground"],
	"--mdt-bg-activity": ["activityBar.background", "sideBar.background"],
	"--mdt-bg-hover": ["list.hoverBackground"],
	"--mdt-bg-selected": ["list.activeSelectionBackground", "list.inactiveSelectionBackground"],
	"--mdt-bg-input": ["input.background"],
	"--mdt-border": ["panel.border", "sideBar.border", "editorGroup.border", "contrastBorder"],
	"--mdt-fg": ["foreground", "sideBar.foreground", "editor.foreground"],
	"--mdt-fg-strong": ["list.activeSelectionForeground", "editor.foreground"],
	"--mdt-fg-muted": ["descriptionForeground", "tab.inactiveForeground"],
	"--mdt-accent": ["focusBorder", "button.background", "activityBarBadge.background"],
	"--mdt-accent-strong": ["button.background", "focusBorder"],
	"--mdt-statusbar": ["statusBar.background"],
	"--mdt-statusbar-fg": ["statusBar.foreground"],
	"--mdt-danger": ["errorForeground", "editorError.foreground"],
	"--mdt-warning": ["editorWarning.foreground"],
};

/** Studio CSS variables for a theme; variables without a matching color keep the built-in value. */
export function cssVarsFromColors(colors) {
	const vars = {};
	for (const [name, keys] of Object.entries(CSS_VARS)) {
		const key = keys.find((k) => isHexColor(colors[k]));
		if (key) vars[name] = colors[key];
	}
	return vars;
}

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

export function terminalThemeFromColors(colors, fallback) {
	const pick = (...keys) => keys.map((k) => colors[k]).find(isHexColor);
	const theme = { ...fallback };
	const set = (key, value) => value && (theme[key] = value);
	set("background", pick("terminal.background", "panel.background", "sideBar.background", "editor.background"));
	set("foreground", pick("terminal.foreground", "editor.foreground", "foreground"));
	set("cursor", pick("terminalCursor.foreground", "editorCursor.foreground"));
	set("selectionBackground", pick("terminal.selectionBackground", "editor.selectionBackground"));
	for (const name of ANSI) {
		const cap = name[0].toUpperCase() + name.slice(1);
		set(name, pick(`terminal.ansi${cap}`));
		set(`bright${cap}`, pick(`terminal.ansiBright${cap}`));
	}
	theme.cursorAccent = theme.background;
	return theme;
}
