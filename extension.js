const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const EXT_ID = 'claude-code-status';
const HOME = os.homedir();
const DEFAULT_SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const DEFAULT_PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const DEFAULT_SETTINGS_FILE = path.join(HOME, '.claude', 'settings.json');
const DEBUG_LOG = path.join(HOME, '.claude', 'hud-debug.log');

/**
 * Read the configured model from ~/.claude/settings.json (env.ANTHROPIC_MODEL).
 * This is what claude-switch writes when switching profiles, so the status bar
 * follows profile switches immediately (within one refresh tick).
 * Returns null if not set or unreadable.
 */
function readConfiguredModel(settingsFile) {
  try {
    if (!fs.existsSync(settingsFile)) return null;
    const data = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
    const env = data && typeof data.env === 'object' ? data.env : null;
    if (env && typeof env.ANTHROPIC_MODEL === 'string' && env.ANTHROPIC_MODEL.trim()) {
      return env.ANTHROPIC_MODEL.trim();
    }
  } catch { /* ignore */ }
  return null;
}

/** Write a debug message to file so we can verify the extension runs. */
function debugLog(msg) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(DEBUG_LOG, `[${ts}] ${msg}\n`);
  } catch { /* silently ignore log failures */ }
  // Also emit to console.error so it appears in VS Code logs
  console.error(`[Claude-Status] ${msg}`);
}

