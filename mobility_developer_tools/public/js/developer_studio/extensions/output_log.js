const MAX_CHARS = 200_000;

/** Output channels of extensions (createOutputChannel + the host's own log). */
export class OutputLog {
	constructor() {
		this.channels = new Map(); // "<ext> · <channel>" -> text
	}

	append(ext, channel, text) {
		const key = `${ext} · ${channel}`;
		const next = (this.channels.get(key) || "") + text;
		this.channels.set(key, next.length > MAX_CHARS ? next.slice(-MAX_CHARS) : next);
	}

	clear(ext, channel) {
		this.channels.set(`${ext} · ${channel}`, "");
	}

	forExtension(ext) {
		return [...this.channels.entries()].filter(([key]) => key.startsWith(`${ext} · `));
	}

	show(ext) {
		const channels = this.forExtension(ext);
		const dialog = new frappe.ui.Dialog({ title: __("Output: {0}", [ext]), size: "extra-large", fields: [{ fieldtype: "HTML", fieldname: "out" }] });
		const wrapper = dialog.get_field("out").$wrapper[0];
		if (!channels.length) wrapper.textContent = __("No output yet.");
		for (const [key, text] of channels) {
			const title = document.createElement("h6");
			title.textContent = key;
			const pre = document.createElement("pre");
			pre.style.cssText = "max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px";
			pre.textContent = text;
			wrapper.append(title, pre);
		}
		dialog.show();
	}
}
