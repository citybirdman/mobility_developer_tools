"""Run several commands one after another in a studio terminal (no shell).

    python -m mobility_developer_tools.studio.bench.sequence '[{"argv": [...], "cwd": "..."}, ...]'

The steps are built and validated by BenchCommand classes; this only executes them,
showing a header per step and stopping at the first failure.
"""

import json
import subprocess
import sys


def main() -> int:
	steps = json.loads(sys.argv[1])
	for number, step in enumerate(steps, 1):
		shown = " ".join(["bench", *step["argv"][1:]]) if step["argv"][0].endswith("bench") else " ".join(step["argv"])
		print(f"\n\x1b[1;36m[{number}/{len(steps)}] {shown}\x1b[0m", flush=True)
		code = subprocess.call(step["argv"], cwd=step["cwd"])
		if code != 0:
			print(f"\n\x1b[31mStopped: step {number} failed with exit code {code}\x1b[0m", flush=True)
			return code
	print(f"\n\x1b[32mAll {len(steps)} steps finished\x1b[0m", flush=True)
	return 0


if __name__ == "__main__":
	sys.exit(main())
