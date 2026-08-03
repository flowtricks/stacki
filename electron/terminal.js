// Terminal panel backend: runs a login shell — or one of the coding CLIs the
// user already has — in a real PTY, with the open Astro project as its cwd.
// The harness's own TUI does the talking: its spinners, its diffs and its
// mid-run approval prompts all work, because this side only ships keystrokes
// in and bytes out. Nothing here knows what a harness is.
//
// ponytail: no snapshot and no undo of what a run changed — a TUI gives us no
// event to hang them on. Upgrade path: snapshot src/ when a session opens and
// diff it on demand.

const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');

const isWin = process.platform === 'win32';
const shell = isWin ? 'powershell.exe' : process.env.SHELL || '/bin/zsh';

const sessions = new Map(); // id -> pty

// What the panel's "+" offers: a plain shell, plus whichever coding CLIs this
// machine actually has. No JSON mode, no model flags, no parser: adding one
// is a name and a binary.
const SHELLS = [
  { id: 'shell', name: 'Shell', bin: null },
  { id: 'claude', name: 'Claude Code', bin: 'claude' },
  { id: 'codex', name: 'Codex', bin: 'codex' },
  { id: 'pi', name: 'pi', bin: 'pi' },
  { id: 'opencode', name: 'opencode', bin: 'opencode' },
  { id: 'gemini', name: 'Gemini', bin: 'gemini' },
];

const listShells = () =>
  SHELLS.filter((s) => !s.bin || which(s.bin)).map(({ id, name, bin }) => ({
    id,
    name,
    command: bin || '',
  }));

// Same idea as `which(1)`: first match on PATH that is executable. Electron
// ships no shell of its own to ask.
function which(bin) {
  const exts = isWin ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        return full;
      } catch {
        /* keep looking */
      }
    }
  }
  return null;
}

// Electron's PATH is the login shell's only when launched from a terminal, so
// an app opened from the Dock can't see /opt/homebrew or ~/.local/bin. Login
// shells are how the user's own PATH gets in — hence `-l` below.
//
// `command` is whatever the panel asked to run, and the panel is a renderer:
// it only gets to name one of the binaries listShells() offered. The user can
// type anything they like once the shell is up — that's a terminal — but a
// compromised renderer can't skip straight to a command line of its choosing.
function open(send, { id, cwd, command }) {
  if (command && !SHELLS.some((s) => s.bin === command)) {
    return { ok: false, error: `Not an offered shell: ${command}` };
  }
  close(id);
  const args = isWin
    ? command
      ? ['-NoLogo', '-Command', command]
      : ['-NoLogo']
    : command
      ? ['-l', '-c', command]
      : ['-l'];
  const proc = pty.spawn(shell, args, {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: cwd || os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
  });
  sessions.set(id, proc);
  proc.onData((data) => send('term:data', { id, data }));
  proc.onExit(({ exitCode }) => {
    sessions.delete(id);
    send('term:exit', { id, code: exitCode });
  });
  return { ok: true, pid: proc.pid, shell };
}

function write(id, data) {
  sessions.get(id)?.write(data);
  return { ok: true };
}

function resize(id, cols, rows) {
  try {
    sessions.get(id)?.resize(Math.max(cols, 2), Math.max(rows, 2));
  } catch {
    /* the pty went away between the resize and the write */
  }
  return { ok: true };
}

function close(id) {
  const proc = sessions.get(id);
  if (!proc) return { ok: false };
  sessions.delete(id);
  try {
    proc.kill();
  } catch {
    /* already gone */
  }
  return { ok: true };
}

const closeAll = () => {
  for (const id of [...sessions.keys()]) close(id);
};

module.exports = { listShells, open, write, resize, close, closeAll };
