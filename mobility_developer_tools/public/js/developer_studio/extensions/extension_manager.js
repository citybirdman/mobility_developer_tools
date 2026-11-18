import { notifyError } from "../core/api_client";
import { languageConfigurations } from "./builtin_languages";
import { DEFAULT_HANDLERS } from "./contributions";
import { ExtensionHost } from "./extension_host";

/**
 * Loads the site's enabled extensions into the studio:
 *   - declarative parts (languages, grammars, snippets, themes, icons) via handlers
 *   - code (web builds) in sandboxed ExtensionHosts
 * Open for extension: pass more handler classes to support more contribution points.
 */
export class ExtensionManager {
	constructor({ api, bus, hostServices, handlerContext, handlers = DEFAULT_HANDLERS }) {
		this.api = api;
		this.bus = bus;
		this.loaded = [];
		this.hostServices = { ...hostServices, languageConfigs: () => languageConfigurations(this.loaded) };
		this.handlerContext = handlerContext;
		this.handlers = handlers.map((H) => new H());
		this.applied = new Map(); // ext id -> disposables
		this.hosts = new Map(); // ext id -> ExtensionHost
	}

	async load() {
		let data;
		try {
			data = await this.api.call("ext_runtime");
		} catch (e) {
			return notifyError(e);
		}
		this.loaded = data.extensions;
		for (const ext of data.extensions) {
			this.applyDeclarative(ext);
			if (ext.browser) this.startHost(ext);
		}
		const { colorThemes, iconThemes } = this.handlerContext;
		await Promise.all([colorThemes.select(data.preferences.color_theme, { persist: false }), iconThemes.select(data.preferences.icon_theme, { persist: false })]);
		this.bus.emit("extensions:changed");
	}

	applyDeclarative(ext) {
		const disposables = [];
		for (const handler of this.handlers) {
			const value = ext.contributes?.[handler.point];
			if (!value || (Array.isArray(value) && !value.length)) continue;
			try {
				disposables.push(...(handler.apply(ext, value, this.handlerContext) || []));
			} catch (e) {
				console.error(`[extension ${ext.id}] ${handler.point}`, e);
			}
		}
		this.applied.set(ext.id, disposables);
	}

	startHost(ext) {
		const host = new ExtensionHost(ext, this.hostServices);
		this.hosts.set(ext.id, host);
		host.start().then(() => this.bus.emit("extensions:changed"));
	}

	unload(id) {
		this.hosts.get(id)?.stop();
		this.hosts.delete(id);
		for (const d of this.applied.get(id) || []) d?.dispose?.();
		this.applied.delete(id);
		this.handlerContext.textmate.removeExtension?.(id);
	}

	/** After install / uninstall / enable / disable: unload everything and load again. */
	async reload() {
		for (const id of [...new Set([...this.applied.keys(), ...this.hosts.keys()])]) this.unload(id);
		await this.load();
	}

	/** Contributed commands of running extensions, for the studio command palette. */
	paletteCommands() {
		const commands = [];
		for (const host of this.hosts.values()) {
			if (!["running", "active"].includes(host.state)) continue;
			for (const c of host.manifest.contributes?.commands || []) {
				commands.push({ id: `ext.${c.command}`, label: c.category ? `${c.category}: ${c.title}` : c.title, run: () => host.executeCommand(c.command) });
			}
		}
		return commands;
	}

	runtimeState(id) {
		const host = this.hosts.get(id);
		return host ? { state: host.state, error: host.error } : null;
	}

	applySettings(id, overrides) {
		this.hosts.get(id)?.applySettings(overrides);
	}
}
