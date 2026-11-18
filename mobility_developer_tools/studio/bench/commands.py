"""Built-in bench / Frappe commands (one class per command)."""

from __future__ import annotations

from frappe import _

from mobility_developer_tools.studio.bench.base import (
	GIT_REF_RE,
	GIT_URL_RE,
	BenchCommand,
	BenchContext,
	CommandField,
	CommandLine,
	validate_app_name,
)
from mobility_developer_tools.studio.exceptions import StudioCommandError

# -- Site ----------------------------------------------------------------------------


class MigrateCommand(BenchCommand):
	key = "migrate"
	label = "Migrate"
	icon = "database"
	description = "Run patches and sync DocTypes for this site"

	def fields(self, ctx):
		return [CommandField("skip_failing", "Skip failing patches", "Check", default=0)]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		return self.frappe_cli(ctx, "migrate", *(["--skip-failing"] if values["skip_failing"] else []))


class ClearCacheCommand(BenchCommand):
	key = "clear-cache"
	label = "Clear Cache"
	icon = "clear-all"
	description = "Clear the cache of this site"

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.frappe_cli(ctx, "clear-cache")


class ClearWebsiteCacheCommand(BenchCommand):
	key = "clear-website-cache"
	label = "Clear Website Cache"
	icon = "globe"

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.frappe_cli(ctx, "clear-website-cache")


class BackupCommand(BenchCommand):
	key = "backup"
	label = "Backup"
	icon = "archive"
	description = "Back up the database (optionally with files)"

	def fields(self, ctx):
		return [CommandField("with_files", "Include files", "Check", default=0)]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		return self.frappe_cli(ctx, "backup", *(["--with-files"] if values["with_files"] else []))


class SchedulerCommand(BenchCommand):
	key = "scheduler"
	label = "Scheduler"
	icon = "watch"
	STATES = ("status", "enable", "disable", "pause", "resume")

	def fields(self, ctx):
		return [CommandField("state", "Action", "Select", list(self.STATES), reqd=True, default="status")]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		return self.frappe_cli(ctx, "scheduler", values["state"])


class MaintenanceModeCommand(BenchCommand):
	key = "maintenance-mode"
	label = "Maintenance Mode"
	icon = "tools"
	danger = True
	description = "Turn maintenance mode on (users are logged out) or off"

	def fields(self, ctx):
		return [CommandField("state", "Maintenance mode", "Select", ["on", "off"], reqd=True, default="off")]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		return self.frappe_cli(ctx, "set-maintenance-mode", values["state"])


class DoctorCommand(BenchCommand):
	key = "doctor"
	label = "Doctor"
	icon = "pulse"
	description = "Check scheduler and background workers"

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.frappe_cli(ctx, "doctor")


# -- Apps ----------------------------------------------------------------------------


class ListAppsCommand(BenchCommand):
	key = "list-apps"
	label = "List Apps"
	group = "Apps"
	icon = "list-unordered"

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.frappe_cli(ctx, "list-apps")


class InstallAppCommand(BenchCommand):
	key = "install-app"
	label = "Install Apps"
	group = "Apps"
	icon = "add"
	description = "Install one or more apps of this bench on this site (in the order selected)"

	def _candidates(self, ctx):
		return [a for a in ctx.bench_apps if a not in ctx.installed_apps]

	def fields(self, ctx):
		return [CommandField("apps", "Apps", "MultiCheck", self._candidates(ctx), reqd=True)]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		apps = [validate_app_name(app, self._candidates(ctx)) for app in values["apps"]]
		return self.frappe_cli(ctx, "install-app", *apps)  # Frappe installs several apps in one run


class UninstallAppCommand(BenchCommand):
	key = "uninstall-app"
	label = "Uninstall App"
	group = "Apps"
	icon = "trash"
	danger = True
	description = "Remove an app and its DocTypes/data from this site (a backup is taken first)"
	PROTECTED = ("frappe", "mobility_developer_tools")

	def _candidates(self, ctx):
		return [a for a in ctx.installed_apps if a not in self.PROTECTED]

	def fields(self, ctx):
		return [CommandField("app", "App", "Select", self._candidates(ctx), reqd=True)]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		# interactive: Frappe asks for confirmation in the terminal
		return self.frappe_cli(ctx, "uninstall-app", validate_app_name(values["app"], self._candidates(ctx)))


class GetAppCommand(BenchCommand):
	key = "get-app"
	label = "Get Apps"
	group = "Apps"
	icon = "repo-clone"
	description = "Clone one or more apps into this bench (then install them with Install Apps)"

	def is_available(self, ctx):
		return bool(ctx.bench_cli)

	def fields(self, ctx):
		return [
			CommandField(
				"repos",
				"Repositories",
				"Lines",
				reqd=True,
				description="One per line: URL [branch]  e.g. https://github.com/frappe/hrms version-15",
			)
		]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		lines = []
		for entry in values["repos"]:
			url, *rest = entry.split()
			if not GIT_URL_RE.match(url):
				raise StudioCommandError(_("Invalid git URL: {0}").format(url))
			if len(rest) > 1:
				raise StudioCommandError(_("Use 'URL [branch]' on each line: {0}").format(entry))
			args = ["get-app", url]
			if rest:
				if not GIT_REF_RE.match(rest[0]):
					raise StudioCommandError(_("Invalid branch: {0}").format(rest[0]))
				args += ["--branch", rest[0]]
			lines.append(self.bench_cli(ctx, *args))
		return self.sequence(ctx, lines)


# -- Bench ---------------------------------------------------------------------------


class BuildCommand(BenchCommand):
	key = "build"
	label = "Build Assets"
	group = "Bench"
	icon = "package"
	ALL = "All apps"

	def fields(self, ctx):
		return [CommandField("app", "App", "Select", [self.ALL, *ctx.bench_apps], reqd=True, default=self.ALL)]

	def build(self, ctx, values):
		values = self.clean(ctx, values)
		if values["app"] == self.ALL:
			return self.frappe_cli(ctx, "build", site=False)
		return self.frappe_cli(ctx, "build", "--app", validate_app_name(values["app"], ctx.bench_apps), site=False)


class RestartCommand(BenchCommand):
	key = "restart"
	label = "Restart"
	group = "Bench"
	icon = "debug-restart"
	danger = True
	description = "Restart web and worker processes (supervisor / systemd)"

	def is_available(self, ctx):
		return bool(ctx.bench_cli)

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.bench_cli(ctx, "restart")


class VersionCommand(BenchCommand):
	key = "version"
	label = "Versions"
	group = "Bench"
	icon = "versions"

	def build(self, ctx, values):
		self.clean(ctx, values)
		return self.frappe_cli(ctx, "version", site=False)


BUILTIN_COMMANDS: tuple[type[BenchCommand], ...] = (
	MigrateCommand,
	ClearCacheCommand,
	ClearWebsiteCacheCommand,
	BackupCommand,
	SchedulerCommand,
	MaintenanceModeCommand,
	DoctorCommand,
	ListAppsCommand,
	InstallAppCommand,
	UninstallAppCommand,
	GetAppCommand,
	BuildCommand,
	RestartCommand,
	VersionCommand,
)


def console_command_line(ctx: BenchContext) -> CommandLine:
	"""`bench --site <site> console` (IPython with frappe connected)."""
	return BenchCommand.frappe_cli(ctx, "console")
