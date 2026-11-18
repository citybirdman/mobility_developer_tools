"""Standalone test runner (no `allow_tests` needed, nothing is committed).

    cd frappe-bench/sites
    ../env/bin/python -m mobility_developer_tools.tests.runner --site <site> [--quick] [-k pattern]

    --quick   security + unit tests only (skips scalability and performance)
"""

import argparse
import os
import sys
import unittest


def main() -> int:
	parser = argparse.ArgumentParser()
	parser.add_argument("--site", required=True)
	parser.add_argument("--sites-path", default=".")
	parser.add_argument("--quick", "--skip-stress", dest="quick", action="store_true")
	parser.add_argument("-k", dest="pattern", default=None, help="only tests whose id contains this text")
	args = parser.parse_args()

	import frappe

	os.environ["MDT_TEST_SITE"] = args.site
	frappe.init(site=args.site, sites_path=args.sites_path)
	frappe.connect()
	frappe.set_user("Administrator")

	try:
		loader = unittest.TestLoader()
		suite = loader.discover(os.path.dirname(__file__), pattern="test_*.py", top_level_dir=_top_level())
		tests = [t for t in _flatten(suite)]
		if args.quick:
			tests = [t for t in tests if ".test_scalability." not in t.id() and ".test_performance." not in t.id()]
		if args.pattern:
			tests = [t for t in tests if args.pattern in t.id()]
		result = unittest.TextTestRunner(verbosity=2).run(unittest.TestSuite(tests))
		return 0 if result.wasSuccessful() else 1
	finally:
		frappe.db.rollback()
		frappe.destroy()


def _top_level():
	# apps/mobility_developer_tools  (so test modules import as mobility_developer_tools.tests.*)
	return os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _flatten(suite):
	for item in suite:
		if isinstance(item, unittest.TestSuite):
			yield from _flatten(item)
		else:
			yield item


if __name__ == "__main__":
	sys.exit(main())
