/**
 * Language configurations VS Code normally gets from its built-in language
 * extensions (vscode.python, vscode.html, ...). Extensions such as Better Comments
 * read them through `vscode.extensions.all`; the runtime exposes them as the
 * pseudo-extension "studio.languages". Installed extensions' own language
 * configurations are merged on top.
 */
const C = (line, block, brackets = [["{", "}"], ["[", "]"], ["(", ")"]]) => ({
	comments: { ...(line ? { lineComment: line } : {}), ...(block ? { blockComment: block } : {}) },
	brackets,
});
const SLASH = C("//", ["/*", "*/"]);
const HASH = C("#");
const MARKUP = C(null, ["<!--", "-->"], [["<!--", "-->"], ["<", ">"], ["{", "}"], ["(", ")"]]);

export const BUILTIN_LANGUAGE_CONFIGS = {
	python: C("#", ['"""', '"""']),
	javascript: SLASH,
	typescript: SLASH,
	javascriptreact: SLASH,
	typescriptreact: SLASH,
	java: SLASH,
	c: SLASH,
	cpp: SLASH,
	csharp: SLASH,
	go: SLASH,
	rust: SLASH,
	php: SLASH,
	swift: SLASH,
	kotlin: SLASH,
	scss: SLASH,
	less: SLASH,
	css: C(null, ["/*", "*/"]),
	json: SLASH,
	jsonc: SLASH,
	html: MARKUP,
	xml: MARKUP,
	markdown: MARKUP,
	vue: MARKUP,
	shell: HASH,
	yaml: HASH,
	dockerfile: HASH,
	ruby: C("#", ["=begin", "=end"]),
	perl: HASH,
	r: HASH,
	ini: C(";", null),
	sql: C("--", ["/*", "*/"]),
	lua: C("--", ["--[[", "]]"]),
	powershell: C("#", ["<#", "#>"]),
	"jinja-html": C(null, ["{#", "#}"]),
};

/** {languageId: configuration} for all studio languages + contributed ones (contributed win). */
export function languageConfigurations(extensions) {
	const configs = { ...BUILTIN_LANGUAGE_CONFIGS };
	for (const ext of extensions) {
		for (const lang of ext.contributes?.languages || []) {
			if (lang.configuration && typeof lang.configuration === "object") configs[lang.id] = lang.configuration;
		}
	}
	return configs;
}
