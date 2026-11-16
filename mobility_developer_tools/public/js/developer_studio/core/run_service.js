import { notifyError } from "./api_client";

/**
 * "Run File": asks the server which runners support the file, lets the user pick
 * one when there are several, saves unsaved changes and sends the command to the
 * terminal - like VS Code's run button.
 */
export class RunService {
	constructor({ api, bus, editor, terminals, contextMenu }) {
		this.api = api;
		this.editor = editor;
		this.terminals = terminals;
		this.menu = contextMenu;
		bus.on("run:request", ({ path, anchor } = {}) => this.run(path || editor.active?.path, anchor));
	}

	async run(path, anchor) {
		if (!path) return frappe.show_alert({ message: __("Open a file to run it"), indicator: "orange" });
		try {
			const runners = await this.api.call("get_runners", { path });
			if (!runners.length) {
				return frappe.show_alert({ message: __("No runner is available for this file type"), indicator: "orange" });
			}
			if (runners.length === 1) return this.execute(path, runners[0].key);

			const rect = (anchor || this.editor.runButton).getBoundingClientRect();
			this.menu.show(
				rect.left,
				rect.bottom + 2,
				runners.map((r) => ({ label: r.label, icon: "play", action: () => this.execute(path, r.key) }))
			);
		} catch (e) {
			notifyError(e);
		}
	}

	async execute(path, runner) {
		try {
			if (this.editor.tabs.has(path) && this.editor.isDirty(this.editor.tabs.get(path))) {
				if (!(await this.editor.save(path))) return;
			}
			const { command } = await this.api.call("get_run_command", { path, runner });
			await this.terminals.runCommand(command);
		} catch (e) {
			notifyError(e);
		}
	}
}
