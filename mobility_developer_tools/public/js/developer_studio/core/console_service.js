import { notifyError } from "./api_client";
import { codeToRun, consolePayload, isPromptReady } from "./console_payload";

const PROMPT_TIMEOUT_MS = 60000;

/**
 * "Bench console as a file": an editor tab where Python is written like in a file,
 * run against the site's IPython console with
 *   Ctrl+Enter   selection, or everything
 *   Shift+Enter  selection, or the current line
 * The console keeps its state between runs; output appears in its terminal tab.
 * The buffer is saved in this browser (per user and site).
 */
export class ConsoleService {
	constructor({ bus, editorArea, terminals, site }) {
		this.bus = bus;
		this.editorArea = editorArea;
		this.terminals = terminals;
		this.site = site;
		this.key = `console://${site}.py`;
		this.storageKey = `mdt_console:${frappe.session.user}:${site}`;

		const editor = editorArea.editor;
		this.isConsole = editor.createContextKey("mdtConsoleActive", false);
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => this.run("all"), "mdtConsoleActive");
		editor.addCommand(monaco.KeyMod.Shift | monaco.KeyCode.Enter, () => this.run("line"), "mdtConsoleActive");
		bus.on("editor:active", (info) => this.isConsole.set(info?.path === this.key));
		bus.on("console:open", () => this.open());
		bus.on("console:run", ({ mode } = {}) => this.run(mode || "all"));
	}

	open() {
		this.editorArea.openVirtual({
			key: this.key,
			title: `Console · ${this.site}`,
			language: "python",
			content: this.load(),
			hint: __("Ctrl+Enter: run selection or all · Shift+Enter: run line · runs in bench console, variables are kept"),
			onChange: (text) => this.save(text),
		});
		this.ensureConsole().catch(notifyError);
	}

	async run(mode) {
		const tab = this.editorArea.tabs.get(this.key);
		if (!tab) return this.open();
		const editor = this.editorArea.editor;
		const payload = consolePayload(codeToRun(tab.model, editor.getSelection(), mode));
		if (!payload) return;
		if (mode === "line" && editor.getSelection()?.isEmpty()) {
			editor.trigger("console", "cursorDown", {}); // like Jupyter: move on after running a line
		}
		try {
			const session = await this.ensureConsole();
			this.terminals.activate(session);
			session.send(payload);
		} catch (e) {
			notifyError(e);
		}
	}

	/** The running console terminal, starting one (and waiting for its prompt) if needed. */
	async ensureConsole() {
		let session = this.terminals.sessions.find((s) => s.meta.kind === "console" && !s.exited);
		if (!session) {
			session = await this.terminals.launch({
				method: "bench_console",
				banner: __("bench --site {0} console  (run code from the Console tab with Ctrl+Enter)", [this.site]),
			});
			if (!session) throw new Error(__("Could not start the bench console"));
		}
		this.bus.emit("panel:toggle", true);
		const started = Date.now();
		while (!isPromptReady(session.bufferText()) && Date.now() - started < PROMPT_TIMEOUT_MS && !session.exited) {
			if (session.ready) break;
			await new Promise((r) => setTimeout(r, 200));
		}
		session.ready = true; // after the first prompt IPython queues input itself
		return session;
	}

	load() {
		try {
			return localStorage.getItem(this.storageKey) ?? DEFAULT_CONSOLE;
		} catch (e) {
			return DEFAULT_CONSOLE;
		}
	}

	save(text) {
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			try {
				localStorage.setItem(this.storageKey, text);
			} catch (e) {
				// storage full or blocked
			}
		}, 400);
	}
}

const DEFAULT_CONSOLE = `# Bench console for this site: write Python here like in a file.
# Ctrl+Enter runs the selection (or everything), Shift+Enter runs the current line.
# frappe is connected; variables are kept between runs. Use frappe.db.commit() to save changes.

frappe.db.count("User")
`;
