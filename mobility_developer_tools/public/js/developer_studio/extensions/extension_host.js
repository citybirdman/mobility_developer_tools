import { copyText, readClipboard } from "../terminal/terminal_keys";
import { toLanguageConfiguration } from "./contributions";
import { activationPlan } from "./converters";
import { ExtensionSandbox } from "./sandbox";

const PROVIDER_TIMEOUT_MS = 3000;
const SLOW_PROVIDER_TIMEOUT_MS = 10000; // formatters
let hostCounter = 0;

/**
 * Connects one extension's sandboxed code to the studio:
 *   - forwards documents / editor state to the sandbox (DocumentSync)
 *   - turns its provider registrations into Monaco providers
 *   - serves its requests (messages, edits, settings, ...) through injected services
 */
export class ExtensionHost {
	constructor(manifest, services) {
		this.manifest = manifest;
		this.id = manifest.id;
		this.name = manifest.display_name || manifest.id;
		this.services = services;
		this.key = `h${++hostCounter}`;
		this.state = "idle";
		this.error = null;
		this.settings = { ...defaultsOf(manifest), ...(manifest.settings || {}) };
		this.plan = activationPlan(manifest);
		this.providers = new Map(); // handle -> monaco disposable
		this.disposables = [];
		this.statusItems = new Set();
		this.markerOwners = new Set();
		this.lastSent = new Map(); // doc uri -> version known by the sandbox
		this.activation = null;
	}

	// -- lifecycle ------------------------------------------------------------------------------

	async start() {
		const { api, sync, commands } = this.services;
		this.state = "starting";
		try {
			this.sandbox = new ExtensionSandbox(this.id, {
				onRequest: (method, params) => this.onRequest(method, params),
				onNotify: (method, params) => this.onNotify(method, params),
				onCrash: (reason) => this.onCrash(reason),
			});
			await this.sandbox.start();
			const files = await api.call("ext_files", { ext_id: this.id, paths: [this.manifest.browser] });
			const code = files[this.manifest.browser];
			if (!code) throw new Error("extension code not found");

			const documents = sync.documents();
			documents.forEach((d) => this.lastSent.set(d.uri, d.version));
			await this.sandbox.call(
				"init",
				{
					extension: { id: this.id, packageJSON: { name: this.manifest.name, publisher: this.manifest.publisher, version: this.manifest.version, displayName: this.manifest.display_name, contributes: this.manifest.contributes } },
					code,
					entry: this.manifest.browser,
					settings: this.settings,
					workspace: { root: this.services.root, name: this.services.root.split("/").pop() },
					documents,
					activeEditor: sync.activeInfo(),
					theme: this.services.colorThemes.current().mode,
					mementos: { global: this.memento("global"), workspace: this.memento("workspace") },
					languages: this.services.languageConfigs(),
				},
				20000
			);
			this.runCommandId = `mdt.ext.run.${this.key}`;
			this.disposables.push(monaco.editor.registerCommand(this.runCommandId, (accessor, ref) => this.sandbox.call("executeCommand", { ref }).catch((e) => this.log("error", e.message))));
			this.disposables.push(...commands.addPaletteEntries(this.manifest, (id) => this.executeCommand(id)));
			this.disposables.push(sync.subscribe((name, data) => this.onDocumentEvent(name, data)));
			this.disposables.push({ dispose: this.services.bus.on("appearance:changed", ({ mode }) => this.sandbox?.event("theme", { kind: mode })) });
			this.state = "running";
			if (this.plan.atStartup || documents.some((d) => this.plan.languages.has(d.languageId))) await this.activate();
		} catch (e) {
			this.fail(e);
		}
		return this;
	}

	activate() {
		if (!this.activation) {
			this.activation = this.sandbox
				.call("activate", {}, 20000)
				.then(() => {
					this.state = "active";
					this.services.bus.emit("extensions:changed");
				})
				.catch((e) => this.fail(e));
		}
		return this.activation;
	}

