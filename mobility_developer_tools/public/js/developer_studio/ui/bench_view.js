import { notifyError } from "../core/api_client";

const GROUP_ORDER = ["Site", "Apps", "Bench"];

/**
 * Side bar view with Frappe / bench commands for the current site and a bench console.
 * The command list and its input fields come from the server (one source of truth);
 * commands run in terminal tabs launched through the bus.
 */
export class BenchView {
	constructor(host, { api, bus }) {
		this.api = api;
		this.bus = bus;
		this.data = { site: "", commands: [] };

		this.el = document.createElement("div");
		this.el.className = "mdt-bench-view";
		this.el.innerHTML = `
			<div class="mdt-sidebar-title">
				<span>${__("Frappe & Bench")}</span>
				<span class="codicon codicon-refresh" title="${__("Refresh")}"></span>
			</div>
			<div class="mdt-bench-site"><span class="codicon codicon-globe"></span><span></span></div>
			<div class="mdt-bench-console">
				<button class="mdt-btn mdt-btn-primary mdt-btn-small">
					<span class="codicon codicon-debug-console"></span> ${__("Open Console")}
				</button>
			</div>
			<div class="mdt-bench-list"><div class="mdt-ai-empty">${__("Loading...")}</div></div>
			<div class="mdt-ai-note">${__("Commands run in a terminal tab. Site commands only affect this site.")}</div>`;
		host.appendChild(this.el);
		this.list = this.el.querySelector(".mdt-bench-list");
		this.el.querySelector(".codicon-refresh").addEventListener("click", () => this.load());
		this.el.querySelector(".mdt-bench-console button").addEventListener("click", () => this.openConsole());
	}

	async load() {
		try {
			this.data = await this.api.call("bench_commands");
		} catch (e) {
			return notifyError(e);
		}
		this.el.querySelector(".mdt-bench-site span:last-child").textContent = this.data.site;
		this.render();
	}

	/** Opens the console editor tab (write Python like a file, Ctrl+Enter to run) + its console. */
	openConsole() {
		this.bus.emit("console:open");
	}

	trigger(command) {
		if (command.fields.length) return this.promptFields(command);
		if (command.danger) {
			return frappe.confirm(__("Run <b>{0}</b> on {1}?", [command.label, this.data.site]), () => this.run(command, {}));
		}
		this.run(command, {});
	}

	promptFields(command) {
		const dialog = new frappe.ui.Dialog({
			title: `${command.label} · ${this.data.site}`,
			fields: [
				...(command.description ? [{ fieldtype: "HTML", options: `<p class="text-muted">${frappe.utils.escape_html(command.description)}</p>` }] : []),
				...command.fields.map((f) => toDialogField(f)),
			],
			primary_action_label: command.danger ? __("Run (dangerous)") : __("Run"),
			primary_action: (values) => {
				dialog.hide();
				const payload = {};
				for (const f of command.fields) payload[f.fieldname] = values[f.fieldname] ?? null;
				this.run(command, payload);
			},
		});
		if (command.danger) dialog.get_primary_btn().removeClass("btn-primary").addClass("btn-danger");
		dialog.show();
	}

	run(command, values) {
		this.bus.emit("terminal:launch", {
			method: "bench_run",
			args: { key: command.key, values: JSON.stringify(values) },
		});
	}

	render() {
		this.list.innerHTML = "";
		const groups = [...new Set([...GROUP_ORDER, ...this.data.commands.map((c) => c.group)])];
		for (const group of groups) {
			const commands = this.data.commands.filter((c) => c.group === group);
			if (!commands.length) continue;
			const heading = document.createElement("div");
			heading.className = "mdt-ai-group";
			heading.textContent = __(group);
			this.list.appendChild(heading);

			for (const command of commands) {
				const row = document.createElement("div");
				row.className = "mdt-bench-cmd" + (command.danger ? " danger" : "");
				row.title = command.description || command.label;
				row.innerHTML = `
					<span class="codicon codicon-${command.icon}"></span>
					<span class="mdt-bench-label"></span>
					${command.fields.length ? '<span class="codicon codicon-ellipsis"></span>' : ""}`;
				row.querySelector(".mdt-bench-label").textContent = __(command.label);
				row.addEventListener("click", () => this.trigger(command));
				this.list.appendChild(row);
			}
		}
	}
}

/** Server field schema -> Frappe dialog field. MultiCheck = checkbox list, Lines = one entry per line. */
function toDialogField(f) {
	const base = { fieldname: f.fieldname, label: __(f.label), reqd: f.reqd ? 1 : 0, description: f.description };
	if (f.fieldtype === "MultiCheck") {
		return { ...base, fieldtype: "MultiCheck", columns: 2, options: f.options.map((o) => ({ label: o, value: o })) };
	}
	if (f.fieldtype === "Lines") return { ...base, fieldtype: "Small Text" };
	return {
		...base,
		fieldtype: f.fieldtype,
		options: f.fieldtype === "Select" ? f.options.join("\n") : undefined,
		default: f.default ?? undefined,
	};
}