// Known model context windows (tokens). Falls back to parsing [Nk]/[Nm] suffix
// or a conservative default.
const MODEL_CONTEXT_MAP = {
  'claude-opus-4-8':          200000,
  'claude-opus-4-7':          200000,
  'claude-sonnet-4-6':        200000,
  'claude-haiku-4-5':         200000,
  'deepseek-v4-pro':         1048576,  // [1m]
  'deepseek-v4-flash':        524288,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert filesystem path → the hashed directory name used by Claude Code. */
function pathToProjectDir(absolutePath) {
  // Claude Code replaces every '/' with '-' in the absolute path
  return absolutePath.replace(/\//g, '-');
}

/**
 * Find the transcript file for a session, trying multiple strategies.
 *
 * Claude Code may normalize paths (e.g. underscores → dashes) when creating
 * the project directory, so the computed dir from cwd might not match.
 *
 * @returns {string|null} path to the .jsonl transcript file, or null.
 */
function findTranscriptPath(projectsDir, sessionId, cwd) {
  // Strategy 1: Compute project dir from cwd
  const computedDir = path.join(projectsDir, pathToProjectDir(cwd));
  const computedPath = path.join(computedDir, sessionId + '.jsonl');
  if (fs.existsSync(computedPath)) return computedPath;

  // Strategy 2: Search all project dirs for this sessionId
  try {
    if (!fs.existsSync(projectsDir)) return null;
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(projectsDir, d.name, sessionId + '.jsonl');
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch { /* ignore */ }

  // Strategy 3: Try resolving the cwd via realpath (handles symlinks)
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) {
      const realDir = path.join(projectsDir, pathToProjectDir(real));
      const realPath = path.join(realDir, sessionId + '.jsonl');
      if (fs.existsSync(realPath)) return realPath;
    }
  } catch { /* ignore */ }

  // Strategy 4: Try with path normalization (underscores → dashes or vice versa)
  // Some filesystems or Claude versions normalize underscores to dashes
  const altCwd1 = cwd.replace(/_/g, '-');
  if (altCwd1 !== cwd) {
    const altDir = path.join(projectsDir, pathToProjectDir(altCwd1));
    const altPath = path.join(altDir, sessionId + '.jsonl');
    if (fs.existsSync(altPath)) return altPath;
  }
  const altCwd2 = cwd.replace(/-/g, '_');
  if (altCwd2 !== cwd) {
    const altDir = path.join(projectsDir, pathToProjectDir(altCwd2));
    const altPath = path.join(altDir, sessionId + '.jsonl');
    if (fs.existsSync(altPath)) return altPath;
  }

  return null;
}

/** Parse context window from model name suffix like "[1m]" or fallback map. */
function getContextWindow(modelName) {
  // Strip suffix first
  const base = (modelName || '').replace(/\[.*\]$/, '');
  if (MODEL_CONTEXT_MAP[base]) return MODEL_CONTEXT_MAP[base];

  // Try suffix: [1m] = 1M, [200k] = 200K
  const m = (modelName || '').match(/\[(\d+)m\]$/i);
  if (m) return parseInt(m[1], 10) * 1_000_000;
  const k = (modelName || '').match(/\[(\d+)k\]$/i);
  if (k) return parseInt(k[1], 10) * 1_000;

  return 200000; // conservative default
}

/** Format bytes/tokens in human-readable form. */
function formatTokens(n) {
  if (n == null || isNaN(n)) return '--';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(0) + 'K';
  return String(n);
}

/** Format a duration in ms to a short string. */
function formatDuration(ms) {
  if (ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m${s % 60}s`;
  return `${s}s`;
}

/** Format a percentage. */
function pct(part, whole) {
  if (!whole || whole === 0) return '0%';
  return ((part / whole) * 100).toFixed(1) + '%';
}

// ---------------------------------------------------------------------------
// Session discovery
// ---------------------------------------------------------------------------

/**
 * Find the "active" Claude Code session.
 *
 * Priority (descending):
 * 1. Alive PID + interactive + cwd matches a workspace folder
 * 2. Alive PID + interactive (any cwd)
 * 3. Alive PID (any kind) + cwd matches
 * 4. Most recent interactive (any PID status)
 * 5. Most recent of all
 *
 * Background-task sessions (kind: "bg") are deprioritized — they confuse the HUD.
 *
 * Returns { sessionId, cwd, startedAt, pid } or null.
 */
function findActiveSession(sessionsDir) {
  try {
    if (!fs.existsSync(sessionsDir)) return null;

    // Get workspace folders for cwd matching
    const workspaceFolders = (vscode.workspace.workspaceFolders || [])
      .map(f => f.uri.fsPath);

    // Read all session files with metadata
    const all = [];
    const dirFiles = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json'));
    for (const f of dirFiles) {
      const fp = path.join(sessionsDir, f);
      try {
        const stat = fs.statSync(fp);
        const pid = parseInt(f.replace('.json', ''), 10);
        const data = readSessionFile(fp);
        if (!data) continue;
        const alive = isPidAlive(pid);
        const interactive = data.kind !== 'bg';
        const cwdMatches = workspaceFolders.some(ws => data.cwd && data.cwd.startsWith(ws));
        all.push({ ...data, pid, _file: fp, mtime: stat.mtimeMs, _alive: alive, _interactive: interactive, _cwdMatches: cwdMatches });
      } catch { /* skip */ }
    }

    // Score: higher = better. Sort descending.
    const score = s => {
      let v = 0;
      if (s._alive)       v += 1000;
      if (s._interactive) v += 100;
      if (s._cwdMatches)  v += 10;
      return v;
    };
    all.sort((a, b) => {
      const s = score(b) - score(a);
      if (s !== 0) return s;
      return b.mtime - a.mtime;
    });

    if (all.length > 0) return all[0];

  } catch (e) {
    console.error('[Claude-Status] Error finding session:', e.message);
  }
  return null;
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readSessionFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    if (data.sessionId && data.cwd) return data;
  } catch { /* ignore */ }
  return null;
}

// ---------------------------------------------------------------------------
// Transcript parsing
// ---------------------------------------------------------------------------

/**
 * Parse a Claude Code transcript JSONL file.
 * Returns aggregated stats:
 *   { inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens, turns, model, lastTimestamp }
 */
function parseTranscript(transcriptPath) {
  const stats = {
    inputTokens: 0,            // from the LAST assistant entry (current context)
    outputTokens: 0,           // from the LAST assistant entry
    cacheReadTokens: 0,        // cumulative across all turns
    cacheCreateTokens: 0,      // cumulative across all turns
    totalInputTokens: 0,       // cumulative (for stats display)
    totalOutputTokens: 0,      // cumulative (for stats display)
    turns: 0,
    model: null,
    lastTimestamp: null,
    lastEntryType: null,       // 'user' | 'assistant' | null
    isActive: false,           // file was recently written to
  };

  try {
    if (!fs.existsSync(transcriptPath)) return stats;

    // Check if file was recently modified (within last 3s → active)
    try {
      const mtime = fs.statSync(transcriptPath).mtimeMs;
      stats.isActive = (Date.now() - mtime) < 3_000;
    } catch { /* ignore */ }

    const content = fs.readFileSync(transcriptPath, 'utf-8');
    const lines = content.trim().split('\n');

    let lastUsage = null;

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        // Track the last entry type for status detection
        if (entry.type === 'user' || entry.type === 'assistant') {
          stats.lastEntryType = entry.type;
        }
        if (entry.type === 'assistant' && entry.message && entry.message.usage) {
          const u = entry.message.usage;
          // Keep cumulative totals for historical reference
          stats.totalInputTokens += u.input_tokens || 0;
          stats.totalOutputTokens += u.output_tokens || 0;
          stats.cacheReadTokens += u.cache_read_input_tokens || 0;
          stats.cacheCreateTokens += u.cache_creation_input_tokens || 0;
          stats.turns += 1;
          if (entry.message.model) stats.model = entry.message.model;
          if (entry.timestamp) stats.lastTimestamp = entry.timestamp;
          // Remember last entry's usage (this reflects current context window fill)
          lastUsage = u;
        }
      } catch { /* skip malformed lines */ }
    }

    // Use the LAST assistant entry's token counts for current context usage.
    // input_tokens (non-cached) + cache_read_input_tokens = total context sent.
    if (lastUsage) {
      stats.inputTokens = (lastUsage.input_tokens || 0) + (lastUsage.cache_read_input_tokens || 0);
      stats.outputTokens = lastUsage.output_tokens || 0;
    }
  } catch (e) {
    console.error('[Claude-Status] Error parsing transcript:', e.message);
  }

  return stats;
}

/**
 * Determine conversation status from transcript stats.
 * Returns { icon, label, color } for display.
 */
function getStatusInfo(stats, session) {
  // If last written entry was from user (not yet answered) → thinking
  // Also check file mtime: if recently modified → thinking
  if (stats.lastEntryType === 'user') {
    return { text: 'Thinking...', label: 'Thinking', color: '#ffaa00' };
  }
  if (stats.isActive && stats.lastEntryType === 'assistant') {
    return { text: 'Thinking...', label: 'Thinking', color: '#ffaa00' };
  }
  if (stats.turns > 0) {
    return { text: 'Idle', label: 'Idle', color: '#40c040' };
  }
  return { text: 'Waiting', label: 'Waiting', color: '#888888' };
}

// ---------------------------------------------------------------------------
// Status bar items
// ---------------------------------------------------------------------------

class ClaudeHUD {
  constructor(context) {
    this.context = context;
    this.items = [];           // all status bar items
    this.disposables = [];
    this.timer = null;
    this.enabled = true;
  }

  /** Build or rebuild status bar items according to current config. */
  buildItems() {
    this.disposeItems();

    const config = vscode.workspace.getConfiguration('claudeCodeStatus');
    this.enabled = config.get('enabled', true);
    if (!this.enabled) return;

    const mode = config.get('displayMode', 'compact');

    if (mode === 'detailed') {
      this.items = [
        this._createItem('claudeStatus.status',   '●', 'status',   101),
        this._createItem('claudeStatus.model',    '🤖', 'model',    100),
        this._createItem('claudeStatus.tokens',   '⚡', 'tokens',   99),
        this._createItem('claudeStatus.cache',    '🗄', 'cache',    98),
        this._createItem('claudeStatus.turns',    '💬', 'turns', 97),
        this._createItem('claudeStatus.duration', '⏱', 'duration', 96),
      ];
    } else {
      // compact: individual items, Right-aligned
      this.items = [
        this._createItem('claudeStatus.status',   '●',  'status',   100),
        this._createItem('claudeStatus.model',    '🤖', 'model',    99),
        this._createItem('claudeStatus.tokens',   '⚡', 'tokens',   98),
        this._createItem('claudeStatus.cache',    '🗄', 'cache',    97),
        this._createItem('claudeStatus.turns',    '💬', 'turns',    96),
        this._createItem('claudeStatus.duration', '⏱', 'duration', 95),
      ];
    }

    // Show all
    for (const item of this.items) {
      item.show();
    }
  }

  _createItem(id, icon, kind, priority) {
    const item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Right,
      priority
    );
    item.name = id;
    item.command = 'claudeCodeStatus.showDetail';
    item.tooltip = 'Claude Code Status – click for details';
    // Store metadata
    item._hudKind = kind;
    item._hudIcon = icon;
    this.disposables.push(item);
    return item;
  }

  disposeItems() {
    for (const item of this.items) {
      item.dispose();
    }
    this.items = [];
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }

  // ---- Refresh -----------------------------------------------------------

  async refresh() {
    try {
      const config = vscode.workspace.getConfiguration('claudeCodeStatus');
      if (!config.get('enabled', true)) {
        for (const item of this.items) item.hide();
        return;
      }

      const sessionsDir = config.get('sessionsDir') || DEFAULT_SESSIONS_DIR;
      const projectsDir = config.get('projectsDir') || DEFAULT_PROJECTS_DIR;

      const session = findActiveSession(sessionsDir);
      if (!session) {
        this._showInactive();
        return;
      }

      const transcriptPath = findTranscriptPath(projectsDir, session.sessionId, session.cwd);
      const stats = transcriptPath ? parseTranscript(transcriptPath) : {
        inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, turns: 0, model: null, lastTimestamp: null
      };

      // Model: prefer the configured model from ~/.claude/settings.json
      // (this is what claude-switch writes, so we follow profile switches
      // immediately). Fall back to the transcript's recorded model, then env.
      const settingsFile = config.get('settingsFile') || DEFAULT_SETTINGS_FILE;
      const configuredModel = readConfiguredModel(settingsFile);
      if (configuredModel) {
        stats.model = configuredModel;
      } else if (!stats.model) {
        stats.model = process.env.ANTHROPIC_MODEL || 'unknown';
      }

      // Duration
      const now = Date.now();
      const elapsed = now - (session.startedAt || now);

      // Context usage: use the LAST assistant entry's tokens (reflects current context fill).
      // totalInputTokens / totalOutputTokens are cumulative across all turns, but
      // inputTokens / outputTokens from the last entry show the current state.
      const ctxWin = getContextWindow(stats.model);
      const currentUsed = stats.inputTokens + stats.outputTokens;
      const totalUsed = (stats.totalInputTokens || 0) + (stats.totalOutputTokens || 0);
      const cacheHit = stats.cacheReadTokens > 0
        ? stats.cacheReadTokens / (stats.totalInputTokens + stats.cacheReadTokens)
        : 0;



      // Store for tooltip / detail
      this._lastData = { session, stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit, transcriptPath };

      // Update display
      const mode = config.get('displayMode', 'compact');
      if (mode === 'detailed') {
        this._updateDetailed(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit);
      } else {
        this._updateCompact(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit);
      }
    } catch (err) {
      debugLog(`Refresh error: ${err.message}`);
    }
  }

  _showInactive() {
    for (const item of this.items) {
      if (item._hudKind === 'status') {
        item.text = 'No session';
        item.tooltip = 'No active Claude Code session';
        item.color = '#888888';
        item.show();
      } else if (item._hudKind === 'model') {
        item.text = '🤖 No session';
        item.tooltip = 'Open Claude Code for VS Code to start.';
        item.color = '#888888';
        item.show();
      } else {
        item.hide();
      }
    }
  }

  _updateCompact(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit) {
    const config = vscode.workspace.getConfiguration('claudeCodeStatus');
    const status = getStatusInfo(stats);

    // Color palette for different indicators
    const COLORS = {
      status:   status.color,                                          // dynamic
      model:    '#569cd6',   // blue
      tokens:   '#dcdcaa',   // gold
      cache:    '#4ec9b0',   // teal
      turns:    '#ce9178',   // coral
      duration: '#c586c0',   // purple
    };

    // Compile compact tooltip once
    const tooltip = this._buildTooltip(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit);

    for (const item of this.items) {
      const k = item._hudKind;
      item.tooltip = tooltip;
      item.color = COLORS[k] || undefined;

      switch (k) {
        case 'status': {
          item.text = status.text;
          item.show();
          break;
        }
        case 'model': {
          if (!config.get('showModel', true)) { item.hide(); break; }
          const short = stats.model.replace(/\[.*\]$/, '').split('-').slice(-2).join('-');
          item.text = `🤖 ${short}`;
          item.show();
          break;
        }
        case 'tokens': {
          if (!config.get('showTokens', true)) { item.hide(); break; }
          item.text = `⚡ ${formatTokens(currentUsed)}/${formatTokens(ctxWin)} (${pct(currentUsed, ctxWin)})`;
          item.show();
          break;
        }
        case 'cache': {
          if (!config.get('showCache', true)) { item.hide(); break; }
          item.text = `🗄 ${pct(stats.cacheReadTokens, stats.cacheReadTokens + stats.inputTokens)}`;
          item.show();
          break;
        }
        case 'turns': {
          if (!config.get('showTurns', true)) { item.hide(); break; }
          item.text = `💬 ${stats.turns}`;
          item.show();
          break;
        }
        case 'duration': {
          if (!config.get('showDuration', true)) { item.hide(); break; }
          item.text = `⏱ ${formatDuration(elapsed)}`;
          item.show();
          break;
        }
      }
    }
  }

  _updateDetailed(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit) {
    for (const item of this.items) {
      const k = item._hudKind;
      const config = vscode.workspace.getConfiguration('claudeCodeStatus');

      // Color palette
      const DCOLORS = { status: getStatusInfo(stats).color, model: '#569cd6', tokens: '#dcdcaa', cache: '#4ec9b0', turns: '#ce9178', duration: '#c586c0' };
      item.color = DCOLORS[k] || undefined;

      switch (k) {
        case 'status': {
          const st = getStatusInfo(stats);
          item.text = st.text;
          item.tooltip = `Status: ${st.label}\nLast activity: ${stats.lastTimestamp || 'N/A'}`;
          item.show();
          break;
        }
        case 'model': {
          if (!config.get('showModel', true)) { item.hide(); break; }
          const short = stats.model.replace(/\[.*\]$/, '');
          item.text = `🤖 ${short}`;
          item.tooltip = `Model: ${stats.model}\nContext window: ${formatTokens(ctxWin)} tokens`;
          item.show();
          break;
        }
        case 'tokens': {
          if (!config.get('showTokens', true)) { item.hide(); break; }
          const pctUsed = pct(currentUsed, ctxWin);
          item.text = `⚡ ${formatTokens(currentUsed)}/${formatTokens(ctxWin)} (${pctUsed})`;
          item.tooltip = `Current input: ${formatTokens(stats.inputTokens)}\nCurrent output: ${formatTokens(stats.outputTokens)}\nCurrent total: ${formatTokens(currentUsed)} / ${formatTokens(ctxWin)} (${pctUsed})\nCumulative: ${formatTokens(totalUsed)} across ${stats.turns} turns`;
          item.show();
          break;
        }
        case 'cache': {
          if (!config.get('showCache', true)) { item.hide(); break; }
          const denominator = stats.cacheReadTokens + stats.inputTokens;
          const ratio = denominator > 0 ? pct(stats.cacheReadTokens, denominator) : '--';
          item.text = `🗄 Cache: ${ratio}`;
          item.tooltip = `Cache read: ${formatTokens(stats.cacheReadTokens)}\nCache create: ${formatTokens(stats.cacheCreateTokens)}\nRegular input: ${formatTokens(stats.inputTokens)}\nCache hit ratio: ${ratio}`;
          item.show();
          break;
        }
        case 'turns': {
          if (!config.get('showTurns', true)) { item.hide(); break; }
          item.text = `💬 ${stats.turns} turns`;
          item.tooltip = `Conversation turns (assistant messages): ${stats.turns}`;
          item.show();
          break;
        }
        case 'duration': {
          if (!config.get('showDuration', true)) { item.hide(); break; }
          item.text = `⏱ ${formatDuration(elapsed)}`;
          item.tooltip = `Session started: ${new Date(this._lastData?.session?.startedAt).toLocaleString()}\nElapsed: ${formatDuration(elapsed)}`;
          item.show();
          break;
        }
      }
    }
  }

  _buildTooltip(stats, elapsed, ctxWin, currentUsed, totalUsed, cacheHit) {
    const s = this._lastData?.session;
    const st = getStatusInfo(stats);
    const lines = [
      `Claude Code Status`,
      `─────────────────────────`,
      `Status:      ${st.label}`,
      `Model:       ${stats.model}`,
      `Tokens:      ${formatTokens(currentUsed)} / ${formatTokens(ctxWin)} (${pct(currentUsed, ctxWin)})`,
      `  Input:     ${formatTokens(stats.inputTokens)}`,
      `  Output:    ${formatTokens(stats.outputTokens)}`,
      `Cumulative:  ${formatTokens(totalUsed)} across ${stats.turns} turns`,
      `  Cache read: ${formatTokens(stats.cacheReadTokens)}`,
      `  Cache create: ${formatTokens(stats.cacheCreateTokens)}`,
      `Cache hit:   ${pct(stats.cacheReadTokens, stats.cacheReadTokens + (stats.totalInputTokens || 0))}`,
      `Turns:       ${stats.turns}`,
      `Duration:    ${formatDuration(elapsed)}`,
      `─────────────────────────`,
      `Session:     ${s?.sessionId?.slice(0, 8) || '?'}...`,
      `Project:     ${s?.cwd || '?'}`,
      `Started:     ${s?.startedAt ? new Date(s.startedAt).toLocaleString() : '?'}`,
      ``,
      `Click for detail  •  /refresh to update`,
    ];
    return lines.join('\n');
  }

  // ---- Start / stop refresh loop ----------------------------------------

  startRefreshLoop() {
    const config = vscode.workspace.getConfiguration('claudeCodeStatus');
    const interval = (config.get('refreshInterval', 5) || 5) * 1000;
    this.timer = setInterval(() => this.refresh(), interval);
    this.refresh(); // immediate first run

    // Fast tick: update duration every second without reading files
    this._tickTimer = setInterval(() => this._tickDuration(), 1000);
  }

  /** Update duration + status every 1s. Status uses live mtime check. */
  _tickDuration() {
    if (!this._lastData) return;
    const { session, stats } = this._lastData;

    // Update duration
    if (session?.startedAt) {
      const elapsed = Date.now() - session.startedAt;
      for (const item of this.items) {
        if (item._hudKind === 'duration') {
          item.text = `⏱ ${formatDuration(elapsed)}`;
          break;
        }
      }
    }

    // Update status: re-check file mtime live (no full file read)
    if (this._lastData.transcriptPath) {
      try {
        const mtime = fs.statSync(this._lastData.transcriptPath).mtimeMs;
        stats.isActive = (Date.now() - mtime) < 3_000;
      } catch { /* ignore */ }
    }
    const status = getStatusInfo(stats, session);
    for (const item of this.items) {
      if (item._hudKind === 'status') {
        item.text = status.text;
        item.color = status.color;
        break;
      }
    }
  }

  stopRefreshLoop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this._tickTimer) {
      clearInterval(this._tickTimer);
      this._tickTimer = null;
    }
  }

  dispose() {
    this.stopRefreshLoop();
    this.disposeItems();
  }
}

// ---------------------------------------------------------------------------
// Extension lifecycle
// ---------------------------------------------------------------------------

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  try {
    debugLog('Activate() called, starting initialization...');

    const hud = new ClaudeHUD(context);
    context.subscriptions.push(hud);

    // Build initial items
    hud.buildItems();
    debugLog(`Built ${hud.items.length} status bar items`);

    // Start refresh
    hud.startRefreshLoop();
    debugLog(`Refresh loop started`);

    // ---- Commands ----------------------------------------------------------

    // Show detail
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeCodeStatus.showDetail', () => {
        if (!hud._lastData) {
          vscode.window.showInformationMessage('[Claude-Status] No session data yet. Waiting for refresh...');
          return;
        }
        const { stats, elapsed, ctxWin, currentUsed, totalUsed, session } = hud._lastData;

        const items = [
          { label: '🖥️  Model',        description: stats.model,                          alwaysShow: true },
          { label: '📊 Context',      description: `${formatTokens(currentUsed)} / ${formatTokens(ctxWin)} (${pct(currentUsed, ctxWin)})`, alwaysShow: true },
          { label: '⬆️  Input',        description: formatTokens(stats.inputTokens),        alwaysShow: true },
          { label: '⬇️  Output',       description: formatTokens(stats.outputTokens),       alwaysShow: true },
          { label: '📈 Cumulative',    description: `${formatTokens(totalUsed)} across ${stats.turns} turns`, alwaysShow: true },
          { label: '💾 Cache read',    description: formatTokens(stats.cacheReadTokens),    alwaysShow: true },
          { label: '🔧 Cache create',  description: formatTokens(stats.cacheCreateTokens),  alwaysShow: true },
          { label: '💬 Turns',         description: String(stats.turns),                    alwaysShow: true },
          { label: '⏱️  Duration',     description: formatDuration(elapsed),                alwaysShow: true },
          { label: '', description: '', alwaysShow: true, kind: vscode.QuickPickItemKind.Separator },
          { label: '📁 Project',       description: session?.cwd || '?',                    alwaysShow: true },
          { label: '🆔 Session',       description: session?.sessionId?.slice(0, 8) + '...' || '?', alwaysShow: true },
        ];

        const qp = vscode.window.createQuickPick();
        qp.items = items;
        qp.title = 'Claude Code Status — Session Detail';
        qp.placeholder = 'ESC to close';
        qp.buttons = [
          { iconPath: new vscode.ThemeIcon('refresh'), tooltip: 'Refresh' }
        ];
        qp.onDidTriggerButton(() => { hud.refresh(); qp.hide(); });
        qp.show();
      })
    );

    // Refresh
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeCodeStatus.refresh', () => {
        hud.refresh();
        vscode.window.showInformationMessage('[Claude-Status] Refreshed.');
      })
    );

    // Toggle display mode
    context.subscriptions.push(
      vscode.commands.registerCommand('claudeCodeStatus.toggleDisplay', async () => {
        const config = vscode.workspace.getConfiguration('claudeCodeStatus');
        const current = config.get('displayMode', 'compact');
        const next = current === 'compact' ? 'detailed' : 'compact';
        await config.update('displayMode', next, vscode.ConfigurationTarget.Global);
        hud.buildItems();
        hud.refresh();
        vscode.window.showInformationMessage(`[Claude-Status] Display mode: ${next}`);
      })
    );

    // ---- Watch config changes ----------------------------------------------

    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('claudeCodeStatus')) {
          debugLog('Config changed, rebuilding...');
          hud.stopRefreshLoop();
          hud.buildItems();
          hud.startRefreshLoop();
        }
      })
    );

    debugLog('Activated successfully.');
  } catch (err) {
    debugLog(`FATAL: activate() failed: ${err.message}\n${err.stack}`);
  }
}

function deactivate() {
  console.log('[Claude-Status] Deactivated.');
}

module.exports = { activate, deactivate };
