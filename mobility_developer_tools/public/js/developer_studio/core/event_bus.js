/**
 * Tiny pub/sub used to decouple components (they never reference each other directly).
 *
 * Events:
 *   file:open {path}                 editor:active {path, language} | null
 *   entry:renamed {from, to}         editor:cursor {line, column}
 *   entry:deleted {path}             terminal:open {cwd}
 *   run:request                      studio:locked / studio:unlocked
 */
export class EventBus {
	constructor() {
		this.handlers = new Map();
	}

	on(event, handler) {
		if (!this.handlers.has(event)) this.handlers.set(event, new Set());
		this.handlers.get(event).add(handler);
		return () => this.handlers.get(event)?.delete(handler);
	}

	emit(event, payload) {
		for (const handler of this.handlers.get(event) || []) {
			try {
				handler(payload);
			} catch (e) {
				console.error(`[developer studio] handler for ${event} failed`, e);
			}
		}
	}
}
