import { ipcMain as nativeIpcMain } from 'electron';
import { createIpcRegistrar } from '../lib/ipcRegistrar';

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { Buffer } from 'node:buffer';
import type { PseudoTerminal, SpawnOptions } from 'node-pty';

import { parseTerminalAck, parseTerminalInput } from '../../shared/ipc/ipcPayloads';
import type { IpcPayloads } from '../../shared/ipc/ipcPayloads';
import type { IpcResults } from '../../shared/ipc/ipcResults';
import { toRecord } from '../../shared/core/record';
import { isPathWithin, mergeToolPaths, pathEnvironmentValue, setPathEnvironment, staticToolPathGuesses } from '../lib/platform';

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

const ipcMain = { handle: createIpcRegistrar(nativeIpcMain) };

const isWin = process.platform === 'win32';

type TerminalHandle = { readonly proc: PseudoTerminal; readonly cwd: string };

// terminalId -> { proc, cwd }
const terminals = new Map<string, TerminalHandle>();

// ---------------------------------------------------------------------------
// Shell environment
// ---------------------------------------------------------------------------

// Build an env that mirrors what the user's Terminal.app would see.
//
// A GUI-launched Electron app inherits launchd's minimal PATH, so CLIs
// installed via Homebrew / npm / Bun / Volta / pnpm / fnm / asdf / deno / yarn
// aren't on it. Prepend the common install locations, then let the login shell
// (spawned with `-l` below) extend PATH further from .zprofile, .bash_profile
// or .zshrc — which is where version managers actually put themselves.
//
// Note this is a different job from lib/nodeTools.ts's `ensureToolPath()`: that one
// probes a shell to fix *this process's* PATH before spawning `astro`/`git`
// directly. Here the shell we spawn does its own sourcing; we only need to
// hand it a plausible starting point and get Electron's fingerprints off it.
function buildShellEnv(): Record<string, string | undefined> {
  const env = { ...process.env };

  // Strip Electron/npm-leaked vars so the shell looks like a fresh
  // Terminal.app launch rather than an Electron child. Volta/fnm/nvm read
  // npm_* and NODE_OPTIONS and can resolve a different Node than the user's
  // default — which masks globally installed CLIs. TERM_PROGRAM gates some
  // user .zshrc/.bashrc branches; set a stable marker so conditional config
  // still runs.
  delete env['ELECTRON_RUN_AS_NODE'];
  delete env['NODE_OPTIONS'];
  delete env['NODE_PATH'];
  delete env['INIT_CWD'];
  delete env['VITE_DEV_SERVER_URL'];
  for (const key of Object.keys(env)) {
    if (key.startsWith('npm_')) {
      delete env[key];
    }
  }
  env['TERM_PROGRAM'] = 'stacki';
  env['COLORTERM'] = 'truecolor';

  if (isWin) {
    const current = pathEnvironmentValue(env);
    const guesses = staticToolPathGuesses(os.homedir(), env).filter((candidate) => {
      try {
        return fs.existsSync(candidate);
      } catch {
        return false;
      }
    });
    setPathEnvironment(env, mergeToolPaths(current, guesses));
    return env;
  }

  const home = process.env['HOME'] || '';
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

  const seen = new Set<string>();
  env['PATH'] = [...extraPaths, ...(env['PATH'] || '').split(':')]
    .filter((entry) => {
      if (!entry || seen.has(entry)) {
        return false;
      }
      seen.add(entry);
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
// clipboard itself depends on a tool that is often missing (osascript, xclip,
// wl-paste or PowerShell), so it's only the fallback.
const CLIPBOARD_DIRECTORY = path.join(os.tmpdir(), 'stacki-clipboard');
const CLIPBOARD_TTL_MS = 60 * 60 * 1000; // prune pasted images older than an hour

const IMAGE_MIME_EXT: Record<string, string> = {
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
function pruneOldClipboardImages(): void {
  let names: string[];
  try {
    names = fs.readdirSync(CLIPBOARD_DIRECTORY);
  } catch {
    return; // doesn't exist yet — nothing to prune
  }
  const now = Date.now();
  for (const name of names) {
    const full = path.join(CLIPBOARD_DIRECTORY, name);
    try {
      if (now - fs.statSync(full).mtimeMs > CLIPBOARD_TTL_MS) {
        fs.unlinkSync(full);
      }
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
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

interface SpawnFields {
  code?: string;
  message?: string;
}

// A pty setup failure can be any throw; only its oserror face is meaningful.
function spawnError(error: unknown): SpawnFields {
  const record = toRecord(error);
  const fields: SpawnFields = {};
  const code = record?.['code'];
  const message = record?.['message'];
  // Only present keys appear; with exactOptionalPropertyTypes, undefined is
  // not a value for an optional property.
  if (typeof code === 'string') {
    fields.code = code;
  }
  if (typeof message === 'string') {
    fields.message = message;
  }
  return fields;
}

type SpawnResult = { readonly proc: PseudoTerminal; readonly error: undefined } | { readonly proc: undefined; readonly error: SpawnFields };

type PtySpawn = (typeof import('node-pty'))['spawn'];
let ptySpawnPromise: Promise<PtySpawn> | undefined;

function loadPtySpawn(): Promise<PtySpawn> {
  ptySpawnPromise ??= import('node-pty').then((module) => module.spawn);
  return ptySpawnPromise;
}

async function spawnWithRetry(shell: string, args: readonly string[], options: SpawnOptions): Promise<SpawnResult> {
  let spawnPty: PtySpawn;
  try {
    spawnPty = await loadPtySpawn();
  } catch (error: unknown) {
    return { proc: undefined, error: { ...spawnError(error), code: 'PTY_LOAD_FAILED' } };
  }
  let lastError: SpawnFields | undefined = undefined;
  for (let attempt = 0; attempt <= SPAWN_RETRIES; attempt++) {
    try {
      return { proc: spawnPty(shell, [...args], options), error: undefined };
    } catch (error: unknown) {
      lastError = spawnError(error);
      if (!RETRIABLE_SPAWN_CODES.has(lastError.code ?? '') || attempt === SPAWN_RETRIES) {
        break;
      }
      await sleep(SPAWN_RETRY_DELAY_MS);
    }
  }
  return { proc: undefined, error: lastError ?? {} };
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
const flowState = new Map<string, { unacked: number; paused: boolean }>();

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
const lastProcessName = new Map<string, string>();
let pollTimer: ReturnType<typeof setInterval> | undefined = undefined;

function pollProcessNames(send: (channel: string, payload: unknown) => void): void {
  if (terminals.size === 0) {
    stopPolling();
    return;
  }
  for (const [id, entry] of terminals) {
    let name: string;
    try {
      name = entry.proc.process;
    } catch {
      continue; // exited between the map read and the fd lookup
    }
    if (!name || lastProcessName.get(id) === name) {
      continue;
    }
    lastProcessName.set(id, name);
    send('terminal:process', { id, name });
  }
}

function startPolling(send: (channel: string, payload: unknown) => void): void {
  if (pollTimer) {
    return;
  }
  pollTimer = setInterval(() => pollProcessNames(send), PROCESS_POLL_MS);
  // Never hold the event loop open on quit — this poll is decoration.
  pollTimer.unref?.();
}

function stopPolling(): void {
  if (!pollTimer) {
    return;
  }
  clearInterval(pollTimer);
  pollTimer = undefined;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

// A `send` payload that fails its parser is dropped: the channel has no reply
// to carry the refusal, so the log is where a renderer bug surfaces.
function parseSendPayload<T>(channel: string, input: unknown, parse: (input: unknown) => T): T | undefined {
  try {
    return parse(input);
  } catch (error: unknown) {
    console.error(`[terminal] ${channel}: refused payload — ${String(error)}`);
    return undefined;
  }
}

type Send = (channel: string, payload: unknown) => void;

/**
 * @param send        (channel, payload) => void — posts to the renderer
 * @param projectRoot () => string|undefined — the open project, for the cwd check
 */
function registerTerminalHandlers({ send, projectRoot }: { readonly send: Send; readonly projectRoot: () => string | undefined }): void {
  ipcMain.handle('terminal:start', (_event: unknown, payload) => startTerminal(payload, { send, root: projectRoot() }));
  // `on`, not `handle`: keystrokes and acks are high-frequency one-way signals
  // that need no reply, so they shouldn't pay for a round trip.
  nativeIpcMain.on('terminal:input', (_event: unknown, input: unknown) => {
    const payload = parseSendPayload('terminal:input', input, parseTerminalInput);
    if (payload !== undefined) {
      writeTerminalInput(payload.id, payload.data);
    }
  });
  nativeIpcMain.on('terminal:ack', (_event: unknown, input: unknown) => {
    const payload = parseSendPayload('terminal:ack', input, parseTerminalAck);
    if (payload !== undefined) {
      acknowledgeTerminal(payload.id, payload.count);
    }
  });
  ipcMain.handle('terminal:resize', (_event: unknown, payload) => resizeTerminal(payload));
  ipcMain.handle('terminal:close', (_event: unknown, payload) => closeTerminal(payload.id));
  ipcMain.handle('terminal:clipboardImage', (_event: unknown, payload) => saveClipboardImage(payload));
}

type StartResult = IpcResults['terminal:start'];

async function startTerminal(
  payload: IpcPayloads['terminal:start'],
  { send, root }: { readonly send: Send; readonly root: string | undefined },
): Promise<StartResult> {
  // The shell can go anywhere the user takes it, but the app only ever opens
  // one *at* the project it has open — same reach as the asset protocol.
  const cwd = payload?.cwd;
  const abs = cwd ? path.resolve(cwd) : undefined;
  if (!root || !abs || !isPathWithin(root, abs)) {
    return { ok: false as const, error: 'Terminal can only open inside the current project.' };
  }
  const id = payload?.id ?? '';
  if (!id) {
    return { ok: false as const, error: 'Missing terminal id.' };
  }
  retireTerminal(id);

  const shell = isWin ? 'powershell.exe' : process.env['SHELL'] || '/bin/bash';
  // Login shell on macOS/Linux so ~/.zprofile, ~/.bash_profile and ~/.profile
  // run — that's where Homebrew, nvm and CLI installers add to PATH.
  // Without it, half the user's tools are "command not found" on a GUI
  // launch even though they work in Terminal.app.
  const shellArgs = isWin ? [] : ['-l'];
  const { proc, error } = await spawnWithRetry(shell, shellArgs, {
    name: 'xterm-256color',
    cols: payload.cols,
    rows: payload.rows,
    cwd: abs,
    env: buildShellEnv(),
  });
  if (!proc) {
    return { ok: false as const, error: spawnFailureMessage(shell, error) };
  }

  terminals.set(id, { proc, cwd: abs });
  flowState.set(id, { unacked: 0, paused: false });
  // Label the tab now rather than a poll interval later — the shell's name
  // is available the moment it spawns. A stale name under this id would
  // suppress the send, so clear it first.
  lastProcessName.delete(id);
  startPolling(send);
  pollProcessNames(send);
  const command = typeof payload?.autoLaunch === 'string' ? payload.autoLaunch.trim() : '';
  wireTerminal(id, proc, { send, command });
  return { ok: true as const, id };
}

// Ids are reused (a renderer reload re-creates "…:term-1"), so retire any
// pty still holding this one before spawning its replacement.
function retireTerminal(id: string): void {
  const existing = terminals.get(id);
  if (existing) {
    terminals.delete(id);
    try {
      existing.proc.kill();
    } catch {
      /* already gone */
    }
  }
}

function spawnFailureMessage(shell: string, error: SpawnFields): string {
  const code = error.code;
  return FD_LIMIT_CODES.has(code ?? '')
    ? `Couldn't open a terminal — too many open files (${code}). ` + 'Close a few tabs and try again.'
    : `Couldn't start ${shell}${code ? ` (${code})` : ''}: ` + `${error.message || 'unknown error'}`;
}

// Output, flow control, the optional auto-launch command, and exit.
//
// Optional auto-launch (`claude`, `codex`, anything). Firing on the first
// data chunk races shell init — Powerlevel10k's instant prompt, nvm,
// oh-my-zsh, profile sourcing — and the command text is dropped because
// nothing is reading stdin yet, leaving the user at an empty prompt. Wait
// for init to fall quiet instead, which is a reliable proxy for "the
// prompt is up".
function wireTerminal(id: string, proc: PseudoTerminal, { send, command }: { readonly send: Send; readonly command: string }): void {
  let launched = !command;
  let quietTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  let fallbackTimer: ReturnType<typeof setTimeout> | undefined = undefined;
  const QUIET_MS = 400;
  const FALLBACK_MS = 4000;

  const launch = (): void => {
    if (launched) {
      return;
    }
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
  if (command) {
    fallbackTimer = setTimeout(launch, FALLBACK_MS);
  }

  proc.onData((data) => {
    send('terminal:data', { id, data });
    noteTerminalOutput(id, proc, data.length);
    if (launched) {
      return;
    }
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
    if (terminals.get(id)?.proc !== proc) {
      return;
    }
    terminals.delete(id);
    flowState.delete(id);
    lastProcessName.delete(id);
    send('terminal:exit', { id, exitCode });
  });
}

// Counts chars sent to the renderer and pauses the pty past the high watermark.
function noteTerminalOutput(id: string, proc: PseudoTerminal, length: number): void {
  const flow = flowState.get(id);
  if (!flow) {
    return;
  }
  flow.unacked += length;
  if (!flow.paused && flow.unacked >= FLOW_HIGH_WATERMARK) {
    try {
      proc.pause();
      flow.paused = true;
    } catch {
      /* already gone — nothing to pause */
    }
  }
}

function writeTerminalInput(id: string, data: string): void {
  const entry = terminals.get(id);
  if (!entry) {
    return;
  }
  try {
    entry.proc.write(data);
  } catch {
    /* exited mid-keystroke */
  }
}

// The renderer reports chars it has actually rendered. Resume a pty the high
// watermark paused once it has drained.
function acknowledgeTerminal(id: string, count: number): void {
  const flow = flowState.get(id);
  if (!flow) {
    return;
  }
  flow.unacked = Math.max(0, flow.unacked - count);
  if (!flow.paused || flow.unacked > FLOW_LOW_WATERMARK) {
    return;
  }
  const entry = terminals.get(id);
  if (!entry) {
    return;
  }
  try {
    entry.proc.resume();
    flow.paused = false;
  } catch {
    /* already gone — nothing to resume */
  }
}

function resizeTerminal(payload: IpcPayloads['terminal:resize']): IpcResults['terminal:resize'] {
  const entry = terminals.get(payload?.id ?? '');
  const cols = payload?.cols;
  const rows = payload?.rows;
  if (!entry || typeof cols !== 'number' || typeof rows !== 'number') {
    // Mirrors the original: missing sizes made node-pty throw, and the
    // caller got { ok: false } from the catch.
    return { ok: false as const };
  }
  try {
    entry.proc.resize(cols, rows);
  } catch {
    return { ok: false as const };
  }
  return { ok: true as const };
}

function closeTerminal(id: string): IpcResults['terminal:close'] {
  const entry = terminals.get(id);
  terminals.delete(id);
  flowState.delete(id);
  lastProcessName.delete(id);
  if (!entry) {
    return { ok: false as const };
  }
  try {
    entry.proc.kill();
  } catch {
    /* already gone */
  }
  return { ok: true as const };
}

// Persist pasted image bytes and hand back the path. Returns ok:false so the
// renderer can fall back to forwarding the raw Ctrl+V byte.
function saveClipboardImage(payload: IpcPayloads['terminal:clipboardImage']): IpcResults['terminal:clipboardImage'] {
  const buf = Buffer.from(payload.bytes);
  if (buf.length === 0) {
    return { ok: false as const, error: 'empty image' };
  }
  try {
    pruneOldClipboardImages();
    fs.mkdirSync(CLIPBOARD_DIRECTORY, { recursive: true });
    const ext = IMAGE_MIME_EXT[payload?.mime ?? ''] || 'png';
    const name = `clipboard-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const file = path.join(CLIPBOARD_DIRECTORY, name);
    fs.writeFileSync(file, buf);
    return { ok: true as const, path: file };
  } catch (error: unknown) {
    const record = toRecord(error);
    return {
      ok: false as const,
      error: typeof record?.['message'] === 'string' ? record['message'] : String(error),
    };
  }
}

// Kill every pty. Called on quit — an orphaned shell would otherwise outlive
// the window that owned it.
function cleanupTerminals(): void {
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

export { registerTerminalHandlers, cleanupTerminals };
