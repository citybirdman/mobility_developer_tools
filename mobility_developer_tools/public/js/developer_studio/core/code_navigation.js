import { notifyError } from "./api_client";

const LANGUAGES = ["python", "javascript"];

/**
 * Go to Definition (F12, Ctrl+click, Alt+F12 peek) backed by the server
 * (Jedi for Python, dotted paths like "app.module.function" in Python and JS strings).
 * Definitions in other files are opened as studio tabs at the right line.
 */
export class CodeNavigation {
	constructor({ api, editorArea }) {
		this.api = api;
		this.editorArea = editorArea;
		this.disposables = [
			monaco.languages.registerDefinitionProvider(LANGUAGES, { provideDefinition: (model, position) => this.definitions(model, position) }),
			monaco.editor.registerEditorOpener({ openCodeEditor: (source, resource, selection) => this.openEditor(resource, selection) }),
		];
	}

	async definitions(model, position) {
		if (model.uri.scheme !== "studio") return null;
		let found;
		try {
			found = await this.api.call("goto_definition", {
				path: model.uri.path.slice(1),
				source: model.getValue(),
				line: position.lineNumber,
				column: position.column - 1,
				language: model.getLanguageId(),
			});
		} catch (e) {
			notifyError(e);
			return null;
		}
		const locations = [];
		for (const d of found || []) {
			const target = d.path === model.uri.path.slice(1) ? model : await this.editorArea.ensureModel(d.path);
			if (target) locations.push({ uri: target.uri, range: new monaco.Range(d.line, d.column + 1, d.line, d.column + 1) });
		}
		return locations;
	}

	/** Monaco asks to show a definition in another file: open it as a studio tab. */
	openEditor(resource, selectionOrPosition) {
		if (resource.scheme !== "studio") return false;
		this.editorArea.open(resource.path.slice(1)).then(() => this.editorArea.reveal(selectionOrPosition));
		return true;
	}

	/** F12 from the studio's keyboard handler. */
	goToDefinition() {
		const editor = this.editorArea.editor;
		editor.focus();
		editor.trigger("keyboard", "editor.action.revealDefinition", {});
	}
}
