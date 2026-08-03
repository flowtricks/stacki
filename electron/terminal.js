// Embedded terminal — a real login shell in the open project, hosted by
// node-pty and rendered by xterm in the bottom dock.
//
// A tool that opens *any* Astro project can't anticipate the user's toolchain:
// their package manager, their test runner, their generator, their coding
// agent. Rather than guessing at each one, give them the shell they already
// know, already pointed at the project.
//
// Ported from Meno (electron-app/main/terminal.js). Dropped along the way:
// its preferences module (the auto-launch command now rides in on the start
// payload, so the renderer owns that setting) and its clipboard-image paste
// (kept — see below) minus the projects-base path model, which Stacki replaces
// with the open-project check the asset protocol already uses.

const { ipcMain } = require('electron');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const pty = require('node-pty');

const isWin = process.platform === 'win32';

// terminalId -> { proc, cwd }
const terminals = new Map();

// ---------------------------------------------------------------------------
// Shell environment
// ---------------------------------------------------------------------------

// Build an env that mirrors what the user's Terminal.app would see.
//
// A GUI-launched Electron app inherits launchd's minimal PATH, so CLIs
// installed via Homebrew / npm / Bun / Volta / pnpm / fnm / asdf / deno / yarn
// aren't on it. Prepend the common install locations, then let the login shell
// (spawned with `-l` below) extend PATH further from .zprofile / .bash_profile
// / .zshrc — which is where version managers actually put themselves.
//
// Note this is a different job from main.js's `ensureToolPath()`: that one
// probes a shell to fix *this process's* PATH before spawning `astro`/`git`
// directly. Here the shell we spawn does its own sourcing; we only need to
// hand it a plausible starting point and get Electron's fingerprints off it.
function buildShellEnv() {
  const env = { ...process.env };

  // Strip Electron/npm-leaked vars so the shell looks like a fresh
  // Terminal.app launch rather than an Electron child. Volta/fnm/nvm read
  // npm_* and NODE_OPTIONS and can resolve a different Node than the user's
  // default — which masks globally installed CLIs. TERM_PROGRAM gates some
  // user .zshrc/.bashrc branches; set a stable marker so conditional config
  // still runs.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  delete env.INIT_CWD;
  delete env.VITE_DEV_SERVER_URL;
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) delete env[key];
  }
  env.TERM_PROGRAM = 'stacki';
  env.COLORTERM = 'truecolor';

  if (isWin) return env;

  const home = process.env.HOME || '';
  const extraPaths = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/home/linuxbrew/.linuxbrew/bin',
    home && path.join(home, '.claude', 'local', 'bin'),
    home && path.join(home, '.volta', 'bin'),
    home && path.join(home, '.bun', 'bin'),
    home && path.join(home, 'Library', 'pnpm'),
    home && path.join(home, '.deno', 'bin'),
    home && path.join(home, '.yarn', 'bin'),
    home && path.join(home, '.fnm', 'aliases', 'default', 'bin'),
    home && path.join(home, '.asdf', 'shims'),
    home && path.join(home, '.npm-global', 'bin'),
    home && path.join(home, '.local', 'bin'),
    home && path.join(home, 'bin'),
  ].filter(Boolean);

  const seen = new Set();
  env.PATH = [...extraPaths, ...(env.PATH || '').split(':')]
    .filter((p) => {
      if (!p || seen.has(p)) return false;
      seen.add(p);
      return true;
    })
    .join(':');
  return env;
}

// ---------------------------------------------------------------------------
// Clipboard images
// ---------------------------------------------------------------------------

// A pty carries bytes, so an image can't travel through it. Pasted image data
// lands here as a temp file instead and the terminal pastes its *path* — the
// same thing a CLI receives when you drag a file onto a native terminal.
// Forwarding a bare Ctrl+V and hoping the foreground program reads the OS
// clipboard itself depends on a tool that is often missing (osascript / xclip
// / wl-paste / PowerShell), so it's only the fallback.
const CLIPBOARD_DIR = path.join(os.tmpdir(), 'stacki-clipboard');
const CLIPBOARD_TTL_MS = 60 * 60 * 1000; // prune pasted images older than an hour

