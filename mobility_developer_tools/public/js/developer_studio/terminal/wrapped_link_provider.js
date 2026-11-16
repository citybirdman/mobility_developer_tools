const URL_RE = /https?:\/\/[^\s"'<>`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

/**
 * xterm link provider that finds http(s) URLs even when a program hard-wrapped
 * them over several lines (CLIs like Claude Code print long sign-in URLs that
 * way). A line continues the previous one when it is soft-wrapped by xterm, or
 * when the previous line is completely full and this one starts with a URL
 * character.
 */
export class WrappedLinkProvider {
	constructor(term, activate) {
		this.term = term;
		this.activate = activate;
	}

	provideLinks(y, callback) {
		const buffer = this.term.buffer.active;
		const index = y - 1; // provideLinks is 1-based
		if (!buffer.getLine(index)) return callback(undefined);

		let start = index;
		while (start > 0 && this.continues(buffer, start)) start--;
		let end = index;
		while (buffer.getLine(end + 1) && this.continues(buffer, end + 1)) end++;

		// joined text + map from joined offset -> buffer position
		let text = "";
		const positions = [];
		for (let row = start; row <= end; row++) {
			const line = buffer.getLine(row).translateToString(true);
			for (let col = 0; col < line.length; col++) positions.push({ x: col + 1, y: row + 1 });
			text += line;
		}

		const links = [];
		for (const match of text.matchAll(URL_RE)) {
			const url = match[0].replace(TRAILING_PUNCTUATION, "");
			const from = positions[match.index];
			const to = positions[match.index + url.length - 1];
			if (!from || !to || to.y < y || from.y > y) continue; // not on this line
			links.push({
				range: { start: from, end: to },
				text: url,
				decorations: { underline: true, pointerCursor: true },
				activate: (event, linkText) => this.activate(linkText),
			});
		}
		callback(links.length ? links : undefined);
	}

	/** Does buffer row `row` continue row `row - 1`? */
	continues(buffer, row) {
		const line = buffer.getLine(row);
		if (!line) return false;
		if (line.isWrapped) return true;
		const previous = buffer.getLine(row - 1)?.translateToString(true) || "";
		const first = line.translateToString(true).charAt(0);
		return previous.length >= this.term.cols && /[^\s"'<>`]/.test(first);
	}
}
