import { decorationCss } from "./decoration_styles";

/** `createTextEditorDecorationType` / `setDecorations` for all extensions (sanitized CSS). */
export class DecorationManager {
	constructor({ themeColor, mode }) {
		this.themeColor = themeColor;
		this.mode = mode;
		this.types = new Map(); // "<host>:<key>" -> {className, beforeClass, afterClass, css, before, after}
		this.applied = new Map(); // "<host>:<key>:<model id>" -> {model, ids}
		this.style = document.createElement("style");
		document.head.appendChild(this.style);
		this.counter = 0;
	}

	setMode(mode) {
		this.mode = mode;
		this.render();
	}

	define(hostId, key, options) {
		const id = `${hostId}:${key}`;
		const n = ++this.counter;
		this.types.set(id, {
			className: `mdt-deco-${n}`,
			beforeClass: `mdt-deco-${n}-before`,
			afterClass: `mdt-deco-${n}-after`,
			css: decorationCss(options || {}, this.themeColor),
		});
		this.render();
	}

	remove(hostId, key) {
		const id = `${hostId}:${key}`;
		for (const [k, entry] of this.applied) {
			if (k.startsWith(`${id}:`)) {
				if (!entry.model.isDisposed()) entry.model.deltaDecorations(entry.ids, []);
				this.applied.delete(k);
			}
		}
		this.types.delete(id);
		this.render();
	}

	removeHost(hostId) {
		for (const id of [...this.types.keys()]) if (id.startsWith(`${hostId}:`)) this.remove(hostId, id.slice(hostId.length + 1));
	}

	set(hostId, key, model, items) {
		const type = this.types.get(`${hostId}:${key}`);
		if (!type || !model) return;
		const css = this.variant(type.css);
		const decorations = (items || []).slice(0, 5000).map((item) => ({
			range: new monaco.Range(item.range[0] + 1, item.range[1] + 1, item.range[2] + 1, item.range[3] + 1),
			options: {
				inlineClassName: css.inline ? type.className : undefined,
				className: css.isWholeLine && css.inline ? type.className : undefined,
				isWholeLine: css.isWholeLine,
				before: css.before?.text ? { content: css.before.text, inlineClassName: type.beforeClass } : undefined,
				after: css.after?.text ? { content: css.after.text, inlineClassName: type.afterClass } : undefined,
				overviewRuler: css.overviewRulerColor ? { color: css.overviewRulerColor, position: monaco.editor.OverviewRulerLane.Right } : undefined,
				hoverMessage: (item.hover || []).map((m) => ({ value: m.md !== undefined ? m.md : m.text || "", isTrusted: false, supportHtml: false })),
			},
		}));
		const appliedKey = `${hostId}:${key}:${model.id}`;
		const previous = this.applied.get(appliedKey);
		const ids = model.deltaDecorations(previous ? previous.ids : [], decorations);
		this.applied.set(appliedKey, { model, ids });
	}

	variant(css) {
		const override = this.mode === "light" ? css.light : css.dark;
		if (!override) return css;
		return { ...css, inline: [css.inline, override.inline].filter(Boolean).join("; ") };
	}

	render() {
		const rules = [];
		for (const type of this.types.values()) {
			const css = this.variant(type.css);
			if (css.inline) rules.push(`.monaco-editor .${type.className} { ${css.inline} }`);
			if (css.before?.css) rules.push(`.monaco-editor .${type.beforeClass} { ${css.before.css} }`);
			if (css.after?.css) rules.push(`.monaco-editor .${type.afterClass} { ${css.after.css} }`);
		}
		this.style.textContent = rules.join("\n");
	}
}