	fail(error) {
		this.state = "failed";
		this.error = String(error?.message || error);
		this.log("error", `failed: ${this.error}`);
		this.services.bus.emit("extensions:changed");
	}

	onCrash(reason) {
		if (this.stopping) return;
		this.state = "crashed";
		this.error = reason;
		this.log("error", `extension ${reason}`);
		this.cleanup();
		this.services.bus.emit("extensions:changed");
	}

	stop() {
		this.stopping = true;
		this.sandbox?.call("deactivate", {}, 2000).catch(() => {});
		setTimeout(() => this.sandbox?.kill("stopped"), 50);
		this.cleanup();
		this.state = "stopped";
	}

	cleanup() {
		const { commands, decorations, statusBar } = this.services;
		for (const d of this.providers.values()) d.dispose();
		this.providers.clear();
		this.disposables.forEach((d) => d?.dispose?.());
		this.disposables = [];
		commands.unregisterHost(this);
		decorations.removeHost(this.key);
		for (const key of this.statusItems) statusBar.removeExtensionItem(key);
		this.statusItems.clear();
		statusBar.setProgress(this.key, null);
		for (const model of monaco.editor.getModels()) for (const owner of this.markerOwners) monaco.editor.setModelMarkers(model, owner, []);
		this.markerOwners.clear();
	}

	async executeCommand(id) {
		if (this.state === "failed" || this.state === "crashed") throw new Error(`${this.name} is not running`);
		await this.activate();
		return this.sandbox.call("executeCommand", { id }, 30000);
	}

	// -- documents --------------------------------------------------------------------------------

	onDocumentEvent(name, data) {
		if (!this.sandbox || this.sandbox.dead) return;
		if (name === "docOpen" || name === "docChange") this.lastSent.set(data.uri, data.version);
		if (name === "docClose") this.lastSent.delete(data.uri);
		this.sandbox.event(name, data);
		if (name === "docOpen" && this.plan.languages.has(data.languageId)) this.activate();
	}

	ensureSynced(model) {
		const { sync } = this.services;
		const uri = sync.docUri(model);
		if (this.lastSent.get(uri) !== model.getVersionId()) {
			const snapshot = sync.snapshot(model);
			this.lastSent.set(uri, snapshot.version);
			this.sandbox.event(this.lastSent.has(uri) ? "docChange" : "docOpen", snapshot);
		}
		return uri;
	}

	async invoke(handle, model, args, timeout = PROVIDER_TIMEOUT_MS) {
		if (!this.sandbox || this.sandbox.dead || !this.services.sync.isStudioModel(model)) return null; // files only
		await this.activate();
		const uri = this.ensureSynced(model);
		try {
			return await this.sandbox.call("provide", { handle, uri, args }, timeout);
		} catch (e) {
			this.log("warn", e.message);
			return null;
		}
	}

	commandFor(cmd) {
		return cmd ? { id: this.runCommandId, title: cmd.title || "", arguments: [cmd.ref] } : undefined;
	}

	// -- providers ----------------------------------------------------------------------------------

