/**
 * Remembers the studio unlock in this browser so the password is only asked when
 * the studio is opened for the first time (and again after Lock, logout, or 30
 * minutes without activity — the server expires the token and binds it to the
 * Frappe login session, so a copied token is useless elsewhere).
 */
export class TokenStore {
	constructor(user) {
		this.key = `mdt_studio_token:${user}`;
	}

	get() {
		try {
			return localStorage.getItem(this.key);
		} catch (e) {
			return null;
		}
	}

	set(token) {
		try {
			if (token) localStorage.setItem(this.key, token);
			else localStorage.removeItem(this.key);
		} catch (e) {
			// storage blocked: the password will simply be asked again next time
		}
	}
}
