/**
 * Keyboard policy of the terminal (pure, unit-tested in tests/js).
 *
 * Returns what to do with a keydown:
 *   "native-paste" -> let the browser fire its paste event; xterm inserts the text
 *                     (works without the async clipboard API, i.e. also on plain http)
 *   "copy"         -> copy the selection (Ctrl+C with a selection, Ctrl+Shift+C, Ctrl+Insert)
 *   "select-all"   -> Ctrl+Shift+A
 *   "terminal"     -> normal key for the program (Ctrl+C without selection = SIGINT, Ctrl+R, ...)
 */
export function terminalKeyAction(event, hasSelection) {
	const ctrl = event.ctrlKey || event.metaKey;
	const key = (event.key || "").toLowerCase();

	if ((ctrl && key === "v") || (event.shiftKey && !ctrl && key === "insert")) return "native-paste";
	if (ctrl && key === "insert") return "copy";
	if (ctrl && key === "c" && (event.shiftKey || hasSelection)) return "copy";
	if (ctrl && event.shiftKey && key === "a") return "select-all";
	return "terminal";
}

/** Copy text: async clipboard API on https/localhost, execCommand fallback on http. */
export function copyText(text) {
	if (!text) return Promise.resolve(false);
	if (navigator.clipboard && window.isSecureContext) {
		return navigator.clipboard.writeText(text).then(() => true, () => legacyCopy(text));
	}
	return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text) {
	const area = document.createElement("textarea");
	area.value = text;
	area.setAttribute("readonly", "");
	area.style.cssText = "position:fixed;top:-1000px;opacity:0";
	const active = document.activeElement;
	document.body.appendChild(area);
	area.select();
	let ok = false;
	try {
		ok = document.execCommand("copy");
	} catch (e) {
		ok = false;
	}
	area.remove();
	active?.focus?.();
	return ok;
}

/** Read the clipboard for "Paste" from a menu (only possible on https/localhost). */
export function readClipboard() {
	if (navigator.clipboard?.readText && window.isSecureContext) return navigator.clipboard.readText();
	return Promise.reject(new Error("clipboard-unavailable"));
}
