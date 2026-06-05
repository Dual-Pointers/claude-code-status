# Claude Code Status

VS Code status bar extension that displays real-time Claude Code session statistics — token usage, context window fill, cache hits, turn count, session duration, and conversation status.


## What you see in the status bar

```
● Thinking...  |  🤖 opus-4-8  |  ⚡ 68K/1.0M (6.5%)  |  🗄 97.3%  |  💬 42  |  ⏱ 1h23m
```

Each metric has its own color — status is orange when thinking, green when idle; model is blue; tokens are gold; cache is teal; turns are coral; duration is purple.

Hover over any item to see full details. Click any item to open a detail panel.

---

## Installation

### Method 1: Download the pre-built VSIX (recommended)

A `.vsix` file is the VS Code extension package — you download it once and install it. No build tools needed.

**Step 1 — Download**

Go to [Releases](https://github.com/Dual-Pointers/claude-code-status/releases) and download the latest `claude-code-status-*.vsix` file.

**Step 2 — Install**

Open a terminal and run:

```bash
code --install-extension /path/to/claude-code-status-0.1.1.vsix --force
```

Replace `/path/to/` with the actual path where you downloaded the file.  
The `--force` flag ensures any previous version is replaced.

**Step 3 — Reload VS Code**

Press `Ctrl+Shift+P` (Mac: `Cmd+Shift+P`), type `Reload Window`, and press Enter.

The status bar should immediately show the HUD. If no Claude Code session is active, it will display `● No session` and `🤖 No session`.

### Method 2: Build from source

Requirements: [Node.js](https://nodejs.org) ≥ 18, [git](https://git-scm.com).

```bash
# Clone the repository
git clone git@github.com:Dual-Pointers/claude-code-status.git
cd claude-code-status

# Install the VS Code Extension CLI
npm install -g @vscode/vsce

# Package into a .vsix file
vsce package

# Install
code --install-extension claude-code-status-*.vsix --force
```

Then reload VS Code (`Ctrl+Shift+P` → `Reload Window`).

---

## Installing on a remote machine (SSH / dev server)

If you use VS Code Remote-SSH to connect to a remote server, install the extension **on the remote side**:

```bash
# 1. Copy the .vsix file to the remote server (or download it directly there)
scp claude-code-status-0.1.1.vsix user@server:~/

# 2. SSH into the server and install
ssh user@server
code --install-extension ~/claude-code-status-0.1.1.vsix --force
```

The extension files will be placed under `~/.vscode-server/extensions/daimaocai.claude-code-status-*/` on the remote machine.

Then run `Developer: Reload Window` in VS Code on the remote side.

---

## File locations

| What | Where |
|------|-------|
| Extension source (after install) | `~/.vscode-server/extensions/daimaocai.claude-code-status-*/` |
| Session metadata (Claude Code) | `~/.claude/sessions/<PID>.json` |
| Conversation transcripts (Claude Code) | `~/.claude/projects/<hashed-cwd>/<sessionId>.jsonl` |
| Debug log | `~/.claude/hud-debug.log` |

---

## Commands

| Command | Description |
|---------|-------------|
| `Claude Code Status: Show Session Detail` | View all session stats in a list |
| `Claude Code Status: Refresh` | Manually refresh data from disk |
| `Claude Code Status: Toggle Display Mode` | Switch between compact and detailed |

---

## Settings

All settings are under `claudeCodeStatus.*` in VS Code settings (`Ctrl+,`):

| Setting | Description | Default |
|---------|-------------|---------|
| `enabled` | Turn the HUD on/off | `true` |
| `refreshInterval` | How often to re-read data (seconds) | `2` |
| `displayMode` | `compact` (icons only) or `detailed` (with labels) | `compact` |
| `showModel` | Show/hide model name | `true` |
| `showTokens` | Show/hide token usage | `true` |
| `showCache` | Show/hide cache hit ratio | `true` |
| `showTurns` | Show/hide turn count | `true` |
| `showDuration` | Show/hide session duration | `true` |
| `sessionsDir` | Override sessions directory (auto-detected if empty) | `""` |
| `projectsDir` | Override projects directory (auto-detected if empty) | `""` |

---

## How it works

1. On activation, the extension finds the most relevant Claude Code session from `~/.claude/sessions/` (preferring interactive sessions in the current workspace over background tasks).
2. It reads the corresponding transcript file (`*.jsonl`) in `~/.claude/projects/`.
3. The most recent assistant message's token usage is extracted to calculate current context window fill (not cumulative history, which would grow unbounded).
4. The display refreshes every 2 seconds for data, and every 1 second for duration and status.

---

## Troubleshooting

**Extension not showing up after install**  
Run `Developer: Reload Window` in VS Code.

**Shows "No session" even though Claude Code is running**  
The extension reads from `~/.claude/sessions/`. Make sure Claude Code has written a session file there. If you just started Claude Code, wait a few seconds and it should appear.

**Wrong session or wrong numbers**  
If you have multiple Claude Code windows open, the extension picks the most relevant one (interactive + matching workspace). Background tasks are deprioritized. If it's still wrong, open a detail panel (click any HUD item) to check which session is being read.

**Percentage seems off**  
After `/compact`, the percentage drops because old context is replaced by a short summary. This is expected — it shows the actual context window fill of the most recent API call.

---

## License

MIT — see [LICENSE](LICENSE).
