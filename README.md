# Claude Terminals

A small Electron app that keeps several [Claude Code](https://claude.com/claude-code) sessions open as tabs in one window, plus an MCP server so one Claude session can open, message and monitor the others.

> **Windows only, as it stands.** It spawns Git Bash through a pty, and the launchers are `.vbs`/`.cmd` files. Porting would mean changing the shell path in `server.js` and the launchers. Hobby project, no warranty.

## What it does

- **Tabbed, persistent sessions.** A background daemon (`server.js`) owns the ptys, so closing the window doesn't kill your sessions. Reopen the window and the tabs are back. Tab state is saved in `~/.claude-terminals/state.json`.
- **Rename and recolour** tabs (9 colours).
- **Status icon** per tab: busy (spinner) or waiting for you.
- **Resume** earlier Claude conversations from a history picker, or open a plain Git Bash tab.
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

  Claude Code's native peer messaging (`ListAgents` / `SendMessage`) works alongside this between the sessions you open.

## Run it

Requirements: Windows, Node.js, Git for Windows, and the `claude` CLI on your PATH.

```
npm install
npm start          # Electron window; starts the daemon if it isn't running
npm run daemon     # or just the daemon, no window
```

Double-click `Claude Terminals.cmd` or `launch.vbs` (no console window) to launch from Explorer.

Register the MCP server with Claude Code (adjust the path):

```
claude mcp add claude-terminals -- node C:/path/to/claude-terminals/mcp.js
```

## Configuration

| Setting | Default | Notes |
|---|---|---|
| `CLAUDE_TERMINALS_PORT` | `47821` | Daemon port (set it for the daemon, window and MCP server alike) |
| `CLAUDE_TERMINALS_BASH` | `C:/Program Files/Git/bin/bash.exe` | Git Bash location |
| Data directory | `~/.claude-terminals` | Holds `state.json` and an auto-generated `token`. Not in this repo; keep it private. |

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
main.js  server.js  mcp.js  ui/index.html   the app
launch.vbs  Claude Terminals.cmd            Windows launchers
skill/dispatch/                             the /dispatch skill
examples/tasks.md                           example tracker
```

## License

MIT
