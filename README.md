## Mobility Developer Tools

A VS Code-like **Developer Studio** inside Frappe, for System Managers: browse, edit, search and run the bench's
files, use a real terminal, run bench commands, work in the bench console, use Claude Code / Antigravity, and install
VS Code extensions. No extra server is needed.

Open it from **Apps → Developer Tools**, at `/developer-studio`, or at `/app/developer-studio`.

### Features at a glance

| Area | What you get |
|---|---|
| [Workbench](#workbench) | Full-screen VS Code layout (activity bar, side bar, editor, panel, status bar), resizable, layout remembered, light/dark follows Frappe's theme |
| [Explorer and editor](#explorer-and-editor) | File tree with create / rename / delete / copy path, Monaco editor with tabs, Quick Open, conflict-safe saving |
| [Search](#search-find--replace-in-files) | Find / replace in files with match case, whole word, regex, include / exclude globs |
| [Go to Definition](#go-to-definition) | `F12` on Python names and on dotted paths in strings (`hooks.py`, `frappe.call`) |
| [Live file updates](#live-file-updates) | Open files and the explorer refresh when files change elsewhere |
| [Running files](#running-files) | ▶ / `F5` runs Python (inside the site or the bench env), shell and node scripts |
| [Terminal](#terminal) | Interactive PTY terminals that survive page reloads, with copy / paste keys |
| [Frappe & Bench panel](#frappe--bench-panel) | Migrate, cache, backup, install / uninstall / get apps (several at once), build, restart... |
| [Bench console as a file](#bench-console-as-a-file) | Write Python in an editor tab and run it in `bench console` with `Ctrl+Enter` |
| [AI assistants](#ai-assistants-claude-code-antigravity) | Install, sign in to and use Claude Code and Antigravity, stored per site |
| [Extensions](#extensions-vs-code-extensions-no-extra-server) | VS Code extensions from Open VSX or `.vsix`: themes, icons, grammars, snippets and sandboxed web extensions, with a compatibility check |
| [Command palette and dialogs](#command-palette-and-dialogs) | `F1` palette, VS Code-style dialogs for Frappe messages |
| [Security](#security) | System Manager only, password re-entry, path guard, audit log |

### Requirements and installation

* Frappe v15 (`>=15,<17`) on Linux, with Redis (as every bench has). Python 3.10+.
* Python dependency: `jedi` (already installed with IPython in a bench).

```bash
bench get-app $URL_OF_THIS_REPO
bench --site <site> install-app mobility_developer_tools
bench build --app mobility_developer_tools
bench restart
```

The studio is **off unless** `developer_mode` is on for the site, or `developer_studio_enabled: 1` is set in the site config.

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

| Keys | Action |
|---|---|
| `F1` | Command palette (works with no file open) |
| `Ctrl+P` | Quick Open (go to file) |
| `Ctrl+Shift+F` / `Ctrl+Shift+H` | Search / replace in files |
| `Ctrl+Shift+X` | Extensions |
| `Ctrl+S` | Save |
| `F5` | Run the current file |
| `F12`, `Ctrl+click`, `Alt+F12` | Go to definition / peek definition |
| `` Ctrl+` `` | Toggle the terminal |
| `Ctrl+Enter` / `Shift+Enter` | Console tab: run the selection or the whole tab / the current line |
| `Ctrl+Shift+L` | Lock the studio |
| `Alt+C` / `Alt+W` / `Alt+R` | Search view: match case / whole word / regex |
| `Ctrl+Shift+C` / `Ctrl+Shift+V` | Copy / paste in the terminal (see [Terminal](#terminal)) |

Studio shortcuts work wherever the focus is in the studio, including when no file is open. Frappe's own desk
shortcuts are kept out of the studio, and `F12` never opens the browser's developer tools while the studio is shown.

### Workbench

* **Full screen.** Frappe's header is hidden while the studio is shown. Your avatar at the bottom of the activity bar
  opens your profile, **Back to Desk**, **Lock Studio** and **Log Out**.
* **Activity bar:** Explorer, Search, AI Assistants, Frappe & Bench, Extensions, Toggle Terminal, Lock.
  Clicking the active view again hides the side bar, as in VS Code.
* **Layout:** drag the borders to resize the side bar and the panel. Sizes and visibility are remembered in the browser.
  The panel can be maximized.
* **Theme:** the built-in dark (dark grey, not black) and light themes follow Frappe's theme live, including Frappe's
  "Automatic" (operating system) mode. A color theme from an extension replaces them; see [Extensions](#extensions-vs-code-extensions-no-extra-server).
* **Status bar:** lock, site, root folder, cursor position, language and items added by extensions.

### Explorer and editor

* **Explorer:** lazy-loaded tree of the studio root. Right-click for New File / New Folder, Rename, Delete, Copy Path,
  Copy Relative Path, Open in Terminal, Find in Folder, Run and Open Claude Code / Antigravity Here.
  Other sites' folders and the studio's private data folder are hidden and blocked.
* **Editor:** Monaco (the VS Code editor) with tabs, breadcrumbs, dirty markers, language detection and syntax
  highlighting. Files up to 5 MB; binary files are refused. Read-only files open read-only.
* **Saving** is atomic (temporary file + rename, keeping the file mode) and conflict-safe: if the file changed on disk
  after you opened it, the save is refused instead of overwriting someone else's change.
* **Quick Open** (`Ctrl+P`): fuzzy file search across the root.
* Leaving the page with unsaved changes asks for confirmation.

### Search (find / replace in files)

The magnifier in the activity bar (or **Ctrl+Shift+F**, **Ctrl+Shift+H** for replace) opens the Search view, as in VS Code.
The search box is filled with the editor's selected text.

* Search as you type, with **Match Case** (`Alt+C`), **Whole Word** (`Alt+W`) and **Regular Expression** (`Alt+R`)
  toggles. `Shift+Enter` adds a line for multi-line searches.
* **Files to include / exclude** (the `...` button): comma separated globs such as `*.py`, `apps/frappe/**`, `*.{js,ts}`.
  A bare name like `tests` matches that folder anywhere, and `./apps/x` matches only from the root.
  In the Explorer, right-click a folder and choose **Find in Folder...**
* Results are grouped by file, with match counts and highlighted previews; files with many matches start collapsed.
  Click a match to open the file with the match selected; double-click or `Enter` moves the focus into the editor.
  Use `↑ ↓ ← →` in the results, and `✕` or `Delete` to dismiss a match or a file. The title bar has Refresh, Clear and
  Collapse All.
* **Replace:** per match, per file or **Replace All** (asks first). The results show the old text struck through and the
  new text in green. Regex replace understands `$1`, `$<name>`, `$&`, `$$` and `\n`.
  A file that changed since the search, or that is open with unsaved changes, is never overwritten. Open editors reload
  right away, and every replace is written to the audit log.
* The query and options are remembered.
* **Limits:** 5000 matches, 1000 files, files up to 2 MB, 15 s per search. Binary files, `node_modules`, `env`, `.git`,
  `assets`, `logs`, hidden folders and blocked folders (other sites, stored sign-ins) are skipped.
  A search of a whole bench (~28,000 files) takes about 1.5 s, or about 4 s with a regular expression.

### Go to Definition

`F12` (or `Ctrl+click`, `Alt+F12` to peek) on a name in a **Python** file jumps to its definition, opening the file in a
new tab. It uses **Jedi** with the bench's own environment, so `frappe`, your apps and their imports resolve, and
nothing is imported or executed. Definitions in the same file work even before you save.

It also works on **dotted paths in strings**, in Python and JavaScript: `hooks.py` entries (`"app.module.function"`),
`frappe.call({ method: "..." })`, `frappe.get_attr("...")`.
Definitions outside the studio root (e.g. the Python standard library) or in other sites' folders are not shown.

### Live file updates

Changes made outside the studio show up on their own: another browser tab, a terminal, git, Claude, a Search replace,
or another user.

* **Open file, no unsaved edits:** reloads in place. Cursor, scroll and undo history are kept.
* **Open file with unsaved edits:** a bar offers **Reload (discard mine)** or **Keep Mine**. Keep Mine means your next save
  overwrites the disk version. The file is never replaced silently.
* **Deleted on disk:** the tab is struck through, and saving creates the file again.
* **Explorer:** expanded folders refresh when entries are added, removed or renamed.

The page polls `watch` every 2 s with the open files and expanded folders (at most 200 of each). Polling pauses
when the page is hidden or the studio is locked, and backs off after errors.

A file's version is its mtime in nanoseconds plus its size plus its inode, not the mtime alone, because the kernel
updates mtime on a coarse clock tick. Atomic saves (the studio's, most editors', git's) change the inode, so they are
always detected. Polling is used instead of inotify because a web worker cannot reach a browser connected through
another worker, and inotify limits run out quickly on a bench.

### Running files

**Run** (▶ / `F5`, or right-click → Run) sends the command to the active terminal:

* `.py` → **Python in Frappe site** (`frappe.connect()` as you; commits on success, rolls back on error), or
  **Python (bench env)**
* `.sh` → bash · `.js` → node

Other apps can add runners with the `developer_studio_runners` hook. Each entry is a dotted path to a
`mobility_developer_tools.studio.runners.base.ScriptRunner` subclass.

### Terminal

Real interactive terminals (PTY, login shell as the bench Linux user) in the bottom panel: several tabs, new / kill /
clear, maximize, clickable links (also links wrapped across lines). A terminal keeps running across page reloads and
closes after `developer_studio_terminal_idle_minutes` with no browser attached.

| Keys | Action |
|---|---|
| `Ctrl+V`, `Ctrl+Shift+V`, `Shift+Insert` | Paste (uses the browser's paste, so it also works on plain http) |
| `Ctrl+C` | Copy when text is selected, otherwise interrupt (SIGINT) |
| `Ctrl+Shift+C`, `Ctrl+Insert` | Copy |
| `Ctrl+Shift+A` | Select all |
| Right click | Copy / Paste / Select All / Clear / Kill |
| Alt (macOS Option) | Meta, e.g. `Alt+B` / `Alt+F` word jumps |

Browsers never let a page capture `Ctrl+W`, `Ctrl+T` or `Ctrl+N`. Menu **Paste** needs HTTPS, but `Ctrl+V` always works.

### Frappe & Bench panel

Commands for **this site only** (there is no site input):

| Group | Commands |
|---|---|
| Site | Migrate, Clear Cache, Clear Website Cache, Backup, Scheduler, Maintenance Mode, Doctor |
| Apps | List Apps, **Install Apps** (tick several apps of the bench that are not on the site yet), Uninstall App (not frappe / this app), **Get Apps** (one `URL [branch]` per line) |
| Bench | Build Assets, Restart, Versions |
| Console | **Open Console** (see below) |

* Installing several apps runs one `install-app` with all of them. Getting several apps runs `bench get-app` for each
  line, in order, and stops at the first failure. At most 20 entries per run.
* Commands run in a terminal tab through `frappe.utils.bench_helper`, so they work without the `bench` CLI. Get App and
  Restart need the CLI and are hidden where it is missing.
* Inputs are validated against each command's fields and passed as an argument list, never through a shell.
  Dangerous commands ask for confirmation. Every run is written to **Developer Studio Log**.
* Other apps can add commands with the `developer_studio_bench_commands` hook (`BenchCommand` subclasses).

### Bench console as a file

**Frappe & Bench → Open Console** (or `F1` → *Bench: Open Console*) opens a **Console** editor tab plus a
`bench --site <site> console` terminal. Write Python as you would in a file:

* `Ctrl+Enter` (or ▶) runs the selection, or the whole tab.
* `Shift+Enter` runs the current line.

Code is sent to IPython as one block (bracketed paste), so variables are kept between runs, as in Jupyter. The tab's
content is saved in your browser for each user and site.

### AI assistants (Claude Code, Antigravity)

Open the **AI Assistants** view (✦ in the activity bar):

1. **Install** runs the official installer in a terminal, for the bench Linux user, after you confirm:
   * Claude Code: `curl -fsSL https://claude.ai/install.sh | bash`
   * Antigravity CLI (`agy`): `curl -fsSL https://antigravity.google/cli/install.sh | bash`
2. **Open** starts the tool in a new terminal tab (the panel keeps its size), in the folder selected in the Explorer.
   You can also right-click a folder and choose **Open Claude Code Here**.
3. **Sign in.** The server has no browser, so when a tool wants to open a sign-in page you get an
   **Open** prompt in the studio. Links in the terminal are also clickable, even when wrapped. Sign-in links that point
   back to `localhost` are handled, so the tool falls back to showing a code. Sign in, then paste the code back into the
   terminal if the tool asks for one.

**Everything is stored in the site folder** (mode 0700), so it belongs to that site only, survives bench redeploys and
does not need to be installed again on each deploy:

```
sites/<site>/private/mobility_developer_tools/
    tools-home/          installed CLIs and their auto-updates (installers run with HOME set here)
    profiles/<user>/     each Frappe user's sign-in, settings and history
    shims/               browser shim for sign-in links
    extensions/          installed VS Code extensions
```

* Claude Code: `HOME` is the site's `tools-home`, and `CLAUDE_CONFIG_DIR` is the user's profile folder.
* Antigravity: the binary comes from `tools-home`. `HOME` and the `XDG_*` folders point to the user's profile
  folder, and it is started in remote (SSH-style) mode so it prints a sign-in link.
* If a tool is only installed server-wide (`~/.local/bin`), it still works, and the card offers **Install into site**.
* The explorer and the search hide the other sites' folders and this folder. **The terminal does not**: it is a
  shell as the bench Linux user and can read any file on the bench.
* This folder is **not** part of `bench backup --with-files`, which only covers `public/files` and `private/files`.
  After restoring a site somewhere else, install the tools again and sign in again.

The tools can read, change and run anything the bench user can, the same as the terminal. Both CLIs ask
for permission before editing files or running commands. Review what you approve.

Other apps can add assistants with the `developer_studio_ai_tools` hook. Each entry is a dotted path to a
`mobility_developer_tools.studio.ai_tools.base.AiTool` subclass.

### Extensions (VS Code extensions, no extra server)

**Extensions** in the activity bar (`Ctrl+Shift+X`): search **Open VSX**, or install a `.vsix` file.
Every extension is **checked before installing**. The report shows what will work, what will not, and why
(Works / Partly works / Not supported).

| Level | What works | How |
|---|---|---|
| 1 (no code) | Color themes, file icon themes, syntax grammars (VS Code's own TextMate engine), languages, snippets | Read from the package and applied to Monaco and the studio |
| 2 (code) | Web builds (`"browser"` entry) that use the supported API | Each extension runs in its own **sandbox** |

* **Supported API** (see `studio/extensions/api_support.json`, the single source used by both the checker and the runtime tests):
  * commands (shown in the F1 palette, with keybindings),
  * messages, input boxes and quick picks,
  * status bar items, output channels and progress,
  * text edits, snippets, decorations and diagnostics,
  * settings (editable per extension) and `workspace.fs` for the extension's own files,
  * completion, hover, definition, references, rename, formatting, symbols, folding, code actions, signature help,
    links and inlay hints.
* **Not available:** webviews, tree views, terminals, debuggers, tasks, SCM, language servers, Node.js-only (desktop)
  builds. The checker lists these per extension.
* **Sandbox:** a hidden `sandbox="allow-scripts"` iframe (opaque origin: no studio, no cookies, no Frappe session) with
  a CSP of `connect-src 'none'` (no network), running a Web Worker. A busy extension cannot freeze the page, and an
  unresponsive one is stopped. Extension markdown is never trusted, decoration CSS is sanitized, and status bar and
  message text is plain text.
* **Downloads:** only from Open VSX hosts, and only when the published SHA-256 matches. Packages are checked for path
  traversal, symlinks and zip bombs. Extensions are stored per site in `<site>/private/mobility_developer_tools/extensions/`.
* **Themes:** installing a color theme or a file icon theme asks whether to use it now. You can switch any time with
  **Color Theme** and **File Icons** in the Extensions view; the choice is saved for your user. A color theme also restyles
  the studio panels, the terminal and the dialogs.
* Installed extensions can be disabled, enabled, configured or uninstalled, and their output log can be viewed.

### Command palette and dialogs

* **`F1`** opens the studio command palette: Go to File, Find / Replace in Files, Toggle Terminal, New Terminal,
  Open Console, Show Explorer / Extensions / Frappe & Bench / AI Assistants, Lock, Back to Desk, plus every
  command contributed by extensions.
* **Dialogs:** while the studio is shown, `frappe.msgprint`, `frappe.confirm` and `frappe.warn` (including messages from
  the server) appear as a VS Code-style dialog: centered, a type icon (info, question, warning, error, success), buttons
  bottom-right, `Enter` for the primary button, `Esc` to cancel. Messages that arrive together are merged into one dialog.
  Message features it does not support (tables, wide dialogs, server actions) fall back to Frappe's dialog. Frappe's form
  dialogs are centered and use the studio's colors. On other Frappe pages nothing changes.

### Security

The studio gives full shell access to the server as the bench user, so it is locked down:

* Only users with the **System Manager** role can open it (page, apps tile and every API call).
* It is **disabled unless** `developer_mode` is on, or `developer_studio_enabled: 1` is set in the site config.
* The user must **type their password again** the first time they open it. After 5 wrong attempts they are locked out
  for 5 minutes.
* Unlocking issues a random token. The browser remembers it (localStorage), so the password is asked only on first
  entry, but the server binds it to the user **and** the Frappe login session: it stops working on log out or in another
  session. It expires after `developer_studio_session_minutes` without activity. **Lock** (or `Ctrl+Shift+L`) ends it immediately.
* Every endpoint is POST-only and checks role, feature flag and token.
* File access (explorer, editor, search, replace, go to definition) is limited to the studio root (default: the bench
  folder). Path traversal and symlinks pointing outside the root are rejected. Other sites' folders and the studio's
  private data folder are blocked.
* Saving, creating, renaming, deleting, replacing in files, running files and bench commands, unlocking (successful and
  failed) and opening or closing terminals are written to **Developer Studio Log**. Commands typed inside a terminal are
  *not* logged.

### Tests

```bash
cd frappe-bench/sites
../env/bin/python -m mobility_developer_tools.tests.runner --site <site>          # everything (~60 s)
../env/bin/python -m mobility_developer_tools.tests.runner --site <site> --quick  # security + unit (~3 s)
../env/bin/python -m mobility_developer_tools.tests.runner --site <site> -k test_search
cd .. && node --test apps/mobility_developer_tools/mobility_developer_tools/tests/js/   # front-end logic
```

No `allow_tests` is needed, and nothing is committed. The tests also run under `bench run-tests` when that is enabled.

| Suite | What it proves |
|---|---|
| `test_security_files` | Path traversal (8 forms), symlink escape, blocked folders, root protection, binary and size limits, conflict versions (including two writes within one clock tick) |
| `test_security_session` | Password lockout, random tokens bound to user and login session, expiry, role and feature-flag checks |
| `test_security_api` | Every endpoint guarded, POST-only, closed to guests; injection attempts on bench commands; anonymous HTTP against the live server |
| `test_security_commands` | No shell in command lines, argument validation (including multiple apps / repos), safe quoting of run commands, URL handling of the browser shim |
| `test_security_extensions` | .vsix traversal, symlinks and zip bombs; CSS injection via themes; contribution paths escaping the package; registry host allow-list and checksum; extension files confined; API scan accuracy |
| `test_search` | Search options, regex, globs, UTF-16 columns, previews, limits and time budget; blocked folders and symlink escapes never searched or replaced; replace with groups, single matches, conflict detection, file mode, non-UTF-8 refusal |
| `test_code_intel` | Go to Definition on real Frappe code (APIs, re-exports, hooks strings, `frappe.call`), results outside the root or in blocked folders hidden, input limits, warm latency budget |
| `test_security_watch` | Change detection reveals nothing outside the root, bounded work per request, strict input types |
| `test_terminal_manager` | Terminal ownership, per-user limit, input size, input order |
| `test_scalability` | 20 MB of output; 300 rapid inputs in order; parallel burst against the limit; 4 users × 3 terminals isolated; open/close and idle cleanup leave no processes or keys; 32 concurrent watchers |
| `test_performance` | Budgets: guarded API call, watch poll, 5,000-entry folder, 4 MB open/save, quick open, keystroke round trip (< 40 ms median), terminal start time and memory |
| `tests/js` | Terminal key policy, wrapped links, outside changes, the extension runtime (every supported API implemented, a sample extension end to end, `workspace.fs` limits), themes, icons, keybindings, converters, decoration CSS sanitizing, console payload, dialog message handling, search replace preview and results |

### Architecture (SOLID)

```
studio/
  config.py            StudioConfig: reads settings only
  kv.py                KeyValueStore protocol + Redis implementation
  exceptions.py        typed errors with HTTP status codes
  security/access.py   AccessPolicy: role and feature flag
  security/session.py  StudioSessionService: password re-auth, lockout, session tokens
  files/path_guard.py  PathGuard: keeps every path inside the root and out of blocked folders
  files/service.py     FileReader / FileWriter protocols + LocalFileService, file_version()
  files/search.py      SearchQuery, GlobFilter, TextSearcher, TextReplacer (Search view)
  files/watch.py       FileChangeDetector (open files / expanded folders, bounded)
  code_intel/          DefinitionFinder + strategies (Jedi, dotted paths in strings)
  runners/             ScriptRunner ABC, built-in runners, RunnerRegistry (open for extension)
  terminal/            TerminalManager (web side), PtyTerminalHost (detached PTY process),
                       LaunchSpec (shell or program + env), OutputPublisher (socket.io),
                       ProcessSpawner, shared protocol
  bench/               BenchCommand ABC + CommandField schema, one class per command,
                       BenchCommandRegistry (hook), BenchService, command sequences (Get Apps)
  extensions/          vsix (safe reading), openvsx (verified downloads), contributions (one reader per point),
                       checker (compatibility report + manifest), store, service, api_support.json
  ai_tools/            AiTool ABC + ToolContext, Claude Code / Antigravity, AiToolRegistry (hook),
                       AiToolService (status, install/start specs, per-user profiles),
                       open_url.py (browser shim -> "Open" prompt in the page)
  audit.py             AuditLogger protocol + DocType implementation
  container.py         composition root: the only place that picks concrete classes
  api.py               thin whitelisted endpoints (+ @studio_endpoint guard)
public/js/developer_studio/
  core/                api client, token store, event bus, asset loader, languages, theme, file watcher +
                       change policy, run service, code navigation, console service, search model
  ui/                  layout, lock screen, explorer, editor, quick open, search view, status bar,
                       context menu, picker, command palette, dialogs, AI / bench / extensions views
  extensions/          extension manager and host, sandbox, document sync, converters, command registry,
                       decorations, TextMate engine, color / icon theme services, contribution readers
  terminal/            transport (realtime + polling + ordered input), session (xterm), panel, keys, links
  studio.js            front-end composition root
public/js/extension_runtime/
  runtime.js           the `vscode` API shim that runs inside the extension sandbox
```

Components talk through an event bus and receive their dependencies from the composition roots (`container.py`,
`studio.js`), so each piece can be replaced or tested alone. Commands, runners and AI tools are open for extension
through hooks.

**How the terminal works.** Each terminal is a small detached Python process that owns a pseudo terminal
running a login shell. Keystrokes go from the browser to the API, then into a Redis list that the process reads.
Output is pushed back through Frappe's socket.io. The last chunks are also kept in Redis, so the browser can
re-attach after a reload or fall back to polling when socket.io is down.

### Third-party code

Vendored in `public/lib`: Monaco Editor 0.52.2, xterm.js 5.5.0, vscode-textmate 9.3.2 and vscode-oniguruma 2.0.1
(all MIT).

### License

MIT
