/** Bottom status bar: lock button, root/site on the left; cursor + language on the right. */
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
			<span class="mdt-status-spacer"></span>
			<span class="mdt-status-item mdt-status-cursor"></span>
			<span class="mdt-status-item mdt-status-lang"></span>
			<span class="mdt-status-item">UTF-8</span>`;
		host.appendChild(this.el);
		this.el.querySelector(".mdt-status-lock").addEventListener("click", onLock);

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
}
