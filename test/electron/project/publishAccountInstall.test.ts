// Goal: missing project Wrangler installs once with the site's package manager before login, which
// then starts in the same session. Installation stays bounded, and cancelling it skips login
// without interrupting the package manager.
// Method: run deterministic child processes through the real session manager and intercept only
// process launch when checking install arguments. No packages are downloaded and no account is
// changed. Timeouts use mocked timers.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import childProcess, {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import {
  PublishingAccount,
  wranglerInstallArguments,
} from '#dist/electron/project/publishAccount.js';
import { projectHasWrangler } from '#dist/electron/project/publishExecutable.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { ACCOUNT_INSTALL_TIMEOUT_MS } from '#dist/shared/ipc/publishAccount.js';

const id = '00000000-0000-4000-8000-000000000000';
const other = '11111111-1111-4111-8111-111111111111';
const request = { id, provider: 'cloudflare' as const };
const root = process.cwd();
const browserURL = 'https://dash.cloudflare.com/oauth2/auth?client_id=test&state=nonce';
const login = `process.stdout.write('${browserURL}\\n'); setInterval(() => {}, 1000);`;
const endless = "process.stdout.write('ready'); setInterval(() => {}, 1000);";

function fixture(context: TestContext, script: string) {
  const children: ChildProcessWithoutNullStreams[] = [];
  const steps: string[] = [];
  const account = new PublishingAccount(
    (_root, provider, step) => {
      assert.equal(provider, 'cloudflare');
      steps.push(step.kind);
      const child = spawn(process.execPath, ['-e', step.kind === 'installing' ? script : login], {
        stdio: 'pipe',
        shell: false,
        detached: process.platform !== 'win32',
      });
      children.push(child);
      return child;
    },
    () => false,
    () => 'pnpm',
  );
  context.after(() => {
    account.request(root, { ...request, action: 'cancel' });
    for (const child of children) {
      child.kill('SIGKILL');
    }
  });
  assert.deepEqual(account.request(root, { ...request, action: 'start' }), {
    kind: 'installing',
  });
  const installer = children[0];
  assert.ok(installer);
  return { account, children, installer, steps };
}

test('the install uses the package manager detected for the site', () => {
  const managers: string[] = [];
  const account = new PublishingAccount(
    (_root, _provider, step) => {
      assert.equal(step.kind, 'installing');
      managers.push(step.packageManager);
      throw new Error('the test only inspects the launch step');
    },
    () => false,
    () => 'yarn',
  );
  account.request(root, { ...request, action: 'start' });
  assert.deepEqual(managers, ['yarn']);
});

test('successful installation automatically begins login in the same session', async (context) => {
  const { account, children, installer, steps } = fixture(context, "console.log('installed');");
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'installing');
  assert.equal(account.request(root, { ...request, id: other, action: 'start' }).kind, 'failed');
  await once(installer, 'close');
  const child = children[1];
  assert.ok(child);
  await once(child.stdout, 'data');
  assert.deepEqual(steps, ['installing', 'starting']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'browser',
    url: browserURL,
  });
  installer.emit('close', 1);
  installer.emit('error', new Error('late installer failure'));
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'browser');
  account.request(root, { ...request, action: 'cancel' });
  await once(child, 'close');
});

test('failed installation never starts login or exposes installer output', async (context) => {
  const { account, installer, steps } = fixture(
    context,
    "process.stderr.write('registry-secret'); process.exitCode = 1;",
  );
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  const state = account.request(root, { ...request, action: 'status' });
  assert.equal(state.kind, 'failed');
  assert.equal(JSON.stringify(state).includes('registry-secret'), false);
  const retry = { ...request, id: other };
  assert.equal(account.request(root, { ...retry, action: 'start' }).kind, 'installing');
  account.request(root, { ...retry, action: 'cancel' });
});

test('a missing package manager reports which one to install', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-missing-manager-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(path.join(directory, 'missing-pnpm'), [], { stdio: 'pipe', shell: false });
  const account = new PublishingAccount(
    () => child,
    () => false,
    () => 'pnpm',
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(account.request(directory, { ...request, action: 'start' }).kind, 'installing');
  await closed;
  assert.deepEqual(account.request(directory, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Could not run pnpm to install Wrangler. Install pnpm, then try again.',
  });
});

test('a package manager that cannot be resolved fails without a session', () => {
  const account = new PublishingAccount(
    () => {
      throw new Error('Install bun in this project.');
    },
    () => false,
    () => 'bun',
  );
  assert.deepEqual(account.request(root, { ...request, action: 'start' }), {
    kind: 'failed',
    message: 'Could not run Bun to install Wrangler. Install Bun, then try again.',
  });
  // No session was left pending, so a retry reports the same cause, not a sign-in in progress.
  assert.deepEqual(account.request(root, { ...request, id: other, action: 'start' }), {
    kind: 'failed',
    message: 'Could not run Bun to install Wrangler. Install Bun, then try again.',
  });
});

