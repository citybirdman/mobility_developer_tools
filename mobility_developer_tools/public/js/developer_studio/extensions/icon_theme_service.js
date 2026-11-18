import { iconColorForPath } from "../core/languages";
import { fontCharacter, resolveIcon } from "./icon_resolver";

const MIME = { svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };

/**
 * File icons for the explorer, tabs and quick open: built-in codicons, or an icon
 * theme from an installed extension. Image icons are fetched lazily in batches and
 * shown as CSS background images (blob: URLs), so SVG scripts never run.
 */
export class IconThemeService {
	constructor({ bus, api }) {
		this.bus = bus;
		this.api = api;
		this.themes = new Map(); // key -> {ext, id, label, resource}
		this.selected = "";
		this.theme = null; // normalized theme data
		this.ext = null;
		this.urls = new Map(); // path -> object URL
		this.queue = new Set();
		this.mode = "dark";
		bus.on("appearance:changed", ({ mode }) => {
			if (mode !== this.mode) {
				this.mode = mode;
				if (this.theme?.light) bus.emit("icons:changed");
			}
		});
	}

	register(ext, theme) {
		this.themes.set(`${ext}/${theme.id}`, { ext, ...theme });
	}

	clearExtension(ext) {
		for (const key of [...this.themes.keys()]) if (key.startsWith(`${ext}/`)) this.themes.delete(key);
		if (this.selected.startsWith(`${ext}/`)) this.select("", { persist: false });
	}

	list() {
		return [...this.themes.entries()].map(([key, t]) => ({ key, label: t.label, ext: t.ext }));
	}

	async select(key, { persist = true } = {}) {
		if (key && !this.themes.has(key)) key = "";
		this.theme = null;
		this.ext = null;
		for (const url of this.urls.values()) URL.revokeObjectURL(url);
		this.urls.clear();
		if (key) {
			const meta = this.themes.get(key);
			try {
				const files = await this.api.call("ext_files", { ext_id: meta.ext, paths: [meta.resource] });
				this.theme = JSON.parse(files[meta.resource] || "null");
				this.ext = meta.ext;
				await this.loadFonts();
			} catch (e) {
				console.error(e);
				this.theme = null;
				key = "";
			}
		}
		this.selected = key;
		if (persist) this.api.call("ext_set_preference", { key: "icon_theme", value: key }).catch(() => {});
		this.bus.emit("icons:changed");
	}

	async loadFonts() {
		for (const font of this.theme?.fonts || []) {
			const src = font.src[0];
			const files = await this.api.call("ext_files", { ext_id: this.ext, paths: [src.path], encoding: "base64" });
			if (!files[src.path]) continue;
			const bytes = Uint8Array.from(atob(files[src.path]), (c) => c.charCodeAt(0));
			const face = new FontFace(this.fontFamily(font.id), bytes.buffer);
			await face.load();
			document.fonts.add(face);
		}
	}

	fontFamily(id) {
		return `mdt-icons-${String(this.ext).replace(/\W+/g, "-")}-${String(id || "default").replace(/\W+/g, "-")}`;
	}

	get hidesArrows() {
		return !!this.theme?.hidesExplorerArrows;
	}

	/**
	 * Render the icon for an explorer/tab entry into `el`.
	 * entry: {name, path, type: "file"|"folder", expanded, isRoot, languageId}
	 */
	render(el, entry) {
		el.className = `mdt-file-icon ${el.dataset.base || ""}`;
		el.textContent = "";
		el.style.cssText = "";
		delete el.dataset.iconPath;
		const def = this.theme ? resolveIcon(this.theme, { ...entry, light: this.mode === "light" }) : null;

		if (!def) {
			// built-in codicons
			const folder = entry.type === "folder";
			el.classList.add("codicon", folder ? (entry.expanded ? "codicon-folder-opened" : "codicon-folder") : "codicon-file");
			if (!folder) el.style.color = iconColorForPath(entry.path || entry.name);
			return;
		}
		if (def.path) {
			el.classList.add("mdt-file-icon-img");
			el.dataset.iconPath = def.path;
			if (this.urls.has(def.path)) el.style.backgroundImage = `url("${this.urls.get(def.path)}")`;
			else this.request(def.path);
			return;
		}
		if (def.char) {
			el.classList.add("mdt-file-icon-font");
			const font = (this.theme.fonts || []).find((f) => f.id === def.font) || (this.theme.fonts || [])[0];
			el.style.fontFamily = `"${this.fontFamily(font?.id)}"`;
			if (def.color) el.style.color = def.color;
			if (def.size || font?.size) el.style.fontSize = def.size || font.size;
			el.textContent = fontCharacter(def.char);
		}
	}

	request(path) {
		this.queue.add(path);
		clearTimeout(this.timer);
		this.timer = setTimeout(() => this.flush(), 20);
	}

	async flush() {
		const ext = this.ext;
		const paths = [...this.queue].slice(0, 150);
		paths.forEach((p) => this.queue.delete(p));
		if (!paths.length || !ext) return;
		let files = {};
		try {
			files = await this.api.call("ext_files", { ext_id: ext, paths, encoding: "base64" });
		} catch (e) {
			return;
		}
		if (ext !== this.ext) return; // theme changed meanwhile
		for (const path of paths) {
			if (!files[path] || this.urls.has(path)) continue;
			const type = MIME[path.split(".").pop().toLowerCase()];
			if (!type) continue;
			const bytes = Uint8Array.from(atob(files[path]), (c) => c.charCodeAt(0));
			this.urls.set(path, URL.createObjectURL(new Blob([bytes], { type })));
		}
		for (const el of document.querySelectorAll(".mdt-file-icon-img[data-icon-path]")) {
			const url = this.urls.get(el.dataset.iconPath);
			if (url) el.style.backgroundImage = `url("${url}")`;
		}
		if (this.queue.size) this.flush();
	}
}
