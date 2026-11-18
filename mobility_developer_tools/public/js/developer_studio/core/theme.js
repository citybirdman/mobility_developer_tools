const QUERY = "(prefers-color-scheme: dark)";

/**
 * Follows the Frappe desk theme, live.
 *
 * Frappe writes the effective theme on <html data-theme="light|dark"> (its
 * "Automatic" mode resolves to the operating system setting there too). When the
 * attribute is missing, the operating system setting (prefers-color-scheme) is used.
 * Emits "theme:changed" on the bus; ColorThemeService turns it into the studio's look.
 */
export class ThemeService {
	constructor(root, bus) {
		this.root = root;
		this.bus = bus;
		this.media = window.matchMedia ? window.matchMedia(QUERY) : null;
		this.mode = this.resolve();

		const update = () => {
			const mode = this.resolve();
			if (mode === this.mode) return;
			this.mode = mode;
			this.bus.emit("theme:changed", mode);
		};
		new MutationObserver(update).observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme", "data-theme-mode"],
		});
		this.media?.addEventListener?.("change", update);
	}

	resolve() {
		const frappeTheme = document.documentElement.getAttribute("data-theme");
		if (frappeTheme === "dark" || frappeTheme === "light") return frappeTheme;
		return this.media && !this.media.matches ? "light" : "dark";
	}
}
