// Goal: a project's package manager comes from package.json's packageManager field when it
// names one Stacki runs, then from its lockfile, then npm; each installs with its own command.
// Method: parse valid, versioned, unknown, malformed and oversized fields, then detect inside
// temporary project folders that combine fields and lockfiles, and pin each install command.
// Nothing is installed.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectPackageManager, installArguments } from '#dist/electron/project/packageManager.js';
import {
  PACKAGE_MANAGERS,
  packageManagerLabel,
  parsePackageManagerField,
} from '#dist/shared/properties/packageManager.js';

async function project(context: TestContext, files: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-package-manager-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(path.join(directory, name), content);
  }
  return directory;
}

test('the packageManager field names a manager with or without a version', () => {
  assert.equal(parsePackageManagerField('pnpm@9.12.0'), 'pnpm');
  assert.equal(parsePackageManagerField('yarn@4.5.0+sha512.abc123'), 'yarn');
  assert.equal(parsePackageManagerField('bun@1.1.30'), 'bun');
  assert.equal(parsePackageManagerField('npm'), 'npm');
});

test('the packageManager field names nothing when unknown, malformed or oversized', () => {
  for (const input of [
    undefined,
    7,
    '',
    '@9.0.0',
    'deno@2.0.0',
    'PNPM@9.0.0',
    ` pnpm@9.0.0`,
    `pnpm@${'9'.repeat(256)}`,
  ]) {
    assert.equal(parsePackageManagerField(input), undefined, String(input));
  }
});

test('each package manager installs dependencies with its own command', () => {
  assert.deepEqual(installArguments('npm'), ['install', '--no-audit', '--no-fund']);
  assert.deepEqual(installArguments('pnpm'), ['install', '--config.strict-dep-builds=false']);
  assert.deepEqual(installArguments('yarn'), ['install']);
  assert.deepEqual(installArguments('bun'), ['install']);
});

test('every package manager has the name people know it by', () => {
  assert.deepEqual(
    PACKAGE_MANAGERS.map((manager) => packageManagerLabel(manager)),
    ['npm', 'pnpm', 'Yarn', 'Bun'],
  );
});

test('the packageManager field outranks the lockfile', async (context) => {
  const directory = await project(context, {
    'package.json': JSON.stringify({ packageManager: 'pnpm@9.12.0' }),
    'package-lock.json': '{}',
    'yarn.lock': '',
  });
  assert.equal(detectPackageManager(directory), 'pnpm');
});

test('lockfiles decide when the field is absent, unknown or unreadable', async (context) => {
  const cases = [
    [{ 'package.json': '{}', 'pnpm-lock.yaml': '' }, 'pnpm'],
    [{ 'package.json': JSON.stringify({ packageManager: 'deno@2.0.0' }), 'yarn.lock': '' }, 'yarn'],
    [{ 'package.json': '{ not json', 'bun.lock': '' }, 'bun'],
    [{ 'bun.lockb': '' }, 'bun'],
    [{ 'package.json': '{}' }, 'npm'],
    [{}, 'npm'],
  ] as const;
  for (const [files, expected] of cases) {
    assert.equal(detectPackageManager(await project(context, files)), expected);
  }
});
