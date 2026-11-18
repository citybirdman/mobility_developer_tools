/**
 * Generic filterable list picker (VS Code-style quick pick).
 * pick(items: [{label, description, detail}], {placeholder, multiple}) -> index | [indices] | null
 */
export class Picker {
	constructor(host) {
		this.el = document.createElement("div");
		this.el.className = "mdt-quick-open mdt-picker";
		this.el.innerHTML = `<input class="mdt-input"><div class="mdt-quick-results"></div><div class="mdt-picker-footer"></div>`;
		host.appendChild(this.el);
		this.input = this.el.querySelector("input");
		this.list = this.el.querySelector(".mdt-quick-results");
		this.footer = this.el.querySelector(".mdt-picker-footer");
		this.input.addEventListener("input", () => this.render());
		this.input.addEventListener("keydown", (e) => this.onKey(e));
	}

	pick(items, { placeholder = "", multiple = false } = {}) {
		this.finish?.(null);
		this.items = items.slice(0, 2000).map((item, index) => ({ ...item, index }));
		this.multiple = multiple;
		this.chosen = new Set();
		this.active = 0;
		this.input.value = "";
		this.input.placeholder = placeholder || __("Type to filter");
		this.footer.textContent = multiple ? __("Space: select · Enter: confirm · Esc: cancel") : "";
		this.el.classList.add("visible");
		this.render();
		setTimeout(() => this.input.focus());
		return new Promise((resolve) => {
			this.finish = (value) => {
				this.finish = null;
				this.el.classList.remove("visible");
				resolve(value);
			};
		});
	}

	visible() {
		const q = this.input.value.toLowerCase();
		return this.items.filter((i) => !q || `${i.label} ${i.description || ""}`.toLowerCase().includes(q));
	}

	onKey(e) {
		e.stopPropagation();
		const list = this.visible();
		if (e.key === "Escape") return this.finish?.(null);
		if (e.key === "ArrowDown" || e.key === "ArrowUp") {
			e.preventDefault();
			this.active = (this.active + (e.key === "ArrowDown" ? 1 : -1) + list.length) % Math.max(list.length, 1);
			return this.render();
		}
		if (this.multiple && e.key === " " && list[this.active]) {
			e.preventDefault();
			const i = list[this.active].index;
			this.chosen.has(i) ? this.chosen.delete(i) : this.chosen.add(i);
			return this.render();
		}
		if (e.key === "Enter") {
			e.preventDefault();
			if (this.multiple) return this.finish?.([...this.chosen]);
			if (list[this.active]) this.finish?.(list[this.active].index);
		}
	}

	render() {
		const list = this.visible();
		this.active = Math.min(this.active, Math.max(list.length - 1, 0));
		this.list.innerHTML = "";
		list.slice(0, 200).forEach((item, i) => {
			const row = document.createElement("div");
			row.className = "mdt-quick-row" + (i === this.active ? " active" : "");
			row.innerHTML = `${this.multiple ? `<span class="codicon codicon-${this.chosen.has(item.index) ? "check" : "blank"}"></span>` : ""}<span class="mdt-quick-name"></span><span class="mdt-quick-dir"></span>`;
			row.querySelector(".mdt-quick-name").textContent = String(item.label ?? "");
			row.querySelector(".mdt-quick-dir").textContent = [item.description, item.detail].filter(Boolean).join(" · ");
			row.addEventListener("mousedown", (e) => {
				e.preventDefault();
				if (this.multiple) {
					this.chosen.has(item.index) ? this.chosen.delete(item.index) : this.chosen.add(item.index);
					this.render();
				} else this.finish?.(item.index);
			});
			this.list.appendChild(row);
		});
	}
}
