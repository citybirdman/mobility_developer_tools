/**
 * Bottom status bar: lock, site and root on the left; extension items, cursor and
 * language on the right. Extensions add items through setExtensionItem (plain
 * text + "$(icon)" codicons, never HTML).
 */
export class StatusBar {
	constructor(host, { bus, onLock }) {
		this.el = document.createElement("div");
		this.el.className = "mdt-statusbar";
		this.el.innerHTML = `
			<span class="mdt-status-item mdt-status-lock" title="${__("Lock the studio")}">
				<span class="codicon codicon-lock"></span> ${__("Lock")}
			</span>
			<span class="mdt-status-item mdt-status-site"><span class="codicon codicon-server"></span> <span></span></span>
			<span class="mdt-status-item mdt-status-root"><span class="codicon codicon-root-folder"></span> <span></span></span>
			<span class="mdt-status-ext mdt-status-ext-left"></span>
			<span class="mdt-status-item mdt-status-message"></span>
			<span class="mdt-status-spacer"></span>
			<span class="mdt-status-item mdt-status-progress"></span>
			<span class="mdt-status-ext mdt-status-ext-right"></span>
			<span class="mdt-status-item mdt-status-cursor"></span>
			<span class="mdt-status-item mdt-status-lang"></span>
			<span class="mdt-status-item">UTF-8</span>`;
		host.appendChild(this.el);
		this.el.querySelector(".mdt-status-lock").addEventListener("click", onLock);
		this.items = new Map(); // key -> {el, priority}
		this.progress = new Map(); // key -> text

		bus.on("editor:cursor", ({ line, column }) => this.set(".mdt-status-cursor", __("Ln {0}, Col {1}", [line, column])));
		bus.on("editor:active", (info) => {
			this.set(".mdt-status-lang", info ? info.language : "");
			if (!info) this.set(".mdt-status-cursor", "");
		});
	}

	setContext({ site, root }) {
		this.el.querySelector(".mdt-status-site span:last-child").textContent = site;
		this.el.querySelector(".mdt-status-root span:last-child").textContent = root;
	}

	set(selector, text) {
		this.el.querySelector(selector).textContent = text;
	}

	// -- extension items ---------------------------------------------------------------------------

	setExtensionItem(key, { text, tooltip, alignment, priority, onClick }) {
		let entry = this.items.get(key);
		if (!entry) {
			entry = { el: document.createElement("span") };
			entry.el.className = "mdt-status-item mdt-status-ext-item";
			entry.el.addEventListener("click", () => entry.onClick?.());
			this.items.set(key, entry);
		}
		entry.onClick = onClick;
		entry.priority = priority || 0;
		entry.el.classList.toggle("clickable", !!onClick);
		entry.el.title = tooltip || "";
		renderLabel(entry.el, text);
		const container = this.el.querySelector(alignment === "right" ? ".mdt-status-ext-right" : ".mdt-status-ext-left");
		container.appendChild(entry.el);
		// higher priority = further left (like VS Code)
		[...container.children]
			.sort((a, b) => this.priorityOf(b) - this.priorityOf(a))
			.forEach((child) => container.appendChild(child));
	}

	priorityOf(el) {
		for (const entry of this.items.values()) if (entry.el === el) return entry.priority;
		return 0;
	}

	removeExtensionItem(key) {
		this.items.get(key)?.el.remove();
		this.items.delete(key);
	}

	setMessage(text, timeout = 5000) {
		const el = this.el.querySelector(".mdt-status-message");
		renderLabel(el, text || "");
		clearTimeout(this.messageTimer);
		if (text) this.messageTimer = setTimeout(() => (el.textContent = ""), Math.min(timeout || 5000, 60000));
	}

	setProgress(key, text) {
		text ? this.progress.set(key, text) : this.progress.delete(key);
		const el = this.el.querySelector(".mdt-status-progress");
		const current = [...this.progress.values()].pop();
		renderLabel(el, current ? `$(sync~spin) ${current}` : "");
	}
}

/** "$(check) Ready" -> codicon + text. Icon names are restricted to [a-z0-9-]. */
function renderLabel(el, text) {
	el.textContent = "";
	const value = String(text || "").slice(0, 200);
	let last = 0;
	for (const match of value.matchAll(/\$\(([a-z0-9-]+)(~spin)?\)/g)) {
		if (match.index > last) el.append(value.slice(last, match.index));
		const icon = document.createElement("span");
		icon.className = `codicon codicon-${match[1]}${match[2] ? " codicon-modifier-spin" : ""}`;
		el.appendChild(icon);
		last = match.index + match[0].length;
	}
	if (last < value.length) el.append(value.slice(last));
}
