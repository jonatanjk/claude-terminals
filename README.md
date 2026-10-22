# Claude Terminals

A small Electron app that keeps several [Claude Code](https://claude.com/claude-code) sessions open as tabs in one window, plus an MCP server so one Claude session can open, message and monitor the others.

> **Windows and macOS.** On Windows tabs run Git Bash, or PowerShell if Git for Windows isn't installed; on macOS they run your login shell (`$SHELL`, usually zsh). Linux should work the same way as macOS but is untested. Hobby project, no warranty.

## What it does

- **Tabbed, persistent sessions.** A background daemon (`server.js`) owns the ptys, so closing the window doesn't kill your sessions. Reopen the window and the tabs are back. Tab state is saved in `~/.claude-terminals/state.json`.
- **Rename and recolour** tabs (9 colours).
- **Status icon** per tab: busy (spinner) or waiting for you.
- **Ask badges.** A session that needs you raises an ask; its tab gets a red count (Slack-style) and the app's Dock/taskbar icon shows the total. See [Ask badges](#ask-badges).
- **Resume** earlier Claude conversations from a history picker, or open a plain shell tab (Git Bash or PowerShell on Windows).
- **MCP server** (`mcp.js`) exposing the daemon to Claude:

  | Tool | Purpose |
  |---|---|
  | `list_sessions` | List tabs (id, name, colour, cwd, Claude session id, alive) |
  | `open_session` | Open a Claude or bash tab (optional cwd, resume id, first prompt) |
  | `close_session` | Close a tab (the conversation stays resumable) |
  | `rename_session` | Rename and/or recolour a tab |
  | `restart_session` | Restart a tab's shell; Claude tabs resume their conversation |
  | `send_input` | Type text into a tab |
  | `read_output` | Read a tab's recent output (ANSI stripped) |
  | `ask_user` | Raise an ask for the calling tab: red count on the tab and the Dock (`summary`; optional `session`) |

  Claude Code's native peer messaging (`ListAgents` / `SendMessage`) works alongside this between the sessions you open.

## Run it

Requirements: Node.js and the `claude` CLI on your PATH. Git for Windows is recommended on Windows (Claude Code's Bash tool needs it); without it, tabs fall back to PowerShell 7 (`pwsh`) or Windows PowerShell. On macOS, `npm install` may compile the pty module, which needs the Xcode command-line tools (`xcode-select --install`).

```
npm install
npm start          # Electron window; starts the daemon if it isn't running
npm run daemon     # or just the daemon, no window
npm test           # unit tests, then a smoke test that starts a throwaway daemon and checks a shell tab runs a command
```

On Windows, double-click `Claude Terminals.cmd` or `launch.vbs` (no console window) to launch from Explorer. On macOS, double-click `Claude Terminals.app` in Finder (or drag it to the Dock); it starts Electron through an interactive login shell so `node` and `claude` are on PATH (including nvm/fnm set up in `~/.zshrc`), without opening a Terminal window. Keep the app inside the checkout (add it to the Dock rather than copying it to /Applications), and install with `git clone`: a zip download can be quarantined by Gatekeeper. Because the launcher runs your interactive shell config without a terminal, anything in `~/.zshrc` that needs one (auto-starting tmux, prompts) should be guarded with `[[ -t 0 ]]`. Launch output goes to `~/Library/Logs/claude-terminals.log`.

Register the MCP server with Claude Code (adjust the path):

```
claude mcp add claude-terminals -- node C:/path/to/claude-terminals/mcp.js     # Windows
claude mcp add claude-terminals -- node ~/path/to/claude-terminals/mcp.js       # macOS
```

### Keyboard

| Action | Windows | macOS |
|---|---|---|
| New Claude tab | Ctrl+Shift+` | Cmd+Shift+` |
| Copy / paste | Ctrl+C (with a selection) / Ctrl+V | Cmd+C / Cmd+V |
| Rename tab | F2 | F2 |
| Reload / dev tools | Ctrl+Shift+R / Ctrl+Shift+I | Cmd+Shift+R / Cmd+Shift+I |

On macOS, Ctrl+C and Ctrl+V go straight to the terminal (interrupt, and Claude Code's image paste).

## Ask badges

A Claude session decides when it needs you (an approval, a decision, a credential, an answer) and raises an ask with a one-line summary. You see a red count next to that tab in the session list, the total on the Dock icon (macOS), taskbar overlay (Windows) or launcher badge (Linux), and the window title becomes `(n) Claude Terminals`. Open the tab and each open ask is a read-only line in a slim strip at the bottom of the pane (full text, time, ✕ to dismiss). There is no reply box: answer in the session's own chat, and typing into the tab clears its asks.

**Clear rule.** A tab's asks reset to 0 when you type (or paste) into that tab while it is the focused tab. Output alone does not clear them, nor does selecting the tab, nor input sent by another session through `send_input` or `/api/input`. `ct-ask --clear` and `/api/ask/clear` clear them explicitly. Counts survive a daemon restart (they are stored with the tab in `state.json`).

**From inside a tab** (every tab has `$CLAUDE_TERMINALS_ID`, `$CLAUDE_TERMINALS_PORT` and `$CLAUDE_TERMINALS_DATA` set):

```
bin/ct-ask "Approve the prod deploy? It needs your SSO login"   # prints: ask raised: 1 open
bin/ct-ask --clear                                             # prints: asks cleared
```

`ct-ask` reads the token from the data directory and never prints it. Outside a Claude Terminals tab it fails with `not inside a Claude Terminals tab`. Put it on your PATH with, for example, `ln -s ~/path/to/claude-terminals/bin/ct-ask /usr/local/bin/ct-ask`.

**From Claude via MCP**, call `ask_user` with `summary`. The MCP server runs inside the tab, so it raises the ask for that tab; pass `session` (a tab id from `list_sessions`) to raise one for another tab.

**HTTP API** (token in the `x-token` header, like the other routes):

| Route | Body | Result |
|---|---|---|
| `POST /api/ask` | `{"session": "<tab id>", "summary": "<one line>"}` | Adds one ask, stores the summary (whitespace collapsed, cut to 200 characters) and its time. `200 {session, asks, ask_summary, ask_at, total}`; `400` without a summary; `404` for an unknown tab; `401` for a bad token |
| `POST /api/ask/clear` | `{"session": "<tab id>"}` | Resets the tab's asks to 0 |
| `POST /api/ask/dismiss` | `{"session": "<tab id>", "id": "<ask id>"}` | Removes one ask; `404` for an unknown ask id |

`POST /api/ask` also returns the new ask's `id` and keeps its full text (up to 2000 characters). `GET /api/sessions` includes `asks`, `ask_summary`, `ask_at` and the full `asklist` (`{id, text, at}`) for each tab.

**Raise an ask whenever Claude Code is waiting for you.** Claude Code's `Notification` hook fires when it needs your permission or has been idle waiting for input. To turn those into asks, add something like this to `~/.claude/settings.json` (adjust the path; the guard keeps it silent in sessions outside Claude Terminals):

```json
{
  "hooks": {
    "Notification": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "[ -n \"$CLAUDE_TERMINALS_ID\" ] && ~/path/to/claude-terminals/bin/ct-ask \"Claude is waiting for you\" >/dev/null || true"
          }
        ]
      }
    ]
  }
}
```

Each notification adds one to the count, and typing in the tab clears it. To have Claude raise asks itself, with a summary of what it needs, tell it so in your `CLAUDE.md` (for example: "When you need my input, a decision or an approval, run `ct-ask \"<what and why>\"` or call `ask_user`, then wait").

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `CLAUDE_TERMINALS_PORT` | `47821` | Daemon port (set it for the daemon, window and MCP server alike) |
| `CLAUDE_TERMINALS_BASH` | Windows: `C:/Program Files/Git/bin/bash.exe` if present, else `pwsh.exe`, else `powershell.exe`; macOS/Linux: `$SHELL`, else `/bin/zsh` | Shell each tab runs. Bash-like shells start with `-l -i`; a `pwsh`/`powershell` path starts with `-NoLogo` |
| `CLAUDE_TERMINALS_DATA` | `~/.claude-terminals` | Data directory: holds `state.json` and an auto-generated `token`. Not in this repo; keep it private. Point a second (test) daemon at its own directory so it does not restore your live tabs. |

The daemon listens on `127.0.0.1` only. The API needs the token, which `mcp.js` reads from the data directory.

## Dispatcher / worker workflow

`skill/dispatch/` contains a Claude Code skill, `/dispatch`, that turns one session into a "main dispatcher":

1. Copy `skill/dispatch` to `~/.claude/skills/dispatch`.
2. In one session, run `/dispatch`. It reads a tracker file (`~/dispatch/tasks.md`, format in the skill; see `examples/tasks.md`) and checks open tabs.
3. For each task it opens a worker tab (`open_session`), waits for it to appear in `ListAgents`, and sends a self-contained brief (`brief-template.md`) with `SendMessage`.
4. Workers do the work, and you can type into any tab to steer it. Each worker messages the dispatcher once when done or blocked.
5. The dispatcher updates the tracker, summarises, and closes finished tabs.

The skill's rules matter: worker messages are information, not approvals, and risky actions go back to the human.

## Layout

```
main.js  preload.js  server.js  shell.js  mcp.js  ui/index.html   the app
bin/ct-ask                                  raise or clear an ask from a tab
launch.vbs  Claude Terminals.cmd            Windows launchers
Claude Terminals.app                        macOS launcher
test/                                       npm test
skill/dispatch/                             the /dispatch skill
examples/tasks.md                           example tracker
```

## License

MIT
