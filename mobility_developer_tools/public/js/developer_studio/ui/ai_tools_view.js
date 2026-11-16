import { notifyError } from "../core/api_client";

/**
 * Side bar view listing AI coding tools (Claude Code, Antigravity, ...).
 * Install / Open launch terminals through the bus; it never touches the terminal panel directly.
 */
export class AiToolsView {
	constructor(host, { api, bus }) {
		this.api = api;
		this.bus = bus;
		this.tools = [];

		this.el = document.createElement("div");
		this.el.className = "mdt-ai-view";
		this.el.innerHTML = `
			<div class="mdt-sidebar-title">
				<span>${__("AI Assistants")}</span>
				<span class="codicon codicon-refresh" title="${__("Refresh")}"></span>
			</div>
			<div class="mdt-ai-list"><div class="mdt-ai-empty">${__("Loading...")}</div></div>
			<div class="mdt-ai-note">
				${__("Each tool runs in a terminal on the server in the folder selected in the Explorer. Tools are installed in this site's private folder and your sign-in is stored for your user on this site only.")}
			</div>`;
		host.appendChild(this.el);
		this.list = this.el.querySelector(".mdt-ai-list");
		this.el.querySelector(".codicon-refresh").addEventListener("click", () => this.load());

		bus.on("ai:refresh", () => this.load());
		bus.on("ai:start", ({ key, cwd }) => this.start(key, cwd));
		bus.on("explorer:folder", (path) => (this.cwd = path));
	}

	async load() {
		try {
			this.tools = await this.api.call("ai_tools");
		} catch (e) {
			notifyError(e);
			return;
		}
		this.render();
		this.bus.emit("ai:tools", this.tools);
	}

	start(key, cwd = this.cwd || "") {
		const tool = this.tools.find((t) => t.key === key);
		if (!tool) return;
		this.bus.emit("terminal:launch", {
			method: "ai_tool_start",
			args: { key, cwd },
			maximize: true,
			banner: `${tool.label} - ${__("folder")}: /${cwd}\r\n${tool.sign_in_hint}`,
		});
	}

	install(tool) {
		frappe.confirm(
			__("Install {0} into this site's private folder (only this site will use it)?<br><br><code>{1}</code>", [
				tool.label,
				frappe.utils.escape_html(tool.install_command),
			]),
			() => this.bus.emit("terminal:launch", { method: "ai_tool_install", args: { key: tool.key } })
		);
	}

	render() {
		this.list.innerHTML = "";
		for (const tool of this.tools) {
			const card = document.createElement("div");
			card.className = "mdt-ai-card";
			card.innerHTML = `
				<div class="mdt-ai-head">
					<span class="codicon codicon-${tool.icon} mdt-ai-icon"></span>
					<div class="mdt-ai-meta">
						<div class="mdt-ai-name"></div>
						<div class="mdt-ai-status"></div>
					</div>
				</div>
				<div class="mdt-ai-actions"></div>`;
			card.querySelector(".mdt-ai-name").textContent = tool.label;
			const status = card.querySelector(".mdt-ai-status");
			status.textContent = tool.installed ? tool.version || __("Installed") : __("Not installed");
			if (tool.location === "server") {
				const note = document.createElement("div");
				note.className = "mdt-ai-location";
				note.textContent = __("Installed on the server only, not in this site");
				status.after(note);
			}
			card.classList.toggle("installed", tool.installed);

			const actions = card.querySelector(".mdt-ai-actions");
			if (tool.installed) {
				actions.append(button(__("Open"), "play", "primary", () => this.start(tool.key)));
				if (tool.location === "server") {
					actions.append(button(__("Install into site"), "cloud-download", "", () => this.install(tool)));
				}
				actions.append(
					button(__("Docs"), "link-external", "", () => window.open(tool.docs_url, "_blank", "noopener"))
				);
			} else {
				actions.append(
					button(__("Install"), "cloud-download", "primary", () => this.install(tool)),
					button(__("Docs"), "link-external", "", () => window.open(tool.docs_url, "_blank", "noopener"))
				);
			}
			this.list.appendChild(card);
		}
		if (!this.tools.length) this.list.innerHTML = `<div class="mdt-ai-empty">${__("No AI tools configured")}</div>`;
	}
}

function button(label, icon, variant, onClick) {
	const el = document.createElement("button");
	el.className = `mdt-btn mdt-btn-small ${variant ? `mdt-btn-${variant}` : "mdt-btn-ghost"}`;
	el.innerHTML = `<span class="codicon codicon-${icon}"></span> <span></span>`;
	el.lastElementChild.textContent = label;
	el.addEventListener("click", onClick);
	return el;
}
