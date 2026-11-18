import { notifyError } from "../core/api_client";
import { languageForPath } from "../core/languages";

const INDENT = 12;

const parentOf = (path) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** Lazy-loaded file tree (explorer side bar). */
export class FileExplorer {
	constructor(host, { api, bus, contextMenu, icons }) {
		this.icons = icons;
		this.api = api;
		this.bus = bus;
		this.menu = contextMenu;
		this.nodes = new Map();
		this.expanded = new Set();
		this.selected = null;
		this.root = { abs: "", name: "" };

		this.el = document.createElement("div");
		this.el.className = "mdt-explorer";
		this.el.innerHTML = `
			<div class="mdt-sidebar-title">
				<span>${__("Explorer")}</span>
			</div>
			<div class="mdt-explorer-header">
				<span class="codicon codicon-chevron-down"></span>
				<span class="mdt-explorer-root"></span>
				<span class="mdt-explorer-actions">
					<span class="codicon codicon-new-file" data-action="new-file" title="${__("New File")}"></span>
					<span class="codicon codicon-new-folder" data-action="new-folder" title="${__("New Folder")}"></span>
					<span class="codicon codicon-refresh" data-action="refresh" title="${__("Refresh")}"></span>
					<span class="codicon codicon-collapse-all" data-action="collapse" title="${__("Collapse All")}"></span>
				</span>
			</div>
			<div class="mdt-tree" tabindex="0"></div>`;
		host.appendChild(this.el);
		this.tree = this.el.querySelector(".mdt-tree");
		this.rootNode = { path: "", type: "folder", depth: -1, children: this.tree, loaded: false };
		this.nodes.set("", this.rootNode);

		this.el.querySelector(".mdt-explorer-actions").addEventListener("click", (e) => {
			const action = e.target.dataset.action;
			const target = this.targetFolder();
			if (action === "new-file") this.promptCreate(target, "file");
			if (action === "new-folder") this.promptCreate(target, "folder");
			if (action === "refresh") this.refresh("");
			if (action === "collapse") this.collapseAll();
		});
		this.tree.addEventListener("contextmenu", (e) => {
			if (e.target === this.tree) {
				e.preventDefault();
				this.showMenu(e, this.rootNode);
			}
		});

		bus.on("editor:active", (info) => this.highlight(info?.path));
		this.aiTools = [];
		bus.on("ai:tools", (tools) => (this.aiTools = tools.filter((t) => t.installed)));
		bus.on("fs:folder-changed", (event) => this.onFolderChanged(event));
		bus.on("icons:changed", () => {
			for (const node of this.nodes.values()) if (node.row) this.renderIcon(node);
		});
	}

	setRoot(abs, name) {
		this.root = { abs, name };
		this.el.querySelector(".mdt-explorer-root").textContent = (name || abs).toUpperCase();
		this.el.querySelector(".mdt-explorer-root").title = abs;
	}

	async load() {
		await this.loadChildren(this.rootNode);
	}

	// -- tree rendering -------------------------------------------------------

	async loadChildren(node) {
		let entries;
		try {
			entries = await this.api.call("list_dir", { path: node.path });
		} catch (e) {
			notifyError(e);
			return;
		}
		for (const [path, child] of this.nodes) {
			if (path && parentOf(path) === node.path) this.forget(child);
		}
		node.children.innerHTML = "";
		for (const entry of entries) node.children.appendChild(this.renderNode(entry, node.depth + 1));
		node.loaded = true;

		await Promise.all(
			entries
				.filter((e) => e.type === "folder" && this.expanded.has(e.path))
				.map((e) => this.expand(this.nodes.get(e.path)))
		);
		this.highlight(this.activePath);
	}

