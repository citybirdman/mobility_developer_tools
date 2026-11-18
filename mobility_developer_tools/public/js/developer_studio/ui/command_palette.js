import { Picker } from "./picker";

/**
 * F1 command palette. Commands come from sources (functions returning
 * [{id, label, keys, run}]) registered by the composition root: studio commands,
 * running extensions' commands, ... (Open/Closed: add a source, no change here).
 *
 * With a file open, Monaco's own palette is used instead, so the studio commands
 * are also registered there as editor actions (registerInEditor).
 */
export class CommandPalette {
	constructor({ host, editor }) {
		this.picker = new Picker(host);
		this.editor = editor;
		this.sources = [];
	}

	addSource(source) {
		this.sources.push(source);
	}

	commands() {
		return this.sources.flatMap((source) => source() || []).sort((a, b) => a.label.localeCompare(b.label));
	}

	async show() {
		const commands = this.commands();
		const index = await this.picker.pick(
			commands.map((c) => ({ label: c.label, description: c.keys || "" })),
			{ placeholder: __("Type a command") }
		);
		if (index != null) commands[index].run();
	}

	/** F1: Monaco's palette when a file is open (it includes these commands), else ours. */
	open() {
		if (this.editor.getModel()) {
			this.editor.focus();
			this.editor.trigger("keyboard", "editor.action.quickCommand", {});
		} else {
			this.show();
		}
	}

	registerInEditor(commands) {
		return commands.map((c) => this.editor.addAction({ id: `mdt.studio.${c.id}`, label: c.label, run: () => c.run() }));
	}
}
