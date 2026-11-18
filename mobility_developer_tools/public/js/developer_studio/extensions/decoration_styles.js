/**
 * Turns `window.createTextEditorDecorationType` options into CSS (pure, unit-tested).
 * Extension-supplied values are untrusted: only whitelisted properties with
 * strictly validated values are emitted, so no `url()`, no `;`/`{}` breakouts.
 */
const COLOR = /^(#[0-9a-fA-F]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}\s*(,\s*(0|1|0?\.\d+)\s*)?\)|[a-zA-Z]{3,20})$/;
const LENGTH = /^(0|\d{1,3}(\.\d+)?(px|em|rem|%))(\s+(0|\d{1,3}(\.\d+)?(px|em|rem|%))){0,3}$/;
const KEYWORDS = {
	fontStyle: /^(normal|italic|oblique)$/,
	fontWeight: /^(normal|bold|bolder|lighter|[1-9]00)$/,
	textDecoration: /^(none|underline|overline|line-through)( (solid|double|dotted|dashed|wavy))?( (#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}))?$/,
	borderStyle: /^(none|solid|dashed|dotted|double)$/,
	cursor: /^(default|pointer|text|help)$/,
	opacity: /^(0|1|0?\.\d+)$/,
};
const PROPS = {
	color: ["color", COLOR],
	backgroundColor: ["background-color", COLOR],
	outlineColor: ["outline-color", COLOR],
	borderColor: ["border-color", COLOR],
	borderWidth: ["border-width", LENGTH],
	borderRadius: ["border-radius", LENGTH],
	borderStyle: ["border-style", KEYWORDS.borderStyle],
	fontStyle: ["font-style", KEYWORDS.fontStyle],
	fontWeight: ["font-weight", KEYWORDS.fontWeight],
	textDecoration: ["text-decoration", KEYWORDS.textDecoration],
	cursor: ["cursor", KEYWORDS.cursor],
	opacity: ["opacity", KEYWORDS.opacity],
	margin: ["margin", LENGTH],
};

/** themeColor(id) resolves vscode.ThemeColor references (returns a hex or undefined). */
export function decorationCss(options, themeColor = () => undefined) {
	const declarations = (source) => {
		const out = [];
		for (const [key, [cssName, pattern]] of Object.entries(PROPS)) {
			let value = source?.[key];
			if (value && typeof value === "object" && value.id) value = themeColor(value.id);
			if (typeof value === "string" && pattern.test(value.trim())) out.push(`${cssName}: ${value.trim()} !important`);
		}
		if (typeof source?.border === "string" && /^(\d{1,2}px)\s+(solid|dashed|dotted)\s+(#[0-9a-fA-F]{3,8})$/.test(source.border.trim())) {
			out.push(`border: ${source.border.trim()} !important`);
		}
		return out.join("; ");
	};
	const attachment = (a) => {
		if (!a || typeof a !== "object") return null;
		const text = typeof a.contentText === "string" ? a.contentText.slice(0, 200) : "";
		return { text, css: declarations(a) };
	};
	return {
		inline: declarations(options),
		isWholeLine: !!options?.isWholeLine,
		before: attachment(options?.before),
		after: attachment(options?.after),
		overviewRulerColor: typeof options?.overviewRulerColor === "string" && COLOR.test(options.overviewRulerColor) ? options.overviewRulerColor : undefined,
		light: options?.light ? decorationCss({ ...options.light, light: null, dark: null }, themeColor) : null,
		dark: options?.dark ? decorationCss({ ...options.dark, light: null, dark: null }, themeColor) : null,
	};
}
