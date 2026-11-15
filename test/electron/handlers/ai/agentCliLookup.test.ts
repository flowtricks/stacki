// Goal: the AI panel finds the person's own Claude Code and Codex CLI the way
// the system does. On Windows the PATH variable is `Path`, and a copy of the
// environment is a plain object whose keys are case-sensitive, so a bare
// `['PATH']` read found nothing and reported an installed CLI as missing
// (issue 82). The lookup must read the PATH case-insensitively there, honour
// PATHEXT, keep reading `PATH` exactly as before on macOS and Linux, and the
// Windows tool guesses must include the native installer's folder.
// Methodology: findCli, AgentSetup and AgentHost from dist/ with the platform
// named `win32` and an in-memory file system keyed by Windows paths, so the
// cases run the same on macOS, Linux and Windows; the POSIX case does the same with POSIX paths,
// so no real folder, executable bit or host path rule is involved. ELECTRON_RUN_AS_NODE is deleted, never emptied.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { AgentSetup } from '#dist/electron/handlers/ai/agentSetup.js';
import { findCli, type CliFileSystem } from '#dist/electron/handlers/ai/agentRegistry.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { staticToolPathGuesses } from '#dist/electron/lib/platform.js';

delete process.env['ELECTRON_RUN_AS_NODE'];

// Windows can hold a folder open a moment after a process ends (EBUSY, EPERM), so removal retries, bounded.
const REMOVE_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

const TOOLS = 'C:\\Users\\Tim\\AppData\\Local\\Programs\\Claude';
const CLAUDE_EXE = `${TOOLS}\\claude.exe`;

/** A disk holding exactly `files`; each resolves to itself. */
function fakeDisk(...files: readonly string[]): CliFileSystem {
  return { resolveFile: (candidate) => (files.includes(candidate) ? candidate : undefined) };
}

test('Windows: a Path-only environment finds claude.exe', () => {
  const environment = { Path: `C:\\Windows\\System32;${TOOLS}` };
  assert.equal(findCli('claude', { environment, platform: 'win32', fileSystem: fakeDisk(CLAUDE_EXE) }), CLAUDE_EXE);
  assert.equal(findCli('codex', { environment, platform: 'win32', fileSystem: fakeDisk(CLAUDE_EXE) }), undefined);
});

test('Windows: the PATH key is found in any casing, and quoted entries are unquoted', () => {
  const disk = fakeDisk(CLAUDE_EXE);
  for (const key of ['Path', 'PATH', 'path', 'pAtH']) {
    assert.equal(findCli('claude', { environment: { [key]: `"${TOOLS}"` }, platform: 'win32', fileSystem: disk }), CLAUDE_EXE, key);
  }
  assert.equal(findCli('claude', { environment: { HOME: TOOLS }, platform: 'win32', fileSystem: disk }), undefined);
});

test('Windows: PATHEXT decides the names, and the .cmd and .bat shims are still found', () => {
  const npmBin = 'C:\\Users\\Tim\\AppData\\Roaming\\npm';
  const environment = { Path: npmBin };
  assert.equal(findCli('codex', { environment, platform: 'win32', fileSystem: fakeDisk(`${npmBin}\\codex.cmd`) }), `${npmBin}\\codex.cmd`);
  assert.equal(findCli('codex', { environment, platform: 'win32', fileSystem: fakeDisk(`${npmBin}\\codex.bat`) }), `${npmBin}\\codex.bat`);
  const both = fakeDisk(`${npmBin}\\codex.cmd`, `${npmBin}\\codex.exe`);
  assert.equal(findCli('codex', { environment: { ...environment, PATHEXT: '.EXE;.CMD' }, platform: 'win32', fileSystem: both }), `${npmBin}\\codex.exe`);
  assert.equal(findCli('codex', { environment: { ...environment, PATHEXT: '.CMD;.EXE' }, platform: 'win32', fileSystem: both }), `${npmBin}\\codex.cmd`);
  assert.equal(findCli('codex', { environment, platform: 'win32', fileSystem: fakeDisk(`${npmBin}\\codex.ps1`) }), undefined);
});

