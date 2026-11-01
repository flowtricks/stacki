// What the dev server orchestration asks of a project before and while it
// runs: its trailing-slash setting, whether a port answers, an adopted server's
// lock, and whether its Node satisfies Astro's engine range.

import { object, text } from '../../shared/core/boundary';
import * as path from 'path';
import * as net from 'net';
import { createHash } from 'node:crypto';
import { assert } from '../../shared/core/assert';
import { spawnSync, execFileSync } from 'child_process';
import { capture, readJson } from '../lib/mainHelpers';
import { resolveNodeBin } from '../lib/nodeTools';

// The lock file `astro dev` leaves while it runs, read for the one field we use.
export const parseAstroLock = object({ url: text });

// Astro's dev server enforces the project's `trailingSlash`. Under 'always' a
// slashless URL is answered with a 404 and Astro's own page asking "Do you
// want to go to /de/hotel/ instead?"; under 'never' the slash is the 404. The
// canvas points at real URLs, so it has to know which spelling it serves.
export const TRAILING_SLASH_MODES = ['always', 'never', 'ignore'];
export const ASTRO_CONFIG_FILES = ['astro.config.mjs', 'astro.config.js', 'astro.config.mts', 'astro.config.ts', 'astro.config.cjs'];

// Read from the config's text, not by importing it: the file is ESM, is often
// TypeScript, and is written to be loaded by Astro rather than by this
// process. Whole-line comments go first so a commented-out setting doesn't
// count; a trailing `//` is left alone because it can't be told from the one
// in a URL without really parsing.
export function trailingSlashFromSource(text: string) {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const match = code.match(/(^|[\s,{])trailingSlash\s*:\s*['"`](always|never|ignore)['"`]/);
  return match ? capture(match, 2) : undefined;
}

export function portAnswers(port: number, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const sock = net.connect(port, host);
    sock.setTimeout(1500);
    sock.once('connect', () => {
      sock.destroy();
      resolve(true);
    });
    sock.once('timeout', () => {
      sock.destroy();
      resolve(false);
    });
    sock.once('error', () => resolve(false));
  });
}

// Astro hashes its server port into the content-cache key. Give each project a
// stable starting port so unrelated servers do not force a rebuild on every open.
export function previewPort(projectPath: string): number {
  assert(projectPath.length > 0, 'Preview port requires a project path');
  const digest = createHash('sha256').update(projectPath).digest();
  const port = 45000 + (digest.readUInt32BE(0) % 10000);
  assert(port >= 45000, 'Preview port must not fall below its search range');
  assert(port < 55000, 'Preview port must leave room for conflict retries');
  return port;
}

// Probe Vite's lightweight client, not the homepage: rendering a cold homepage
// can exceed the probe timeout and start repeated, abandoned renders before the
// canvas even navigates. Error responses still prove HTTP middleware is ready.
export async function serverResponds(url: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/@vite/client', url), {
      signal: AbortSignal.timeout(1500),
      redirect: 'manual',
    });
    await response.body?.cancel();
    return true;
  } catch {
    return false;
  }
}

// Astro >= 5 keeps a per-project single-instance lock and reports the
// already-running server's URL when it refuses to start. The message format
// varies: "already running.\n  URL: http://..." on a TTY, or a JSON log line
// "Dev server already running at http://localhost:4322 (pid 69052)" otherwise —
// so grab the first URL that follows "already running".
export function parseExistingServer(log: string) {
  const match = log.match(/already running[\s\S]*?(https?:\/\/[^\s"\\)]+)/i);
  return match ? capture(match, 1).replace(/\/+$/, '') : undefined;
}

// Node's own parser, asked the same question it will be asked at startup.
// Cheap next to spawning a dev server, and it turns a whole class of mistake
// in the generated config from "no preview" into "preview without extras".
export function parsesAsModule(file: string) {
  try {
    const bin = resolveNodeBin();
    if (!bin) {
      return true;
    } // nothing to check with — let Astro have its say
    const out = spawnSync(bin, ['--check', file], { encoding: 'utf8', timeout: 10000 });
    if (out.error || out.status === null) {
      return true;
    } // check could not run
    return out.status === 0;
  } catch {
    return true;
  }
}

// Probes the URL's port on its hostname plus both loopback families —
// on macOS "localhost" may resolve to ::1 while the server listens on IPv4.
export async function serverAlive(urlString: string) {
  const parsed = new URL(urlString);
  const port = Number(parsed.port || 80);
  for (const host of [parsed.hostname, '127.0.0.1', '::1']) {
    if (await portAnswers(port, host)) {
      return true;
    }
  }
  return false;
}

// Astro's daemon lock file (.astro/dev.json) — the source of truth for an
// already-running background server, regardless of who started it.
export function readAstroLock(projectPath: string) {
  try {
    const data = parseAstroLock(readJson(path.join(projectPath, '.astro', 'dev.json')));
    if (data.url) {
      return data;
    }
  } catch {
    /* no lock */
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Why the dev server won't start
//
// A raw Astro log tells a user nothing actionable. Nearly every failure that
// isn't the project's own code is one of: no Node at all, a Node too old for
// the version of Astro the project pins, or dependencies never installed —
// so name which one it is and what the project actually needs.
// ---------------------------------------------------------------------------

// engines.node ranges as they're actually written ("18.20.8 || ^20.3.0 ||
// >=22.0.0", ">=22.12.0"). Anything this can't parse counts as satisfied:
// the point is to explain a failure that already happened, never to block a
// launch over a range we couldn't read.
export function satisfiesRange(version: string | undefined, range: string | undefined) {
  if (!version || !range) {
    return true;
  }
  const parse = (text: string): readonly [number, number, number] | undefined => {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(String(text));
    return match ? [+capture(match, 1), +capture(match, 2), +capture(match, 3)] : undefined;
  };
  const current = parse(version);
  if (!current) {
    return true;
  }
  const cmp = (left: readonly [number, number, number], right: readonly [number, number, number]) =>
    left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
  return range.split('||').some((partRaw) => {
    const part = partRaw.trim();
    const target = parse(part);
    if (!target) {
      return true;
    } // "*", "latest", something exotic — don't judge
    if (part.startsWith('>=')) {
      return cmp(current, target) >= 0;
    }
    if (part.startsWith('>')) {
      return cmp(current, target) > 0;
    }
    if (part.startsWith('^')) {
      return current[0] === target[0] && cmp(current, target) >= 0;
    }
    if (part.startsWith('~')) {
      return current[0] === target[0] && current[1] === target[1] && cmp(current, target) >= 0;
    }
    return cmp(current, target) === 0;
  });
}

export function nodeVersionOf(bin: string) {
  try {
    return execFileSync(bin, ['--version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}
