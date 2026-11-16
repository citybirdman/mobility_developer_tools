import { notifyError } from "../core/api_client";

/** Password prompt shown before the studio can be used (and whenever the session locks). */
export class LockScreen {
	constructor(host, api) {
		this.api = api;
		this.el = document.createElement("div");
		this.el.className = "mdt-lock";
		this.el.innerHTML = `
			<form class="mdt-lock-card" autocomplete="off">
				<img class="mdt-lock-logo" src="/assets/mobility_developer_tools/images/logo.svg" alt="">
				<div class="mdt-lock-title">${__("Developer Studio")}</div>
				<div class="mdt-lock-sub">${__("Confirm your password to continue")}</div>
				<div class="mdt-lock-user"></div>
				<input class="mdt-input mdt-lock-password" type="password" placeholder="${__("Password")}"
					autocomplete="current-password" required>
				<div class="mdt-lock-error"></div>
				<button class="mdt-btn mdt-btn-primary" type="submit">
					<svg class="mdt-lock-icon" viewBox="0 0 16 16" width="13" height="13" fill="currentColor"
						aria-hidden="true"><path d="M5 7V5a3 3 0 0 1 6 0v2h1a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h1zm1.5 0h3V5a1.5 1.5 0 0 0-3 0v2z"/></svg>
					${__("Unlock")}
				</button>
			</form>`;
		this.el.querySelector(".mdt-lock-user").textContent = frappe.session.user;
		this.input = this.el.querySelector(".mdt-lock-password");
		this.error = this.el.querySelector(".mdt-lock-error");
		this.button = this.el.querySelector("button");
		this.el.querySelector("form").addEventListener("submit", (e) => {
			e.preventDefault();
			this.submit();
		});
		host.appendChild(this.el);
		this.resolve = null;
	}

	/** Shows the lock screen; resolves with the unlock result once the password is accepted. */
	prompt() {
		this.el.classList.add("visible");
		this.error.textContent = "";
		this.input.value = "";
		setTimeout(() => this.input.focus(), 50);
		return new Promise((resolve) => (this.resolve = resolve));
	}

	get visible() {
		return this.el.classList.contains("visible");
	}

	async submit() {
		this.button.disabled = true;
		this.error.textContent = "";
		try {
			const result = await this.api.call("unlock", { password: this.input.value });
			this.api.setToken(result.token);
			this.input.value = "";
			this.el.classList.remove("visible");
			this.resolve?.(result);
			this.resolve = null;
		} catch (e) {
			this.error.textContent = e.message;
			if (!e.type) notifyError(e);
			this.input.select();
		} finally {
			this.button.disabled = false;
		}
	}
}
