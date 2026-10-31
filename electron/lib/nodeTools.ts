// Finding and running Node and the command-line tools a project needs: the
// PATH a GUI launch lacks, the CLI entry behind a .bin shim, a bounded command
// runner, a free port, and a process tree stopped as a whole.

import { MAIN_LIMITS } from './mainLimits';
import {
  commandNeedsShell,
  mergeToolPaths,
  pathEnvironmentValue,
  setPathEnvironment,
  staticToolPathGuesses,
} from './platform';
import { userInfo } from 'os';
import type { ChildProcess, ExecFileOptions } from 'child_process';
import { toRecord } from '../../shared/core/record';
import { assert } from '../../shared/core/assert';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import { spawn, execFile, execFileSync } from 'child_process';
import { isWin, capture, readJson, parseRecord, parseOptionalString } from './mainHelpers';

// ---------------------------------------------------------------------------
// Finding Node
//
// Launched from Finder or the Dock, the app inherits launchd's PATH —
// `/usr/bin:/bin:/usr/sbin:/sbin` — not the shell's. Nothing installed by
// Homebrew, nvm, fnm, volta, or the Node installer is on it, so `astro` (a
// `#!/usr/bin/env node` shim) dies with "env: node: No such file or
// directory" and `npm install` fails as ENOENT. Launched from a terminal it
// all works, which is why this only bites in the packaged app.
// ---------------------------------------------------------------------------

// Interactive login shell, because that's the one that sources .zshrc/.bashrc
// where version managers put themselves. Marker-delimited so rc-file chatter
// around the value can't be mistaken for it.
export function shellPathDirectories() {
  // $SHELL is usually set even under launchd, but not always — the account's
  // registered login shell is the reliable source when it isn't.
  let shell: string | undefined = process.env['SHELL'];
  if (!shell) {
    try {
      shell = userInfo().shell || undefined;
    } catch {
      shell = undefined;
    }
  }
  if (!shell) {
    return [];
  }
  try {
    const out = execFileSync(shell, ['-ilc', 'printf "__AVB__%s__AVB__" "$PATH"'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      // Quieter rc files: no pagers, no update prompts, no color codes.
      env: { ...process.env, TERM: 'dumb', DISABLE_AUTO_UPDATE: 'true' },
    });
    const match = /__AVB__([\s\S]*?)__AVB__/.exec(out);
    return match ? (capture(match, 1) ?? '').split(path.delimiter).filter(Boolean) : [];
  } catch {
    return []; // no shell, hung rc file, exotic setup — fall through to the guesses
  }
}

export const cmpVersion = (left: string, right: string) => {
  const parts = (version: string) =>
    version
      .replace(/^v/, '')
      .split('.')
      .map((part) => parseInt(part, 10) || 0);
  const [x, y] = [parts(left), parts(right)];
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
};

// Where Node ends up when the shell probe comes back empty — every install
// route in common use, since we can't ask the user which one they took.
export function nodeDirectoryGuesses(home: string) {
  const directories = isWin
    ? [...staticToolPathGuesses(home, process.env)]
    : [
        '/opt/homebrew/bin', // Homebrew, Apple Silicon
        '/usr/local/bin', // Homebrew on Intel, and the official installer
        '/opt/local/bin', // MacPorts
        '/snap/bin', // Linux snap
        path.join(home, '.volta/bin'),
        path.join(home, '.asdf/shims'),
        path.join(home, '.nodenv/shims'),
        path.join(home, '.local/share/mise/shims'),
        path.join(home, '.local/bin'),
        path.join(home, '.npm-global/bin'),
        path.join(home, 'n/bin'),
      ];
  // Version managers keep one directory per version — take the newest, so a
  // project needing a modern Node still gets one.
  const versioned: readonly (readonly [string, string])[] = isWin
    ? [[path.join(home, 'AppData', 'Roaming', 'nvm'), '']]
    : [
        [path.join(home, '.nvm/versions/node'), 'bin'],
        [path.join(home, '.local/share/fnm/node-versions'), 'installation/bin'],
        [path.join(home, 'Library/Application Support/fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.fnm/node-versions'), 'installation/bin'],
        [path.join(home, '.asdf/installs/nodejs'), 'bin'],
        [path.join(home, '.nodenv/versions'), 'bin'],
        [path.join(home, '.local/share/mise/installs/node'), 'bin'],
        ['/usr/local/n/versions/node', 'bin'],
      ];
  for (const [base, suffix] of versioned) {
    try {
      const newest = fs
        .readdirSync(base)
        .filter((version) => /^v?\d/.test(version))
        .sort(cmpVersion)
        .pop();
      if (newest) {
        directories.push(suffix ? path.join(base, newest, suffix) : path.join(base, newest));
      }
    } catch {
      /* not installed */
    }
  }
  return directories;
}

// The home directory the guesses start from: Electron's own answer, handed
// over once at startup. This module may not import electron, because the main
// harness loads everything but main.js with Node's own require.
export let toolPathHome: string | undefined = undefined;
export function setToolPathHome(home: string): void {
  assert(path.isAbsolute(home), 'The tool path home is an absolute path');
  toolPathHome = home;
}

