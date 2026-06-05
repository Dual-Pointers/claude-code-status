# Changelog

## [0.1.1] - 2026-06-04

### Changed
- Renamed from "Claude Code HUD" to **Claude Code Status** (avoid conflict with CLI claude-hud)
- Detail view uses QuickPick list (one item per line)

### Fixed
- Token percentage uses last API call's context fill (including cache read), not cumulative history sum — no more 121.8% after compact
- Session selection filters out background tasks (`kind: "bg"`), prioritizes interactive + matching workspace
- Active window shortened from 10s to 3s, status switches to Idle faster
- Status re-checks file mtime every 1s instead of waiting for 2s refresh

## [0.1.0] - 2026-06-04

### Added
- Status bar stats for Claude Code sessions
- Metrics: status, model name, token usage, cache hit ratio, turns, duration
- Compact / Detailed display modes
- Per-metric coloring
- 1s duration tick, 2s data refresh
- Status detection: Thinking / Idle / No session
- VSIX packaging
- Multi-strategy transcript path resolution

### Commands
- `Claude Code Status: Show Session Detail`
- `Claude Code Status: Refresh`
- `Claude Code Status: Toggle Display Mode`

### Configuration
- `claudeCodeStatus.enabled` / `refreshInterval` / `displayMode`
- `claudeCodeStatus.showModel` / `showTokens` / `showCache` / `showTurns` / `showDuration`
- `claudeCodeStatus.sessionsDir` / `projectsDir`
