// Goal: catch manifest/lockfile drift without trusting the developer's node_modules.
// Method: ask the active npm to plan clean installs in disposable directories for
// each release target. Offline dry runs neither download packages nor run lifecycle scripts.
import assert from 'node:assert/strict';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const INPUTS = [
  ['package.json', 'package-lock.json'],
  ['studio/package.json', 'studio/package-lock.json'],
  ['studio/test/fixtures/site/package.json', 'studio/test/fixtures/site/package-lock.json'],
] as const;
const TARGETS = [
  { os: 'darwin', cpu: 'arm64' },
  { os: 'darwin', cpu: 'x64' },
  { os: 'win32', cpu: 'x64' },
  { os: 'linux', cpu: 'x64' },
] as const;

for (const [manifest, lockfile] of INPUTS) {
  test(`${manifest} has a clean npm install plan for every release target`, () => {
    const npmCLI = process.env['npm_execpath'];
    // Git hooks invoke the gate directly, outside npm's environment. In that case
    // use the npm on PATH, which is the same entry a manual npm test would launch.
    const executable = npmCLI === undefined ? 'npm' : process.execPath;
    const directory = mkdtempSync(join(tmpdir(), 'stacki-clean-install-'));
    try {
      copyFileSync(manifest, join(directory, 'package.json'));
      copyFileSync(lockfile, join(directory, 'package-lock.json'));
      for (const target of TARGETS) {
        const result: SpawnSyncReturns<string> = spawnSync(
          executable,
          [
            ...(npmCLI === undefined ? [] : [npmCLI]),
            'ci',
            '--dry-run',
            '--ignore-scripts',
            '--offline',
            '--no-audit',
            '--no-fund',
            '--include=dev',
            '--include=optional',
            `--os=${target.os}`,
            `--cpu=${target.cpu}`,
          ],
          {
            cwd: directory,
            encoding: 'utf8',
            timeout: 60000,
            maxBuffer: 2_000_000,
            shell: npmCLI === undefined && process.platform === 'win32',
          },
        );
        assert.equal(result.error, undefined, `${manifest}: ${String(result.error)}`);
        assert.equal(result.status, 0, `${manifest} (${target.os}/${target.cpu}):\n${result.stderr}\n${result.stdout}`);
      }
      assert.deepEqual(readFileSync(join(directory, 'package-lock.json')), readFileSync(lockfile));
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
