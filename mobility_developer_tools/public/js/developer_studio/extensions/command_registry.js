import { parseKeybinding } from "./keybindings";

/**
 * Commands from all running extensions + the few built-in VS Code commands the
 * studio can honour. Contributed commands appear in Monaco's command palette (F1)
 * with their keybindings.
 */
export class CommandRegistry {
	constructor({ editor, editorArea, sync }) {
		this.editor = editor;
		this.editorArea = editorArea;
		this.sync = sync;
		this.owners = new Map(); // command id -> host
		this.builtins = {
			setContext: () => null,
			"workbench.action.files.save": () => this.editorArea.save(),
			"workbench.action.files.saveAll": async () => {
				for (const path of this.editorArea.openPaths()) await this.editorArea.save(path);
			},
			"vscode.open": (uri) => {
				const path = this.sync.relativePath(String(uri));
				if (!path) throw new Error("Only files of this bench can be opened");
				this.editorArea.open(path);
				return null;
			},
		};
	}

	register(id, host) {
		this.owners.set(id, host);
	}

	unregisterHost(host) {
		for (const [id, owner] of this.owners) if (owner === host) this.owners.delete(id);
	}

	ids() {
		return [...new Set([...this.owners.keys(), ...Object.keys(this.builtins)])];
	}

	async execute(id, args = [], { from } = {}) {
		const owner = this.owners.get(id);
		if (owner && owner !== from) return owner.executeCommand(id);
		if (this.builtins[id]) return this.builtins[id](...args);
		const action = id.startsWith("editor.action.") ? this.editor.getAction(id) : null;
		if (action) return action.run();
		throw new Error(`Command "${id}" is not available in Developer Studio`);
	}

	/** Palette entries + keybindings for a manifest's contributed commands. */
	addPaletteEntries(manifest, run) {
		const keys = {};
		const isMac = /Mac/.test(navigator.platform);
		for (const k of manifest.contributes.keybindings || []) {
			const binding = parseKeybinding(isMac && k.mac ? k.mac : k.key, monaco, isMac);
			if (binding) (keys[k.command] = keys[k.command] || []).push(binding);
		}
		return (manifest.contributes.commands || []).map((c) =>
			this.editor.addAction({
				id: `mdt.ext.${manifest.id}.${c.command}`,
				label: c.category ? `${c.category}: ${c.title}` : c.title,
				keybindings: keys[c.command],
				run: () => run(c.command),
			})
		);
	}
}
