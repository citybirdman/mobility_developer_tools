from mobility_developer_tools.studio.runners.base import RunContext, ScriptRunner


class PythonRunner(ScriptRunner):
	key = "python"
	label = "Python (bench env)"
	extensions = (".py",)

	def build_args(self, abs_path, ctx: RunContext):
		return [ctx.python, abs_path]


class FrappePythonRunner(ScriptRunner):
	"""Runs a .py file inside the current site (frappe.connect, session user,
	commit on success / rollback on error)."""

	key = "frappe"
	label = "Python in Frappe site"
	extensions = (".py",)

	def build_args(self, abs_path, ctx: RunContext):
		return [
			ctx.python,
			"-m",
			"mobility_developer_tools.studio.runners.site_runner",
			"--sites-path",
			ctx.sites_path,
			"--site",
			ctx.site,
			"--user",
			ctx.user,
			abs_path,
		]


class ShellRunner(ScriptRunner):
	key = "bash"
	label = "Bash"
	extensions = (".sh", ".bash")

	def build_args(self, abs_path, ctx):
		return ["bash", abs_path]


class NodeRunner(ScriptRunner):
	key = "node"
	label = "Node.js"
	extensions = (".js", ".mjs", ".cjs")

	def build_args(self, abs_path, ctx):
		return ["node", abs_path]
