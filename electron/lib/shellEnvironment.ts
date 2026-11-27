// The starting environment for a child process the person would recognise: this
// app's own environment with Electron's fingerprints taken off and the common
// tool folders added to PATH. It reads no shell startup file. The terminal dock
// (terminal/terminal.ts) spawns its login shell from it, and that shell then
// reads the startup files itself. The AI panel (handlers/ai/) starts from it
// too, and its agents also get an allowlist of sign-in settings read from the
// login shell (lib/loginShellSettings.ts): only the agents, never from here.
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mergeToolPaths, pathEnvironmentValue, setPathEnvironment, staticToolPathGuesses } from './platform';

const isWin = process.platform === 'win32';

// Build the env a login shell can start from.
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
export function buildShellEnv(): Record<string, string | undefined> {
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
