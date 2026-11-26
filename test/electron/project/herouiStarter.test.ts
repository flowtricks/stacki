// Exercise staging, the catalog writer, Git and publication using test doubles
// only at the package manager and injected move failures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { createHeroUIStarter } from '#dist/electron/project/herouiStarter.js';
import { detectPackageManager } from '#dist/electron/project/packageManager.js';
import { runCreateCommand } from '#dist/electron/project/starter.js';

type Runner = typeof runCreateCommand;

const name = 'new-site';
const noop = (): void => undefined;

async function makeParent(context: TestContext): Promise<string> {
  const parent = await realpath(await mkdtemp(path.join(os.tmpdir(), 'stacki heroui starter ')));
  context.after(() => rm(parent, { force: true, recursive: true }));
  return parent;
}

function installFixture(lockfile: string, writeExtra?: (directory: string) => Promise<void>): Runner {
  return async (command, argumentsList, directory, onLog, options) => {
    assert.equal(options?.waitForStop, true);
    if (command === 'git') {
      return runCreateCommand(command, argumentsList, directory, onLog, options);
    }
    if (argumentsList[0] === '--version') {
      return /^npm/.test(command) ? '10.9.9\n' : '12.23.0\n';
    }
    assert.equal(argumentsList[0], 'install');
    assert.equal(options?.environment?.['COREPACK_ENABLE_PROJECT_SPEC'], '0');
    assert.match(path.basename(path.dirname(directory)), /^\.stacki-heroui-/);
    assert.match(await readFile(path.join(directory, 'src/styles/theme.css'), 'utf8'), /:root\[data-theme="dark"\]/);
    if (command.startsWith('npm')) {
      assert.ok(argumentsList.includes('--workspaces=false'));
      assert.equal(options.environment?.['npm_config_workspaces'], 'false');
    } else {
      assert.ok(argumentsList.includes('--config.node-linker=hoisted'));
      assert.equal(await readFile(path.join(directory, 'pnpm-workspace.yaml'), 'utf8'), 'packages: []\nnodeLinker: hoisted\n');
    }
    await writeFile(path.join(directory, lockfile), 'fixture lockfile\n');
    await writeExtra?.(directory);
    return '';
  };
}

for (const [manager, lockfile] of [
  ['npm', 'package-lock.json'],
  ['pnpm', 'pnpm-lock.yaml'],
] as const) {
  test(`publishes an isolated ${manager} site with tracked sources and one Git commit`, async (context) => {
    const parentPath = await makeParent(context);
    const parentManifest = '{"name":"parent","private":true,"workspaces":["**"]}\n';
    await writeFile(path.join(parentPath, 'package.json'), parentManifest);
    await writeFile(path.join(parentPath, 'pnpm-workspace.yaml'), 'packages: ["**"]\n');
    const logs: string[] = [];
    const request = manager === 'npm' ? { parentPath, name } : { parentPath, name, packageManager: manager };
    const { projectPath } = await createHeroUIStarter(request, (line) => logs.push(line), installFixture(lockfile));
    assert.deepEqual((await readdir(parentPath)).sort(), ['new-site', 'package.json', 'pnpm-workspace.yaml']);
    assert.equal(await readFile(path.join(parentPath, 'package.json'), 'utf8'), parentManifest);
    assert.equal(projectPath, path.join(parentPath, name));
    assert.equal(detectPackageManager(projectPath), manager);
    const git = (argumentsList: readonly string[]) => runCreateCommand('git', argumentsList, projectPath, undefined, { stdoutOnly: true });
    assert.equal((await git(['rev-list', '--count', 'HEAD'])).trim(), '1');
    assert.equal((await git(['status', '--porcelain'])).trim(), '');
    assert.equal((await git(['remote'])).trim(), '');
    const tracked = await git(['ls-files', '--', '.stacki', 'src/pages', 'src/styles', lockfile]);
    assert.match(tracked, /\.stacki\/components\.json/);
    assert.match(tracked, /\.stacki\/styles\.json/);
    assert.match(tracked, /src\/pages\/index\.astro/);
    assert.match(tracked, /src\/pages\/example-components\.astro/);
    assert.match(tracked, /src\/styles\/theme\.css/);
    assert.ok(tracked.includes(lockfile));
    assert.ok(logs.join('').includes(`> ${manager} install`));
    assert.match(logs.join(''), /Creating the first Git commit[\s\S]*Publishing the HeroUI site/);
  });
}

test('tool failure and a dangling destination are refused before staging', async (context) => {
  const parentPath = await makeParent(context);
  const request = { parentPath, name };
  let commandCount = 0;
  const missingTool: Runner = async () => {
    commandCount += 1;
    throw new Error('npm could not be found');
  };
  await assert.rejects(createHeroUIStarter(request, noop, missingTool), /npm could not be found/);
  assert.equal(commandCount, 1);
  assert.deepEqual(await readdir(parentPath), []);
  if (process.platform !== 'win32') {
    const destination = path.join(parentPath, name);
    await symlink(path.join(parentPath, 'absent'), destination);
    await assert.rejects(createHeroUIStarter(request, noop, missingTool), /already exists/);
    assert.equal(commandCount, 1);
    assert.equal((await fs.promises.lstat(destination)).isSymbolicLink(), true);
  }
});