	registerProvider({ handle, kind, selector, meta }) {
		const conv = this.services.converters;
		const languages = [...new Set((selector || []).map((s) => s.language || "*"))];
		const sel = languages.length ? languages : ["*"];
		const call = (model, args, timeout) => this.invoke(handle, model, args, timeout);
		const L = monaco.languages;
		const locations = (res) => (res || []).map(conv.location).filter(Boolean);
		const factories = {
			completion: () =>
				L.registerCompletionItemProvider(sel, {
					triggerCharacters: meta?.triggerCharacters || [],
					provideCompletionItems: async (model, position, context) => {
						const res = await call(model, { position: conv.position(position), triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter });
						if (!res) return { suggestions: [] };
						const word = model.getWordUntilPosition(position);
						const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
						return { incomplete: !!res.isIncomplete, suggestions: res.items.map((i) => conv.completionItem(i, range, this.commandFor(i.command))) };
					},
				}),
			hover: () =>
				L.registerHoverProvider(sel, {
					provideHover: async (model, position) => {
						const res = await call(model, { position: conv.position(position) });
						return res && res.contents.length ? { contents: res.contents.map(conv.markdown), range: conv.range(res.range) } : null;
					},
				}),
			definition: () => L.registerDefinitionProvider(sel, { provideDefinition: async (m, p) => locations(await call(m, { position: conv.position(p) })) }),
			declaration: () => L.registerDeclarationProvider(sel, { provideDeclaration: async (m, p) => locations(await call(m, { position: conv.position(p) })) }),
			typeDefinition: () => L.registerTypeDefinitionProvider(sel, { provideTypeDefinition: async (m, p) => locations(await call(m, { position: conv.position(p) })) }),
			implementation: () => L.registerImplementationProvider(sel, { provideImplementation: async (m, p) => locations(await call(m, { position: conv.position(p) })) }),
			references: () => L.registerReferenceProvider(sel, { provideReferences: async (m, p) => locations(await call(m, { position: conv.position(p) })) }),
			documentHighlight: () =>
				L.registerDocumentHighlightProvider(sel, {
					provideDocumentHighlights: async (m, p) => ((await call(m, { position: conv.position(p) })) || []).map((h) => ({ range: conv.range(h.range), kind: h.kind })),
				}),
			rename: () =>
				L.registerRenameProvider(sel, {
					provideRenameEdits: async (m, p, newName) => conv.workspaceEdit(await call(m, { position: conv.position(p), newName }, SLOW_PROVIDER_TIMEOUT_MS)),
				}),
			formatting: () =>
				L.registerDocumentFormattingEditProvider(sel, {
					displayName: this.name,
					provideDocumentFormattingEdits: async (m, options) => ((await call(m, { options }, SLOW_PROVIDER_TIMEOUT_MS)) || []).map(conv.textEdit),
				}),
			rangeFormatting: () =>
				L.registerDocumentRangeFormattingEditProvider(sel, {
					displayName: this.name,
					provideDocumentRangeFormattingEdits: async (m, range, options) => ((await call(m, { range: conv.rangeOut(range), options }, SLOW_PROVIDER_TIMEOUT_MS)) || []).map(conv.textEdit),
				}),
			onTypeFormatting: () =>
				L.registerOnTypeFormattingEditProvider(sel, {
					autoFormatTriggerCharacters: (meta?.triggerCharacters || []).filter(Boolean),
					provideOnTypeFormattingEdits: async (m, p, ch, options) => ((await call(m, { position: conv.position(p), ch, options })) || []).map(conv.textEdit),
				}),
			documentSymbol: () =>
				L.registerDocumentSymbolProvider(sel, { displayName: this.name, provideDocumentSymbols: async (m) => ((await call(m, {})) || []).map((s) => conv.symbol(s)) }),
			foldingRange: () => L.registerFoldingRangeProvider(sel, { provideFoldingRanges: async (m) => ((await call(m, {})) || []).map((r) => conv.folding(r)) }),
			codeAction: () =>
				L.registerCodeActionProvider(sel, {
					provideCodeActions: async (m, range, context) => {
						const res = await call(m, { range: conv.rangeOut(range), diagnostics: context.markers.map(conv.markerOut), only: context.only, triggerKind: context.trigger });
						return {
							actions: (res || []).map((a) => ({
								title: a.title,
								kind: a.kind,
								isPreferred: a.isPreferred,
								diagnostics: (a.diagnostics || []).map(conv.marker),
								edit: a.edit ? conv.workspaceEdit(a.edit) : undefined,
								command: this.commandFor(a.command),
							})),
							dispose() {},
						};
					},
				}),
			signatureHelp: () =>
				L.registerSignatureHelpProvider(sel, {
					signatureHelpTriggerCharacters: meta?.triggerCharacters || [],
					signatureHelpRetriggerCharacters: meta?.retriggerCharacters || [],
					provideSignatureHelp: async (m, p, token, context) => {
						const res = await call(m, { position: conv.position(p), triggerKind: context.triggerKind, triggerCharacter: context.triggerCharacter });
						return res ? { value: conv.signatureHelp(res), dispose() {} } : null;
					},
				}),
			documentLink: () => L.registerLinkProvider(sel, { provideLinks: async (m) => ({ links: ((await call(m, {})) || []).map(conv.link).filter(Boolean) }) }),
			inlayHints: () =>
				L.registerInlayHintsProvider(sel, {
					provideInlayHints: async (m, range) => ({ hints: ((await call(m, { range: conv.rangeOut(range) })) || []).map(conv.inlayHint), dispose() {} }),
				}),
		};
		const factory = factories[kind];
		if (!factory) return this.log("warn", `provider kind ${kind} is not supported`);
		this.providers.set(handle, factory());
	}

