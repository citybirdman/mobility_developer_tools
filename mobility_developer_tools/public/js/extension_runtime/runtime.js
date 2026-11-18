/*
 * Developer Studio - VS Code extension runtime.
 *
 * Runs inside a Web Worker created by a sandboxed iframe (opaque origin, CSP
 * `connect-src 'none'`): extension code has no DOM, no network, no cookies and no
 * access to the studio. Everything goes through postMessage RPC with the page,
 * which decides what is allowed. The set of implemented APIs must match
 * studio/extensions/api_support.json (checked by tests/js).
 *
 * Protocol (page <-> runtime):
 *   page -> runtime  {type:"init", extension, settings, workspace, documents, activeEditor, theme}
 *                    {type:"call", id, method, params}     (provider calls, commands)
 *                    {type:"event", name, data}             (documents, editor, configuration)
 *                    {type:"response", id, result | error}  (answers to runtime requests)
 *   runtime -> page  {type:"request", id, method, params}  (needs an answer)
 *                    {type:"notify", method, params}        (fire and forget)
 *                    {type:"response", id, result | error}
 */
(function () {
	"use strict";

	// -- RPC ------------------------------------------------------------------------------------
	const pending = new Map();
	let nextRequestId = 1;
	const send = (msg) => self.postMessage(msg);
	const request = (method, params) =>
		new Promise((resolve, reject) => {
			const id = nextRequestId++;
			pending.set(id, { resolve, reject });
			send({ type: "request", id, method, params });
		});
	const notify = (method, params) => send({ type: "notify", method, params });
	const log = (level, message) => notify("log", { level, message: String(message).slice(0, 4000) });

	// -- events -------------------------------------------------------------------------------------
	class Disposable {
		constructor(fn) {
			this._fn = fn;
		}
		static from(...items) {
			return new Disposable(() => items.forEach((d) => d && d.dispose && d.dispose()));
		}
		dispose() {
			if (this._fn) {
				const fn = this._fn;
				this._fn = null;
				fn();
			}
		}
	}

	class EventEmitter {
		constructor() {
			this._listeners = new Set();
			this.event = (listener, thisArgs, disposables) => {
				const entry = { listener, thisArgs };
				this._listeners.add(entry);
				const d = new Disposable(() => this._listeners.delete(entry));
				if (Array.isArray(disposables)) disposables.push(d);
				return d;
			};
		}
		fire(data) {
			for (const { listener, thisArgs } of [...this._listeners]) {
				try {
					listener.call(thisArgs, data);
				} catch (e) {
					log("error", `listener failed: ${e && e.stack ? e.stack : e}`);
				}
			}
		}
		dispose() {
			this._listeners.clear();
		}
	}
	const neverEvent = new EventEmitter().event; // events that never fire here

	class CancellationTokenSource {
		constructor() {
			const emitter = new EventEmitter();
			this._emitter = emitter;
			this.token = { isCancellationRequested: false, onCancellationRequested: emitter.event };
		}
		cancel() {
			if (!this.token.isCancellationRequested) {
				this.token.isCancellationRequested = true;
				this._emitter.fire();
			}
		}
		dispose() {
			this._emitter.dispose();
		}
	}
	class CancellationError extends Error {
		constructor() {
			super("Canceled");
			this.name = "Canceled";
		}
	}

	// -- basic types ----------------------------------------------------------------------------------
	class Position {
		constructor(line, character) {
			this.line = Math.max(0, line | 0);
			this.character = Math.max(0, character | 0);
		}
		isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
		isBeforeOrEqual(o) { return this.isBefore(o) || this.isEqual(o); }
		isAfter(o) { return !this.isBeforeOrEqual(o); }
		isAfterOrEqual(o) { return !this.isBefore(o); }
		isEqual(o) { return this.line === o.line && this.character === o.character; }
		compareTo(o) { return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1; }
		translate(a, b) {
			if (typeof a === "object") return new Position(this.line + (a.lineDelta || 0), this.character + (a.characterDelta || 0));
			return new Position(this.line + (a || 0), this.character + (b || 0));
		}
		with(a, b) {
			if (typeof a === "object" && a) return new Position(a.line ?? this.line, a.character ?? this.character);
			return new Position(a ?? this.line, b ?? this.character);
		}
	}

	class Range {
		constructor(a, b, c, d) {
			if (typeof a === "number") {
				a = new Position(a, b);
				b = new Position(c, d);
			}
			const [start, end] = a.isBeforeOrEqual(b) ? [a, b] : [b, a];
			this.start = new Position(start.line, start.character);
			this.end = new Position(end.line, end.character);
		}
		get isEmpty() { return this.start.isEqual(this.end); }
		get isSingleLine() { return this.start.line === this.end.line; }
		contains(x) {
			if (x instanceof Range) return this.contains(x.start) && this.contains(x.end);
			return x.isAfterOrEqual(this.start) && x.isBeforeOrEqual(this.end);
		}
		isEqual(o) { return this.start.isEqual(o.start) && this.end.isEqual(o.end); }
		intersection(o) {
			const start = this.start.isAfter(o.start) ? this.start : o.start;
			const end = this.end.isBefore(o.end) ? this.end : o.end;
			return start.isAfter(end) ? undefined : new Range(start, end);
		}
		union(o) {
			return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
		}
		with(a, b) {
			if (a && !(a instanceof Position)) return new Range(a.start || this.start, a.end || this.end);
			return new Range(a || this.start, b || this.end);
		}
	}

	class Selection extends Range {
		constructor(a, b, c, d) {
			if (typeof a === "number") {
				a = new Position(a, b);
				b = new Position(c, d);
			}
			super(a, b);
			this.anchor = a;
			this.active = b;
		}
		get isReversed() { return this.active.isBefore(this.anchor); }
	}

	class Location {
		constructor(uri, rangeOrPosition) {
			this.uri = uri;
			this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
		}
	}

	class Uri {
		constructor(scheme, authority, path, query, fragment) {
			this.scheme = scheme || "file";
			this.authority = authority || "";
			this.path = path || "/";
			this.query = query || "";
			this.fragment = fragment || "";
		}
		static parse(value) {
			const m = /^([a-zA-Z][\w+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(String(value));
			if (!m) return new Uri("file", "", String(value));
			return new Uri(m[1], m[2], decodeURIComponent(m[3] || "/"), m[4], m[5]);
		}
		static file(path) { return new Uri("file", "", String(path).startsWith("/") ? path : `/${path}`); }
		static joinPath(base, ...parts) {
			const joined = [base.path.replace(/\/$/, ""), ...parts].join("/");
			return base.with({ path: normalizePath(joined) });
		}
		static from(c) { return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment); }
		get fsPath() { return this.path; }
		with(change) {
			return new Uri(change.scheme ?? this.scheme, change.authority ?? this.authority, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment);
		}
		toString() {
			let s = `${this.scheme}://${this.authority}${encodeURI(this.path)}`;
			if (this.query) s += `?${this.query}`;
			if (this.fragment) s += `#${this.fragment}`;
			return s;
		}
		toJSON() { return { $mid: 1, scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
	}

	function normalizePath(p) {
		const out = [];
		for (const part of p.split("/")) {
			if (part === "..") out.pop();
			else if (part && part !== ".") out.push(part);
		}
		return `/${out.join("/")}`;
	}

	class TextEdit {
		constructor(range, newText) { this.range = range; this.newText = newText; }
		static replace(range, text) { return new TextEdit(range, text); }
		static insert(position, text) { return new TextEdit(new Range(position, position), text); }
		static delete(range) { return new TextEdit(range, ""); }
		static setEndOfLine() { return new TextEdit(new Range(0, 0, 0, 0), ""); }
	}

	class WorkspaceEdit {
		constructor() { this._edits = new Map(); }
		_list(uri) {
			const key = uri.toString();
			if (!this._edits.has(key)) this._edits.set(key, { uri, edits: [] });
			return this._edits.get(key).edits;
		}
		replace(uri, range, text) { this._list(uri).push(new TextEdit(range, text)); }
		insert(uri, pos, text) { this._list(uri).push(TextEdit.insert(pos, text)); }
		delete(uri, range) { this._list(uri).push(TextEdit.delete(range)); }
		set(uri, edits) { this._list(uri).splice(0, Infinity, ...(edits || []).map((e) => (Array.isArray(e) ? e[0] : e))); }
		has(uri) { return this._edits.has(uri.toString()); }
		get(uri) { return this._edits.get(uri.toString())?.edits || []; }
		entries() { return [...this._edits.values()].map((e) => [e.uri, e.edits]); }
		get size() { return this._edits.size; }
		createFile() { throw notSupported("WorkspaceEdit.createFile"); }
		deleteFile() { throw notSupported("WorkspaceEdit.deleteFile"); }
		renameFile() { throw notSupported("WorkspaceEdit.renameFile"); }
	}

	class SnippetString {
		constructor(value) { this.value = value || ""; this._tab = 1; }
		static _escape(v) { return v.replace(/\$|}|\\/g, "\\$&"); }
		appendText(s) { this.value += SnippetString._escape(s); return this; }
		appendTabstop(n = this._tab++) { this.value += `$${n}`; return this; }
		appendPlaceholder(v, n = this._tab++) {
			const inner = typeof v === "function" ? (v(new SnippetString()), "") : SnippetString._escape(String(v));
			this.value += `\${${n}:${inner}}`;
			return this;
		}
		appendChoice(values, n = this._tab++) { this.value += `\${${n}|${values.map((v) => v.replace(/[,|\\]/g, "\\$&")).join(",")}|}`; return this; }
		appendVariable(name, def) { this.value += def ? `\${${name}:${def}}` : `$${name}`; return this; }
	}

	class MarkdownString {
		constructor(value, supportThemeIcons) { this.value = value || ""; this.supportThemeIcons = !!supportThemeIcons; this.isTrusted = false; this.supportHtml = false; }
		appendText(v) { this.value += String(v).replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&"); return this; }
		appendMarkdown(v) { this.value += v; return this; }
		appendCodeblock(code, lang = "") { this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`; return this; }
	}

	const enumOf = (names, start = 0) => Object.freeze(Object.fromEntries(names.map((n, i) => [n, i + start])));
	const CompletionItemKind = enumOf(["Text", "Method", "Function", "Constructor", "Field", "Variable", "Class", "Interface", "Module", "Property", "Unit", "Value", "Enum", "Keyword", "Snippet", "Color", "File", "Reference", "Folder", "EnumMember", "Constant", "Struct", "Event", "Operator", "TypeParameter", "User", "Issue"]);
	const SymbolKind = enumOf(["File", "Module", "Namespace", "Package", "Class", "Method", "Property", "Field", "Constructor", "Enum", "Interface", "Function", "Variable", "Constant", "String", "Number", "Boolean", "Array", "Object", "Key", "Null", "EnumMember", "Struct", "Event", "Operator", "TypeParameter"]);
	const DiagnosticSeverity = enumOf(["Error", "Warning", "Information", "Hint"]);
	const DiagnosticTag = Object.freeze({ Unnecessary: 1, Deprecated: 2 });
	const CompletionItemTag = Object.freeze({ Deprecated: 1 });
	const CompletionTriggerKind = enumOf(["Invoke", "TriggerCharacter", "TriggerForIncompleteCompletions"]);
	const FoldingRangeKind = Object.freeze({ Comment: 1, Imports: 2, Region: 3 });
	const CodeActionTriggerKind = Object.freeze({ Invoke: 1, Automatic: 2 });
	const SignatureHelpTriggerKind = Object.freeze({ Invoke: 1, TriggerCharacter: 2, ContentChange: 3 });
	const DocumentHighlightKind = enumOf(["Text", "Read", "Write"]);
	const InlayHintKind = Object.freeze({ Type: 1, Parameter: 2 });
	const StatusBarAlignment = Object.freeze({ Left: 1, Right: 2 });
	const EndOfLine = Object.freeze({ LF: 1, CRLF: 2 });
	const TextEditorRevealType = enumOf(["Default", "InCenter", "InCenterIfOutsideViewport", "AtTop"]);
	const ViewColumn = Object.freeze({ Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 });
	const ProgressLocation = Object.freeze({ SourceControl: 1, Window: 10, Notification: 15 });
	const ConfigurationTarget = Object.freeze({ Global: 1, Workspace: 2, WorkspaceFolder: 3 });
	const OverviewRulerLane = Object.freeze({ Left: 1, Center: 2, Right: 4, Full: 7 });
	const DecorationRangeBehavior = enumOf(["OpenOpen", "ClosedClosed", "OpenClosed", "ClosedOpen"]);
	const TextDocumentSaveReason = Object.freeze({ Manual: 1, AfterDelay: 2, FocusOut: 3 });
	const ExtensionMode = Object.freeze({ Production: 1, Development: 2, Test: 3 });
	const ExtensionKind = Object.freeze({ UI: 1, Workspace: 2 });
	const UIKind = Object.freeze({ Desktop: 1, Web: 2 });
	const ColorThemeKind = Object.freeze({ Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 });
	const FileType = Object.freeze({ Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 });
	const IndentAction = enumOf(["None", "Indent", "IndentOutdent", "Outdent"]);
	const TextEditorLineNumbersStyle = enumOf(["Off", "On", "Relative"]);
	const TextEditorCursorStyle = enumOf(["Line", "Block", "Underline", "LineThin", "BlockOutline", "UnderlineThin"], 1);

	class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
	class CompletionList { constructor(items, isIncomplete) { this.items = items || []; this.isIncomplete = !!isIncomplete; } }
	class Hover { constructor(contents, range) { this.contents = Array.isArray(contents) ? contents : [contents]; this.range = range; } }
	class Diagnostic { constructor(range, message, severity = DiagnosticSeverity.Error) { this.range = range; this.message = message; this.severity = severity; } }
	class DiagnosticRelatedInformation { constructor(location, message) { this.location = location; this.message = message; } }
	class DocumentSymbol { constructor(name, detail, kind, range, selectionRange) { Object.assign(this, { name, detail, kind, range, selectionRange, children: [] }); } }
	class SymbolInformation {
		constructor(name, kind, a, b) {
			this.name = name;
			this.kind = kind;
			this.containerName = typeof a === "string" ? a : "";
			this.location = a instanceof Location ? a : b instanceof Location ? b : new Location(b, a);
		}
	}
	class FoldingRange { constructor(start, end, kind) { Object.assign(this, { start, end, kind }); } }
	class CodeActionKind {
		constructor(value) { this.value = value; }
		append(part) { return new CodeActionKind(this.value ? `${this.value}.${part}` : part); }
		contains(o) { return this.value === o.value || o.value.startsWith(`${this.value}.`); }
		intersects(o) { return this.contains(o) || o.contains(this); }
	}
	for (const [k, v] of Object.entries({ Empty: "", QuickFix: "quickfix", Refactor: "refactor", RefactorExtract: "refactor.extract", RefactorInline: "refactor.inline", RefactorMove: "refactor.move", RefactorRewrite: "refactor.rewrite", Source: "source", SourceOrganizeImports: "source.organizeImports", SourceFixAll: "source.fixAll", Notebook: "notebook" })) {
		CodeActionKind[k] = new CodeActionKind(v);
	}
	class CodeAction { constructor(title, kind) { this.title = title; this.kind = kind; } }
	class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0; } }
	class SignatureInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; this.parameters = []; } }
	class ParameterInformation { constructor(label, documentation) { this.label = label; this.documentation = documentation; } }
	class DocumentHighlight { constructor(range, kind = DocumentHighlightKind.Text) { this.range = range; this.kind = kind; } }
	class DocumentLink { constructor(range, target) { this.range = range; this.target = target; } }
	class InlayHint { constructor(position, label, kind) { Object.assign(this, { position, label, kind }); } }
	class ThemeColor { constructor(id) { this.id = id; } }
	class ThemeIcon {
		constructor(id, color) { this.id = id; this.color = color; }
	}
	ThemeIcon.File = new ThemeIcon("file");
	ThemeIcon.Folder = new ThemeIcon("folder");
	class RelativePattern {
		constructor(base, pattern) { this.baseUri = typeof base === "string" ? Uri.file(base) : base.uri || base; this.base = this.baseUri.path; this.pattern = pattern; }
	}
	class FileSystemError extends Error {
		constructor(message, code = "Unknown") { super(String(message || code)); this.code = code; this.name = `${code} (FileSystemError)`; }
	}
	for (const code of ["FileNotFound", "FileExists", "FileNotADirectory", "FileIsADirectory", "NoPermissions", "Unavailable"]) {
		FileSystemError[code] = (m) => new FileSystemError(m && m.toString ? m.toString() : m, code);
	}

	function notSupported(what) {
		const error = new Error(`${what} is not supported in Developer Studio`);
		error.name = "NotSupportedError";
		log("warn", error.message);
		return error;
	}

	// -- documents ------------------------------------------------------------------------------------
	const documents = new Map(); // uri string -> TextDocument
	const onDidOpen = new EventEmitter(), onDidClose = new EventEmitter(), onDidChange = new EventEmitter();
	const onDidSave = new EventEmitter(), onWillSave = new EventEmitter();

	class TextDocument {
		constructor(data) { this._update(data); this.isUntitled = false; this.eol = EndOfLine.LF; this.isClosed = false; this.isDirty = false; }
		_update({ uri, languageId, version, text }) {
			if (uri) this.uri = Uri.parse(uri);
			if (languageId) this.languageId = languageId;
			if (version !== undefined) this.version = version;
			if (text !== undefined) { this._text = text; this._lines = null; this._offsets = null; }
		}
		get fileName() { return this.uri.path; }
		get lineCount() { return this._lineList().length; }
		_lineList() { return this._lines || (this._lines = this._text.split(/\r\n|\r|\n/)); }
		_lineOffsets() {
			if (!this._offsets) {
				this._offsets = [0];
				const re = /\r\n|\r|\n/g;
				let m;
				while ((m = re.exec(this._text))) this._offsets.push(m.index + m[0].length);
			}
			return this._offsets;
		}
		getText(range) {
			if (!range) return this._text;
			return this._text.slice(this.offsetAt(range.start), this.offsetAt(range.end));
		}
		lineAt(arg) {
			const line = typeof arg === "number" ? arg : arg.line;
			if (line < 0 || line >= this.lineCount) throw new Error(`Illegal line ${line}`);
			const text = this._lineList()[line];
			const first = text.search(/\S/);
			return {
				lineNumber: line,
				text,
				range: new Range(line, 0, line, text.length),
				rangeIncludingLineBreak: new Range(line, 0, Math.min(line + 1, this.lineCount - 1), line + 1 < this.lineCount ? 0 : text.length),
				firstNonWhitespaceCharacterIndex: first < 0 ? text.length : first,
				isEmptyOrWhitespace: first < 0,
			};
		}
		offsetAt(pos) {
			const p = this.validatePosition(pos);
			return this._lineOffsets()[p.line] + p.character;
		}
		positionAt(offset) {
			offset = Math.max(0, Math.min(offset | 0, this._text.length));
			const offsets = this._lineOffsets();
			let lo = 0, hi = offsets.length - 1;
			while (lo < hi) {
				const mid = (lo + hi + 1) >> 1;
				if (offsets[mid] <= offset) lo = mid; else hi = mid - 1;
			}
			return new Position(lo, offset - offsets[lo]);
		}
		validatePosition(pos) {
			const line = Math.min(Math.max(pos.line, 0), this.lineCount - 1);
			return new Position(line, Math.min(Math.max(pos.character, 0), this._lineList()[line].length));
		}
		validateRange(range) { return new Range(this.validatePosition(range.start), this.validatePosition(range.end)); }
		getWordRangeAtPosition(pos, regex) {
			const p = this.validatePosition(pos);
			const text = this._lineList()[p.line];
			const re = new RegExp((regex || /(-?\d*\.\d\w*)|([^`~!@#$%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g).source, "g");
			let m;
			while ((m = re.exec(text))) {
				if (m.index <= p.character && re.lastIndex >= p.character && m[0].length) return new Range(p.line, m.index, p.line, re.lastIndex);
				if (!m[0].length) re.lastIndex++;
			}
			return undefined;
		}
		save() { return request("saveDocument", { uri: this.uri.toString() }); }
	}

	// -- editors ----------------------------------------------------------------------------------------
	let activeEditor;
	const onDidChangeActiveEditor = new EventEmitter(), onDidChangeSelection = new EventEmitter();
	const onDidChangeVisible = new EventEmitter();

	class TextEditor {
		constructor(document, selections) {
			this.document = document;
			this._selections = selections;
			this.options = { tabSize: 4, insertSpaces: false, cursorStyle: 1, lineNumbers: 1 };
			this.viewColumn = ViewColumn.One;
			this.visibleRanges = [];
		}
		get selection() { return this._selections[0]; }
		set selection(s) { this.selections = [s]; }
		get selections() { return this._selections; }
		set selections(list) {
			this._selections = list;
			notify("setSelections", { uri: this.document.uri.toString(), selections: list.map(selectionToJson) });
		}
		edit(callback) {
			const edits = [];
			callback({
				replace: (loc, text) => edits.push({ range: rangeOf(loc), text }),
				insert: (pos, text) => edits.push({ range: rangeOf(pos), text }),
				delete: (range) => edits.push({ range: rangeOf(range), text: "" }),
				setEndOfLine: () => {},
			});
			return request("applyEdits", { uri: this.document.uri.toString(), edits: edits.map((e) => ({ range: rangeToJson(e.range), text: e.text })) });
		}
		insertSnippet(snippet, location) {
			const ranges = !location ? [] : Array.isArray(location) ? location.map(rangeOf) : [rangeOf(location)];
			return request("insertSnippet", { uri: this.document.uri.toString(), snippet: snippet.value ?? String(snippet), ranges: ranges.map(rangeToJson) });
		}
		setDecorations(type, rangesOrOptions) {
			notify("setDecorations", {
				uri: this.document.uri.toString(),
				key: type.key,
				items: (rangesOrOptions || []).map((r) => (r instanceof Range ? { range: rangeToJson(r) } : { range: rangeToJson(r.range), hover: hoverText(r.hoverMessage) })),
			});
		}
		revealRange(range, type) { notify("revealRange", { uri: this.document.uri.toString(), range: rangeToJson(range), type }); }
		show() {}
		hide() {}
	}

	const rangeOf = (x) => (x instanceof Range ? x : x instanceof Position ? new Range(x, x) : x && x.start ? new Range(x.start, x.end) : new Range(0, 0, 0, 0));
	const rangeToJson = (r) => (r ? [r.start.line, r.start.character, r.end.line, r.end.character] : null);
	const rangeFromJson = (j) => new Range(j[0], j[1], j[2], j[3]);
	const posFromJson = (j) => new Position(j[0], j[1]);
	const selectionToJson = (s) => [s.anchor.line, s.anchor.character, s.active.line, s.active.character];
	const selectionFromJson = (j) => new Selection(j[0], j[1], j[2], j[3]);

	// -- serialization of provider results ---------------------------------------------------------------
	const commandRefs = new Map(); // ref -> {command, args}
	let nextCommandRef = 1;
	function commandToJson(cmd) {
		if (!cmd || !cmd.command) return undefined;
		const ref = nextCommandRef++;
		commandRefs.set(ref, { command: cmd.command, args: cmd.arguments || [] });
		if (commandRefs.size > 2000) commandRefs.delete(commandRefs.keys().next().value);
		return { id: cmd.command, title: cmd.title || "", ref };
	}
	function markdown(value) {
		if (value == null) return undefined;
		if (typeof value === "string") return { text: value };
		if (value instanceof MarkdownString || typeof value.value === "string") return { md: String(value.value) };
		if (value.language && value.value) return { md: `\`\`\`${value.language}\n${value.value}\n\`\`\`` };
		return { text: String(value) };
	}
	function hoverText(v) {
		if (!v) return undefined;
		const list = Array.isArray(v) ? v : [v];
		return list.map(markdown).filter(Boolean);
	}
	function locationToJson(l) {
		if (!l) return null;
		if (l.targetUri) return { uri: l.targetUri.toString(), range: rangeToJson(l.targetSelectionRange || l.targetRange) };
		return { uri: l.uri.toString(), range: rangeToJson(l.range) };
	}
	const asArray = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
	function textEditToJson(e) { return { range: rangeToJson(e.range), text: e.newText }; }
	function workspaceEditToJson(we) {
		if (!we) return null;
		return we.entries().map(([uri, edits]) => ({ uri: uri.toString(), edits: edits.map(textEditToJson) }));
	}
	function completionItemToJson(item) {
		const insert = item.insertText instanceof SnippetString ? { snippet: item.insertText.value } : item.insertText !== undefined ? { text: String(item.insertText) } : undefined;
		let range;
		if (item.range instanceof Range) range = rangeToJson(item.range);
		else if (item.range && item.range.inserting) range = { insert: rangeToJson(item.range.inserting), replace: rangeToJson(item.range.replacing) };
		return {
			label: typeof item.label === "string" ? item.label : item.label && item.label.label,
			labelDetail: item.label && item.label.detail,
			labelDescription: item.label && item.label.description,
			kind: item.kind,
			detail: item.detail,
			documentation: markdown(item.documentation),
			insert,
			filterText: item.filterText,
			sortText: item.sortText,
			preselect: !!item.preselect,
			range,
			additionalTextEdits: asArray(item.additionalTextEdits).map(textEditToJson),
			commitCharacters: item.commitCharacters,
			tags: item.tags,
			command: commandToJson(item.command),
		};
	}
	function symbolToJson(s) {
		if (s.location) return { name: s.name, detail: s.containerName || "", kind: s.kind, range: rangeToJson(s.location.range), selectionRange: rangeToJson(s.location.range), children: [] };
		return { name: s.name, detail: s.detail || "", kind: s.kind, range: rangeToJson(s.range), selectionRange: rangeToJson(s.selectionRange || s.range), children: asArray(s.children).map(symbolToJson) };
	}
	function diagnosticToJson(d) {
		return {
			range: rangeToJson(d.range),
			message: String(d.message),
			severity: d.severity ?? DiagnosticSeverity.Error,
			source: d.source,
			code: typeof d.code === "object" && d.code ? String(d.code.value) : d.code !== undefined ? String(d.code) : undefined,
			tags: d.tags,
		};
	}
	function diagnosticFromJson(j) {
		const d = new Diagnostic(rangeFromJson(j.range), j.message, j.severity);
		d.source = j.source;
		d.code = j.code;
		return d;
	}

	// -- providers ---------------------------------------------------------------------------------------
	const providers = new Map(); // handle -> {kind, provider}
	let nextHandle = 1;
	function normalizeSelector(selector) {
		return asArray(selector).map((s) => (typeof s === "string" ? { language: s } : { language: s.language, scheme: s.scheme, pattern: typeof s.pattern === "string" ? s.pattern : undefined }));
	}
	function registerProvider(kind, selector, provider, meta = {}) {
		const handle = nextHandle++;
		providers.set(handle, { kind, provider });
		notify("registerProvider", { handle, kind, selector: normalizeSelector(selector), meta });
		return new Disposable(() => {
			providers.delete(handle);
			notify("unregisterProvider", { handle });
		});
	}

	const PROVIDER_CALLS = {
		completion: async (p, doc, a, t) => {
			const res = await p.provideCompletionItems(doc, posFromJson(a.position), t, { triggerKind: a.triggerKind || 0, triggerCharacter: a.triggerCharacter });
			const list = Array.isArray(res) ? { items: res, isIncomplete: false } : res || { items: [] };
			return { isIncomplete: !!list.isIncomplete, items: asArray(list.items).slice(0, 5000).map(completionItemToJson) };
		},
		hover: async (p, doc, a, t) => {
			const h = await p.provideHover(doc, posFromJson(a.position), t);
			return h ? { contents: asArray(h.contents).map(markdown).filter(Boolean), range: rangeToJson(h.range) } : null;
		},
		definition: async (p, doc, a, t) => asArray(await p.provideDefinition(doc, posFromJson(a.position), t)).map(locationToJson),
		declaration: async (p, doc, a, t) => asArray(await p.provideDeclaration(doc, posFromJson(a.position), t)).map(locationToJson),
		typeDefinition: async (p, doc, a, t) => asArray(await p.provideTypeDefinition(doc, posFromJson(a.position), t)).map(locationToJson),
		implementation: async (p, doc, a, t) => asArray(await p.provideImplementation(doc, posFromJson(a.position), t)).map(locationToJson),
		references: async (p, doc, a, t) => asArray(await p.provideReferences(doc, posFromJson(a.position), { includeDeclaration: true }, t)).map(locationToJson),
		documentHighlight: async (p, doc, a, t) => asArray(await p.provideDocumentHighlights(doc, posFromJson(a.position), t)).map((h) => ({ range: rangeToJson(h.range), kind: h.kind })),
		rename: async (p, doc, a, t) => workspaceEditToJson(await p.provideRenameEdits(doc, posFromJson(a.position), a.newName, t)),
		formatting: async (p, doc, a, t) => asArray(await p.provideDocumentFormattingEdits(doc, a.options, t)).map(textEditToJson),
		rangeFormatting: async (p, doc, a, t) => asArray(await p.provideDocumentRangeFormattingEdits(doc, rangeFromJson(a.range), a.options, t)).map(textEditToJson),
		onTypeFormatting: async (p, doc, a, t) => asArray(await p.provideOnTypeFormattingEdits(doc, posFromJson(a.position), a.ch, a.options, t)).map(textEditToJson),
		documentSymbol: async (p, doc, a, t) => asArray(await p.provideDocumentSymbols(doc, t)).map(symbolToJson),
		foldingRange: async (p, doc, a, t) => asArray(await p.provideFoldingRanges(doc, {}, t)).map((r) => ({ start: r.start, end: r.end, kind: r.kind })),
		codeAction: async (p, doc, a, t) => {
			const context = { diagnostics: asArray(a.diagnostics).map(diagnosticFromJson), only: a.only ? new CodeActionKind(a.only) : undefined, triggerKind: a.triggerKind || 1 };
			const actions = asArray(await p.provideCodeActions(doc, rangeFromJson(a.range), context, t));
			return actions.slice(0, 200).map((x) =>
				typeof x.command === "string"
					? { title: x.title, command: commandToJson(x) }
					: { title: x.title, kind: x.kind && x.kind.value, isPreferred: !!x.isPreferred, edit: workspaceEditToJson(x.edit), command: commandToJson(x.command), diagnostics: asArray(x.diagnostics).map(diagnosticToJson) }
			);
		},
		signatureHelp: async (p, doc, a, t) => {
			const h = await p.provideSignatureHelp(doc, posFromJson(a.position), t, { triggerKind: a.triggerKind || 1, triggerCharacter: a.triggerCharacter, isRetrigger: false });
			if (!h) return null;
			return {
				activeSignature: h.activeSignature || 0,
				activeParameter: h.activeParameter || 0,
				signatures: asArray(h.signatures).map((s) => ({
					label: s.label,
					documentation: markdown(s.documentation),
					activeParameter: s.activeParameter,
					parameters: asArray(s.parameters).map((x) => ({ label: x.label, documentation: markdown(x.documentation) })),
				})),
			};
		},
		documentLink: async (p, doc, a, t) => asArray(await p.provideDocumentLinks(doc, t)).map((l) => ({ range: rangeToJson(l.range), target: l.target && l.target.toString(), tooltip: l.tooltip })),
		inlayHints: async (p, doc, a, t) =>
			asArray(await p.provideInlayHints(doc, rangeFromJson(a.range), t)).map((h) => ({
				position: [h.position.line, h.position.character],
				label: typeof h.label === "string" ? h.label : asArray(h.label).map((part) => part.value).join(""),
				kind: h.kind,
				paddingLeft: !!h.paddingLeft,
				paddingRight: !!h.paddingRight,
				tooltip: markdown(h.tooltip),
			})),
	};

	// -- commands -----------------------------------------------------------------------------------------
	const commands = new Map();
	const commandsApi = {
		registerCommand(id, fn, thisArg) {
			commands.set(id, (...args) => fn.apply(thisArg, args));
			notify("registerCommand", { id });
			return new Disposable(() => {
				commands.delete(id);
				notify("unregisterCommand", { id });
			});
		},
		registerTextEditorCommand(id, fn, thisArg) {
			return commandsApi.registerCommand(id, async (...args) => {
				if (!activeEditor) return;
				const edits = [];
				const builder = {
					replace: (loc, text) => edits.push({ range: rangeToJson(rangeOf(loc)), text }),
					insert: (pos, text) => edits.push({ range: rangeToJson(rangeOf(pos)), text }),
					delete: (range) => edits.push({ range: rangeToJson(rangeOf(range)), text: "" }),
					setEndOfLine: () => {},
				};
				await fn.call(thisArg, activeEditor, builder, ...args);
				if (edits.length) await request("applyEdits", { uri: activeEditor.document.uri.toString(), edits });
			});
		},
		async executeCommand(id, ...args) {
			if (commands.has(id)) return commands.get(id)(...args);
			return request("executeCommand", { id, args: jsonSafe(args) });
		},
		async getCommands() {
			const external = await request("getCommands", {});
			return [...new Set([...commands.keys(), ...external])];
		},
	};

	function jsonSafe(value, depth = 0) {
		if (depth > 6 || value == null) return value ?? null;
		if (value instanceof Uri) return value.toString();
		if (value instanceof Range) return rangeToJson(value);
		if (value instanceof Position) return [value.line, value.character];
		if (Array.isArray(value)) return value.slice(0, 1000).map((v) => jsonSafe(v, depth + 1));
		if (typeof value === "object") {
			const out = {};
			for (const [k, v] of Object.entries(value).slice(0, 200)) if (typeof v !== "function") out[k] = jsonSafe(v, depth + 1);
			return out;
		}
		return typeof value === "function" ? null : value;
	}

	// -- configuration -----------------------------------------------------------------------------------
	let settings = {};
	const BUILTIN_SETTINGS = { "editor.tabSize": 4, "editor.insertSpaces": false, "editor.fontSize": 13, "files.eol": "\n", "editor.formatOnSave": false };
	const onDidChangeConfiguration = new EventEmitter();
	function lookup(full) {
		if (Object.prototype.hasOwnProperty.call(settings, full)) return settings[full];
		if (Object.prototype.hasOwnProperty.call(BUILTIN_SETTINGS, full)) return BUILTIN_SETTINGS[full];
		// nested object access: get("a") when "section.a.b" exists
		const prefix = `${full}.`;
		let found, obj;
		for (const [k, v] of Object.entries(settings)) {
			if (!k.startsWith(prefix)) continue;
			found = true;
			obj = obj || {};
			let cursor = obj;
			const parts = k.slice(prefix.length).split(".");
			parts.slice(0, -1).forEach((p) => (cursor = cursor[p] = cursor[p] || {}));
			cursor[parts[parts.length - 1]] = v;
		}
		return found ? obj : undefined;
	}
	function getConfiguration(section) {
		const key = (k) => (section ? `${section}.${k}` : k);
		const config = {
			get(k, def) {
				const v = lookup(key(k));
				return v === undefined ? def : v;
			},
			has(k) { return lookup(key(k)) !== undefined; },
			inspect(k) { return { key: key(k), defaultValue: lookup(key(k)), globalValue: lookup(key(k)) }; },
			async update(k, value) {
				await request("updateSetting", { key: key(k), value: jsonSafe(value) });
				if (value === undefined) delete settings[key(k)]; else settings[key(k)] = value;
				onDidChangeConfiguration.fire({ affectsConfiguration: (s) => key(k) === s || key(k).startsWith(`${s}.`) });
			},
		};
		return new Proxy(config, {
			get(target, prop) {
				if (prop in target) return target[prop];
				return typeof prop === "string" ? lookup(key(prop)) : undefined;
			},
		});
	}

	// -- diagnostics -------------------------------------------------------------------------------------
	const diagnosticsByOwner = new Map(); // owner -> Map(uri -> Diagnostic[])
	const onDidChangeDiagnostics = new EventEmitter();
	let nextCollection = 1;
	function createDiagnosticCollection(name) {
		const owner = `${name || "ext"}#${nextCollection++}`;
		const store = new Map();
		diagnosticsByOwner.set(owner, store);
		const publish = (uri) => {
			notify("diagnostics", { owner, uri: uri.toString(), items: (store.get(uri.toString()) || []).map(diagnosticToJson) });
			onDidChangeDiagnostics.fire({ uris: [uri] });
		};
		return {
			name: name || owner,
			set(uri, diags) {
				if (Array.isArray(uri)) {
					for (const [u, d] of uri) this.set(u, d);
					return;
				}
				store.set(uri.toString(), asArray(diags).slice(0, 1000));
				publish(uri);
			},
			delete(uri) { store.delete(uri.toString()); publish(uri); },
			clear() { for (const k of [...store.keys()]) this.delete(Uri.parse(k)); },
			forEach(cb) { for (const [k, v] of store) cb(Uri.parse(k), v, this); },
			get(uri) { return store.get(uri.toString()); },
			has(uri) { return store.has(uri.toString()); },
			dispose() { this.clear(); diagnosticsByOwner.delete(owner); },
			[Symbol.iterator]: function* () { for (const [k, v] of store) yield [Uri.parse(k), v]; },
		};
	}
	function getDiagnostics(uri) {
		if (uri) {
			const out = [];
			for (const store of diagnosticsByOwner.values()) out.push(...(store.get(uri.toString()) || []));
			return out;
		}
		const map = new Map();
		for (const store of diagnosticsByOwner.values()) for (const [k, v] of store) map.set(k, [...(map.get(k) || []), ...v]);
		return [...map].map(([k, v]) => [Uri.parse(k), v]);
	}

	// -- window ---------------------------------------------------------------------------------------------
	let nextUiHandle = 1;
	function message(severity) {
		return async (text, ...rest) => {
			const options = rest[0] && typeof rest[0] === "object" && !("title" in rest[0]) && !Array.isArray(rest[0]) ? rest.shift() : {};
			const items = rest.flat();
			const index = await request("showMessage", {
				severity,
				message: String(text),
				detail: options.detail,
				modal: !!options.modal,
				items: items.map((i) => (typeof i === "string" ? i : i.title)),
			});
			return index == null || index < 0 ? undefined : items[index];
		};
	}
	function createStatusBarItem(a, b, c) {
		const handle = nextUiHandle++;
		const alignment = typeof a === "string" ? b : a;
		const priority = typeof a === "string" ? c : b;
		const state = { handle, alignment: alignment || StatusBarAlignment.Left, priority: priority || 0, visible: false, text: "", tooltip: "", command: undefined, color: undefined, backgroundColor: undefined };
		// colors are not forwarded: the page only shows plain text (no style injection)
		const push = () =>
			notify("statusBar", {
				handle: state.handle,
				alignment: state.alignment,
				priority: state.priority,
				visible: state.visible,
				text: String(state.text || ""),
				tooltip: typeof state.tooltip === "string" ? state.tooltip : state.tooltip && state.tooltip.value,
				command: state.command && commandToJson(typeof state.command === "string" ? { command: state.command } : state.command),
			});
		const item = {
			id: typeof a === "string" ? a : `item${handle}`,
			show() { state.visible = true; push(); },
			hide() { state.visible = false; push(); },
			dispose() { notify("statusBar", { handle, dispose: true }); },
		};
		for (const key of ["text", "tooltip", "command", "name", "color", "backgroundColor", "accessibilityInformation"]) {
			Object.defineProperty(item, key, { get: () => state[key], set: (v) => { state[key] = v; if (state.visible) push(); }, enumerable: true });
		}
		Object.defineProperty(item, "alignment", { get: () => state.alignment });
		Object.defineProperty(item, "priority", { get: () => state.priority });
		return item;
	}
	function createOutputChannel(name, options) {
		const write = (text) => notify("output", { channel: String(name), text: String(text) });
		const level = (lvl) => (msg, ...args) => write(`[${lvl}] ${msg}${args.length ? " " + args.map((x) => (x instanceof Error ? x.stack : JSON.stringify(jsonSafe(x)))).join(" ") : ""}\n`);
		const channel = {
			name: String(name),
			append: (t) => write(t),
			appendLine: (t) => write(`${t}\n`),
			replace: (t) => { notify("output", { channel: String(name), clear: true }); write(t); },
			clear: () => notify("output", { channel: String(name), clear: true }),
			show: () => notify("output", { channel: String(name), show: true }),
			hide: () => {},
			dispose: () => {},
		};
		if (options && options.log) Object.assign(channel, { trace: level("trace"), debug: level("debug"), info: level("info"), warn: level("warning"), error: level("error"), logLevel: 3, onDidChangeLogLevel: neverEvent });
		return channel;
	}
	const decorationTypes = new Set();
	function createTextEditorDecorationType(options) {
		const key = `dec${nextUiHandle++}`;
		decorationTypes.add(key);
		notify("decorationType", { key, options: jsonSafe(options) });
		return { key, dispose: () => { decorationTypes.delete(key); notify("decorationType", { key, dispose: true }); } };
	}

	const windowApi = {
		showInformationMessage: message("info"),
		showWarningMessage: message("warning"),
		showErrorMessage: message("error"),
		async showInputBox(options = {}) {
			const value = await request("showInputBox", { title: options.title, prompt: options.prompt, placeHolder: options.placeHolder, value: options.value, password: !!options.password });
			if (value != null && options.validateInput) {
				const problem = await options.validateInput(value);
				if (problem) {
					await windowApi.showErrorMessage(typeof problem === "string" ? problem : problem.message);
					return undefined;
				}
			}
			return value == null ? undefined : value;
		},
		async showQuickPick(items, options = {}) {
			const list = await items;
			const labels = list.map((i) => (typeof i === "string" ? { label: i } : { label: i.label, description: i.description, detail: i.detail }));
			const picked = await request("showQuickPick", { items: labels, placeHolder: options.placeHolder || options.title, canPickMany: !!options.canPickMany });
			if (picked == null) return undefined;
			return options.canPickMany ? picked.map((i) => list[i]) : list[picked];
		},
		createStatusBarItem,
		createOutputChannel,
		async withProgress(options, task) {
			notify("progress", { title: options.title, state: "start" });
			const source = new CancellationTokenSource();
			try {
				return await task({ report: (v) => v && v.message && notify("progress", { title: options.title, message: v.message, state: "report" }) }, source.token);
			} finally {
				notify("progress", { title: options.title, state: "end" });
			}
		},
		setStatusBarMessage(text, hide) {
			notify("statusMessage", { text: String(text), timeout: typeof hide === "number" ? hide : 5000 });
			return new Disposable(() => notify("statusMessage", { text: "" }));
		},
		createTextEditorDecorationType,
		get activeTextEditor() { return activeEditor; },
		get visibleTextEditors() { return activeEditor ? [activeEditor] : []; },
		async showTextDocument(docOrUri) {
			const uri = docOrUri.uri ? docOrUri.uri : docOrUri;
			await request("showDocument", { uri: uri.toString() });
			return activeEditor;
		},
		onDidChangeActiveTextEditor: onDidChangeActiveEditor.event,
		onDidChangeVisibleTextEditors: onDidChangeVisible.event,
		onDidChangeTextEditorSelection: onDidChangeSelection.event,
		onDidChangeTextEditorVisibleRanges: neverEvent,
		onDidChangeTextEditorOptions: neverEvent,
		state: { focused: true, active: true },
		onDidChangeWindowState: neverEvent,
		activeColorTheme: { kind: ColorThemeKind.Dark },
		onDidChangeActiveColorTheme: new EventEmitter().event,
	};
	const themeEmitter = new EventEmitter();
	windowApi.onDidChangeActiveColorTheme = themeEmitter.event;

	// -- workspace ------------------------------------------------------------------------------------------
	let workspaceInfo = { root: "/", name: "workspace" };
	let extensionInfo = { id: "", packageJSON: {} };
	const EXT_ROOT = "/__studio_ext";
	const LANGUAGES_ID = "studio.languages";
	let languageConfigs = {};
	const extUri = () => Uri.file(`${EXT_ROOT}/${extensionInfo.id}`);
	/** Which virtual extension file a uri points at: {ext, path} or null. Nothing else is readable. */
	function extensionFile(uri) {
		if (uri.scheme === "studio-ext") return { ext: uri.authority, path: uri.path.replace(/^\//, "") };
		if (uri.scheme !== "file" || !uri.path.startsWith(`${EXT_ROOT}/`)) return null;
		const [ext, ...rest] = normalizePath(uri.path).slice(EXT_ROOT.length + 1).split("/");
		return { ext, path: rest.join("/") };
	}
	const encodeText = (text) => new TextEncoder().encode(text);
	const fsApi = {
		async readFile(uri) {
			const target = extensionFile(uri);
			if (target && target.ext === LANGUAGES_ID) {
				const id = target.path.replace(/^languages\//, "").replace(/\.json$/, "");
				if (!Object.prototype.hasOwnProperty.call(languageConfigs, id)) throw FileSystemError.FileNotFound(uri);
				return encodeText(JSON.stringify(languageConfigs[id]));
			}
			if (!target || target.ext !== extensionInfo.id || !target.path) throw FileSystemError.NoPermissions(uri);
			const b64 = await request("readExtensionFile", { path: target.path });
			if (b64 == null) throw FileSystemError.FileNotFound(uri);
			const bin = atob(b64);
			const bytes = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
			return bytes;
		},
		async stat(uri) {
			const data = await fsApi.readFile(uri);
			return { type: FileType.File, ctime: 0, mtime: 0, size: data.length };
		},
		async readDirectory() { throw notSupported("workspace.fs.readDirectory"); },
		async writeFile() { throw FileSystemError.NoPermissions("workspace.fs.writeFile is not allowed"); },
		async delete() { throw FileSystemError.NoPermissions("workspace.fs.delete is not allowed"); },
		async rename() { throw FileSystemError.NoPermissions("workspace.fs.rename is not allowed"); },
		async copy() { throw FileSystemError.NoPermissions("workspace.fs.copy is not allowed"); },
		async createDirectory() { throw FileSystemError.NoPermissions("workspace.fs.createDirectory is not allowed"); },
		isWritableFileSystem: () => false,
	};
	const workspaceFolder = () => ({ uri: Uri.file(workspaceInfo.root), name: workspaceInfo.name, index: 0 });
	const workspaceApi = {
		getConfiguration,
		onDidChangeConfiguration: onDidChangeConfiguration.event,
		get textDocuments() { return [...documents.values()]; },
		onDidOpenTextDocument: onDidOpen.event,
		onDidCloseTextDocument: onDidClose.event,
		onDidChangeTextDocument: onDidChange.event,
		onDidSaveTextDocument: onDidSave.event,
		onWillSaveTextDocument: onWillSave.event,
		get workspaceFolders() { return [workspaceFolder()]; },
		get rootPath() { return workspaceInfo.root; },
		get name() { return workspaceInfo.name; },
		getWorkspaceFolder(uri) { return uri && uri.path && uri.path.startsWith(workspaceInfo.root) ? workspaceFolder() : undefined; },
		asRelativePath(pathOrUri) {
			const p = typeof pathOrUri === "string" ? pathOrUri : pathOrUri.path;
			return p.startsWith(`${workspaceInfo.root}/`) ? p.slice(workspaceInfo.root.length + 1) : p;
		},
		async applyEdit(edit) { return request("applyWorkspaceEdit", { edits: workspaceEditToJson(edit) }); },
		async openTextDocument(arg) {
			if (arg && typeof arg === "object" && !(arg instanceof Uri) && !arg.scheme) {
				const doc = new TextDocument({ uri: `untitled:/Untitled-${nextUiHandle++}`, languageId: arg.language || "plaintext", version: 1, text: arg.content || "" });
				doc.isUntitled = true;
				return doc;
			}
			const uri = typeof arg === "string" ? Uri.file(arg) : arg;
			const doc = documents.get(uri.toString());
			if (doc) return doc;
			throw notSupported("workspace.openTextDocument for files that are not open");
		},
		fs: fsApi,
		isTrusted: true,
		onDidChangeWorkspaceFolders: neverEvent,
		onDidGrantWorkspaceTrust: neverEvent,
		createFileSystemWatcher() {
			return { ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false, onDidCreate: neverEvent, onDidChange: neverEvent, onDidDelete: neverEvent, dispose() {} };
		},
		onDidCreateFiles: neverEvent,
		onDidDeleteFiles: neverEvent,
		onDidRenameFiles: neverEvent,
		onWillCreateFiles: neverEvent,
		onWillDeleteFiles: neverEvent,
		onWillRenameFiles: neverEvent,
	};

	// -- languages -------------------------------------------------------------------------------------------
	const languagesApi = {
		registerCompletionItemProvider: (sel, p, ...triggerCharacters) => registerProvider("completion", sel, p, { triggerCharacters: triggerCharacters.flat().filter((c) => typeof c === "string") }),
		registerHoverProvider: (sel, p) => registerProvider("hover", sel, p),
		registerDefinitionProvider: (sel, p) => registerProvider("definition", sel, p),
		registerDeclarationProvider: (sel, p) => registerProvider("declaration", sel, p),
		registerTypeDefinitionProvider: (sel, p) => registerProvider("typeDefinition", sel, p),
		registerImplementationProvider: (sel, p) => registerProvider("implementation", sel, p),
		registerReferenceProvider: (sel, p) => registerProvider("references", sel, p),
		registerDocumentHighlightProvider: (sel, p) => registerProvider("documentHighlight", sel, p),
		registerRenameProvider: (sel, p) => registerProvider("rename", sel, p),
		registerDocumentFormattingEditProvider: (sel, p) => registerProvider("formatting", sel, p),
		registerDocumentRangeFormattingEditProvider: (sel, p) => registerProvider("rangeFormatting", sel, p),
		registerOnTypeFormattingEditProvider: (sel, p, first, ...more) => registerProvider("onTypeFormatting", sel, p, { triggerCharacters: [first, ...more] }),
		registerDocumentSymbolProvider: (sel, p) => registerProvider("documentSymbol", sel, p),
		registerFoldingRangeProvider: (sel, p) => registerProvider("foldingRange", sel, p),
		registerCodeActionsProvider: (sel, p, meta = {}) => registerProvider("codeAction", sel, p, { kinds: asArray(meta.providedCodeActionKinds).map((k) => k.value) }),
		registerSignatureHelpProvider: (sel, p, a, ...rest) => {
			const meta = a && typeof a === "object" ? { triggerCharacters: a.triggerCharacters || [], retriggerCharacters: a.retriggerCharacters || [] } : { triggerCharacters: [a, ...rest].filter(Boolean), retriggerCharacters: [] };
			return registerProvider("signatureHelp", sel, p, meta);
		},
		registerDocumentLinkProvider: (sel, p) => registerProvider("documentLink", sel, p),
		registerInlayHintsProvider: (sel, p) => registerProvider("inlayHints", sel, p),
		createDiagnosticCollection,
		getDiagnostics,
		onDidChangeDiagnostics: onDidChangeDiagnostics.event,
		getLanguages: () => request("getLanguages", {}),
		match(selector, document) {
			let best = 0;
			for (const s of normalizeSelector(selector)) {
				if (s.language === "*" || s.language === document.languageId) best = Math.max(best, s.language === "*" ? 5 : 10);
				else if (!s.language && (s.scheme || s.pattern)) best = Math.max(best, 5);
			}
			return best;
		},
		setLanguageConfiguration(language, config) {
			const re = (r) => (r instanceof RegExp ? { source: r.source, flags: r.flags } : undefined);
			notify("languageConfiguration", {
				language,
				config: {
					comments: config.comments,
					brackets: config.brackets,
					wordPattern: re(config.wordPattern),
					indentationRules: config.indentationRules && Object.fromEntries(Object.entries(config.indentationRules).map(([k, v]) => [k, re(v)])),
					onEnterRules: asArray(config.onEnterRules).map((r) => ({ beforeText: re(r.beforeText), afterText: re(r.afterText), previousLineText: re(r.previousLineText), action: r.action })),
					autoClosingPairs: config.__characterPairSupport ? undefined : config.autoClosingPairs,
				},
			});
			return new Disposable(() => {});
		},
	};

	// -- env / extensions / l10n ----------------------------------------------------------------------------
	const randomId = () => Array.from({ length: 4 }, () => Math.random().toString(16).slice(2, 10)).join("");
	const envApi = {
		clipboard: { readText: () => request("clipboardRead", {}), writeText: (t) => request("clipboardWrite", { text: String(t) }) },
		language: "en",
		appName: "Developer Studio",
		appHost: "web",
		uriScheme: "studio",
		machineId: randomId(),
		sessionId: randomId(),
		openExternal: (uri) => request("openExternal", { uri: uri.toString() }),
		uiKind: UIKind.Web,
		shell: "",
		remoteName: undefined,
		isTelemetryEnabled: false,
		onDidChangeTelemetryEnabled: neverEvent,
		isNewAppInstall: false,
	};
	let selfExtension;
	let languagesExtension;
	const extensionsApi = {
		getExtension: (id) => {
			const lower = String(id || "").toLowerCase();
			if (selfExtension && lower === extensionInfo.id) return selfExtension;
			if (languagesExtension && lower === LANGUAGES_ID) return languagesExtension;
			return undefined;
		},
		get all() { return [selfExtension, languagesExtension].filter(Boolean); },
		onDidChange: neverEvent,
	};
	const l10nApi = {
		t(message, ...args) {
			const text = typeof message === "object" ? message.message : String(message);
			const named = args.length === 1 && args[0] && typeof args[0] === "object" && !Array.isArray(args[0]) ? args[0] : null;
			return text.replace(/\{(\w+)\}/g, (m, k) => {
				const v = named ? named[k] : args[Number(k)];
				return v === undefined ? m : String(v);
			});
		},
		bundle: undefined,
		uri: undefined,
	};

	// -- the vscode module -------------------------------------------------------------------------------------
	function namespace(name, impl, unsupported = []) {
		return new Proxy(impl, {
			get(target, prop) {
				if (prop in target) return target[prop];
				if (typeof prop !== "string") return undefined;
				if (prop.startsWith("on")) return neverEvent; // registering for an event we never fire is harmless
				if (unsupported.includes(prop) || /^[a-z]/.test(prop)) {
					return (...args) => {
						throw notSupported(`vscode.${name}.${prop}`);
					};
				}
				return undefined;
			},
		});
	}
	const unsupportedNamespace = (name) =>
		new Proxy({}, {
			get(target, prop) {
				if (typeof prop !== "string") return undefined;
				if (prop.startsWith("on")) return neverEvent;
				return (...args) => {
					throw notSupported(`vscode.${name}.${prop}`);
				};
			},
		});

	const vscode = {
		version: "1.95.0",
		commands: namespace("commands", commandsApi),
		window: namespace("window", windowApi),
		workspace: namespace("workspace", workspaceApi),
		languages: namespace("languages", languagesApi),
		env: namespace("env", envApi),
		extensions: namespace("extensions", extensionsApi),
		l10n: namespace("l10n", l10nApi),
		debug: unsupportedNamespace("debug"),
		tasks: unsupportedNamespace("tasks"),
		scm: unsupportedNamespace("scm"),
		authentication: unsupportedNamespace("authentication"),
		notebooks: unsupportedNamespace("notebooks"),
		comments: unsupportedNamespace("comments"),
		tests: unsupportedNamespace("tests"),
		chat: unsupportedNamespace("chat"),
		lm: unsupportedNamespace("lm"),
		Uri, Position, Range, Selection, Location, Disposable, EventEmitter, CancellationTokenSource, CancellationError,
		TextEdit, WorkspaceEdit, SnippetString, MarkdownString, CompletionItem, CompletionItemKind, CompletionItemTag,
		CompletionList, CompletionTriggerKind, Hover, Diagnostic, DiagnosticSeverity, DiagnosticTag,
		DiagnosticRelatedInformation, DocumentSymbol, SymbolInformation, SymbolKind, FoldingRange, FoldingRangeKind,
		CodeAction, CodeActionKind, CodeActionTriggerKind, SignatureHelp, SignatureInformation, ParameterInformation,
		SignatureHelpTriggerKind, DocumentHighlight, DocumentHighlightKind, DocumentLink, InlayHint, InlayHintKind,
		StatusBarAlignment, ThemeColor, ThemeIcon, EndOfLine, TextEditorRevealType, ViewColumn, ProgressLocation,
		ConfigurationTarget, OverviewRulerLane, DecorationRangeBehavior, TextDocumentSaveReason, ExtensionMode,
		ExtensionKind, UIKind, ColorThemeKind, FileType, RelativePattern, IndentAction, TextEditorLineNumbersStyle,
		TextEditorCursorStyle, FileSystemError,
	};

	// -- module loader -------------------------------------------------------------------------------------------
	const pathModule = {
		sep: "/",
		delimiter: ":",
		normalize: (p) => normalizePath(p),
		join: (...parts) => {
			const joined = parts.filter((p) => p !== "").join("/");
			const normalized = normalizePath(joined);
			return joined.startsWith("/") ? normalized : normalized.slice(1) || ".";
		},
		resolve: (...parts) => normalizePath(parts.join("/")),
		dirname: (p) => p.replace(/\/[^/]*$/, "") || "/",
		basename: (p, ext) => {
			const b = p.replace(/\/$/, "").split("/").pop();
			return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b;
		},
		extname: (p) => {
			const m = /\.[^./]*$/.exec(p.split("/").pop());
			return m ? m[0] : "";
		},
		isAbsolute: (p) => p.startsWith("/"),
		relative: (from, to) => to.replace(`${from.replace(/\/$/, "")}/`, ""),
	};
	pathModule.posix = pathModule;
	const processShim = { env: {}, platform: "linux", arch: "web", version: "v20", versions: {}, cwd: () => "/", nextTick: (fn, ...a) => queueMicrotask(() => fn(...a)), argv: [], hrtime: Object.assign(() => [0, 0], { bigint: () => 0n }) };

	function requireShim(name) {
		if (name === "vscode") return vscode;
		if (name === "path" || name === "path-browserify" || name === "node:path") return pathModule;
		if (name === "util" || name === "node:util") return { TextEncoder, TextDecoder, inspect: (x) => JSON.stringify(jsonSafe(x)), promisify: (fn) => (...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v)))) };
		if (name === "process") return processShim;
		throw new Error(`Module "${name}" is not available to extensions in Developer Studio`);
	}

	// -- page -> runtime ---------------------------------------------------------------------------------------------
	let extensionModule = null;
	let context = null;
	const handlers = {
		async init(params) {
			extensionInfo = params.extension;
			settings = params.settings || {};
			languageConfigs = params.languages || {};
			const languagesUri = Uri.file(`${EXT_ROOT}/${LANGUAGES_ID}`);
			languagesExtension = {
				id: LANGUAGES_ID,
				extensionUri: languagesUri,
				extensionPath: languagesUri.path,
				isActive: true,
				exports: undefined,
				extensionKind: ExtensionKind.Workspace,
				packageJSON: {
					name: "languages",
					publisher: "studio",
					contributes: { languages: Object.keys(languageConfigs).map((id) => ({ id, configuration: `./languages/${id}.json` })) },
				},
				activate: async () => undefined,
			};
			workspaceInfo = params.workspace || workspaceInfo;
			windowApi.activeColorTheme = { kind: params.theme === "light" ? ColorThemeKind.Light : ColorThemeKind.Dark };
			for (const d of params.documents || []) documents.set(d.uri, new TextDocument(d));
			setActive(params.activeEditor);

			const module = { exports: {} };
			const factory = new Function("module", "exports", "require", "process", "__filename", "__dirname", "global", params.code);
			factory(module, module.exports, requireShim, processShim, `/${params.entry}`, "/", self);
			extensionModule = module.exports;

			const memento = (scope) => {
				const data = Object.assign({}, (params.mementos || {})[scope]);
				return {
					get: (k, d) => (k in data ? data[k] : d),
					keys: () => Object.keys(data),
					update: async (k, v) => {
						if (v === undefined) delete data[k]; else data[k] = jsonSafe(v);
						notify("memento", { scope, data });
					},
					setKeysForSync() {},
				};
			};
			const secrets = new Map();
			const base = extUri();
			context = {
				subscriptions: [],
				workspaceState: memento("workspace"),
				globalState: memento("global"),
				secrets: { get: async (k) => secrets.get(k), store: async (k, v) => secrets.set(k, v), delete: async (k) => secrets.delete(k), onDidChange: neverEvent },
				extensionUri: base,
				extensionPath: base.path,
				asAbsolutePath: (rel) => Uri.joinPath(base, rel).path,
				storageUri: Uri.parse(`studio-storage://${extensionInfo.id}/workspace`),
				globalStorageUri: Uri.parse(`studio-storage://${extensionInfo.id}/global`),
				logUri: Uri.parse(`studio-log://${extensionInfo.id}/`),
				storagePath: undefined,
				globalStoragePath: `/storage/${extensionInfo.id}`,
				logPath: `/log/${extensionInfo.id}`,
				extensionMode: ExtensionMode.Production,
				environmentVariableCollection: { persistent: false, replace() {}, append() {}, prepend() {}, get() {}, forEach() {}, delete() {}, clear() {}, getScoped() { return this; } },
				extension: null,
			};
			selfExtension = { id: extensionInfo.id, extensionUri: base, extensionPath: base.path, packageJSON: extensionInfo.packageJSON || {}, extensionKind: ExtensionKind.Workspace, isActive: false, exports: undefined, activate: async () => selfExtension.exports };
			context.extension = selfExtension;
			return true;
		},
		async activate() {
			if (!extensionModule || typeof extensionModule.activate !== "function") return { activated: false };
			selfExtension.exports = await extensionModule.activate(context);
			selfExtension.isActive = true;
			return { activated: true };
		},
		async deactivate() {
			try {
				if (extensionModule && typeof extensionModule.deactivate === "function") await extensionModule.deactivate();
			} finally {
				for (const d of context ? context.subscriptions : []) {
					try {
						d && d.dispose && d.dispose();
					} catch (e) {
						// ignore
					}
				}
			}
			return true;
		},
		async provide({ handle, uri, args }) {
			const entry = providers.get(handle);
			const doc = documents.get(uri);
			if (!entry || !doc) return null;
			const source = new CancellationTokenSource();
			return PROVIDER_CALLS[entry.kind](entry.provider, doc, args || {}, source.token);
		},
		async executeCommand({ id, ref }) {
			if (ref) {
				const target = commandRefs.get(ref);
				if (!target) return null;
				return jsonSafe(await commandsApi.executeCommand(target.command, ...target.args));
			}
			return jsonSafe(await commandsApi.executeCommand(id));
		},
	};

	function setActive(info) {
		if (!info) {
			activeEditor = undefined;
			return;
		}
		const doc = documents.get(info.uri);
		activeEditor = doc ? new TextEditor(doc, (info.selections || [[0, 0, 0, 0]]).map(selectionFromJson)) : undefined;
		if (activeEditor && info.options) Object.assign(activeEditor.options, info.options);
	}

	const events = {
		docOpen(d) {
			const doc = new TextDocument(d);
			documents.set(d.uri, doc);
			onDidOpen.fire(doc);
		},
		docChange(d) {
			const doc = documents.get(d.uri);
			if (!doc) return;
			const old = doc._text;
			doc._update(d);
			doc.isDirty = !!d.dirty;
			onDidChange.fire({ document: doc, contentChanges: [{ range: new Range(0, 0, Math.max(0, old.split("\n").length - 1), 0), rangeOffset: 0, rangeLength: old.length, text: d.text }], reason: undefined });
		},
		docClose(d) {
			const doc = documents.get(d.uri);
			if (!doc) return;
			documents.delete(d.uri);
			doc.isClosed = true;
			onDidClose.fire(doc);
		},
		docSave(d) {
			const doc = documents.get(d.uri);
			if (doc) {
				doc.isDirty = false;
				onDidSave.fire(doc);
			}
		},
		activeEditor(info) {
			setActive(info);
			onDidChangeActiveEditor.fire(activeEditor);
			onDidChangeVisible.fire(windowApi.visibleTextEditors);
		},
		selection(info) {
			if (!activeEditor || activeEditor.document.uri.toString() !== info.uri) return;
			activeEditor._selections = info.selections.map(selectionFromJson);
			onDidChangeSelection.fire({ textEditor: activeEditor, selections: activeEditor._selections, kind: undefined });
		},
		configuration(data) {
			const before = settings;
			settings = data.settings || {};
			const changed = new Set([...Object.keys(before), ...Object.keys(settings)].filter((k) => JSON.stringify(before[k]) !== JSON.stringify(settings[k])));
			onDidChangeConfiguration.fire({ affectsConfiguration: (s) => [...changed].some((k) => k === s || k.startsWith(`${s}.`)) });
		},
		theme(data) {
			windowApi.activeColorTheme = { kind: data.kind === "light" ? ColorThemeKind.Light : ColorThemeKind.Dark };
			themeEmitter.fire(windowApi.activeColorTheme);
		},
	};

	self.onmessage = async (event) => {
		const msg = event.data || {};
		if (msg.type === "response") {
			const p = pending.get(msg.id);
			if (!p) return;
			pending.delete(msg.id);
			msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
		} else if (msg.type === "event") {
			try {
				events[msg.name] && events[msg.name](msg.data);
			} catch (e) {
				log("error", e && e.stack ? e.stack : e);
			}
		} else if (msg.type === "call") {
			try {
				const fn = handlers[msg.method];
				if (!fn) throw new Error(`unknown call ${msg.method}`);
				const result = await fn(msg.params || {});
				send({ type: "response", id: msg.id, result });
			} catch (e) {
				log("error", e && e.stack ? e.stack : e);
				send({ type: "response", id: msg.id, error: String((e && e.message) || e) });
			}
		}
	};
	self.addEventListener("unhandledrejection", (e) => log("error", `unhandled: ${e.reason && e.reason.stack ? e.reason.stack : e.reason}`));
	self.addEventListener("error", (e) => log("error", e.message));

	// exposed for unit tests only (tests/js load this file in a fake worker scope)
	self.__studioVscode = vscode;
	self.__studioImpl = { commands: commandsApi, window: windowApi, workspace: workspaceApi, languages: languagesApi, env: envApi, extensions: extensionsApi, l10n: l10nApi };
	self.__studioPath = pathModule;
	self.__studioHandlers = handlers;
	self.__studioEvents = events;
	send({ type: "ready" });
})();
