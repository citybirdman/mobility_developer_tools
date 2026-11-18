const STORAGE_KEY = "mdt_studio_layout";

/**
 * VS Code-like skeleton: activity bar | sidebar | (editor / panel), status bar.
 * Owns sizes, the drag handles (sashes) and panel/sidebar visibility.
 */
export class WorkbenchLayout {
	constructor(root, { onResize, onMaximize, onViewShown }) {
		this.onResize = onResize;
		this.onMaximize = onMaximize;
		this.onViewShown = onViewShown;
		this.state = { sidebar: 260, panel: 260, panelVisible: true, sidebarVisible: true, ...load(), panelMaximized: false };

		root.insertAdjacentHTML(
			"beforeend",
			`<div class="mdt-main">
				<div class="mdt-activitybar">
					<span class="codicon codicon-files active" data-action="explorer" data-view="explorer" title="${__("Explorer")}"></span>
					<span class="codicon codicon-search" data-action="search" data-view="search" title="${__("Search")} (Ctrl+Shift+F)"></span>
					<span class="codicon codicon-sparkle" data-action="ai" data-view="ai" title="${__("AI Assistants")}"></span>
					<span class="codicon codicon-server-process" data-action="bench" data-view="bench" title="${__("Frappe & Bench")}"></span>
					<span class="codicon codicon-extensions" data-action="extensions" data-view="extensions" title="${__("Extensions")} (Ctrl+Shift+X)"></span>
					<span class="codicon codicon-terminal" data-action="terminal" title="${__("Toggle Terminal")} (Ctrl+\`)"></span>
					<span class="mdt-activity-spacer"></span>
					<span class="codicon codicon-lock" data-action="lock" title="${__("Lock")}"></span>
					<span class="mdt-activity-avatar" data-action="account" title="${frappe.utils.escape_html(frappe.session.user_fullname || frappe.session.user)}">${frappe.avatar(frappe.session.user, "avatar-small")}</span>
				</div>
				<div class="mdt-sidebar"></div>
				<div class="mdt-sash mdt-sash-v"></div>
				<div class="mdt-workbench">
					<div class="mdt-editor-slot"></div>
					<div class="mdt-sash mdt-sash-h"></div>
					<div class="mdt-panel-slot"></div>
				</div>
			</div>
			<div class="mdt-status-slot"></div>`
		);
		this.activitybar = root.querySelector(".mdt-activitybar");
		this.sidebar = root.querySelector(".mdt-sidebar");
		this.editorSlot = root.querySelector(".mdt-editor-slot");
		this.panelSlot = root.querySelector(".mdt-panel-slot");
		this.statusSlot = root.querySelector(".mdt-status-slot");
		this.sashV = root.querySelector(".mdt-sash-v");
		this.sashH = root.querySelector(".mdt-sash-h");

		this.drag(this.sashV, (e, start) => {
			this.state.sidebar = clamp(start.sidebar + e.clientX - start.x, 160, 700);
		});
		this.drag(this.sashH, (e, start) => {
			this.state.panel = clamp(start.panel - (e.clientY - start.y), 80, window.innerHeight - 200);
		});
		this.apply();
	}

	onActivity(handler) {
		this.activitybar.addEventListener("click", (e) => {
			const target = e.target.closest("[data-action]");
			if (target) handler(target.dataset.action, target);
		});
	}

	/** Creates a side bar view; only one view is visible at a time. */
	addView(name) {
		const view = document.createElement("div");
		view.className = "mdt-sidebar-view";
		view.dataset.view = name;
		this.sidebar.appendChild(view);
		this.views = { ...(this.views || {}), [name]: view };
		if (Object.keys(this.views).length === 1) this.currentView = name;
		this.applyView();
		return view;
	}

	/** Shows a view; clicking the active view again hides the side bar (like VS Code). */
	showView(name, { toggle = true } = {}) {
		if (this.currentView === name && this.state.sidebarVisible) return toggle ? this.toggleSidebar(false) : undefined;
		this.currentView = name;
		this.state.sidebarVisible = true;
		this.applyView();
		this.apply();
		this.onViewShown?.(name);
	}

	applyView() {
		for (const [name, view] of Object.entries(this.views || {})) view.style.display = name === this.currentView ? "" : "none";
		this.activitybar.querySelectorAll("[data-view]").forEach((icon) =>
			icon.classList.toggle("active", this.state.sidebarVisible && icon.dataset.view === this.currentView)
		);
	}

	togglePanel(visible = !this.state.panelVisible) {
		this.state.panelVisible = visible;
		if (!visible) this.state.panelMaximized = false;
		this.apply();
	}

	toggleMaximize(maximized = !this.state.panelMaximized) {
		this.state.panelMaximized = maximized;
		if (maximized) this.state.panelVisible = true;
		this.apply();
	}

	toggleSidebar(visible = !this.state.sidebarVisible) {
		this.state.sidebarVisible = visible;
		this.applyView();
		this.apply();
	}

	apply() {
		const { sidebar, panel, panelVisible, sidebarVisible, panelMaximized } = this.state;
		const maximized = panelVisible && panelMaximized;
		this.sidebar.style.width = `${sidebar}px`;
		this.sidebar.style.display = sidebarVisible ? "" : "none";
		this.sashV.style.display = sidebarVisible ? "" : "none";
		this.editorSlot.style.display = maximized ? "none" : "";
		this.panelSlot.style.height = maximized ? "auto" : `${panel}px`;
		this.panelSlot.style.flex = maximized ? "1" : "";
		this.panelSlot.style.display = panelVisible ? "" : "none";
		this.sashH.style.display = panelVisible && !maximized ? "" : "none";
		save(this.state);
		this.onMaximize?.(maximized);
		this.onResize?.();
	}

	drag(sash, update) {
		sash.addEventListener("pointerdown", (e) => {
			e.preventDefault();
			const start = { x: e.clientX, y: e.clientY, ...this.state };
			sash.setPointerCapture(e.pointerId);
			sash.classList.add("dragging");
			const move = (ev) => {
				update(ev, start);
				this.apply();
			};
			const up = () => {
				sash.classList.remove("dragging");
				sash.removeEventListener("pointermove", move);
				sash.removeEventListener("pointerup", up);
			};
			sash.addEventListener("pointermove", move);
			sash.addEventListener("pointerup", up);
		});
	}
}

const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

function load() {
	try {
		return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
	} catch (e) {
		return {};
	}
}

function save(state) {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
	} catch (e) {
		// storage unavailable
	}
}