	// -- requests from the extension --------------------------------------------------------------------

	async onRequest(method, p) {
		const { api, sync, editor, editorArea, commands, ui } = this.services;
		const conv = this.services.converters;
		switch (method) {
			case "showMessage":
				return ui.showMessage(this.name, p);
			case "showInputBox":
				return ui.inputBox(p);
			case "showQuickPick":
				return ui.quickPick(p);
			case "executeCommand":
				return commands.execute(String(p.id), Array.isArray(p.args) ? p.args : [], { from: this });
			case "getCommands":
				return commands.ids();
			case "getLanguages":
				return monaco.languages.getLanguages().map((l) => l.id);
			case "applyEdits": {
				const model = sync.modelFor(p.uri);
				if (!model) return false;
				model.pushEditOperations([], (p.edits || []).map((e) => ({ range: conv.range(e.range), text: e.text })), () => null);
				return true;
			}
			case "applyWorkspaceEdit": {
				const entries = p.edits || [];
				if (!entries.every((e) => sync.modelFor(e.uri))) return false; // only open files, all or nothing
				for (const e of entries) sync.modelFor(e.uri).pushEditOperations([], e.edits.map((x) => ({ range: conv.range(x.range), text: x.text })), () => null);
				return true;
			}
			case "insertSnippet": {
				const model = sync.modelFor(p.uri);
				if (!model || editor.getModel() !== model) return false;
				if (p.ranges?.length) editor.setSelections(p.ranges.map((r) => monacoSelection(conv.range(r))));
				editor.getContribution("snippetController2")?.insert(String(p.snippet));
				return true;
			}
			case "saveDocument": {
				const path = sync.relativePath(p.uri);
				return path ? !!(await editorArea.save(path)) : false;
			}
			case "showDocument": {
				const path = sync.relativePath(p.uri);
				if (path) await editorArea.open(path);
				return !!path;
			}
			case "readExtensionFile": {
				const files = await api.call("ext_files", { ext_id: this.id, paths: [String(p.path)], encoding: "base64" });
				return files[p.path] ?? null;
			}
			case "updateSetting":
				return this.updateSetting(String(p.key), p.value);
			case "clipboardRead":
				return readClipboard().catch(() => "");
			case "clipboardWrite":
				await copyText(String(p.text || ""));
				return true;
			case "openExternal":
				return ui.openExternal(this.name, String(p.uri));
			default:
				throw new Error(`Unknown request ${method}`);
		}
	}

	async updateSetting(key, value) {
		if (value === null || value === undefined) delete this.settings[key];
		else this.settings[key] = value;
		const defaults = defaultsOf(this.manifest);
		const overrides = Object.fromEntries(Object.entries(this.settings).filter(([k, v]) => JSON.stringify(defaults[k]) !== JSON.stringify(v)));
		await this.services.api.call("ext_set_settings", { ext_id: this.id, settings: JSON.stringify(overrides) });
		return true;
	}

	/** Settings edited in the Extensions view. */
	applySettings(overrides) {
		this.settings = { ...defaultsOf(this.manifest), ...overrides };
		this.sandbox?.event("configuration", { settings: this.settings });
	}

	// -- notifications from the extension --------------------------------------------------------------