	renderNode(entry, depth) {
		const el = document.createElement("div");
		el.className = "mdt-tree-node";
		const row = document.createElement("div");
		row.className = "mdt-tree-row";
		row.style.paddingLeft = `${depth * INDENT + 6}px`;
		row.title = entry.path;

		const isFolder = entry.type === "folder";
		row.innerHTML = `
			<span class="codicon ${isFolder ? "codicon-chevron-right" : "codicon-blank"} mdt-twisty"></span>
			<span class="mdt-tree-icon" data-base="mdt-tree-icon"></span>
			<span class="mdt-tree-label"></span>`;
		row.querySelector(".mdt-tree-label").textContent = entry.name;
		if (entry.symlink) row.classList.add("symlink");

		const children = document.createElement("div");
		children.className = "mdt-tree-children";
		el.append(row, children);

		const node = { ...entry, depth, el, row, children, loaded: false };
		this.nodes.set(entry.path, node);
		this.renderIcon(node);

		row.addEventListener("click", () => {
			this.select(node);
			if (isFolder) this.toggle(node);
			else this.bus.emit("file:open", { path: node.path });
		});
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.select(node);
			this.showMenu(e, node);
		});
		return el;
	}

	forget(node) {
		for (const path of [...this.nodes.keys()]) {
			if (path === node.path || path.startsWith(`${node.path}/`)) this.nodes.delete(path);
		}
	}

	renderIcon(node) {
		const isFolder = node.type === "folder";
		this.icons.render(node.row.querySelector(".mdt-tree-icon"), {
			name: node.name,
			path: node.path,
			type: node.type,
			expanded: !!node.expanded,
			languageId: isFolder ? null : languageForPath(node.path),
		});
		node.row.querySelector(".mdt-twisty").style.visibility = isFolder && this.icons.hidesArrows ? "hidden" : "";
	}

	async toggle(node) {
		if (node.expanded) this.collapse(node);
		else await this.expand(node);
	}

	async expand(node) {
		if (!node || node.type !== "folder") return;
		node.expanded = true;
		this.expanded.add(node.path);
		if (node.row) {
			node.row.querySelector(".mdt-twisty").classList.replace("codicon-chevron-right", "codicon-chevron-down");
			this.renderIcon(node);
		}
		node.children.style.display = "";
		if (!node.loaded) await this.loadChildren(node);
	}

	collapse(node) {
		node.expanded = false;
		this.expanded.delete(node.path);
		node.row.querySelector(".mdt-twisty").classList.replace("codicon-chevron-down", "codicon-chevron-right");
		this.renderIcon(node);
		node.children.style.display = "none";
	}

	collapseAll() {
		for (const node of this.nodes.values()) if (node.expanded && node.row) this.collapse(node);
		this.expanded.clear();
	}

	/** Folders the file watcher should check: the loaded root and every expanded folder. */
	watchedFolders() {
		const folders = this.rootNode.loaded ? [""] : [];
		for (const path of this.expanded) if (this.nodes.get(path)?.loaded) folders.push(path);
		return folders;
	}

	onFolderChanged({ path, signature }) {
		if (this.tree.querySelector(".mdt-inline-input")) return; // never disturb a rename / new file in progress
		if (signature === null) {
			// the folder itself is gone: reload its parent instead
			this.expanded.delete(path);
			return this.refresh(parentOf(path));
		}
		this.refresh(path);
	}

	async refresh(path = "") {
		const node = this.nodes.get(path);
		if (node?.type === "folder" && (node.loaded || node === this.rootNode)) await this.loadChildren(node);
	}

	select(node) {
		this.tree.querySelector(".mdt-tree-row.selected")?.classList.remove("selected");
		node.row?.classList.add("selected");
		this.selected = node;
		this.bus.emit("explorer:folder", this.targetFolder().path);
	}

	highlight(path) {
		this.activePath = path;
		this.tree.querySelector(".mdt-tree-row.active")?.classList.remove("active");
		this.nodes.get(path)?.row?.classList.add("active");
	}

	targetFolder() {
		const node = this.selected;
		if (!node) return this.rootNode;
		return node.type === "folder" ? node : this.nodes.get(parentOf(node.path)) || this.rootNode;
	}

	absolutePath(path) {
		return path ? `${this.root.abs}/${path}` : this.root.abs;
	}

	// -- context menu ---------------------------------------------------------

	showMenu(e, node) {
		const isFolder = node.type === "folder";
		const folder = isFolder ? node : this.nodes.get(parentOf(node.path)) || this.rootNode;
		const items = [];

		if (!isFolder) items.push({ label: __("Open"), icon: "go-to-file", action: () => this.bus.emit("file:open", { path: node.path }) });
		if (!isFolder) items.push({ label: __("Run"), icon: "play", action: () => this.bus.emit("run:request", { path: node.path }) }, "-");
		items.push(
			{ label: __("New File..."), icon: "new-file", action: () => this.promptCreate(folder, "file") },
			{ label: __("New Folder..."), icon: "new-folder", action: () => this.promptCreate(folder, "folder") },
			{ label: __("Open in Terminal"), icon: "terminal", action: () => this.bus.emit("terminal:open", { cwd: folder.path }) },
			{ label: __("Find in Folder..."), icon: "search", action: () => this.bus.emit("search:in-folder", { path: folder.path }) },
			...this.aiTools.map((tool) => ({
				label: __("Open {0} Here", [tool.label]),
				icon: tool.icon,
				action: () => this.bus.emit("ai:start", { key: tool.key, cwd: folder.path }),
			})),
			"-",
			{ label: __("Copy Path"), icon: "copy", action: () => frappe.utils.copy_to_clipboard(this.absolutePath(node.path)) },
			{ label: __("Copy Relative Path"), icon: "copy", action: () => frappe.utils.copy_to_clipboard(node.path) }
		);
		if (node !== this.rootNode) {
			items.push(
				"-",
				{ label: __("Rename..."), icon: "edit", action: () => this.promptRename(node) },
				{ label: __("Delete"), icon: "trash", danger: true, action: () => this.confirmDelete(node) }
			);
		}
		if (isFolder) items.push("-", { label: __("Refresh"), icon: "refresh", action: () => this.refresh(node.path) });
		this.menu.show(e.clientX, e.clientY, items);
	}

	// -- create / rename / delete ----------------------------------------------

	async promptCreate(folder, type) {
		if (folder !== this.rootNode) await this.expand(folder);
		const row = document.createElement("div");
		row.className = "mdt-tree-row editing";
		row.style.paddingLeft = `${(folder.depth + 1) * INDENT + 6}px`;
		row.innerHTML = `
			<span class="codicon codicon-blank mdt-twisty"></span>
			<span class="codicon ${type === "folder" ? "codicon-folder" : "codicon-file"} mdt-tree-icon"></span>`;
		folder.children.prepend(row);

		this.inlineInput(row, "", async (name) => {
			const path = join(folder.path, name);
			await this.api.call("create_entry", { path, entry_type: type });
			await this.refresh(folder.path);
			if (type === "file") this.bus.emit("file:open", { path });
		}, () => row.remove());
	}

	promptRename(node) {
		const label = node.row.querySelector(".mdt-tree-label");
		label.style.display = "none";
		this.inlineInput(node.row, node.name, async (name) => {
			if (name === node.name) return;
			const to = join(parentOf(node.path), name);
			await this.api.call("rename_entry", { path: node.path, new_path: to });
			this.bus.emit("entry:renamed", { from: node.path, to });
			await this.refresh(parentOf(node.path));
		}, () => (label.style.display = ""));
	}

	confirmDelete(node) {
		const what = node.type === "folder" ? __("folder '{0}' and all its contents", [node.name]) : `'${node.name}'`;
		frappe.confirm(__("Permanently delete {0}?", [frappe.utils.escape_html(what)]), async () => {
			try {
				await this.api.call("delete_entry", { path: node.path });
				this.expanded.delete(node.path);
				this.bus.emit("entry:deleted", { path: node.path });
				await this.refresh(parentOf(node.path));
			} catch (e) {
				notifyError(e);
			}
		});
	}

	inlineInput(row, value, onCommit, onDone) {
		const input = document.createElement("input");
		input.className = "mdt-inline-input";
		input.value = value;
		row.appendChild(input);
		input.focus();
		const dot = value.lastIndexOf(".");
		input.setSelectionRange(0, dot > 0 ? dot : value.length);

		let finished = false;
		const finish = async (commit) => {
			if (finished) return;
			const name = input.value.trim();
			if (commit && name) {
				if (name.includes("/") && !name.split("/").every(Boolean)) return;
				finished = true;
				try {
					await onCommit(name);
				} catch (e) {
					notifyError(e);
				}
			}
			finished = true;
			input.remove();
			onDone();
		};
		input.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Enter") finish(true);
			if (e.key === "Escape") finish(false);
		});
		input.addEventListener("blur", () => finish(true));
	}
}
