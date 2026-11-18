/**
 * VS Code file icon theme resolution (pure, unit-tested). Same precedence as VS Code:
 *   files:   fileNames > fileExtensions (longest first) > languageIds > file
 *   folders: rootFolder / folderNames(Expanded) > folder(Expanded)
 * The `light` section (if any) overrides for light themes.
 */
export function resolveIconId(theme, { name, type, expanded = false, isRoot = false, languageId = null, light = false }) {
	if (!theme) return null;
	const sections = light && theme.light ? [theme.light, theme] : [theme];
	const lower = String(name || "").toLowerCase();
	const first = (fn) => {
		for (const section of sections) {
			const id = fn(section);
			if (id) return id;
		}
		return null;
	};

	if (type === "folder") {
		if (isRoot) {
			const root = first((s) => (expanded ? s.rootFolderExpanded || s.rootFolder : s.rootFolder));
			if (root) return root;
		}
		return (
			first((s) => (expanded ? s.folderNamesExpanded?.[lower] || s.folderNames?.[lower] : s.folderNames?.[lower])) ||
			first((s) => (expanded ? s.folderExpanded || s.folder : s.folder))
		);
	}

	const byName = first((s) => s.fileNames?.[lower]);
	if (byName) return byName;
	const parts = lower.split(".");
	for (let i = 1; i < parts.length; i++) {
		const ext = parts.slice(i).join(".");
		const byExt = first((s) => s.fileExtensions?.[ext]);
		if (byExt) return byExt;
	}
	if (languageId) {
		const byLang = first((s) => s.languageIds?.[languageId]);
		if (byLang) return byLang;
	}
	return first((s) => s.file);
}

export function resolveIcon(theme, entry) {
	const id = resolveIconId(theme, entry);
	return id ? theme.definitions?.[id] || null : null;
}

/** "\\E001" / "\\uE001" / "" -> the character to render */
export function fontCharacter(value) {
	const m = /^\\u?([0-9a-fA-F]{1,6})$/.exec(String(value || ""));
	return m ? String.fromCodePoint(parseInt(m[1], 16)) : String(value || "").slice(0, 2);
}