	onNotify(method, p) {
		const { sync, editor, decorations, statusBar, output, commands } = this.services;
		const conv = this.services.converters;
		switch (method) {
			case "log":
				return this.log(p.level, p.message);
			case "registerProvider":
				return this.registerProvider(p);
			case "unregisterProvider":
				this.providers.get(p.handle)?.dispose();
				return this.providers.delete(p.handle);
			case "registerCommand":
				return commands.register(String(p.id), this);
			case "unregisterCommand":
				return null;
			case "statusBar": {
				const key = `${this.key}:${p.handle}`;
				if (p.dispose || !p.visible) {
					statusBar.removeExtensionItem(key);
					return this.statusItems.delete(key);
				}
				this.statusItems.add(key);
				return statusBar.setExtensionItem(key, {
					text: p.text,
					tooltip: p.tooltip ? `${p.tooltip}\n— ${this.name}` : this.name,
					alignment: p.alignment === 2 ? "right" : "left",
					priority: p.priority || 0,
					onClick: p.command ? () => this.sandbox.call("executeCommand", { ref: p.command.ref }).catch((e) => this.log("error", e.message)) : null,
				});
			}
			case "statusMessage":
				return statusBar.setMessage(p.text, p.timeout);
			case "progress":
				return statusBar.setProgress(this.key, p.state === "end" ? null : p.message || p.title || this.name);
			case "output":
				if (p.clear) output.clear(this.id, p.channel);
				if (p.text) output.append(this.id, p.channel, p.text);
				return null;
			case "decorationType":
				return p.dispose ? decorations.remove(this.key, p.key) : decorations.define(this.key, p.key, p.options);
			case "setDecorations":
				return decorations.set(this.key, p.key, sync.modelFor(p.uri), p.items);
			case "diagnostics": {
				const model = sync.modelFor(p.uri);
				const owner = `ext:${this.id}:${p.owner}`;
				this.markerOwners.add(owner);
				if (model) monaco.editor.setModelMarkers(model, owner, (p.items || []).map(conv.marker));
				return null;
			}
			case "languageConfiguration": {
				const config = toLanguageConfiguration(p.config);
				if (config && p.language) this.disposables.push(monaco.languages.setLanguageConfiguration(String(p.language), config));
				return null;
			}
			case "setSelections": {
				const model = sync.modelFor(p.uri);
				if (model && editor.getModel() === model) editor.setSelections(p.selections.map((s) => new monaco.Selection(s[0] + 1, s[1] + 1, s[2] + 1, s[3] + 1)));
				return null;
			}
			case "revealRange": {
				const model = sync.modelFor(p.uri);
				if (model && editor.getModel() === model) editor.revealRangeInCenterIfOutsideViewport(conv.range(p.range));
				return null;
			}
			case "memento":
				return this.saveMemento(p.scope, p.data);
			default:
				return this.log("warn", `unknown notification ${method}`);
		}
	}

	// -- helpers ------------------------------------------------------------------------------------------

	log(level, message) {
		this.services.output.append(this.id, "Extension Host", `[${level}] ${message}\n`);
		if (level === "error") console.warn(`[extension ${this.id}]`, message);
	}

	mementoKey(scope) {
		return `mdt_ext_memento:${frappe.session.user}:${this.id}:${scope}`;
	}

	memento(scope) {
		try {
			return JSON.parse(localStorage.getItem(this.mementoKey(scope)) || "{}");
		} catch (e) {
			return {};
		}
	}

	saveMemento(scope, data) {
		try {
			const text = JSON.stringify(data || {});
			if (text.length < 512 * 1024) localStorage.setItem(this.mementoKey(scope === "workspace" ? "workspace" : "global"), text);
		} catch (e) {
			// storage unavailable or full
		}
	}
}

function defaultsOf(manifest) {
	const defaults = {};
	for (const [key, schema] of Object.entries(manifest.contributes?.configuration || {})) {
		if (schema && schema.default !== undefined) defaults[key] = schema.default;
	}
	return defaults;
}

function monacoSelection(range) {
	return new monaco.Selection(range.startLineNumber, range.startColumn, range.endLineNumber, range.endColumn);
}