// Costs a shell spawn, so it runs once, lazily — nothing needs it until a
// child process is about to start.
export let toolPathReady = false;
export function ensureToolPath() {
  if (toolPathReady) {
    return;
  }
  assert(toolPathHome !== undefined, 'setToolPathHome runs before any child process starts');
  toolPathReady = true;
  const candidates: string[] = [];
  // Appended, not prepended: the system's own resolution order stays intact,
  // and these directories only ever win for tools the base PATH lacks.
  if (!isWin) {
    candidates.push(...shellPathDirectories());
  }
  for (const directory of nodeDirectoryGuesses(toolPathHome)) {
    if (fs.existsSync(directory)) {
      candidates.push(directory);
    }
  }
  const current = pathEnvironmentValue(process.env);
  setPathEnvironment(process.env, mergeToolPaths(current, candidates));
}

export function resolveNodeBin() {
  ensureToolPath();
  const exe = isWin ? 'node.exe' : 'node';
  for (const directory of pathEnvironmentValue(process.env).split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    const candidate = path.join(directory, exe);
    try {
      if (fs.statSync(candidate).isFile()) {
        return candidate;
      }
    } catch {
      /* not here */
    }
  }
  return undefined;
}

// node_modules/.bin/<name> is a symlink to the package's JS entry on POSIX
// and a wrapper script on Windows. The package's own `bin` field is correct
// on both (and survives pnpm's store layout, where the symlink points
// somewhere else entirely), so read that first and fall back to the link.
export function resolveCliEntry(binPath: string) {
  const name = path.basename(binPath).replace(/\.(cmd|ps1|exe|bat)$/i, '');
  const pkgDirectory = path.join(path.dirname(binPath), '..', name);
  try {
    const pkg = parseRecord(readJson(path.join(pkgDirectory, 'package.json')));
    const bin = pkg['bin'];
    const rel = parseOptionalString(typeof bin === 'string' ? bin : toRecord(bin)?.[name]);
    if (rel) {
      const entry = path.join(pkgDirectory, rel);
      if (fs.existsSync(entry)) {
        return entry;
      }
    }
  } catch {
    /* not a plain node_modules layout */
  }
  try {
    const real = fs.realpathSync(binPath);
    if (/\.(js|mjs|cjs)$/i.test(real)) {
      return real;
    }
  } catch {
    /* not a symlink */
  }
  return undefined;
}

// Runs the CLI's JS entry point under a resolved Node instead of going
// through the .bin shim, so the shebang's own PATH lookup — the thing that
// fails on a GUI launch — never happens. Returns [command, argv].
export function nodeCliCommand(binPath: string, args: readonly string[]): [string, string[]] {
  const node = resolveNodeBin();
  if (!node) {
    return [binPath, [...args]];
  }
  const entry = resolveCliEntry(binPath);
  return entry ? [node, [entry, ...args]] : [binPath, [...args]];
}

export function run(
  cmd: string,
  args: readonly string[],
  cwd: string,
  options: ExecFileOptions = {},
) {
  // Launched from Finder, the packaged app inherits a bare PATH — Homebrew's
  // bin isn't on it, so `gh` looks uninstalled however it was set up. Cheap
  // after the first call (memoized).
  ensureToolPath();
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    execFile(
      cmd,
      [...args],
      {
        cwd,
        timeout: options.timeout || 60000,
        shell: commandNeedsShell(cmd),
        maxBuffer: MAIN_LIMITS.commandOutputBytesMax,
        ...options,
      },
      (error, stdout, stderr) => {
        if (error) {
          Object.assign(error, { stdout, stderr });
          reject(error);
        } else {
          resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
        }
      },
    );
  });
}

export async function git(
  projectPath: string,
  args: readonly string[],
  options: ExecFileOptions = {},
) {
  return run('git', args, projectPath, options);
}

export async function findFreePort(start: number): Promise<number> {
  assert(Number.isSafeInteger(start), 'Starting port must be an integer');
  assert(start > 0, 'Starting port must be positive');
  for (let attempt = 0; attempt < MAIN_LIMITS.portAttemptsMax; attempt++) {
    const port = start + attempt;
    if (port > 65535) {
      break;
    }
    const available = await findFreePortProbe(port);
    if (available) {
      return port;
    }
  }
  throw new Error('No available preview port within the search limit');
}

export function findFreePortProbe(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (error: NodeJS.ErrnoException) => {
      switch (error.code) {
        // Windows reserves port ranges even when no process is listening.
        // Treat those ports as unavailable within the existing bounded search.
        case 'EADDRINUSE':
        case 'EACCES':
          resolve(false);
          break;
        case undefined:
        default:
          reject(error);
      }
    });
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

export function stopProcessTree(proc: ChildProcess | undefined) {
  if (!proc?.pid) {
    return;
  }
  try {
    if (isWin) {
      spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { windowsHide: true }).on(
        'error',
        () => {
          try {
            proc.kill('SIGTERM');
          } catch {
            /* already gone */
          }
        },
      );
    } else {
      process.kill(-proc.pid, 'SIGTERM');
    }
  } catch {
    try {
      proc.kill('SIGTERM');
    } catch {
      /* already gone */
    }
  }
}

// A dev server for a project that is not open, kept apart from the app's own:
// `devServer` belongs to the canvas, and a thumbnail must not disturb what the
// editor is showing. The project's own config is used rather than the app's
// generated one — the picture is of the site, not of the canvas.
export function spawnAstroServer(
  projectPath: string,
  localBin: string,
  args: readonly string[],
  extraEnvironment: Readonly<Record<string, string>> = {},
) {
  const [cmd, argv] = nodeCliCommand(localBin, args);
  return spawn(cmd, argv, {
    cwd: projectPath,
    shell: commandNeedsShell(cmd),
    // Give descendants their own process group so closing a project can stop
    // Vite and Astro together, including CLIs that launch another process.
    detached: !isWin,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...extraEnvironment, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
}
