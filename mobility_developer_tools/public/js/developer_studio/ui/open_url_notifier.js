import { openExternal } from "../terminal/terminal_session";

const OPEN_URL_EVENT = "mdt_open_url";

/**
 * When a tool on the server tries to open a browser (e.g. a sign-in page), the
 * browser shim forwards the URL here. Browsers block pop-ups that are not started
 * by a click, so we show a toast with an Open button.
 *
 * Links that redirect back to the server's localhost (automatic OAuth login) are
 * never offered: they would end on the user's own machine. The toast then points
 * to the sign-in link printed in the terminal instead.
 */
export class OpenUrlNotifier {
	constructor(host) {
		this.host = host;
		this.handler = (msg) => {
			if (msg?.local_redirect) this.showUseTerminalLink(msg);
			else if (msg?.url) this.showOpen(msg);
		};
		frappe.realtime.on(OPEN_URL_EVENT, this.handler);
	}

	showOpen({ url, tool }) {
		let parsed;
		try {
			parsed = new URL(url);
		} catch (e) {
			return;
		}
		if (!["http:", "https:"].includes(parsed.protocol)) return;

		const toast = this.toast(
			"link-external",
			__("{0} wants to open a page", [tool || __("A tool")]),
			parsed.host,
			[
				[__("Open"), "open", "primary"],
				[__("Copy"), "copy", "ghost"],
			]
		);
		toast.title = parsed.href;
		toast.addEventListener("click", (e) => {
			const action = e.target.closest("[data-action]")?.dataset.action;
			if (action === "open") openExternal(parsed.href);
			if (action === "copy") frappe.utils.copy_to_clipboard(parsed.href);
			if (action === "open") toast.remove();
		});
	}

	showUseTerminalLink({ tool }) {
		this.toast(
			"info",
			__("{0}: sign in with the link shown in the terminal", [tool || __("A tool")]),
			__("Click it, sign in, then copy the code you get and paste it into the terminal (Ctrl+V)."),
			[]
		);
	}

	toast(icon, title, subtitle, buttons) {
		this.host.querySelectorAll(".mdt-toast").forEach((t) => t.remove());
		const toast = document.createElement("div");
		toast.className = "mdt-toast";
		toast.innerHTML = `
			<span class="codicon codicon-${icon}"></span>
			<div class="mdt-toast-body">
				<div class="mdt-toast-title"></div>
				<div class="mdt-toast-url"></div>
			</div>
			${buttons
				.map(([label, action, variant]) => `<button class="mdt-btn mdt-btn-small mdt-btn-${variant}" data-action="${action}">${label}</button>`)
				.join("")}
			<span class="codicon codicon-close" data-action="close"></span>`;
		toast.querySelector(".mdt-toast-title").textContent = title;
		toast.querySelector(".mdt-toast-url").textContent = subtitle;
		toast.querySelector(".codicon-close").addEventListener("click", () => toast.remove());
		this.host.appendChild(toast);
		setTimeout(() => toast.remove(), 5 * 60 * 1000);
		return toast;
	}

	dispose() {
		frappe.realtime.off(OPEN_URL_EVENT, this.handler);
	}
}
