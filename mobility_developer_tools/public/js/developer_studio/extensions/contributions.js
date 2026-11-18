import { registerContributedLanguage } from "../core/languages";

/**
 * Applies the declarative (level 1) parts of an extension to the studio.
 * One handler per contribution point; each returns disposables so an extension
 * can be disabled without reloading the page.
 */

const regex = (value) => {
	if (!value) return undefined;
	try {
		if (typeof value === "string") return new RegExp(value);
		if (typeof value === "object" && value.pattern) return new RegExp(value.pattern, (value.flags || "").replace(/[^gimsuy]/g, ""));
		if (typeof value === "object" && value.source) return new RegExp(value.source, (value.flags || "").replace(/[^gimsuy]/g, ""));
	} catch (e) {
		return undefined;
	}
	return undefined;
};

/** VS Code language-configuration.json -> Monaco LanguageConfiguration */
export function toLanguageConfiguration(c) {
	if (!c || typeof c !== "object") return null;
	const pairs = (list) =>
		(Array.isArray(list) ? list : [])
			.map((p) => (Array.isArray(p) ? { open: p[0], close: p[1] } : p && p.open ? { open: p.open, close: p.close, notIn: p.notIn } : null))
			.filter((p) => p && typeof p.open === "string" && typeof p.close === "string");
	const config = {
		comments: c.comments ? { lineComment: c.comments.lineComment, blockComment: c.comments.blockComment } : undefined,
		brackets: (c.brackets || []).filter((b) => Array.isArray(b) && b.length === 2),
		autoClosingPairs: pairs(c.autoClosingPairs),
		surroundingPairs: pairs(c.surroundingPairs),
		wordPattern: regex(c.wordPattern),
	};
	if (c.folding?.markers) {
		const start = regex(c.folding.markers.start), end = regex(c.folding.markers.end);
		if (start && end) config.folding = { markers: { start, end }, offSide: !!c.folding.offSide };
	}
	if (c.indentationRules) {
		const rules = {};
		for (const key of ["increaseIndentPattern", "decreaseIndentPattern", "indentNextLinePattern", "unIndentedLinePattern"]) {
			const r = regex(c.indentationRules[key]);
			if (r) rules[key] = r;
		}
		if (rules.increaseIndentPattern && rules.decreaseIndentPattern) config.indentationRules = rules;
	}
	if (Array.isArray(c.onEnterRules)) {
		const actions = { none: 0, indent: 1, indentOutdent: 2, outdent: 3 };
		config.onEnterRules = c.onEnterRules
			.map((r) => ({
				beforeText: regex(r.beforeText),
				afterText: regex(r.afterText),
				previousLineText: regex(r.previousLineText),
				action: { indentAction: typeof r.action?.indent === "number" ? r.action.indent : actions[r.action?.indent] ?? 0, appendText: r.action?.appendText, removeText: r.action?.removeText },
			}))
			.filter((r) => r.beforeText);
	}
	return config;
}

export class LanguagesHandler {
	point = "languages";

	apply(ext, languages, ctx) {
		const disposables = [];
		const known = new Set(monaco.languages.getLanguages().map((l) => l.id));
		const grammarLanguages = new Set((ext.contributes.grammars || []).map((g) => g.language).filter(Boolean));
		for (const lang of languages) {
			monaco.languages.register({ id: lang.id, extensions: lang.extensions, filenames: lang.filenames, aliases: lang.aliases, firstLine: lang.firstLine || undefined });
			for (const e of lang.extensions || []) disposables.push(registerContributedLanguage(e, lang.id));
			for (const f of lang.filenames || []) disposables.push(registerContributedLanguage(f, lang.id, true));
			// don't replace a built-in language's rules unless the extension also brings its grammar
			if (lang.configuration && (!known.has(lang.id) || grammarLanguages.has(lang.id))) {
				const config = toLanguageConfiguration(lang.configuration);
				if (config) disposables.push(monaco.languages.setLanguageConfiguration(lang.id, config));
			}
		}
		return disposables;
	}
}

export class GrammarsHandler {
	point = "grammars";

	apply(ext, grammars, ctx) {
		const disposables = [];
		for (const grammar of grammars) {
			ctx.textmate.addGrammar({ ...grammar, ext: ext.id });
			if (grammar.language) disposables.push(ctx.textmate.bindLanguage(grammar.language, grammar.scopeName));
		}
		return disposables;
	}
}

export class SnippetsHandler {
	point = "snippets";

	apply(ext, files, ctx) {
		const disposables = [];
		for (const file of files) {
			let snippets = null;
			const load = async () => {
				if (!snippets) {
					const data = await ctx.api.call("ext_files", { ext_id: ext.id, paths: [file.resource] });
					snippets = JSON.parse(data[file.resource] || "[]");
				}
				return snippets;
			};
			for (const language of file.languages) {
				disposables.push(
					monaco.languages.registerCompletionItemProvider(language === "*" ? "*" : language, {
						async provideCompletionItems(model, position) {
							const word = model.getWordUntilPosition(position);
							const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
							const items = [];
							for (const s of await load()) {
								for (const prefix of s.prefix) {
									items.push({
										label: prefix,
										kind: monaco.languages.CompletionItemKind.Snippet,
										detail: s.description || s.name,
										documentation: s.body,
										insertText: s.body,
										insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
										range,
									});
								}
							}
							return { suggestions: items };
						},
					})
				);
			}
		}
		return disposables;
	}
}

export class ThemesHandler {
	point = "themes";

	apply(ext, themes, ctx) {
		for (const theme of themes) ctx.colorThemes.register(ext.id, theme);
		return [{ dispose: () => ctx.colorThemes.clearExtension(ext.id) }];
	}
}

export class IconThemesHandler {
	point = "iconThemes";

	apply(ext, themes, ctx) {
		for (const theme of themes) ctx.iconThemes.register(ext.id, theme);
		return [{ dispose: () => ctx.iconThemes.clearExtension(ext.id) }];
	}
}

export const DEFAULT_HANDLERS = [LanguagesHandler, GrammarsHandler, SnippetsHandler, ThemesHandler, IconThemesHandler];