test('macOS and Linux: PATH is read as before, and a bare name is the only name tried', () => {
  const directory = '/home/tim/.local/bin';
  const cli = `${directory}/claude`;
  for (const platform of ['darwin', 'linux'] as const) {
    const fileSystem = fakeDisk(cli, `${directory}/codex.exe`);
    assert.equal(findCli('claude', { environment: { PATH: `/nonexistent:${directory}`, Path: '/elsewhere' }, platform, fileSystem }), cli);
    assert.equal(findCli('codex', { environment: { PATH: directory }, platform, fileSystem }), undefined);
    assert.equal(findCli('claude', { environment: { Path: directory }, platform, fileSystem }), undefined);
  }
});

test('AgentSetup finds claude.exe from a Path-only Windows environment', async () => {
  const setup = new AgentSetup({
    environment: () => ({ Path: TOOLS }),
    openExternal: () => undefined,
    publish: () => undefined,
    platform: 'win32',
    home: 'C:\\Users\\Tim',
    cliFileSystem: fakeDisk(CLAUDE_EXE),
    fileSystem: { fileExists: (file: string) => file === CLAUDE_EXE, readText: () => undefined, listDirectory: () => [] },
    spawnPipe: () => ({
      onData: () => undefined,
      onExit: (listener: (code: number) => void) => setImmediate(() => listener(0)),
      write: () => undefined,
      kill: () => undefined,
    }),
  });
  const state = await setup.act('claude', { kind: 'detect' });
  assert.notEqual(state.step, 'missing');
  const absent = await setup.act('codex', { kind: 'detect' });
  assert.equal(absent.step, 'missing');
});

test('AgentHost finds claude.exe from a Path-only Windows environment', () => {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-cli-host-'));
  try {
    const host = new AgentHost({
      userData,
      store: new ChatStore(path.join(userData, 'ai')),
      send: () => undefined,
      files: { read: () => undefined, write: () => undefined, create: () => undefined, trash: async () => undefined },
      snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
      environment: () => ({ Path: TOOLS }),
      now: () => 1_000,
      version: 'test',
      platform: 'win32',
      cliFileSystem: fakeDisk(CLAUDE_EXE),
      entryOf: () => undefined,
    });
    assert.equal(host.availability('claude', undefined).state, 'needs-install');
    assert.equal(host.availability('codex', undefined).state, 'missing-cli');
  } finally {
    fs.rmSync(userData, REMOVE_OPTIONS);
  }
});

test('Windows tool guesses include the native installer folder and npm global, and POSIX has none', () => {
  const guesses = staticToolPathGuesses('C:\\Users\\Tim', { APPDATA: 'C:\\Users\\Tim\\AppData\\Roaming' }, 'win32');
  assert.ok(guesses.includes('C:\\Users\\Tim\\.local\\bin'));
  assert.ok(guesses.includes('C:\\Users\\Tim\\AppData\\Roaming\\npm'));
  assert.deepEqual(staticToolPathGuesses('/home/tim', {}, 'linux'), []);
});

// The bug was one bare read on a copied environment. Reads of the live `process.env` are fine (Windows keeps that
// one case-insensitive), so this guards the shape that failed: a PATH read straight off a dependency's environment.
test('no source reads PATH straight off an injected environment', () => {
  const offenders: string[] = [];
  const pending = [path.resolve('electron')];
  for (let visited = 0; pending.length > 0 && visited < 5_000; visited++) {
    const entry = pending.pop();
    assert.ok(entry !== undefined, 'a pending entry');
    if (fs.statSync(entry).isDirectory()) {
      pending.push(...fs.readdirSync(entry).map((name) => path.join(entry, name)));
    } else if (entry.endsWith('.ts') && /environment\(\)\s*(\[\s*['"]PATH['"]\s*\]|\.PATH\b)/.test(fs.readFileSync(entry, 'utf8'))) {
      offenders.push(entry);
    }
  }
  assert.deepEqual(offenders, []);
});
