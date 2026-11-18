const CHANGE_DEBOUNCE_MS = 250;
const MAX_SYNC_CHARS = 5 * 1024 * 1024;

/**
 * Mirrors the studio's open editor models to extensions as VS Code documents.
 * Models use `studio:/<relative path>`; extensions see `file://<root>/<relative path>`.
 * Listeners receive (name, data) with the runtime's event names:
 *   docOpen / docChange / docClose / docSave / activeEditor / selection
 */
export class DocumentSync {
	constructor({ editor, root, isDirty }) {
		this.editor = editor; // the single Monaco editor of the studio
		this.prefix = `file://${root.replace(/\/$/, "")}`;
		this.isDirty = isDirty;
		this.listeners = new Set();
		this.timers = new Map();
		this.disposables = [];

		const track = (model) => {
			if (!this.isStudioModel(model)) return;
			this.emit("docOpen", this.snapshot(model));
			this.disposables.push(
				model.onDidChangeContent(() => {
					clearTimeout(this.timers.get(model.id));
					this.timers.set(model.id, setTimeout(() => this.emit("docChange", this.snapshot(model)), CHANGE_DEBOUNCE_MS));
				})
			);
		};
		monaco.editor.getModels().forEach(track);
		this.disposables.push(
			monaco.editor.onDidCreateModel(track),
			monaco.editor.onWillDisposeModel((model) => {
				if (!this.isStudioModel(model)) return;
				clearTimeout(this.timers.get(model.id));
				this.emit("docClose", { uri: this.docUri(model) });
			}),
			editor.onDidChangeModel(() => this.emit("activeEditor", this.activeInfo())),
			editor.onDidChangeCursorSelection(() => {
				clearTimeout(this.selectionTimer);
				this.selectionTimer = setTimeout(() => {
					const info = this.activeInfo();
					if (info) this.emit("selection", info);
				}, 100);
			})
		);
	}

	isStudioModel(model) {
		return model?.uri?.scheme === "studio" && model.getValueLength() <= MAX_SYNC_CHARS;
	}

	docUri(model) {
		return `${this.prefix}${model.uri.path}`;
	}

	modelFor(docUri) {
		if (typeof docUri !== "string" || !docUri.startsWith(`${this.prefix}/`)) return null;
		const path = decodeURI(docUri.slice(this.prefix.length));
		return monaco.editor.getModel(monaco.Uri.from({ scheme: "studio", path })) || null;
	}

	relativePath(docUri) {
		const model = this.modelFor(docUri);
		if (model) return model.uri.path.slice(1);
		return typeof docUri === "string" && docUri.startsWith(`${this.prefix}/`) ? decodeURI(docUri.slice(this.prefix.length + 1)) : null;
	}

	snapshot(model) {
		return {
			uri: this.docUri(model),
			languageId: model.getLanguageId(),
			version: model.getVersionId(),
			text: model.getValue(),
			dirty: !!this.isDirty(model.uri.path.slice(1)),
		};
	}

	documents() {
		return monaco.editor.getModels().filter((m) => this.isStudioModel(m)).map((m) => this.snapshot(m));
	}

	activeInfo() {
		const model = this.editor.getModel();
		if (!this.isStudioModel(model)) return null;
		const options = model.getOptions();
		return {
			uri: this.docUri(model),
			selections: (this.editor.getSelections() || []).map((s) => [
				s.selectionStartLineNumber - 1,
				s.selectionStartColumn - 1,
				s.positionLineNumber - 1,
				s.positionColumn - 1,
			]),
			options: { tabSize: options.tabSize, insertSpaces: options.insertSpaces },
		};
	}

	subscribe(listener) {
		this.listeners.add(listener);
		return { dispose: () => this.listeners.delete(listener) };
	}

	emit(name, data) {
		for (const listener of this.listeners) listener(name, data);
	}

	notifySaved(path) {
		const model = monaco.editor.getModel(monaco.Uri.from({ scheme: "studio", path: `/${path}` }));
		if (model) this.emit("docSave", { uri: this.docUri(model) });
	}

	dispose() {
		this.disposables.forEach((d) => d.dispose());
		this.listeners.clear();
	}
}
