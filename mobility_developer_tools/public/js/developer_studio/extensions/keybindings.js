/**
 * VS Code keybinding strings -> Monaco keybinding numbers (pure, unit-tested).
 * "ctrl+shift+k", "cmd+alt+f", "shift+alt+down". Chords ("ctrl+k ctrl+c") use
 * monaco.KeyMod.chord. Returns null for keys Monaco cannot express.
 */
const NAMED = {
	enter: "Enter", escape: "Escape", esc: "Escape", tab: "Tab", space: "Space", backspace: "Backspace",
	delete: "Delete", insert: "Insert", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown",
	up: "UpArrow", down: "DownArrow", left: "LeftArrow", right: "RightArrow",
	"/": "Slash", "\\": "Backslash", ";": "Semicolon", "'": "Quote", ",": "Comma", ".": "Period",
	"-": "Minus", "=": "Equal", "[": "BracketLeft", "]": "BracketRight", "`": "Backquote",
};

export function parseKeybinding(text, { KeyMod, KeyCode }, isMac = false) {
	if (!text || typeof text !== "string") return null;
	const chords = text.trim().toLowerCase().split(/\s+/).slice(0, 2).map((part) => parseChord(part, KeyMod, KeyCode, isMac));
	if (chords.some((c) => c === null)) return null;
	return chords.length === 2 ? KeyMod.chord(chords[0], chords[1]) : chords[0];
}

function parseChord(part, KeyMod, KeyCode, isMac) {
	let code = 0;
	let key = null;
	for (const token of part.split(/\+(?!$)/)) {
		if (token === "ctrl") code |= isMac ? KeyMod.WinCtrl : KeyMod.CtrlCmd;
		else if (token === "cmd" || token === "meta" || token === "win") code |= KeyMod.CtrlCmd;
		else if (token === "shift") code |= KeyMod.Shift;
		else if (token === "alt" || token === "option") code |= KeyMod.Alt;
		else key = token;
	}
	if (!key) return null;
	let name;
	if (/^[a-z]$/.test(key)) name = `Key${key.toUpperCase()}`;
	else if (/^[0-9]$/.test(key)) name = `Digit${key}`;
	else if (/^f([1-9]|1[0-9])$/.test(key)) name = key.toUpperCase();
	else name = NAMED[key];
	return name && KeyCode[name] !== undefined ? code | KeyCode[name] : null;
}
