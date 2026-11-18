import { openExternal } from "../terminal/terminal_session";
import { Picker } from "../ui/picker";

/**
 * Window UI an extension can ask for: messages, input boxes, quick picks,
 * external links. Extension text is always rendered as text (never HTML).
 */
export class ExtensionUi {
	constructor({ host }) {
		this.host = host; // studio root element (toasts are positioned inside it)
		this.picker = new Picker(host);
	}

	showMessage(extName, { severity, message, detail, items, modal }) {
		if (modal) return this.modal(extName, message, detail, items);
		return new Promise((resolve) => {
			const toast = document.createElement("div");
			toast.className = `mdt-toast mdt-ext-message ${severity}`;
			const icon = { info: "info", warning: "warning", error: "error" }[severity] || "info";
			toast.innerHTML = `<span class="codicon codicon-${icon}"></span><div class="mdt-toast-body"><div class="mdt-toast-title"></div><div class="mdt-toast-url"></div></div>`;
			toast.querySelector(".mdt-toast-title").textContent = String(message).slice(0, 1000);
			toast.querySelector(".mdt-toast-url").textContent = extName;
			let done = false;
			const finish = (value) => {
				if (done) return;
				done = true;
				toast.remove();
				resolve(value);
			};
			(items || []).slice(0, 5).forEach((label, index) => {
				const button = document.createElement("button");
				button.className = `mdt-btn mdt-btn-small ${index === 0 ? "mdt-btn-primary" : "mdt-btn-ghost"}`;
				button.textContent = String(label).slice(0, 60);
				button.addEventListener("click", () => finish(index));
				toast.appendChild(button);
			});
			const close = document.createElement("span");
			close.className = "codicon codicon-close";
			close.addEventListener("click", () => finish(-1));
			toast.appendChild(close);
			this.stack().appendChild(toast);
			if (!(items || []).length) setTimeout(() => finish(-1), severity === "error" ? 15000 : 8000);
		});
	}

	stack() {
		let stack = this.host.querySelector(".mdt-toast-stack");
		if (!stack) {
			stack = document.createElement("div");
			stack.className = "mdt-toast-stack";
			this.host.appendChild(stack);
		}
		return stack;
	}

	modal(extName, message, detail, items) {
		return new Promise((resolve) => {
			const dialog = new frappe.ui.Dialog({ title: extName, fields: [{ fieldtype: "HTML", fieldname: "msg" }] });
			const wrapper = dialog.get_field("msg").$wrapper[0];
			const p = document.createElement("p");
			p.textContent = message;
			wrapper.appendChild(p);
			if (detail) {
				const d = document.createElement("p");
				d.className = "text-muted";
				d.textContent = detail;
				wrapper.appendChild(d);
			}
			let answered = -1;
			(items || []).slice(0, 5).forEach((label, index) => dialog.add_custom_action(String(label), () => ((answered = index), dialog.hide())));
			dialog.onhide = () => resolve(answered);
			dialog.show();
		});
	}

	inputBox({ title, prompt, placeHolder, value, password }) {
		return new Promise((resolve) => {
			let result = null;
			const dialog = new frappe.ui.Dialog({
				title: title || prompt || __("Input"),
				fields: [{ fieldtype: password ? "Password" : "Data", fieldname: "value", label: prompt || "", default: value || "", placeholder: placeHolder || "" }],
				primary_action_label: __("OK"),
				primary_action: (values) => {
					result = values.value ?? "";
					dialog.hide();
				},
			});
			dialog.onhide = () => resolve(result);
			dialog.show();
		});
	}

	quickPick({ items, placeHolder, canPickMany }) {
		return this.picker.pick(items || [], { placeholder: placeHolder, multiple: canPickMany });
	}

	openExternal(extName, uri) {
		let url;
		try {
			url = new URL(uri);
		} catch (e) {
			return false;
		}
		if (!["http:", "https:", "mailto:"].includes(url.protocol)) return false;
		return this.showMessage(extName, { severity: "info", message: __("Open {0}?", [url.href]), items: [__("Open")] }).then((i) => {
			if (i === 0) openExternal(url.href);
			return i === 0;
		});
	}
}
