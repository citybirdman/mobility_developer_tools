import { notifyError } from "../core/api_client";

const VERDICTS = {
	works: { label: __("Works"), cls: "ok" },
	partial: { label: __("Partly works"), cls: "partial" },
	unsupported: { label: __("Not supported"), cls: "bad" },
};

/**
 * Side bar view: find extensions on Open VSX, check them before installing,
 * install from Open VSX or a .vsix file, manage installed ones, pick themes.
 */
export class ExtensionsView {
	constructor(host, { api, bus, manager, colorThemes, iconThemes, output }) {
		Object.assign(this, { api, bus, manager, colorThemes, iconThemes, output });
		this.installed = [];

		this.el = document.createElement("div");
		this.el.className = "mdt-ext-view";
		this.el.innerHTML = `
			<div class="mdt-sidebar-title">
				<span>${__("Extensions")}</span>
				<span class="mdt-ext-title-actions">
					<span class="codicon codicon-cloud-upload" data-action="upload" title="${__("Install from .vsix file")}"></span>
					<span class="codicon codicon-refresh" data-action="refresh" title="${__("Refresh")}"></span>
				</span>
			</div>
			<div class="mdt-ext-search"><input class="mdt-input" placeholder="${__("Search Open VSX (e.g. dracula, material icons, jinja)")}"></div>
			<div class="mdt-ext-scroll">
				<div class="mdt-ext-results"></div>
				<div class="mdt-ai-group">${__("Appearance")}</div>
				<label class="mdt-ext-select">${__("Color Theme")}<select data-pref="color"></select></label>
				<label class="mdt-ext-select">${__("File Icons")}<select data-pref="icons"></select></label>
				<div class="mdt-ai-group">${__("Installed")}</div>
				<div class="mdt-ext-installed"><div class="mdt-ai-empty">${__("Loading...")}</div></div>
			</div>
			<input type="file" accept=".vsix" hidden>`;
		host.appendChild(this.el);

		this.results = this.el.querySelector(".mdt-ext-results");
		this.installedEl = this.el.querySelector(".mdt-ext-installed");
		this.search = this.el.querySelector(".mdt-ext-search input");
		this.fileInput = this.el.querySelector("input[type=file]");
		this.search.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") this.runSearch();
		});
		this.el.querySelector(".mdt-ext-title-actions").addEventListener("click", (e) => {
			if (e.target.dataset.action === "refresh") this.load();
			if (e.target.dataset.action === "upload") this.fileInput.click();
		});
		this.fileInput.addEventListener("change", () => this.upload());
		this.el.querySelector('[data-pref="color"]').addEventListener("change", (e) => this.colorThemes.select(e.target.value));
		this.el.querySelector('[data-pref="icons"]').addEventListener("change", (e) => this.iconThemes.select(e.target.value));
		bus.on("extensions:changed", () => this.renderInstalled());
		bus.on("icons:changed", () => this.renderPickers());
		bus.on("appearance:changed", () => this.renderPickers());
	}

	async load() {
		try {
			this.installed = await this.api.call("ext_installed");
		} catch (e) {
			return notifyError(e);
		}
		this.renderInstalled();
		this.renderPickers();
	}

	// -- search / check / install ---------------------------------------------------------------

	async runSearch() {
		const query = this.search.value.trim();
		if (!query) return (this.results.innerHTML = "");
		this.results.innerHTML = `<div class="mdt-ai-empty">${__("Searching...")}</div>`;
		try {
			const items = await this.api.call("ext_search", { query });
			this.renderResults(items);
		} catch (e) {
			this.results.innerHTML = "";
			notifyError(e);
		}
	}

	renderResults(items) {
		this.results.innerHTML = items.length ? "" : `<div class="mdt-ai-empty">${__("No extensions found")}</div>`;
		for (const item of items.slice(0, 30)) {
			const card = this.card({
				icon: item.icon,
				title: item.display_name,
				subtitle: `${item.namespace} · v${item.version} · ${formatCount(item.downloads)} ${__("downloads")}`,
				description: item.description,
			});
			const actions = card.querySelector(".mdt-ext-actions");
			actions.append(
				button(__("Check"), "checklist", "", () => this.check(item)),
				button(item.installed_version ? __("Reinstall") : __("Install"), "cloud-download", "primary", () => this.install(item))
			);
			if (item.installed_version) card.querySelector(".mdt-ext-sub").append(` · ${__("installed")} v${item.installed_version}`);
			this.results.appendChild(card);
		}
	}

	async check(item) {
		const dialog = this.reportDialog(__("Checking {0}...", [item.display_name]));
		try {
			const report = await this.api.call("ext_check", { namespace: item.namespace, name: item.name });
			this.fillReport(dialog, report, report.verdict !== "unsupported" ? () => this.install(item) : null);
		} catch (e) {
			dialog.hide();
			notifyError(e);
		}
	}

	async install(item) {
		frappe.show_alert({ message: __("Installing {0}...", [frappe.utils.escape_html(item.display_name)]), indicator: "blue" });
		try {
			const report = await this.api.call("ext_install", { namespace: item.namespace, name: item.name });
			await this.afterChange();
			this.offerThemes(report.id);
			frappe.show_alert({ message: __("{0} installed: {1}", [frappe.utils.escape_html(report.display_name), VERDICTS[report.verdict].label]), indicator: "green" });
			this.runSearch();
		} catch (e) {
			notifyError(e);
		}
	}

	async upload() {
		const file = this.fileInput.files[0];
		this.fileInput.value = "";
		if (!file) return;
		if (file.size > 18 * 1024 * 1024) return frappe.msgprint(__("This file is too large to upload (max 18 MB). Install it from Open VSX instead."));
		const data = await readAsBase64(file);
		const dialog = this.reportDialog(__("Checking {0}...", [file.name]));
		try {
			const report = await this.api.call("ext_check_upload", { data });
			this.fillReport(dialog, report, report.verdict !== "unsupported" ? async () => {
				try {
					await this.api.call("ext_install_upload", { data });
					await this.afterChange();
					this.offerThemes(report.id);
					frappe.show_alert({ message: __("{0} installed", [frappe.utils.escape_html(report.display_name)]), indicator: "green" });
				} catch (e) {
					notifyError(e);
				}
			} : null);
		} catch (e) {
			dialog.hide();
			notifyError(e);
		}
	}

	/** Like VS Code: installing a theme does not switch to it, so offer to use it right away. */
	offerThemes(extId) {
		const kinds = [
			{ list: this.colorThemes.list(), service: this.colorThemes, title: __("Use a color theme from this extension?") },
			{ list: this.iconThemes.list(), service: this.iconThemes, title: __("Use a file icon theme from this extension?") },
		];
		for (const { list, service, title } of kinds) {
			const themes = list.filter((t) => t.ext === extId);
			if (!themes.length) continue;
			const dialog = new frappe.ui.Dialog({
				title,
				fields: [{ fieldtype: "Select", fieldname: "theme", label: __("Theme"), options: themes.map((t) => t.label).join("\n"), default: themes[0].label }],
				primary_action_label: __("Use Theme"),
				primary_action: ({ theme }) => {
					dialog.hide();
					service.select(themes.find((t) => t.label === theme).key);
				},
				secondary_action_label: __("Not Now"),
				secondary_action: () => dialog.hide(),
			});
			dialog.show();
		}
	}

	async afterChange() {
		await this.manager.reload();
		await this.load();
	}

	// -- installed --------------------------------------------------------------------------------------

	renderInstalled() {
		this.installedEl.innerHTML = this.installed.length ? "" : `<div class="mdt-ai-empty">${__("No extensions installed yet. Search above, or install a .vsix file.")}</div>`;
		for (const ext of this.installed) {
			const runtime = this.manager.runtimeState(ext.id);
			const verdict = VERDICTS[ext.verdict] || VERDICTS.partial;
			const card = this.card({
				title: ext.display_name,
				subtitle: `${ext.publisher} · v${ext.version}`,
				description: ext.description,
				badge: verdict,
				state: !ext.enabled ? __("Disabled") : runtime ? runtimeLabel(runtime) : ext.level === 1 ? __("Level 1 · no code") : "",
			});
			card.classList.toggle("disabled", !ext.enabled);
			const actions = card.querySelector(".mdt-ext-actions");
			actions.append(
				button(ext.enabled ? __("Disable") : __("Enable"), ext.enabled ? "circle-slash" : "pass", "", () => this.setEnabled(ext, !ext.enabled)),
				button(__("Report"), "checklist", "", () => this.fillReport(this.reportDialog(ext.display_name), { ...ext.report, display_name: ext.display_name, version: ext.version }, null))
			);
			if (ext.has_settings) actions.append(button(__("Settings"), "settings-gear", "", () => this.editSettings(ext)));
			if (ext.has_code) actions.append(button(__("Output"), "output", "", () => this.output.show(ext.id)));
			actions.append(button(__("Uninstall"), "trash", "danger", () => this.uninstall(ext)));
			this.installedEl.appendChild(card);
		}
	}

	async setEnabled(ext, enabled) {
		try {
			await this.api.call("ext_set_enabled", { ext_id: ext.id, enabled: enabled ? 1 : 0 });
			await this.afterChange();
		} catch (e) {
			notifyError(e);
		}
	}

	uninstall(ext) {
		frappe.confirm(__("Uninstall {0}?", [frappe.utils.escape_html(ext.display_name)]), async () => {
			try {
				await this.api.call("ext_uninstall", { ext_id: ext.id });
				await this.afterChange();
			} catch (e) {
				notifyError(e);
			}
		});
	}

	editSettings(ext) {
		const rows = Object.entries(ext.configuration)
			.slice(0, 200)
			.map(([key, s]) => `<tr><td><code>${frappe.utils.escape_html(key)}</code></td><td>${frappe.utils.escape_html(JSON.stringify(s.default ?? null))}</td><td>${frappe.utils.escape_html(s.description || "")}</td></tr>`)
			.join("");
		const dialog = new frappe.ui.Dialog({
			title: __("Settings: {0}", [ext.display_name]),
			size: "extra-large",
			fields: [
				{ fieldtype: "Code", fieldname: "json", label: __("Your settings (JSON, only the values you change)"), options: "JSON", default: JSON.stringify(ext.settings || {}, null, 2) },
				{ fieldtype: "HTML", fieldname: "help", options: `<div style="max-height:40vh;overflow:auto"><table class="table table-sm"><thead><tr><th>${__("Setting")}</th><th>${__("Default")}</th><th>${__("Description")}</th></tr></thead><tbody>${rows}</tbody></table></div>` },
			],
			primary_action_label: __("Save"),
			primary_action: async (values) => {
				let settings;
				try {
					settings = JSON.parse(values.json || "{}");
				} catch (e) {
					return frappe.msgprint(__("Settings are not valid JSON"));
				}
				try {
					await this.api.call("ext_set_settings", { ext_id: ext.id, settings: JSON.stringify(settings) });
					this.manager.applySettings(ext.id, settings);
					ext.settings = settings;
					dialog.hide();
				} catch (e) {
					notifyError(e);
				}
			},
		});
		dialog.show();
	}

	renderPickers() {
		const fill = (select, items, selected, label) => {
			select.innerHTML = "";
			select.append(new Option(label, ""));
			for (const item of items) select.append(new Option(`${item.label} (${item.ext})`, item.key));
			select.value = selected || "";
		};
		fill(this.el.querySelector('[data-pref="color"]'), this.colorThemes.list(), this.colorThemes.selected, __("Default (follows Frappe)"));
		fill(this.el.querySelector('[data-pref="icons"]'), this.iconThemes.list(), this.iconThemes.selected, __("Default"));
	}

	// -- report dialog ------------------------------------------------------------------------------------

	reportDialog(title) {
		const dialog = new frappe.ui.Dialog({ title, size: "large", fields: [{ fieldtype: "HTML", fieldname: "report" }] });
		dialog.get_field("report").$wrapper.html(`<div class="text-muted">${__("Downloading and analysing...")}</div>`);
		dialog.show();
		return dialog;
	}

	fillReport(dialog, report, onInstall) {
		const verdict = VERDICTS[report.verdict] || VERDICTS.partial;
		dialog.set_title(`${report.display_name} ${report.version ? `v${report.version}` : ""}`);
		const wrapper = dialog.get_field("report").$wrapper[0];
		wrapper.innerHTML = `
			<div class="mdt-report">
				<p><span class="mdt-verdict ${verdict.cls}"></span> <b class="mdt-report-level"></b></p>
				<p class="mdt-report-summary"></p>
				<h6>${__("Works in the studio")}</h6><ul class="mdt-report-works"></ul>
				<h6>${__("Will not work")}</h6><ul class="mdt-report-not"></ul>
			</div>`;
		wrapper.querySelector(".mdt-verdict").textContent = verdict.label;
		wrapper.querySelector(".mdt-report-level").textContent =
			report.level === 2 ? __("Level 2: its code runs in an isolated sandbox") : __("Level 1: declarative features, no code runs");
		wrapper.querySelector(".mdt-report-summary").textContent = report.summary || "";
		const list = (selector, items) => {
			const ul = wrapper.querySelector(selector);
			if (!items?.length) ul.innerHTML = `<li class="text-muted">${__("Nothing")}</li>`;
			for (const text of (items || []).slice(0, 60)) {
				const li = document.createElement("li");
				li.textContent = text;
				ul.appendChild(li);
			}
		};
		list(".mdt-report-works", report.works);
		list(".mdt-report-not", report.not_working);
		if (onInstall) {
			dialog.set_primary_action(__("Install"), () => {
				dialog.hide();
				onInstall();
			});
		}
	}

	card({ icon, title, subtitle, description, badge, state }) {
		const card = document.createElement("div");
		card.className = "mdt-ext-card";
		card.innerHTML = `
			<div class="mdt-ext-head">
				<span class="mdt-ext-icon codicon codicon-extensions"></span>
				<div class="mdt-ext-meta">
					<div class="mdt-ext-name"></div>
					<div class="mdt-ext-sub"></div>
				</div>
			</div>
			<div class="mdt-ext-desc"></div>
			<div class="mdt-ext-flags"></div>
			<div class="mdt-ext-actions"></div>`;
		card.querySelector(".mdt-ext-name").textContent = title;
		card.querySelector(".mdt-ext-sub").textContent = subtitle || "";
		card.querySelector(".mdt-ext-desc").textContent = description || "";
		if (icon && /^https:\/\/(open-vsx\.org|openvsx\.eclipsecontent\.org)\//.test(icon)) {
			const img = document.createElement("img");
			img.src = icon;
			img.alt = "";
			img.referrerPolicy = "no-referrer";
			img.className = "mdt-ext-icon";
			card.querySelector(".mdt-ext-icon").replaceWith(img);
		}
		const flags = card.querySelector(".mdt-ext-flags");
		if (badge) {
			const b = document.createElement("span");
			b.className = `mdt-verdict ${badge.cls}`;
			b.textContent = badge.label;
			flags.appendChild(b);
		}
		if (state) {
			const s = document.createElement("span");
			s.className = "mdt-ext-state";
			s.textContent = state;
			flags.appendChild(s);
		}
		return card;
	}
}

function runtimeLabel({ state, error }) {
	const labels = { starting: __("Starting..."), running: __("Code loaded"), active: __("Running"), failed: __("Failed"), crashed: __("Stopped"), stopped: __("Stopped") };
	return error ? `${labels[state] || state}: ${error}`.slice(0, 120) : labels[state] || state;
}

function button(label, icon, variant, onClick) {
	const el = document.createElement("button");
	el.className = `mdt-btn mdt-btn-small ${variant === "primary" ? "mdt-btn-primary" : variant === "danger" ? "mdt-btn-ghost mdt-btn-danger" : "mdt-btn-ghost"}`;
	el.innerHTML = `<span class="codicon codicon-${icon}"></span> <span></span>`;
	el.lastElementChild.textContent = label;
	el.addEventListener("click", onClick);
	return el;
}

function formatCount(n) {
	return n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}K` : String(n || 0);
}

function readAsBase64(file) {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(String(reader.result).split(",", 2)[1]);
		reader.onerror = () => reject(reader.error);
		reader.readAsDataURL(file);
	});
}
