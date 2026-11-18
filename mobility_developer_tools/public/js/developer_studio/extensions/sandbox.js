/**
 * Isolated execution of one extension's code.
 *
 *   page ── postMessage ──> sandboxed <iframe>  ── postMessage ──> Web Worker (runtime.js + extension code)
 *
 * - iframe `sandbox="allow-scripts"` without allow-same-origin: opaque origin, so no
 *   access to the studio DOM, cookies, localStorage or the Frappe session
 * - CSP `connect-src 'none'`: no fetch / XHR / WebSocket (inherited by the worker)
 * - a worker: a busy or looping extension cannot freeze the page, and can be killed
 * - every call has a timeout; repeated timeouts terminate the extension
 */
const FRAME_HTML = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'">
</head><body><script>
let worker = null;
window.addEventListener("message", (event) => {
	if (event.source !== window.parent) return;
	const msg = event.data;
	if (msg && msg.type === "__boot") {
		worker = new Worker(URL.createObjectURL(new Blob([msg.runtime], { type: "text/javascript" })));
		worker.onmessage = (e) => window.parent.postMessage(e.data, "*");
		worker.onerror = (e) => window.parent.postMessage({ type: "notify", method: "log", params: { level: "error", message: String(e.message) } }, "*");
		return;
	}
	if (worker) worker.postMessage(msg);
});
window.parent.postMessage({ type: "__frame_ready" }, "*");
</script></body></html>`;

let runtimeSource = null;
async function loadRuntime() {
	if (!runtimeSource) {
		const response = await fetch("/assets/mobility_developer_tools/js/extension_runtime/runtime.js", { credentials: "omit" });
		if (!response.ok) throw new Error("Could not load the extension runtime");
		runtimeSource = response.text();
	}
	return runtimeSource;
}

export class ExtensionSandbox {
	constructor(id, { onRequest, onNotify, onCrash, timeoutMs = 5000, maxTimeouts = 3 }) {
		this.id = id;
		this.onRequest = onRequest;
		this.onNotify = onNotify;
		this.onCrash = onCrash;
		this.timeoutMs = timeoutMs;
		this.maxTimeouts = maxTimeouts;
		this.pending = new Map();
		this.nextId = 1;
		this.consecutiveTimeouts = 0;
		this.dead = false;
		this.listener = (event) => this.receive(event);
	}

	async start() {
		const runtime = await loadRuntime();
		this.frame = document.createElement("iframe");
		this.frame.setAttribute("sandbox", "allow-scripts");
		this.frame.setAttribute("aria-hidden", "true");
		this.frame.style.display = "none";
		this.frame.srcdoc = FRAME_HTML;
		this.ready = new Promise((resolve) => (this.resolveReady = resolve));
		window.addEventListener("message", this.listener);
		document.body.appendChild(this.frame);
		await this.withTimeout(this.ready, 10000, "sandbox did not start");
		this.post({ type: "__boot", runtime });
		await this.withTimeout(new Promise((resolve) => (this.resolveRuntime = resolve)), 10000, "runtime did not start");
	}

	receive(event) {
		if (!this.frame || event.source !== this.frame.contentWindow) return; // only our own frame
		const msg = event.data;
		if (!msg || typeof msg !== "object") return;
		if (msg.type === "__frame_ready") return this.resolveReady?.();
		if (msg.type === "ready") return this.resolveRuntime?.();
		if (msg.type === "response") {
			const call = this.pending.get(msg.id);
			if (!call) return;
			this.pending.delete(msg.id);
			clearTimeout(call.timer);
			this.consecutiveTimeouts = 0;
			msg.error ? call.reject(new Error(msg.error)) : call.resolve(msg.result);
		} else if (msg.type === "request") {
			Promise.resolve()
				.then(() => this.onRequest(String(msg.method), msg.params || {}))
				.then(
					(result) => this.post({ type: "response", id: msg.id, result: result === undefined ? null : result }),
					(error) => this.post({ type: "response", id: msg.id, error: String(error?.message || error) })
				);
		} else if (msg.type === "notify") {
			try {
				this.onNotify(String(msg.method), msg.params || {});
			} catch (e) {
				console.error(`[extension ${this.id}]`, e);
			}
		}
	}

	call(method, params, timeoutMs = this.timeoutMs) {
		if (this.dead) return Promise.reject(new Error("extension is not running"));
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${method} timed out`));
				if (++this.consecutiveTimeouts >= this.maxTimeouts) this.kill("stopped: it did not respond");
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			this.post({ type: "call", id, method, params });
		});
	}

	event(name, data) {
		if (!this.dead) this.post({ type: "event", name, data });
	}

	post(msg) {
		// the frame has an opaque origin, so "*" is the only possible target; it is our own srcdoc frame
		this.frame?.contentWindow?.postMessage(msg, "*");
	}

	withTimeout(promise, ms, message) {
		return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
	}

	kill(reason = "stopped") {
		if (this.dead) return;
		this.dead = true;
		window.removeEventListener("message", this.listener);
		for (const call of this.pending.values()) {
			clearTimeout(call.timer);
			call.reject(new Error(reason));
		}
		this.pending.clear();
		this.frame?.remove(); // destroys the worker too
		this.frame = null;
		this.onCrash?.(reason);
	}
}
