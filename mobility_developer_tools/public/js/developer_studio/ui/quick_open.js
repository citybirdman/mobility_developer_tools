import { notifyError } from "../core/api_client";
import { iconColorForPath } from "../core/languages";

/** Ctrl+P file picker. */
export class QuickOpen {
	constructor(host, { api, bus }) {
		this.api = api;
		this.bus = bus;
		this.results = [];
		this.index = 0;
		this.requestId = 0;

		this.el = document.createElement("div");
		this.el.className = "mdt-quick-open";
		this.el.innerHTML = `
			<input class="mdt-input" placeholder="${__("Search files by name (fuzzy)")}">
			<div class="mdt-quick-results"></div>`;
		host.appendChild(this.el);
		this.input = this.el.querySelector("input");
		this.list = this.el.querySelector(".mdt-quick-results");

		this.input.addEventListener("input", () => {
			clearTimeout(this.timer);
			this.timer = setTimeout(() => this.search(), 150);
		});
		this.input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") this.hide();
			if (e.key === "ArrowDown") this.move(1, e);
			if (e.key === "ArrowUp") this.move(-1, e);
			if (e.key === "Enter") this.pick(this.results[this.index]);
		});
		this.input.addEventListener("blur", () => setTimeout(() => this.hide(), 150));
	}

	show() {
		this.el.classList.add("visible");
		this.input.value = "";
		this.results = [];
		this.renderResults();
		this.input.focus();
	}

	hide() {
		this.el.classList.remove("visible");
	}

	async search() {
		const query = this.input.value.trim();
		const id = ++this.requestId;
		if (!query) {
			this.results = [];
			return this.renderResults();
		}
		try {
			const results = await this.api.call("find_files", { query });
			if (id !== this.requestId) return;
			this.results = results;
			this.index = 0;
			this.renderResults();
		} catch (e) {
			notifyError(e);
		}
	}

	move(delta, e) {
		e.preventDefault();
		if (!this.results.length) return;
		this.index = (this.index + delta + this.results.length) % this.results.length;
		this.renderResults();
	}

	pick(path) {
		if (!path) return;
		this.hide();
		this.bus.emit("file:open", { path });
	}

	renderResults() {
		this.list.innerHTML = "";
		this.results.slice(0, 50).forEach((path, i) => {
			const row = document.createElement("div");
			row.className = "mdt-quick-row" + (i === this.index ? " active" : "");
			const name = path.split("/").pop();
			row.innerHTML = `<span class="codicon codicon-file"></span><span class="mdt-quick-name"></span><span class="mdt-quick-dir"></span>`;
			row.firstChild.style.color = iconColorForPath(path);
			row.querySelector(".mdt-quick-name").textContent = name;
			row.querySelector(".mdt-quick-dir").textContent = path.slice(0, -name.length - 1);
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				this.pick(path);
			});
			this.list.appendChild(row);
			if (i === this.index) row.scrollIntoView({ block: "nearest" });
		});
	}
}
