### Mobility Developer Tools

A VS Code-like **Developer Studio** inside Frappe: file explorer, Monaco editor,
"Run File" and an interactive terminal (real PTY shell).

Open it from **Apps → Developer Tools**, or at `/app/developer-studio`.

### Installation

```bash
bench get-app $URL_OF_THIS_REPO
bench --site <site> install-app mobility_developer_tools
bench build --app mobility_developer_tools
```

### Security

The studio gives full shell access to the server as the bench user, so it is locked down:

* Only users with the **System Manager** role can open it (page, apps tile and every API call).
* It is **disabled unless** `developer_mode` is on, or `developer_studio_enabled: 1` is set in the site config.
* The user must **type their password again** to unlock it. After 5 wrong attempts they are locked out for 5 minutes.
* Unlocking issues a token that is kept only in browser memory and bound to the user **and** the login session.
  It expires after 30 minutes without activity. The **Lock** button (or `Ctrl+Shift+L`) ends it immediately.
* File access is limited to the studio root (default: the bench folder). Symlinks pointing outside the root are rejected.
* Saving, creating, renaming and deleting files, running files, unlocking (successful and failed) and opening or closing terminals
  are written to **Developer Studio Log**. Commands typed inside a terminal are *not* logged.

### Configuration (site_config.json / common_site_config.json)

| Key | Default | Meaning |
|---|---|---|
| `developer_studio_enabled` | `developer_mode` | Turn the studio on or off |
| `developer_studio_root` | bench folder | Root folder of the explorer |
| `developer_studio_session_minutes` | 30 | Minutes of inactivity before the studio locks |
| `developer_studio_terminal_idle_minutes` | 60 | How long a terminal keeps running with no browser attached |
| `developer_studio_max_terminals` | 5 | Max terminals per user |
| `developer_studio_shell` | `$SHELL` or `/bin/bash` | Shell started in terminals |

### Keyboard shortcuts

`Ctrl+P` quick open · `Ctrl+S` save · `F5` run file · `` Ctrl+` `` toggle terminal ·
`Ctrl+Shift+L` lock · `F1` editor command palette · `Ctrl+Shift+C / V` copy / paste in the terminal

### Running files

**Run** (▶ / F5) sends the command to the active terminal:

* `.py` → **Python in Frappe site**: `frappe.connect()` as you; commits on success, rolls back on error, or
  **Python (bench env)**
* `.sh` → bash · `.js` → node

Other apps can add runners with the `developer_studio_runners` hook. Each entry is a dotted path to a
`mobility_developer_tools.studio.runners.base.ScriptRunner` subclass.

### AI assistants (Claude Code, Antigravity)

Open the **AI Assistants** view (✦ in the activity bar):

1. **Install** runs the official installer in a terminal, for the bench Linux user, after you confirm:
   * Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
   * Antigravity CLI (`agy`): `curl -fsSL https://antigravity.google/cli/install.sh | bash`
2. **Open** starts the tool in a maximized terminal tab, in the folder selected in the Explorer.
   You can also right-click a folder and choose **Open Claude Code Here**.
3. **Sign in.** The server has no browser, so when a tool wants to open a sign-in page you get an
   **Open** prompt in the studio. Links in the terminal are also clickable. Sign in, then paste the code
   back into the terminal if the tool asks for one.

**Everything is stored in the site folder** (mode 0700), so it belongs to that site only and survives
bench redeploys:

```
sites/<site>/private/mobility_developer_tools/
    tools-home/          installed CLIs and their auto-updates (installers run with HOME set here)
    profiles/<user>/     each Frappe user's sign-in, settings and history
    shims/               browser shim for sign-in links
```

* Claude Code: `HOME` is the site's `tools-home`, and `CLAUDE_CONFIG_DIR` is the user's profile folder.
* Antigravity: the binary comes from `tools-home`. `HOME` and the `XDG_*` folders point to the user's profile
  folder, and it is started in remote (SSH-style) mode so it prints a sign-in link.
* If a tool is only installed server-wide (`~/.local/bin`), it still works, and the card offers **Install into site**.
* The explorer hides the other sites' folders and this sign-in folder. **The terminal does not**: it is a
  shell as the bench Linux user and can read any file on the bench.
* This folder is **not** part of `bench backup --with-files`, which only covers `public/files` and `private/files`.
  After restoring a site somewhere else, install the tools again and sign in again.

The tools can read, change and run anything the bench user can, the same as the terminal. Both CLIs ask
for permission before editing files or running commands. Review what you approve.

Other apps can add assistants with the `developer_studio_ai_tools` hook. Each entry is a dotted path to a
`mobility_developer_tools.studio.ai_tools.base.AiTool` subclass.

### Architecture (SOLID)

```
studio/
  config.py            StudioConfig: reads settings only
  kv.py                KeyValueStore protocol + Redis implementation
  security/access.py   AccessPolicy: role and feature flag
  security/session.py  StudioSessionService: password re-auth, lockout, session tokens
  files/path_guard.py  PathGuard: keeps every path inside the root
  files/service.py     FileReader / FileWriter protocols + LocalFileService
  runners/             ScriptRunner ABC, built-in runners, RunnerRegistry (open for extension)
  terminal/            TerminalManager (web side), PtyTerminalHost (detached PTY process),
                       LaunchSpec (shell or program + env), OutputPublisher (socket.io),
                       ProcessSpawner, shared protocol
  ai_tools/            AiTool ABC, Claude Code / Antigravity, AiToolRegistry (hook),
                       AiToolService (status, install/start specs, per-user profiles),
                       open_url.py (browser shim -> "Open" prompt in the page)
  audit.py             AuditLogger protocol + DocType implementation
  container.py         composition root: the only place that picks concrete classes
  api.py               thin whitelisted endpoints (+ @studio_endpoint guard)
public/js/developer_studio/
  core/                api client, event bus, asset loader, languages, run service
  ui/                  lock screen, explorer, editor, quick open, status bar, layout, context menu
  terminal/            transport (realtime + polling + ordered input), session (xterm), panel
  studio.js            front-end composition root
```

**How the terminal works.** Each terminal is a small detached Python process that owns a pseudo terminal
running a login shell. Keystrokes go from the browser to the API, then into a Redis list that the process reads.
Output is pushed back through Frappe's socket.io. The last chunks are also kept in Redis, so the browser can
re-attach after a reload or fall back to polling when socket.io is down. A terminal survives page reloads and
closes after `developer_studio_terminal_idle_minutes` with no browser attached.

Vendored libraries: Monaco Editor 0.52.2 and xterm.js 5.5.0 (MIT) in `public/lib`.
