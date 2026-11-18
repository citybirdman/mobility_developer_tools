/**
 * Turns code from the console editor into keystrokes for the IPython bench console
 * (pure, unit-tested). Uses bracketed paste so a whole block arrives as one input:
 * IPython runs it like a Jupyter cell and keeps variables between runs.
 */
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

export function consolePayload(code) {
	// no escape characters: code must not be able to end the paste early or send control sequences
	const text = String(code || "")
		.replace(/\x1b/g, "")
		.replace(/\r\n?/g, "\n")
		.replace(/\s+$/, "");
	if (!text.trim()) return null;
	const lines = text.split("\n");
	const last = lines[lines.length - 1];
	// a block that ends inside an indented body (def/for/if...) needs one more Enter to run
	const needsBlankLine = /^\s/.test(last) || /:\s*(#.*)?$/.test(last);
	return `${PASTE_START}${text}${PASTE_END}\r${needsBlankLine ? "\r" : ""}`;
}

/** Text to run: the selection if there is one, else the whole buffer ("all") or current line ("line"). */
export function codeToRun(model, selection, mode) {
	if (selection && !selection.isEmpty()) return model.getValueInRange(selection);
	if (mode === "line") return model.getLineContent(selection ? selection.positionLineNumber : 1);
	return model.getValue();
}

/** IPython is waiting for input when the last non-empty line is a fresh "In [n]:" prompt. */
export function isPromptReady(bufferText) {
	const lines = String(bufferText || "").split("\n").map((l) => l.trimEnd()).filter(Boolean);
	return lines.length > 0 && /^In \[\d+\]:$/.test(lines[lines.length - 1]);
}