test('cancelling installation skips login but lets the installer finish', async (context) => {
  const { account, installer, steps } = fixture(
    context,
    "process.stdout.write('ready'); setTimeout(() => {}, 300);",
  );
  await once(installer.stdout, 'data');
  assert.equal(account.request(root, { ...request, action: 'cancel' }).kind, 'cancelled');
  assert.ok(installer.exitCode === null, 'the installer keeps running after cancel');
  assert.ok(installer.signalCode === null, 'the installer is not signalled on cancel');
  assert.deepEqual(account.request(root, { ...request, id: other, action: 'start' }), {
    kind: 'failed',
    message: 'Wrangler is still installing in the background. Try again in a moment.',
  });
  await once(installer, 'close');
  assert.equal(installer.exitCode, 0);
  assert.deepEqual(steps, ['installing']);
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'cancelled');
  const retry = { ...request, id: other };
  assert.equal(account.request(root, { ...retry, action: 'start' }).kind, 'installing');
  account.request(root, { ...retry, action: 'cancel' });
});

test('a cancelled installation is still stopped at its timeout', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { account, installer, steps } = fixture(context, endless);
  await once(installer.stdout, 'data');
  assert.equal(account.request(root, { ...request, action: 'cancel' }).kind, 'cancelled');
  context.mock.timers.tick(ACCOUNT_INSTALL_TIMEOUT_MS);
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'cancelled');
});

test('installation timeout stops the process without starting login', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { account, installer, steps } = fixture(context, endless);
  await once(installer.stdout, 'data');
  context.mock.timers.tick(ACCOUNT_INSTALL_TIMEOUT_MS);
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Wrangler installation timed out. Check your connection and try again.',
  });
});

test('installation discards and bounds output', async (context) => {
  const { account, installer, steps } = fixture(
    context,
    "process.stdout.write('x'.repeat(1048577)); setInterval(() => {}, 1000);",
  );
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Wrangler installation returned too much output.',
  });
});

test('each package manager adds the latest Wrangler as a development dependency', () => {
  assert.deepEqual(wranglerInstallArguments('npm'), ['install', '--save-dev', 'wrangler']);
  assert.deepEqual(wranglerInstallArguments('pnpm'), [
    'add',
    '--save-dev',
    '--config.strict-dep-builds=false',
    'wrangler',
  ]);
  assert.deepEqual(wranglerInstallArguments('yarn'), ['add', '--dev', 'wrangler']);
  assert.deepEqual(wranglerInstallArguments('bun'), ['add', '--dev', 'wrangler']);
});

test('Wrangler detection supports project and workspace dependencies', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-account-install-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(projectHasWrangler(directory), false);
  const dependency = path.join(directory, 'node_modules/wrangler');
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), '{"name":"wrangler"}');
  assert.equal(projectHasWrangler(directory), true);
  assert.equal(projectHasWrangler(path.join(directory, 'packages/site')), true);
});

test('Wrangler removed while Stacki runs is detected as missing again', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-account-removed-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const dependency = path.join(directory, 'node_modules/wrangler');
  await mkdir(dependency, { recursive: true });
  await writeFile(path.join(dependency, 'package.json'), '{"name":"wrangler"}');
  assert.equal(projectHasWrangler(directory), true);
  // Node's resolution cache still returns this path after removal, as after `pnpm remove`.
  await rm(dependency, { recursive: true, force: true });
  assert.equal(projectHasWrangler(directory), false);
});

test('default launch installs Wrangler with the site package manager', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-account-command-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{"packageManager":"npm@10.9.0"}');
  setToolPathHome(homedir());
  const child = spawn(process.execPath, ['-e', 'process.exitCode = 1;'], {
    stdio: 'pipe',
    shell: false,
  });
  context.mock.method(
    childProcess,
    'spawn',
    (executable: string, argumentsList: readonly string[], options: SpawnOptionsWithoutStdio) => {
      assert.equal(typeof executable, 'string');
      const expected = wranglerInstallArguments('npm');
      assert.deepEqual(argumentsList.slice(-expected.length), expected);
      assert.equal(options.cwd, directory);
      assert.equal(options.shell, false);
      assert.equal(options.detached, process.platform !== 'win32');
      return child;
    },
  );
  const account = new PublishingAccount();
  assert.equal(account.request(directory, { ...request, action: 'start' }).kind, 'installing');
  await once(child, 'close');
  assert.equal(account.request(directory, { ...request, action: 'status' }).kind, 'failed');
});
