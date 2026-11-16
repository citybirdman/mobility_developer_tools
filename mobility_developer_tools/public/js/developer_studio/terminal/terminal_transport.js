const OUTPUT_EVENT = "mdt_terminal_output";
const EXIT_EVENT = "mdt_terminal_exit";
const POLL_MS = 400;

/**
 * Moves bytes between one browser terminal and its PTY host.
 *  - output: pushed via Frappe socket.io; ordered by `seq`; gaps / reconnects are
 *    filled from the server backlog; falls back to polling when socket.io is down
 *  - input: queued and sent strictly in order, batched while a request is in flight
 */
export class TerminalTransport {
	constructor(api, termId, { onData, onExit, onError }) {
		this.api = api;
		this.id = termId;
		this.onData = onData;
		this.onExit = onExit;
		this.onError = onError;
		this.lastSeq = 0;
		this.exited = false;
		this.inputQueue = "";
		this.sending = false;
		this.fetching = null;

		this.handleOutput = (msg) => msg?.id === this.id && this.receive(msg);
		this.handleExit = (msg) => msg?.id === this.id && this.markExited(msg.code);
		frappe.realtime.on(OUTPUT_EVENT, this.handleOutput);
		frappe.realtime.on(EXIT_EVENT, this.handleExit);
		this.pollTimer = setInterval(() => !this.socketConnected() && this.fetchBacklog(), POLL_MS);
	}

	socketConnected() {
		return !!frappe.realtime?.socket?.connected;
	}

	// -- output -----------------------------------------------------------------

	receive({ seq, data }) {
		if (seq <= this.lastSeq) return;
		if (seq > this.lastSeq + 1) return this.fetchBacklog();
		this.lastSeq = seq;
		this.onData(data);
	}

	fetchBacklog() {
		if (this.fetching || this.exited || !this.api.token) return this.fetching;
		this.fetching = this.api
			.call("terminal_read", { term_id: this.id, after_seq: this.lastSeq })
			.then((res) => {
				for (const chunk of res.chunks) {
					if (chunk.seq > this.lastSeq) {
						this.lastSeq = chunk.seq;
						this.onData(chunk.data);
					}
				}
				if (res.status === "exited") this.markExited(res.exit_code);
			})
			.catch((e) => this.onError(e))
			.finally(() => (this.fetching = null));
		return this.fetching;
	}

	markExited(code) {
		if (this.exiting) return;
		this.exiting = true;
		// make sure trailing output is shown before the exit message
		const finish = () => {
			this.exited = true;
			this.dispose();
			this.onExit(code);
		};
		const pending = this.fetching || this.fetchBacklog();
		pending ? pending.then(finish, finish) : finish();
	}

	// -- input ------------------------------------------------------------------

	send(data) {
		if (this.exited) return;
		this.inputQueue += data;
		this.flush();
	}

	async flush() {
		if (this.sending || !this.inputQueue) return;
		this.sending = true;
		const data = this.inputQueue;
		this.inputQueue = "";
		try {
			await this.api.call("terminal_input", { term_id: this.id, data });
		} catch (e) {
			this.onError(e);
		} finally {
			this.sending = false;
			if (this.inputQueue) this.flush();
		}
	}

	resize(cols, rows) {
		if (this.exited) return;
		clearTimeout(this.resizeTimer);
		this.resizeTimer = setTimeout(
			() => this.api.call("terminal_resize", { term_id: this.id, cols, rows }).catch(this.onError),
			150
		);
	}

	close() {
		if (this.exited) return Promise.resolve();
		return this.api.call("terminal_close", { term_id: this.id });
	}

	dispose() {
		clearInterval(this.pollTimer);
		frappe.realtime.off(OUTPUT_EVENT, this.handleOutput);
		frappe.realtime.off(EXIT_EVENT, this.handleExit);
	}
}