test('install timeout, a changed manifest, a wrong lockfile or Git failure all allow retry', async (context) => {
  const parentPath = await makeParent(context);
  const request = { parentPath, name };
  const npm = installFixture('package-lock.json');
  const cases = [
    {
      message: /HeroUI dependency installation failed.*timed out/,
      run: installFixture('package-lock.json', () => Promise.reject(new Error('install timed out'))),
    },
    {
      message: /HeroUI dependency installation failed.*changed its name field/,
      run: installFixture('package-lock.json', (directory) => writeFile(path.join(directory, 'package.json'), '{"name":"unexpected"}')),
    },
    { message: /HeroUI dependency installation failed.*did not install.*npm/, run: installFixture('pnpm-lock.yaml') },
    {
      message: /HeroUI Git setup failed.*commit failed/,
      run: ((...args) => {
        const [command, argumentsList] = args;
        if (command === 'git' && argumentsList.includes('commit')) {
          return Promise.reject(new Error('commit failed'));
        }
        return npm(...args);
      }) satisfies Runner,
    },
  ];
  for (const entry of cases) {
    await assert.rejects(createHeroUIStarter(request, noop, entry.run), entry.message);
    assert.deepEqual(await readdir(parentPath), []);
  }
  const { projectPath } = await createHeroUIStarter(request, noop, npm);
  assert.equal(projectPath, path.join(parentPath, name));
  assert.deepEqual(await readdir(parentPath), [name]);
});

test('canonicalizes the parent and preserves a destination claimed during installation', { skip: process.platform === 'win32' }, async (context) => {
  const parent = await makeParent(context);
  const actual = path.join(parent, 'actual');
  const alias = path.join(parent, 'alias');
  const destination = path.join(actual, name);
  await mkdir(actual);
  await symlink(actual, alias);
  const run = installFixture('package-lock.json', async () => {
    await mkdir(destination);
    await writeFile(path.join(destination, 'keep.txt'), 'occupied');
  });
  await assert.rejects(createHeroUIStarter({ parentPath: alias, name }, noop, run), /already exists/);
  assert.deepEqual(await readdir(actual), [name]);
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'occupied');
  const result = await createHeroUIStarter({ parentPath: alias, name: 'another-site' }, noop, installFixture('package-lock.json'));
  assert.equal(result.projectPath, path.join(actual, 'another-site'));
});

test('only one concurrent attempt can claim the same destination', async (context) => {
  const parentPath = await makeParent(context);
  const request = { parentPath, name };
  const run = installFixture('package-lock.json');
  const result = await Promise.allSettled([createHeroUIStarter(request, noop, run), createHeroUIStarter(request, noop, run)]);
  const winner = result.find((entry) => entry.status === 'fulfilled');
  const loser = result.find((entry) => entry.status === 'rejected');
  assert.ok(winner?.status === 'fulfilled');
  assert.deepEqual(winner.value, { projectPath: path.join(parentPath, name) });
  assert.ok(loser?.status === 'rejected');
  const reason: unknown = loser.reason;
  assert.ok(reason instanceof Error);
  assert.match(reason.message, /already exists/);
  assert.deepEqual(await readdir(parentPath), [name]);
});

for (const rollback of ['works', 'fails'] as const) {
  test(`keeps the stage only when rolling back a partial move ${rollback}`, async (context) => {
    const parentPath = await makeParent(context);
    const destination = path.join(parentPath, name);
    const rename = fs.renameSync;
    let moveCount = 0;
    context.mock.method(fs, 'renameSync', (source: string, target: string) => {
      if (path.dirname(target) === destination) {
        moveCount += 1;
        if (moveCount === 2) {
          throw new Error('publication move failed');
        }
      }
      if (rollback === 'fails' && path.dirname(source) === destination) {
        throw new Error('rollback move failed');
      }
      rename(source, target);
    });
    const message = rollback === 'fails' ? /publication move failed.*rollback move failed.*files remain/ : /publication move failed/;
    await assert.rejects(createHeroUIStarter({ parentPath, name }, noop, installFixture('package-lock.json')), message);
    if (rollback === 'works') {
      assert.deepEqual(await readdir(parentPath), []);
    } else {
      const entries = await readdir(parentPath);
      const stage = entries.find((entry) => entry.startsWith('.stacki-heroui-'));
      assert.ok(stage);
      assert.ok(entries.includes(name));
      assert.ok((await readdir(destination)).length > 0);
      assert.ok((await readdir(path.join(parentPath, stage, name))).includes('package.json'));
    }
  });
}
