from mobility_developer_tools.studio.ai_tools.base import AiTool, ToolContext


class ClaudeCodeTool(AiTool):
	key = "claude"
	label = "Claude Code"
	icon = "sparkle"
	binary = "claude"
	install_command = "curl -fsSL https://claude.ai/install.sh | bash"
	docs_url = "https://code.claude.com/docs"
	sign_in_hint = (
		"Sign in: choose a login method, then click the long sign-in link printed below "
		"(ignore any 'Opening browser' message). After signing in, copy the code shown and "
		"paste it here with Ctrl+V, then press Enter."
	)

	def env(self, ctx: ToolContext):
		return {
			# the native installer and auto-updates live in ~/.local -> keep them in the site folder
			"HOME": ctx.profile.tools_home,
			# settings, history and credentials live in the user's own folder
			"CLAUDE_CONFIG_DIR": ctx.profile.dir("claude"),
		}


class AntigravityTool(AiTool):
	key = "antigravity"
	label = "Antigravity"
	icon = "rocket"
	binary = "agy"
	install_command = "curl -fsSL https://antigravity.google/cli/install.sh | bash"
	docs_url = "https://antigravity.google/docs/cli/overview"
	sign_in_hint = "Click the Google sign-in link that appears, sign in, then come back to the terminal."

	def env(self, ctx: ToolContext):
		# agy keeps its sign-in under HOME / XDG folders -> the user's own folder
		return {
			"HOME": ctx.profile.dir("antigravity-home"),
			"XDG_CONFIG_HOME": ctx.profile.dir("antigravity-home", ".config"),
			"XDG_DATA_HOME": ctx.profile.dir("antigravity-home", ".local", "share"),
			"XDG_CACHE_HOME": ctx.profile.dir("antigravity-home", ".cache"),
			# agy prints a sign-in URL (instead of opening a local browser) for remote sessions
			"SSH_CONNECTION": "127.0.0.1 0 127.0.0.1 22",
			"SSH_CLIENT": "127.0.0.1 0 22",
		}
