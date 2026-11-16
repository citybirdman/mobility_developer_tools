/**
 * Dark context menu.
 * items: [{label, icon, action, danger, shortcut} | "-"]
 */
export class ContextMenu {
	constructor(host) {
		this.host = host;
		this.el = null;
		this.close = this.close.bind(this);
		this.onKey = (e) => e.key === "Escape" && this.close();
	}

	show(x, y, items) {
		this.close();
		const el = document.createElement("div");
		el.className = "mdt-context-menu";

		for (const item of items) {
			if (item === "-") {
				el.appendChild(Object.assign(document.createElement("div"), { className: "mdt-menu-sep" }));
				continue;
			}
			const row = document.createElement("div");
			row.className = "mdt-menu-item" + (item.danger ? " danger" : "");
			row.innerHTML = `
				<span class="codicon codicon-${item.icon || "blank"}"></span>
				<span class="mdt-menu-label"></span>
				<span class="mdt-menu-shortcut">${item.shortcut || ""}</span>`;
			row.querySelector(".mdt-menu-label").textContent = item.label;
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				this.close();
				item.action();
			});
			el.appendChild(row);
		}

		this.host.appendChild(el);
		const hostRect = this.host.getBoundingClientRect();
		const left = Math.min(x - hostRect.left, hostRect.width - el.offsetWidth - 4);
		const top = Math.min(y - hostRect.top, hostRect.height - el.offsetHeight - 4);
		el.style.left = `${Math.max(left, 0)}px`;
		el.style.top = `${Math.max(top, 0)}px`;
		this.el = el;

		setTimeout(() => {
			document.addEventListener("mousedown", this.close);
			document.addEventListener("keydown", this.onKey, true);
		});
		el.addEventListener("mousedown", (e) => e.stopPropagation());
	}

	close() {
		if (!this.el) return;
		this.el.remove();
		this.el = null;
		document.removeEventListener("mousedown", this.close);
		document.removeEventListener("keydown", this.onKey, true);
	}
}