const IMAGE_MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/svg+xml': 'svg',
};

// Keep the temp dir from growing without bound. Best-effort: races and
// unreadable entries are skipped rather than failing the paste.
function pruneOldClipboardImages() {
  let names;
  try {
    names = fs.readdirSync(CLIPBOARD_DIR);
  } catch {
    return; // doesn't exist yet — nothing to prune
  }
  const now = Date.now();
  for (const name of names) {
    const full = path.join(CLIPBOARD_DIR, name);
    try {
      if (now - fs.statSync(full).mtimeMs > CLIPBOARD_TTL_MS) fs.unlinkSync(full);
    } catch {
      /* vanished or locked */
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

// pty.spawn throws SYNCHRONOUSLY on setup failure — it never reaches an async
// error handler. EAGAIN/EBADF are transient libuv fd races that clear on the
// next attempt; EMFILE/ENFILE mean the process file table is full, which gets
// likelier the longer a session runs (the dev server holds fds and watchers).
// Retry the transient ones, then return a readable error so the renderer can
// print it rather than showing a silently blank pane.
const RETRIABLE_SPAWN_CODES = new Set(['EBADF', 'EAGAIN', 'EMFILE', 'ENFILE']);
const FD_LIMIT_CODES = new Set(['EMFILE', 'ENFILE']);
const SPAWN_RETRIES = 3;
const SPAWN_RETRY_DELAY_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function spawnWithRetry(shell, args, options) {
  let lastErr;
  for (let attempt = 0; attempt <= SPAWN_RETRIES; attempt++) {
    try {
      return { proc: pty.spawn(shell, args, options) };
    } catch (err) {
      lastErr = err;
      if (!RETRIABLE_SPAWN_CODES.has(err?.code) || attempt === SPAWN_RETRIES) break;
      await sleep(SPAWN_RETRY_DELAY_MS);
    }
  }
  return { error: lastErr };
}

// ---------------------------------------------------------------------------
// Flow control
//
// A pty emits far faster than xterm can parse and paint (`yes`, a big build
// log, `cat` on a large file). Without backpressure every chunk is queued over
// IPC regardless, so the renderer's backlog grows until the UI locks up and
// memory balloons — data produced faster than it can ever be drained.
//
// So count the chars written to the renderer and pause the pty once too many
// are unacknowledged. The renderer acks from xterm's write callback, which
// fires only once a chunk has actually been parsed, so the ack tracks real
// render progress rather than IPC delivery. Same shape as VS Code's terminal.
// ---------------------------------------------------------------------------

const FLOW_HIGH_WATERMARK = 100_000; // pause above this many unacked chars
const FLOW_LOW_WATERMARK = 5_000; // resume once drained below this
const flowState = new Map(); // terminalId -> { unacked, paused }

// ---------------------------------------------------------------------------
// Tab labels
//
// A tab prefers the title the foreground program sets via an OSC 0/2 escape
// sequence (Claude Code, oh-my-zsh and Powerlevel10k all do) — the renderer
// reads that straight off xterm, so main isn't involved. But a plain login
// shell sets no title at all: macOS's /etc/zshrc gates its title hook on
// TERM_PROGRAM=Apple_Terminal and buildShellEnv reports 'stacki'. So main also
// reports each pty's foreground process name ("zsh", "node", "claude") as the
// fallback label.
//
// One shared interval rather than a timer per pty: `.process` is a synchronous
// native lookup on the pty fd, so polling a handful is cheap. Only *changes*
// are sent, so an idle tab costs zero IPC and zero renders.
// ---------------------------------------------------------------------------

const PROCESS_POLL_MS = 2000;
const lastProcessName = new Map(); // terminalId -> last name sent
let pollTimer = null;

function pollProcessNames(send) {
  if (terminals.size === 0) {
    stopPolling();
    return;
  }
  for (const [id, entry] of terminals) {
    let name;
    try {
      name = entry.proc?.process;
    } catch {
      continue; // exited between the map read and the fd lookup
    }
    if (!name || lastProcessName.get(id) === name) continue;
    lastProcessName.set(id, name);
    send('terminal:process', { id, name });
  }
}

function startPolling(send) {
  if (pollTimer) return;
  pollTimer = setInterval(() => pollProcessNames(send), PROCESS_POLL_MS);
  // Never hold the event loop open on quit — this poll is decoration.
  pollTimer.unref?.();
}

function stopPolling() {
  if (!pollTimer) return;
  clearInterval(pollTimer);
  pollTimer = null;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

/**
 * @param send        (channel, payload) => void — posts to the renderer
 * @param projectRoot () => string|null — the open project, for the cwd check
 */
function registerTerminalHandlers({ send, projectRoot }) {
  ipcMain.handle('terminal:start', async (_e, { id, cwd, autoLaunch } = {}) => {
    // The shell can go anywhere the user takes it, but the app only ever opens
    // one *at* the project it has open — same reach as the asset protocol.
    const root = projectRoot();
    const abs = cwd ? path.resolve(cwd) : null;
    if (!root || !abs || (abs !== root && !(abs + path.sep).startsWith(root + path.sep))) {
      return { ok: false, error: 'Terminal can only open inside the current project.' };
    }

    // Ids are reused (a renderer reload re-creates "…:term-1"), so retire any
    // pty still holding this one before spawning its replacement.
    const existing = terminals.get(id);
    if (existing) {
      terminals.delete(id);
      try {
        existing.proc.kill();
      } catch {
        /* already gone */
      }
    }

    const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/bash';
    // Login shell on macOS/Linux so ~/.zprofile / ~/.bash_profile / ~/.profile
    // run — that's where Homebrew, nvm and CLI installers add to PATH.
    // Without it, half the user's tools are "command not found" on a GUI
    // launch even though they work in Terminal.app.
    const shellArgs = isWin ? [] : ['-l'];

    const { proc, error } = await spawnWithRetry(shell, shellArgs, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: abs,
      env: buildShellEnv(),
    });

    if (!proc) {
      const code = error?.code;
      return {
        ok: false,
        error: FD_LIMIT_CODES.has(code)
          ? `Couldn't open a terminal — too many open files (${code}). Close a few tabs and try again.`
          : `Couldn't start ${shell}${code ? ` (${code})` : ''}: ${error?.message || 'unknown error'}`,
      };
    }

    terminals.set(id, { proc, cwd: abs });
    flowState.set(id, { unacked: 0, paused: false });

    // Label the tab now rather than a poll interval later — the shell's name
    // is available the moment it spawns. A stale name under this id would
    // suppress the send, so clear it first.
    lastProcessName.delete(id);
    startPolling(send);
    pollProcessNames(send);

    // Optional auto-launch (`claude`, `codex`, anything). Firing on the first
    // data chunk races shell init — Powerlevel10k's instant prompt, nvm,
    // oh-my-zsh, profile sourcing — and the command text is dropped because
    // nothing is reading stdin yet, leaving the user at an empty prompt. Wait
    // for init to fall quiet instead, which is a reliable proxy for "the
    // prompt is up".
    const command = typeof autoLaunch === 'string' ? autoLaunch.trim() : '';
    let launched = !command;
    let quietTimer = null;
    let fallbackTimer = null;
    const QUIET_MS = 400;
    const FALLBACK_MS = 4000;

    const launch = () => {
      if (launched) return;
      launched = true;
      clearTimeout(quietTimer);
      clearTimeout(fallbackTimer);
      try {
        proc.write(`${command}\r`);
      } catch {
        /* pty closed before the write */
      }
    };
    // Hard ceiling: an animated prompt may never fall quiet, so try anyway.
    if (command) fallbackTimer = setTimeout(launch, FALLBACK_MS);

    proc.onData((data) => {
      send('terminal:data', { id, data });

      const flow = flowState.get(id);
      if (flow) {
        flow.unacked += data.length;
        if (!flow.paused && flow.unacked >= FLOW_HIGH_WATERMARK) {
          try {
            proc.pause();
            flow.paused = true;
          } catch {
            /* already gone — nothing to pause */
          }
        }
      }

      if (launched) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(launch, QUIET_MS);
    });

    proc.onExit(({ exitCode }) => {
      clearTimeout(quietTimer);
      clearTimeout(fallbackTimer);
      // Only tear down state this pty still owns. kill() resolves
      // asynchronously, so this can fire *after* a replacement has registered
      // under the same id — clearing unconditionally would orphan the live one
      // and every input/resize/close would silently no-op against it.
      if (terminals.get(id)?.proc !== proc) return;
      terminals.delete(id);
      flowState.delete(id);
      lastProcessName.delete(id);
      send('terminal:exit', { id, exitCode });
    });

    return { ok: true, id };
  });

  // `on`, not `handle`: keystrokes and acks are high-frequency one-way signals
  // that need no reply, so they shouldn't pay for a round trip.
  ipcMain.on('terminal:input', (_e, { id, data } = {}) => {
    const entry = terminals.get(id);
    if (!entry) return;
    try {
      entry.proc.write(data);
    } catch {
      /* exited mid-keystroke */
    }
  });

  // The renderer reports chars it has actually rendered. Resume a pty the high
  // watermark paused once it has drained.
  ipcMain.on('terminal:ack', (_e, { id, count } = {}) => {
    const flow = flowState.get(id);
    if (!flow) return;
    flow.unacked = Math.max(0, flow.unacked - (count || 0));
    if (!flow.paused || flow.unacked > FLOW_LOW_WATERMARK) return;
    const entry = terminals.get(id);
    if (!entry) return;
    try {
      entry.proc.resume();
      flow.paused = false;
    } catch {
      /* already gone — nothing to resume */
    }
  });

  ipcMain.handle('terminal:resize', (_e, { id, cols, rows } = {}) => {
    const entry = terminals.get(id);
    if (!entry) return { ok: false };
    try {
      entry.proc.resize(cols, rows);
    } catch {
      return { ok: false };
    }
    return { ok: true };
  });

  ipcMain.handle('terminal:close', (_e, { id } = {}) => {
    const entry = terminals.get(id);
    terminals.delete(id);
    flowState.delete(id);
    lastProcessName.delete(id);
    if (!entry) return { ok: false };
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
    return { ok: true };
  });

  // Persist pasted image bytes and hand back the path. Returns ok:false so the
  // renderer can fall back to forwarding the raw Ctrl+V byte.
  ipcMain.handle('terminal:clipboardImage', (_e, { bytes, mime } = {}) => {
    try {
      const buf = Buffer.from(bytes || []);
      if (buf.length === 0) return { ok: false, error: 'empty image' };
      pruneOldClipboardImages();
      fs.mkdirSync(CLIPBOARD_DIR, { recursive: true });
      const ext = IMAGE_MIME_EXT[mime] || 'png';
      const name = `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
      const file = path.join(CLIPBOARD_DIR, name);
      fs.writeFileSync(file, buf);
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: err?.message || String(err) };
    }
  });
}

// Kill every pty. Called on quit — an orphaned shell would otherwise outlive
// the window that owned it.
function cleanupTerminals() {
  for (const [, entry] of terminals) {
    try {
      entry.proc.kill();
    } catch {
      /* already gone */
    }
  }
  terminals.clear();
  flowState.clear();
  lastProcessName.clear();
  stopPolling();
}

module.exports = { registerTerminalHandlers, cleanupTerminals };
