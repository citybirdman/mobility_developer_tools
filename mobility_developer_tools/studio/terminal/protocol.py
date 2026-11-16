"""Shared key names / event names between the web side (TerminalManager) and the
PTY host process. Keeping them in one place is the only coupling between both."""

OUTPUT_EVENT = "mdt_terminal_output"
EXIT_EVENT = "mdt_terminal_exit"
OPEN_URL_EVENT = "mdt_open_url"

BACKLOG_MAX_CHUNKS = 1000
HEARTBEAT_SECONDS = 5
META_TTL = 30  # host refreshes meta every HEARTBEAT_SECONDS; stale meta => host is dead


def meta_key(term_id: str) -> str:
	return f"term:{term_id}"


def input_key(term_id: str) -> str:
	return f"term:{term_id}:in"


def output_key(term_id: str) -> str:
	return f"term:{term_id}:out"


def alive_key(term_id: str) -> str:
	"""Exists while a client is attached (refreshed by keepalive). Missing => idle timeout."""
	return f"term:{term_id}:alive"


def user_terms_key(user: str) -> str:
	return f"terms:{user}"
