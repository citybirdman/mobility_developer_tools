/**
 * Runtime (VS Code-shaped JSON, 0-based) <-> Monaco (1-based) conversions.
 * Pure: `monaco` and the URI mapper are passed in, so this is unit-tested with fakes.
 *
 * uris: { toModelUri(docUri) -> monaco Uri | null, toDocUri(modelUri) -> string }
 */

const VS_COMPLETION_KINDS = ["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter", "User", "Issue"];

export function createConverters(monaco, uris) {
	const range = (r) => (r ? new monaco.Range(r[0] + 1, r[1] + 1, r[2] + 1, r[3] + 1) : undefined);
	const position = (p) => [p.lineNumber - 1, p.column - 1];
	const rangeOut = (r) => [r.startLineNumber - 1, r.startColumn - 1, r.endLineNumber - 1, r.endColumn - 1];

	// extension markdown is never trusted: no HTML, no command links
	const markdown = (m) => (m ? { value: m.md !== undefined ? m.md : escapeMarkdown(m.text || ""), isTrusted: false, supportHtml: false } : undefined);

	const completionKind = (k) => {
		const name = VS_COMPLETION_KINDS[k];
		return monaco.languages.CompletionItemKind[name] ?? monaco.languages.CompletionItemKind.Text;
	};
	const severity = (s) => [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][s] ?? monaco.MarkerSeverity.Error;
	const severityOut = (s) => ({ [monaco.MarkerSeverity.Error]: 0, [monaco.MarkerSeverity.Warning]: 1, [monaco.MarkerSeverity.Info]: 2, [monaco.MarkerSeverity.Hint]: 3 })[s] ?? 0;

	function location(l) {
		if (!l || !l.range) return null;
		const uri = uris.toModelUri(l.uri);
		return uri ? { uri, range: range(l.range) } : null;
	}

	function workspaceEdit(entries) {
		const edits = [];
		for (const entry of entries || []) {
			const resource = uris.toModelUri(entry.uri);
			if (!resource) continue; // only open files can be edited
			for (const e of entry.edits || []) edits.push({ resource, versionId: undefined, textEdit: { range: range(e.range), text: e.text } });
		}
		return { edits };
	}

	function completionItem(item, defaultRange, command) {
		const insert = item.insert || { text: item.label };
		let itemRange = defaultRange;
		if (Array.isArray(item.range)) itemRange = range(item.range);
		else if (item.range && item.range.insert) itemRange = { insert: range(item.range.insert), replace: range(item.range.replace) };
		return {
			label: item.labelDetail || item.labelDescription ? { label: item.label, detail: item.labelDetail, description: item.labelDescription } : item.label,
			kind: completionKind(item.kind ?? 0),
			detail: item.detail,
			documentation: markdown(item.documentation),
			insertText: insert.snippet !== undefined ? insert.snippet : insert.text,
			insertTextRules: insert.snippet !== undefined ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
			filterText: item.filterText,
			sortText: item.sortText,
			preselect: item.preselect,
			range: itemRange,
			additionalTextEdits: (item.additionalTextEdits || []).map((e) => ({ range: range(e.range), text: e.text })),
			commitCharacters: item.commitCharacters,
			tags: item.tags,
			command,
		};
	}

	return {
		range,
		position,
		rangeOut,
		markdown,
		location,
		workspaceEdit,
		completionItem,
		severity,

		marker(d) {
			const r = range(d.range);
			return {
				startLineNumber: r.startLineNumber,
				startColumn: r.startColumn,
				endLineNumber: r.endLineNumber,
				endColumn: r.endColumn,
				message: String(d.message || "").slice(0, 5000),
				severity: severity(d.severity),
				source: d.source,
				code: d.code,
				tags: d.tags,
			};
		},
		markerOut(m) {
			return { range: [m.startLineNumber - 1, m.startColumn - 1, m.endLineNumber - 1, m.endColumn - 1], message: m.message, severity: severityOut(m.severity), source: m.source, code: typeof m.code === "string" ? m.code : m.code?.value };
		},
		symbol(s) {
			return {
				name: s.name || "?",
				detail: s.detail || "",
				kind: s.kind ?? 0,
				tags: [],
				range: range(s.range),
				selectionRange: range(s.selectionRange || s.range),
				children: (s.children || []).map((c) => this.symbol(c)),
			};
		},
		folding(r, kinds = monaco.languages.FoldingRangeKind) {
			const kind = { 1: kinds.Comment, 2: kinds.Imports, 3: kinds.Region }[r.kind];
			return { start: r.start + 1, end: r.end + 1, kind };
		},
		textEdit(e) {
			return { range: range(e.range), text: e.text };
		},
		signatureHelp(h) {
			return {
				activeSignature: h.activeSignature || 0,
				activeParameter: h.activeParameter || 0,
				signatures: (h.signatures || []).map((s) => ({
					label: s.label,
					documentation: markdown(s.documentation),
					activeParameter: s.activeParameter,
					parameters: (s.parameters || []).map((p) => ({ label: p.label, documentation: markdown(p.documentation) })),
				})),
			};
		},
		link(l) {
			if (!l.target || !/^https?:\/\//i.test(l.target)) return null; // never javascript:, file:, ...
			return { range: range(l.range), url: l.target, tooltip: l.tooltip };
		},
		inlayHint(h) {
			return {
				position: { lineNumber: h.position[0] + 1, column: h.position[1] + 1 },
				label: String(h.label || ""),
				kind: h.kind,
				paddingLeft: h.paddingLeft,
				paddingRight: h.paddingRight,
				tooltip: markdown(h.tooltip),
			};
		},
	};
}

function escapeMarkdown(text) {
	return String(text).replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&");
}

/**
 * When should an extension's code start? (pure, unit-tested)
 * Returns { atStartup, languages: Set, commands: Set }.
 */
export function activationPlan(manifest) {
	const events = manifest.activation_events || [];
	const plan = { atStartup: false, languages: new Set(), commands: new Set() };
	for (const event of events) {
		const [kind, arg] = event.split(":");
		if (kind === "*" || kind === "onStartupFinished" || kind === "workspaceContains" || kind === "onFileSystem") plan.atStartup = true;
		else if (kind === "onLanguage" && arg) plan.languages.add(arg);
		else if (kind === "onCommand" && arg) plan.commands.add(arg);
	}
	// implicit activation (VS Code >= 1.74): contributed commands and languages
	for (const c of manifest.contributes?.commands || []) plan.commands.add(c.command);
	for (const l of manifest.contributes?.languages || []) plan.languages.add(l.id);
	if (!events.length && !plan.commands.size && !plan.languages.size) plan.atStartup = true;
	return plan;
}
