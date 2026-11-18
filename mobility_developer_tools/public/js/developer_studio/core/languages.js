/** Extension -> Monaco language. Uses Monaco's own registry, plus a few Frappe-specific overrides. */
const OVERRIDES = {
	".jinja": "html",
	".j2": "html",
	".vue": "html",
	".toml": "ini",
	".cfg": "ini",
	".conf": "ini",
	".env": "ini",
	".txt": "plaintext",
	".lock": "plaintext",
};

const FILENAMES = {
	"patches.txt": "ini",
	"modules.txt": "plaintext",
	"procfile": "shell",
	".bashrc": "shell",
	".profile": "shell",
	".gitignore": "ini",
	".editorconfig": "ini",
};

// languages contributed by installed extensions win over the defaults above
const CONTRIBUTED_EXTENSIONS = new Map();
const CONTRIBUTED_FILENAMES = new Map();

/** Returns a disposable that removes the mapping again (extension disabled). */
export function registerContributedLanguage(extOrName, languageId, isFilename = false) {
	const map = isFilename ? CONTRIBUTED_FILENAMES : CONTRIBUTED_EXTENSIONS;
	const key = String(extOrName).toLowerCase();
	map.set(key, languageId);
	return { dispose: () => map.get(key) === languageId && map.delete(key) };
}

export function languageForPath(path) {
	const name = path.split("/").pop().toLowerCase();
	if (CONTRIBUTED_FILENAMES.has(name)) return CONTRIBUTED_FILENAMES.get(name);
	// longest contributed extension first: "file.jinja.html" -> ".jinja.html" before ".html"
	const parts = name.split(".");
	for (let i = 1; i < parts.length; i++) {
		const ext = `.${parts.slice(i).join(".")}`;
		if (CONTRIBUTED_EXTENSIONS.has(ext)) return CONTRIBUTED_EXTENSIONS.get(ext);
	}
	if (FILENAMES[name]) return FILENAMES[name];

	const dot = name.lastIndexOf(".");
	const ext = dot >= 0 ? name.slice(dot) : "";
	if (OVERRIDES[ext]) return OVERRIDES[ext];

	for (const lang of monaco.languages.getLanguages()) {
		if ((lang.filenames || []).some((f) => f.toLowerCase() === name)) return lang.id;
		if (ext && (lang.extensions || []).includes(ext)) return lang.id;
	}
	return "plaintext";
}

const ICON_COLORS = {
	py: "#e5c07b",
	js: "#f0db4f",
	mjs: "#f0db4f",
	ts: "#3b8eea",
	json: "#d19a66",
	html: "#e06c75",
	jinja: "#e06c75",
	css: "#61afef",
	scss: "#c678dd",
	less: "#61afef",
	md: "#56b6c2",
	sh: "#98c379",
	sql: "#d19a66",
	yml: "#e06c75",
	yaml: "#e06c75",
	txt: "#abb2bf",
	vue: "#98c379",
};

export function iconColorForPath(path) {
	const ext = path.split(".").pop().toLowerCase();
	return ICON_COLORS[ext] || "#8b93a1";
}
