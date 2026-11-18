import { LIB_BASE } from "../core/asset_loader";

/**
 * VS Code's own syntax engine (vscode-textmate + Oniguruma WASM) for grammars
 * contributed by extensions. Loaded lazily the first time such a language is used.
 * Tokens carry the most specific TextMate scope (e.g. "keyword.control.python"),
 * which Monaco themes match by dotted prefix.
 */
export class TextMateEngine {
	constructor({ readFile }) {
		this.readFile = readFile; // (grammar) -> Promise<string>
		this.grammars = new Map(); // scopeName -> grammar entry {scopeName, path, ext, injectTo, embeddedLanguages}
		this.injections = new Map(); // target scope -> [scopeName]
		this.registry = null;
		this.loading = null;
	}

	addGrammar(grammar) {
		this.grammars.set(grammar.scopeName, grammar);
		for (const target of grammar.injectTo || []) {
			if (!this.injections.has(target)) this.injections.set(target, []);
			this.injections.get(target).push(grammar.scopeName);
		}
	}

	/** Use the grammar for `languageId` in Monaco (lazy: nothing loads until a file opens). */
	bindLanguage(languageId, scopeName) {
		return monaco.languages.registerTokensProviderFactory(languageId, { create: () => this.tokensProvider(scopeName) });
	}

	removeExtension(ext) {
		for (const [scope, grammar] of [...this.grammars]) if (grammar.ext === ext) this.grammars.delete(scope);
		for (const [target, scopes] of this.injections) this.injections.set(target, scopes.filter((s) => this.grammars.has(s)));
		this.registry = null; // grammars are cached by the registry: rebuild on next use
		this.loading = null;
	}

	async tokensProvider(scopeName) {
		const registry = await this.ensureRegistry();
		const grammar = await registry.loadGrammar(scopeName);
		if (!grammar) return null;
		const INITIAL = window.vscodetextmate.INITIAL;
		return {
			getInitialState: () => new TextMateState(INITIAL),
			tokenize(line, state) {
				const result = grammar.tokenizeLine(line, state.ruleStack, 500);
				return {
					endState: new TextMateState(result.ruleStack),
					tokens: result.tokens.map((t) => ({ startIndex: t.startIndex, scopes: t.scopes[t.scopes.length - 1] })),
				};
			},
		};
	}

	ensureRegistry() {
		if (this.registry) return Promise.resolve(this.registry);
		if (!this.loading) {
			this.loading = (async () => {
				await loadOniguruma();
				const onigLib = Promise.resolve({
					createOnigScanner: (patterns) => new window.onig.OnigScanner(patterns),
					createOnigString: (s) => new window.onig.OnigString(s),
				});
				this.registry = new window.vscodetextmate.Registry({
					onigLib,
					loadGrammar: async (scopeName) => {
						const entry = this.grammars.get(scopeName);
						if (!entry) return null;
						const content = await this.readFile(entry);
						return content ? window.vscodetextmate.parseRawGrammar(content, entry.path) : null;
					},
					getInjections: (scopeName) => this.injections.get(scopeName) || [],
				});
				return this.registry;
			})();
			this.loading.catch(() => (this.loading = null));
		}
		return this.loading;
	}
}

class TextMateState {
	constructor(ruleStack) {
		this.ruleStack = ruleStack;
	}
	clone() {
		return new TextMateState(this.ruleStack);
	}
	equals(other) {
		return other instanceof TextMateState && (other.ruleStack === this.ruleStack || other.ruleStack.equals(this.ruleStack));
	}
}

let onigReady = null;
/** Scripts + WASM are loaded once per page; registries can be rebuilt any time. */
function loadOniguruma() {
	if (!onigReady) {
		onigReady = (async () => {
			await loadScript(`${LIB_BASE}/textmate/vscode-oniguruma.js`);
			await loadScript(`${LIB_BASE}/textmate/vscode-textmate.js`);
			const wasm = await (await fetch(`${LIB_BASE}/textmate/onig.wasm`)).arrayBuffer();
			await window.onig.loadWASM(wasm);
		})();
		onigReady.catch(() => (onigReady = null));
	}
	return onigReady;
}

const loaded = new Map();
function loadScript(src) {
	if (!loaded.has(src)) {
		loaded.set(
			src,
			new Promise((resolve, reject) => {
				const script = document.createElement("script");
				script.src = src;
				script.onload = resolve;
				script.onerror = () => reject(new Error(`Failed to load ${src}`));
				document.head.appendChild(script);
			})
		);
	}
	return loaded.get(src);
}
