# Claude Code Status

Real-time Claude Code session stats in the VS Code status bar.

## Features

- 🖥️ **Model** — current AI model in use
- 📊 **Context Usage** — tokens used / context window (percentage)
- 💾 **Cache Hit** — cache read ratio
- 💬 **Turns** — assistant response count
- ⏱️ **Duration** — session elapsed time
- 🟢 **Status** — Thinking / Idle / No session

## Display Modes

- **Compact** (default): each metric as a separate status bar item, individually colored
- **Detailed**: verbose labels for each metric

## Commands

- `Claude Code Status: Show Session Detail` — view all session stats
- `Claude Code Status: Refresh` — manually refresh data
- `Claude Code Status: Toggle Display Mode` — switch compact/detailed

## Configuration

| Setting | Description | Default |
|---------|-------------|---------|
| `claudeCodeStatus.enabled` | Enable/disable | `true` |
| `claudeCodeStatus.refreshInterval` | Data refresh (seconds) | `2` |
| `claudeCodeStatus.displayMode` | compact / detailed | `compact` |
| `claudeCodeStatus.showModel` | Show model name | `true` |
| `claudeCodeStatus.showTokens` | Show token usage | `true` |
| `claudeCodeStatus.showCache` | Show cache hit ratio | `true` |
| `claudeCodeStatus.showTurns` | Show turn count | `true` |
| `claudeCodeStatus.showDuration` | Show session duration | `true` |

## Data Source

Reads from Claude Code session files:
- `~/.claude/sessions/` — session metadata
- `~/.claude/projects/` — conversation transcripts (token usage)

## Install

```
code --install-extension claude-code-status-0.1.1.vsix
```
