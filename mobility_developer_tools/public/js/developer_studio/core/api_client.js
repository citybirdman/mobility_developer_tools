const METHOD_PREFIX = "mobility_developer_tools.studio.api.";

export class StudioApiError extends Error {
	constructor(message, type, status) {
		super(message);
		this.type = type;
		this.status = status;
	}

	get isLocked() {
		return this.type === "StudioLockedError";
	}
}

/**
 * Talks to the backend. The studio token is sent in a header; it is remembered by
 * an optional TokenStore so the password is only asked on first entry.
 */
export class StudioApi {
	constructor({ tokenStore = null } = {}) {
		this.tokenStore = tokenStore;
		this.token = tokenStore?.get() || null;
		this.lockListeners = new Set();
	}

	onLocked(listener) {
		this.lockListeners.add(listener);
	}

	setToken(token) {
		this.token = token;
		this.tokenStore?.set(token);
	}

	async call(method, args = {}) {
		const headers = {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Frappe-CSRF-Token": frappe.csrf_token,
		};
		if (this.token) headers["X-Studio-Token"] = this.token;

		let response;
		try {
			response = await fetch(`/api/method/${METHOD_PREFIX}${method}`, {
				method: "POST",
				headers,
				credentials: "same-origin",
				body: JSON.stringify(args),
			});
		} catch (e) {
			throw new StudioApiError(__("Network error: {0}", [e.message]), "NetworkError", 0);
		}

		let body = {};
		try {
			body = await response.json();
		} catch (e) {
			// non JSON response
		}

		if (response.ok) return body.message;

		const error = new StudioApiError(
			extractMessage(body) || response.statusText,
			body.exc_type,
			response.status
		);
		if (error.isLocked) {
			this.setToken(null);
			this.lockListeners.forEach((fn) => fn());
		}
		throw error;
	}
}

function extractMessage(body) {
	try {
		if (body._server_messages) {
			return JSON.parse(body._server_messages)
				.map((m) => strip_html(JSON.parse(m).message || ""))
				.filter(Boolean)
				.join("\n");
		}
	} catch (e) {
		// ignore
	}
	if (body.exception) return String(body.exception).split(":").slice(1).join(":").trim();
	return "";
}

/** Show an error to the user unless it is a lock (the lock screen handles that). */
export function notifyError(error) {
	if (error?.isLocked) return;
	console.error(error);
	frappe.show_alert({ message: frappe.utils.escape_html(error?.message || String(error)), indicator: "red" }, 7);
}
