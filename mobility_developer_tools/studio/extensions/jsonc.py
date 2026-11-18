"""JSON with comments and trailing commas (the format VS Code uses for themes,
snippets, language configurations and package.json files)."""

from __future__ import annotations

import json


def loads(text: str | bytes):
	if isinstance(text, bytes):
		text = text.decode("utf-8-sig", errors="replace")
	elif text.startswith("﻿"):
		text = text[1:]
	return json.loads(strip(text))


def strip(text: str) -> str:
	"""Remove // and /* */ comments and trailing commas, leaving strings untouched."""
	out: list[str] = []
	i, n = 0, len(text)
	while i < n:
		ch = text[i]
		if ch == '"':
			j = i + 1
			while j < n:
				if text[j] == "\\":
					j += 2
					continue
				if text[j] == '"':
					break
				j += 1
			out.append(text[i : j + 1])
			i = j + 1
		elif ch == "/" and i + 1 < n and text[i + 1] == "/":
			while i < n and text[i] not in "\r\n":
				i += 1
		elif ch == "/" and i + 1 < n and text[i + 1] == "*":
			end = text.find("*/", i + 2)
			i = n if end < 0 else end + 2
		elif ch in "}]":
			# drop a trailing comma before the closing bracket
			k = len(out) - 1
			while k >= 0 and out[k].isspace():
				k -= 1
			if k >= 0 and out[k] == ",":
				del out[k]
			out.append(ch)
			i += 1
		else:
			out.append(ch)
			i += 1
	return "".join(out)
