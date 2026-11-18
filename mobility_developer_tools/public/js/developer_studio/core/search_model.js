/**
 * Pure helpers of the Search view (no DOM, unit-tested): search options, the
 * replace preview shown in the results tree, and result bookkeeping.
 */

export const DEFAULT_SEARCH_STATE = {
	query: "",
	replace: "",
	isRegex: false,
	matchCase: false,
	wholeWord: false,
	include: "",
	exclude: "",
	showReplace: false,
	showDetails: false,
};

/** Arguments of the search_text / replace_text endpoints. */
export function searchArgs(state) {
	return {
		query: state.query,
		is_regex: state.isRegex ? 1 : 0,
		match_case: state.matchCase ? 1 : 0,
		whole_word: state.wholeWord ? 1 : 0,
		include: state.include || "",
		exclude: state.exclude || "",
	};
}

/** Text that will replace `match` (what the tree shows struck through + inserted). */
export function previewReplacement(state, matchText) {
	if (!state.isRegex) return state.replace;
	let re;
	try {
		re = new RegExp(`^(?:${state.query})$`, state.matchCase ? "s" : "is");
	} catch (e) {
		return state.replace;
	}
	const m = re.exec(matchText);
	if (!m) return state.replace;
	const groups = m.groups || {};
	return state.replace.replace(/\$(\$|&|\d{1,2}|<[A-Za-z_]\w*>)|\\([nt\\])/g, (all, token, escape) => {
		if (escape) return { n: "\n", t: "\t", "\\": "\\" }[escape];
		if (token === "$") return "$";
		if (token === "&") return m[0];
		if (token.startsWith("<")) return groups[token.slice(1, -1)] ?? all;
		const index = Number(token);
		if (index < m.length) return m[index] ?? "";
		if (token.length === 2 && Number(token[0]) < m.length) return (m[Number(token[0])] ?? "") + token[1];
		return all;
	});
}

/** "12 results in 3 files" (+ the server's limit notes). */
export function summarize(result) {
	if (!result) return "";
	if (!result.match_count) return __("No results found. Review your settings for configured exclusions and check your gitignore files.");
	const parts = [
		result.match_count === 1 ? __("1 result") : __("{0} results", [result.match_count]),
		result.file_count === 1 ? __("in 1 file") : __("in {0} files", [result.file_count]),
	];
	let text = parts.join(" ");
	if (result.limit_hit) text += ` — ${__("the result set only contains a subset of all matches. Be more specific in your search to narrow down the results.")}`;
	if (result.timed_out) text += ` — ${__("the search took too long and was stopped. Narrow it down with files to include.")}`;
	return text;
}

/** Copy of `result` without one match (or one file when match is null); empty files disappear. */
export function dismiss(result, path, match = null) {
	const files = [];
	for (const file of result.files) {
		if (file.path !== path) files.push(file);
		else if (match) {
			const matches = file.matches.filter((m) => !(m.line === match.line && m.col === match.col));
			if (matches.length) files.push({ ...file, matches });
		}
	}
	return withCounts(result, files);
}

/** Replace one file's entry with fresh matches from the server (after a replace). */
export function updateFile(result, path, fresh) {
	const entry = fresh.files.find((f) => f.path === path);
	const files = [];
	for (const file of result.files) {
		if (file.path !== path) files.push(file);
		else if (entry) files.push(entry);
	}
	return withCounts(result, files);
}

function withCounts(result, files) {
	return { ...result, files, file_count: files.length, match_count: files.reduce((n, f) => n + f.matches.length, 0) };
}

/** Monaco selection of a match (server columns are 0-based UTF-16 = Monaco column - 1). */
export function matchRange(match) {
	return {
		startLineNumber: match.line,
		startColumn: match.col + 1,
		endLineNumber: match.end_line,
		endColumn: match.end_col + 1,
	};
}

export function loadSearchState(storage, key) {
	try {
		return { ...DEFAULT_SEARCH_STATE, ...JSON.parse(storage.getItem(key) || "{}") };
	} catch (e) {
		return { ...DEFAULT_SEARCH_STATE };
	}
}

export function saveSearchState(storage, key, state) {
	try {
		storage.setItem(key, JSON.stringify(state));
	} catch (e) {
		// storage unavailable (private window ...)
	}
}
