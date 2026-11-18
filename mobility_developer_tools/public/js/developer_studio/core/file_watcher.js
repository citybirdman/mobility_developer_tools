const INTERVAL_MS = 2000;
const MAX_BACKOFF_MS = 30000;

/**
 * Polls the server for changes to the files and folders the user has open, so
 * edits made elsewhere (another tab, git, a terminal, another user) show up.
 *
 * It does not know who owns those paths: components register path sources and
 * react to the events it emits (Dependency Inversion):
 *   fs:file-stat      {path, stat: {exists, version, mtime, size}, requestedAt}
 *   fs:folder-changed {path, signature}   (signature null = folder is gone)
 *
 * Polling pauses while the page is hidden or the studio is locked, and backs
 * off after errors.
 */
export class FileWatcher {
	constructor({ api, bus, interval = INTERVAL_MS }) {
		this.api = api;
		this.bus = bus;
		this.interval = interval;
		this.delay = interval;
		this.fileSources = [];
		this.folderSources = [];
		this.signatures = new Map(); // folder -> last listing signature
		this.timer = null;
		this.inFlight = false;
		this.onVisibility = () => !document.hidden && this.pollSoon(0);
	}

	watchFiles(source) {
		this.fileSources.push(source);
	}

	watchFolders(source) {
		this.folderSources.push(source);
	}

	start() {
		if (this.running) return;
		this.running = true;
		document.addEventListener("visibilitychange", this.onVisibility);
		this.pollSoon(this.interval);
	}

	stop() {
		this.running = false;
		clearTimeout(this.timer);
		document.removeEventListener("visibilitychange", this.onVisibility);
	}

	pollSoon(ms = this.delay) {
		clearTimeout(this.timer);
		if (this.running) this.timer = setTimeout(() => this.poll(), ms);
	}

	async poll() {
		if (!this.running) return;
		if (document.hidden || !this.api.token || this.inFlight) return this.pollSoon();

		const files = unique(this.fileSources.flatMap((source) => source()));
		const folders = unique(this.folderSources.flatMap((source) => source()));
		if (!files.length && !folders.length) return this.pollSoon();

		this.inFlight = true;
		const requestedAt = Date.now();
		try {
			const result = await this.api.call("watch", { files, folders });
			this.delay = this.interval;
			for (const [path, stat] of Object.entries(result.files || {})) {
				this.bus.emit("fs:file-stat", { path, stat, requestedAt });
			}
			for (const [path, signature] of Object.entries(result.folders || {})) {
				const previous = this.signatures.get(path);
				this.signatures.set(path, signature);
				if (previous !== undefined && previous !== signature) this.bus.emit("fs:folder-changed", { path, signature });
			}
			for (const path of this.signatures.keys()) if (!folders.includes(path)) this.signatures.delete(path);
		} catch (e) {
			this.delay = Math.min(this.delay * 2, MAX_BACKOFF_MS);
		} finally {
			this.inFlight = false;
			this.pollSoon();
		}
	}
}

const unique = (paths) => [...new Set(paths)].slice(0, 200);
