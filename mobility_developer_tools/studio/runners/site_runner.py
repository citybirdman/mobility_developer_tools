"""Run a python file inside a Frappe site.

    python -m mobility_developer_tools.studio.runners.site_runner \
        --sites-path <bench>/sites --site <site> --user <user> path/to/script.py

The script runs as ``__main__`` with ``frappe`` connected. Changes are committed
when the script finishes without error, and rolled back otherwise.
"""

import argparse
import os
import runpy
import sys


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--sites-path", required=True)
	parser.add_argument("--site", required=True)
	parser.add_argument("--user", default="Administrator")
	parser.add_argument("script")
	args = parser.parse_args()

	import frappe

	sites_path = os.path.realpath(args.sites_path)
	os.chdir(sites_path)
	frappe.init(site=args.site, sites_path=sites_path)
	frappe.connect()
	frappe.set_user(args.user)
	sys.argv = [args.script]

	try:
		runpy.run_path(args.script, run_name="__main__")
		frappe.db.commit()
		print(f"\n\x1b[32m[site runner] finished on {args.site} - changes committed\x1b[0m")
		return 0
	except SystemExit as e:
		code = e.code if isinstance(e.code, int) else (0 if e.code is None else 1)
		if code == 0:
			frappe.db.commit()
		else:
			frappe.db.rollback()
			print(f"\n\x1b[31m[site runner] exited with {code} - changes rolled back\x1b[0m")
		return code
	except BaseException:
		frappe.db.rollback()
		import traceback

		traceback.print_exc()
		print(f"\n\x1b[31m[site runner] failed on {args.site} - changes rolled back\x1b[0m")
		return 1
	finally:
		frappe.destroy()


if __name__ == "__main__":
	sys.exit(main())
