/**
 * VS Code-style modal dialog: centered, a large type icon on the left, the message
 * and a muted detail, buttons bottom-right (primary first), Enter / Esc, ✕.
 * Used for frappe.msgprint / frappe.confirm / frappe.warn while the studio is shown.
 */
const ICONS = { info: "info", warning: "warning", error: "error", question: "question", success: "pass" };
const INDICATOR_TYPES = { red: "error", orange: "warning", yellow: "warning", green: "success", blue: "info" };
const GENERIC_TITLES = new Set(["message", "confirm", "warning", "error"]);

/**
 * Frappe msgprint arguments -> dialog options (pure, unit-tested).
 * Returns null for msgprint features the studio dialog does not support (the caller
 * then falls back to Frappe's own dialog).
 */
export function normalizeMsgprint(msg, title) {
	let data;
	if (msg && typeof msg === "object" && !Array.isArray(msg)) data = { ...msg };
	else if (typeof msg === "string" && msg.trim().startsWith("{")) {
		try {
			data = JSON.parse(msg);
		} catch (e) {
			data = { message: msg, title };
		}
	} else data = { message: msg, title };

	if (data.as_table || data.wide || data.primary_action?.server_action || data.primary_action?.client_action) return null;
	let message = data.message;
	if (Array.isArray(message)) message = data.as_list ? `<ul>${message.map((m) => `<li>${m}</li>`).join("")}</ul>` : message.join("<br>");
	if (message === undefined || message === null || message === "") return null;
	const heading = typeof data.title === "string" && !GENERIC_TITLES.has(data.title.trim().toLowerCase()) ? data.title : "";
	return {
		type: INDICATOR_TYPES[data.indicator] || "info",
		title: heading,
		html: String(message),
		primaryAction: typeof data.primary_action?.action === "function" ? data.primary_action : null,
	};
}

export class StudioDialog {
	constructor(host) {
		this.host = host;
		this.current = null;
	}

	/**
	 * show({type, title, html, detail, buttons: [{label, value, primary}], cancelValue}) -> Promise<value>
	 * `html` comes from Frappe (msgprint renders HTML the same way); extension text uses `text`.
	 */
	show({ type = "info", title = "", html = null, text = "", detail = "", buttons = null, cancelValue = undefined, merge = false }) {
		if (merge && this.current?.mergeable) {
			this.current.append(html, text);
			return this.current.promise;
		}
		this.close(cancelValue);

		const backdrop = document.createElement("div");
		backdrop.className = "mdt-dialog-backdrop";
		backdrop.innerHTML = `
			<div class="mdt-dialog" role="dialog" aria-modal="true">
				<span class="codicon codicon-close mdt-dialog-close" title="${__("Close")} (Esc)"></span>
				<div class="mdt-dialog-main">
					<span class="codicon codicon-${ICONS[type] || "info"} mdt-dialog-icon ${type}"></span>
					<div class="mdt-dialog-text">
						<div class="mdt-dialog-title"></div>
						<div class="mdt-dialog-message"></div>
						<div class="mdt-dialog-detail"></div>
					</div>
				</div>
				<div class="mdt-dialog-buttons"></div>
			</div>`;
		const dialog = backdrop.querySelector(".mdt-dialog");
		const messageEl = backdrop.querySelector(".mdt-dialog-message");
		backdrop.querySelector(".mdt-dialog-title").textContent = title || "";
		backdrop.querySelector(".mdt-dialog-detail").textContent = detail || "";
		const append = (moreHtml, moreText) => {
			const part = document.createElement("div");
			part.className = "mdt-dialog-part";
			if (moreHtml !== null && moreHtml !== undefined) part.innerHTML = moreHtml;
			else part.textContent = moreText || "";
			messageEl.appendChild(part);
		};
		append(html, text);

		let resolve;
		const promise = new Promise((r) => (resolve = r));
		const finish = (value) => {
			if (this.current?.backdrop !== backdrop) return;
			this.current = null;
			document.removeEventListener("keydown", onKey, true);
			backdrop.remove();
			resolve(value);
		};
		const list = buttons || [{ label: __("OK"), value: true, primary: true }];
		const buttonsEl = backdrop.querySelector(".mdt-dialog-buttons");
		for (const b of list) {
			const button = document.createElement("button");
			button.className = `mdt-btn ${b.primary ? "mdt-btn-primary" : "mdt-btn-secondary"}`;
			button.textContent = b.label;
			button.addEventListener("click", () => finish(b.value));
			buttonsEl.appendChild(button);
		}
		const onKey = (e) => {
			if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				finish(cancelValue);
			} else if (e.key === "Enter" && !e.target.closest?.("textarea")) {
				e.preventDefault();
				e.stopPropagation();
				const primary = list.find((b) => b.primary) || list[0];
				finish(primary.value);
			}
		};
		backdrop.querySelector(".mdt-dialog-close").addEventListener("click", () => finish(cancelValue));
		backdrop.addEventListener("mousedown", (e) => e.target === backdrop && dialog.classList.add("mdt-dialog-shake"));
		dialog.addEventListener("animationend", () => dialog.classList.remove("mdt-dialog-shake"));
		document.addEventListener("keydown", onKey, true);

		this.host.appendChild(backdrop);
		this.current = { backdrop, promise, append, mergeable: merge, close: finish };
		setTimeout(() => buttonsEl.querySelector(".mdt-btn-primary, .mdt-btn")?.focus());
		return promise;
	}

	close(value) {
		this.current?.close(value);
	}

	/** Small object compatible with what Frappe callers expect from a dialog. */
	handle(promise) {
		return { hide: () => this.close(undefined), promise };
	}
}
