"""What a terminal runs. Default: an interactive login shell. A LaunchSpec can
instead run a program (e.g. an AI CLI) with extra environment variables."""

import base64
import json
from dataclasses import asdict, dataclass, field


@dataclass
class LaunchSpec:
	argv: list[str] | None = None  # None => login shell
	env: dict[str, str] = field(default_factory=dict)  # added / overridden variables
	path_prepend: list[str] = field(default_factory=list)  # dirs put in front of PATH
	title: str | None = None
	kind: str = "shell"  # shell | ai | install

	def encode(self) -> str:
		return base64.urlsafe_b64encode(json.dumps(asdict(self)).encode()).decode()

	@classmethod
	def decode(cls, value: str | None) -> "LaunchSpec":
		if not value:
			return cls()
		return cls(**json.loads(base64.urlsafe_b64decode(value.encode())))
