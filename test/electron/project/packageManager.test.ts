// Goal: a project's package manager comes from package.json's packageManager field when it
// names one Stacki runs, then from its lockfile, then npm; each installs with its own command.
// A new site is created only with a manager from the tested list, at the IPC boundary too.
// Method: parse valid, versioned, unknown, malformed and oversized fields, then detect inside
// temporary project folders that combine fields and lockfiles, and pin each install command.
// Detection walks up to the filesystem root, so every folder sits under one with an npm lockfile:
// a stray lockfile above the temp folder cannot change an answer. Nothing is installed.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { detectPackageManager, installArguments } from '#dist/electron/project/packageManager.js';
import { commandNeedsShell } from '#dist/electron/lib/platform.js';
import { resolvePublishExecutable } from '#dist/electron/project/publishExecutable.js';
import {
  CREATE_PACKAGE_MANAGERS,
  PACKAGE_MANAGERS,
  packageManagerLabel,
  parseCreatePackageManager,
  scaffolderManager,
  parsePackageManagerField,
} from '#dist/shared/properties/packageManager.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const starter = (packageManager: string | undefined) => ({
  parentPath: '/tmp/sites',
  name: 'my-site',
  ...(packageManager === undefined ? {} : { packageManager }),
});

async function project(context: TestContext, files: Readonly<Record<string, string>>) {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-package-manager-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package-lock.json'), '{}');
  const directory = path.join(root, 'project');
  await mkdir(directory);
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
  for (const input of [undefined, 7, '', '@9.0.0', 'deno@2.0.0', 'PNPM@9.0.0', ` pnpm@9.0.0`, `pnpm@${'9'.repeat(256)}`]) {
    assert.equal(parsePackageManagerField(input), undefined, String(input));
  }
});

test('a new site can be created with npm, pnpm or bun, and nothing else yet', () => {
  assert.deepEqual(CREATE_PACKAGE_MANAGERS, ['npm', 'pnpm', 'bun']);
  assert.equal(parseCreatePackageManager('npm'), 'npm');
  assert.equal(parseCreatePackageManager('pnpm'), 'pnpm');
  assert.equal(parseCreatePackageManager('bun'), 'bun');
  for (const input of [undefined, 7, '', 'yarn', 'BUN', 'PNPM', ' npm']) {
    assert.throws(() => parseCreatePackageManager(input), /expected one of npm, pnpm, bun$/, String(input));
  }
  assert.equal(parseIpcPayload('project:createStarter', starter('pnpm')).packageManager, 'pnpm');
  assert.equal(parseIpcPayload('project:createStarter', starter(undefined)).packageManager, undefined);
  assert.throws(() => parseIpcPayload('project:createStarter', starter('yarn')), /expected one of npm, pnpm, bun/);
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

// Goal: on Windows every manager is found however it was installed (a .cmd shim or an .exe), which only cmd.exe
// does for a bare name. Method: ask the shell rule about each platform's answer.
test('on Windows a package manager named bare is started through the shell, and nothing else is', () => {
  for (const manager of PACKAGE_MANAGERS) {
    assert.equal(commandNeedsShell(manager, 'win32'), true, manager);
    assert.equal(commandNeedsShell(manager, 'darwin'), false, manager);
    assert.equal(commandNeedsShell(manager, 'linux'), false, manager);
  }
  for (const command of ['git', 'node', 'bun.exe', 'C:\\Tools\\bun', 'bun create']) {
    assert.equal(commandNeedsShell(command, 'win32'), false, command);
  }
});

test('Bun runs the scaffolder itself; every other manager goes through npm', () => {
  assert.deepEqual(PACKAGE_MANAGERS.map(scaffolderManager), ['npm', 'npm', 'npm', 'bun']);
});

// Goal: a Bun site on Windows can add its deploy tool. Method: resolve the command as Windows would; the other
// managers there are run as JavaScript under Node, which Bun's native program cannot be.
test('on Windows Bun is resolved to its own program, with its arguments untouched', () => {
  const command = { executable: 'bun', arguments: ['add', '--dev', 'wrangler'], environment: {} } as const;
  assert.deepEqual(resolvePublishExecutable(tmpdir(), command, 'win32'), { executable: 'bun.exe', arguments: command.arguments });
});
