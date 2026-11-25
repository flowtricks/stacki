// Goal: connecting Cloudflare without Wrangler installs Stacki's pinned copy once, then login starts in the same
// session. A clean installer exit is verified (finish) before login; any other ending discards the staging folder.
// Installation stays bounded, cancelling skips login without interrupting the installer, and every failure is a
// designer-worded sentence that names Cloudflare, never npm, Wrangler or installer output.
// Method: run deterministic child processes through the real session manager and replace only process launch and
// install planning with fakes that record finish and discard. No packages are downloaded and no account is changed.
// Timeouts use mocked timers.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import childProcess, { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { PublishingAccount, type ToolInstall } from '#dist/electron/project/publishAccount.js';
import { projectHasWrangler } from '#dist/electron/project/publishExecutable.js';
import { setAppToolsDirectory } from '#dist/electron/project/publishToolInstall.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { ACCOUNT_INSTALL_TIMEOUT_MS } from '#dist/shared/ipc/publishAccount.js';
import { ok, err } from '#dist/shared/core/result.js';

const id = '00000000-0000-4000-8000-000000000000';
const other = '11111111-1111-4111-8111-111111111111';
const request = { id, provider: 'cloudflare' as const };
const root = process.cwd();
const browserURL = 'https://dash.cloudflare.com/oauth2/auth?client_id=test&state=nonce';
const login = `process.stdout.write('${browserURL}\\n'); setInterval(() => {}, 1000);`;
const endless = "process.stdout.write('ready'); setInterval(() => {}, 1000);";

type Verdict = 'ok' | 'verify' | 'disk';

function fakeInstall(events: string[], verdict: Verdict = 'ok'): ToolInstall {
  return {
    arguments: ['install'],
    cwd: root,
    finish: () => {
      events.push('finish');
      return verdict === 'ok' ? ok(undefined) : err(verdict);
    },
    discard: () => {
      events.push('discard');
    },
  };
}

function fixture(context: TestContext, script: string, verdict: Verdict = 'ok') {
  const children: ChildProcessWithoutNullStreams[] = [];
  const steps: string[] = [];
  const events: string[] = [];
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
    () => ok(fakeInstall(events, verdict)),
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
  return { account, children, installer, steps, events };
}

test('successful installation is verified, then login begins in the same session', async (context) => {
  const { account, children, installer, steps, events } = fixture(context, "console.log('installed');");
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'installing');
  assert.equal(account.request(root, { ...request, id: other, action: 'start' }).kind, 'failed');
  await once(installer, 'close');
  const child = children[1];
  assert.ok(child);
  await once(child.stdout, 'data');
  assert.deepEqual(steps, ['installing', 'starting']);
  assert.deepEqual(events, ['finish']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'browser',
    url: browserURL,
  });
  installer.emit('error', new Error('late installer failure'));
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'browser');
  account.request(root, { ...request, action: 'cancel' });
  await once(child, 'close');
});

test('failed installation discards its folder, never starts login, and hides installer output', async (context) => {
  const { account, installer, steps, events } = fixture(context, "process.stderr.write('registry-secret'); process.exitCode = 1;");
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(events, ['discard']);
  const state = account.request(root, { ...request, action: 'status' });
  assert.deepEqual(state, {
    kind: 'failed',
    message: 'Could not finish setting up Cloudflare. Please try again.',
    messageRef: { key: 'publish.account.setup.failed', params: { provider: 'Cloudflare' } },
  });
  assert.equal(JSON.stringify(state).includes('registry-secret'), false);
  const retry = { ...request, id: other };
  assert.equal(account.request(root, { ...retry, action: 'start' }).kind, 'installing');
  account.request(root, { ...retry, action: 'cancel' });
});

test('an offline installation says the internet could not be reached', async (context) => {
  const { account, installer, events } = fixture(context, "process.stderr.write('npm error code ENOTFOUND registry.npmjs.org'); process.exitCode = 1;");
  await once(installer, 'close');
  assert.deepEqual(events, ['discard']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Could not reach the internet to set up Cloudflare. Check your connection, then try again.',
    messageRef: { key: 'publish.account.setup.offline', params: { provider: 'Cloudflare' } },
  });
});

test('an install that fails verification is refused and login never starts', async (context) => {
  const { account, installer, steps, events } = fixture(context, "console.log('installed');", 'verify');
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(events, ['finish']);
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'failed');
  assert.match(JSON.stringify(account.request(root, { ...request, action: 'status' })), /publish\.account\.setup\.verifyFailed/);
});

test('an install that cannot be moved into place reports the disk', async (context) => {
  const { account, installer } = fixture(context, "console.log('installed');", 'disk');
  await once(installer, 'close');
  assert.match(JSON.stringify(account.request(root, { ...request, action: 'status' })), /publish\.account\.setup\.disk/);
});

test('a staging folder that cannot be prepared fails before anything launches', () => {
  const launches: string[] = [];
  const account = new PublishingAccount(
    (_root, _provider, step) => {
      launches.push(step.kind);
      throw new Error('never launched');
    },
    () => false,
    () =>
      err({
        message: 'Could not save the Cloudflare setup on this computer.',
        messageRef: { key: 'publish.account.setup.disk', params: { provider: 'Cloudflare' } },
      }),
  );
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'failed');
  assert.deepEqual(launches, []);
  // No session was left pending, so a retry can start.
  assert.equal(account.request(root, { ...request, id: other, action: 'start' }).kind, 'failed');
});

test('missing Node (no npm) asks for Node.js and discards the staging folder', () => {
  const events: string[] = [];
  const account = new PublishingAccount(
    () => {
      throw new Error('npm is not on PATH');
    },
    () => false,
    () => ok(fakeInstall(events)),
  );
  assert.deepEqual(account.request(root, { ...request, action: 'start' }), {
    kind: 'failed',
    message: 'Setting up Cloudflare needs Node.js on this computer. Install it from nodejs.org, then try again.',
    messageRef: { key: 'publish.account.setup.needsNode', params: { provider: 'Cloudflare' } },
  });
  assert.deepEqual(events, ['discard']);
});

test('a missing npm found after launch reports Node.js too', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-missing-npm-'));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(path.join(directory, 'missing-npm'), [], { stdio: 'pipe', shell: false });
  const events: string[] = [];
  const account = new PublishingAccount(
    () => child,
    () => false,
    () => ok(fakeInstall(events)),
  );
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  assert.equal(account.request(directory, { ...request, action: 'start' }).kind, 'installing');
  await closed;
  assert.equal(account.request(directory, { ...request, action: 'status' }).kind, 'failed');
  assert.match(JSON.stringify(account.request(directory, { ...request, action: 'status' })), /publish\.account\.setup\.needsNode/);
  assert.deepEqual(events, ['discard']);
});

test('cancelling installation skips login, lets the installer finish, and keeps its verified result', async (context) => {
  const { account, installer, steps, events } = fixture(context, "process.stdout.write('ready'); setTimeout(() => {}, 300);");
  await once(installer.stdout, 'data');
  assert.equal(account.request(root, { ...request, action: 'cancel' }).kind, 'cancelled');
  assert.ok(installer.exitCode === null, 'the installer keeps running after cancel');
  assert.ok(installer.signalCode === null, 'the installer is not signalled on cancel');
  assert.deepEqual(account.request(root, { ...request, id: other, action: 'start' }), {
    kind: 'failed',
    message: 'Cloudflare is still being set up. Try again in a moment.',
    messageRef: { key: 'publish.account.setup.stillRunning', params: { provider: 'Cloudflare' } },
  });
  await once(installer, 'close');
  assert.equal(installer.exitCode, 0);
  assert.deepEqual(steps, ['installing']);
  // Kept, so the next Connect starts sign-in at once.
  assert.deepEqual(events, ['finish']);
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'cancelled');
});

test('a cancelled installation is still stopped at its timeout, and its folder discarded', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { account, installer, steps, events } = fixture(context, endless);
  await once(installer.stdout, 'data');
  assert.equal(account.request(root, { ...request, action: 'cancel' }).kind, 'cancelled');
  context.mock.timers.tick(ACCOUNT_INSTALL_TIMEOUT_MS);
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(events, ['discard']);
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'cancelled');
});

test('installation timeout stops the process without starting login', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { account, installer, steps, events } = fixture(context, endless);
  await once(installer.stdout, 'data');
  context.mock.timers.tick(ACCOUNT_INSTALL_TIMEOUT_MS);
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(events, ['discard']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Setting up Cloudflare took too long. Check your connection, then try again.',
    messageRef: { key: 'publish.account.setup.timedOut', params: { provider: 'Cloudflare' } },
  });
});

test('installation discards and bounds output', async (context) => {
  const { account, installer, steps } = fixture(context, "process.stdout.write('x'.repeat(1048577)); setInterval(() => {}, 1000);");
  await once(installer, 'close');
  assert.deepEqual(steps, ['installing']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'failed',
    message: 'Could not finish setting up Cloudflare. Please try again.',
    messageRef: { key: 'publish.account.setup.failed', params: { provider: 'Cloudflare' } },
  });
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

test('default launch runs npm in a staging folder under the app tools, never in the site', async (context) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'stacki-account-command-'));
  const tools = await mkdtemp(path.join(tmpdir(), 'stacki-account-tools-'));
  context.after(async () => {
    setAppToolsDirectory(undefined);
    await rm(directory, { recursive: true, force: true });
    await rm(tools, { recursive: true, force: true });
  });
  await writeFile(path.join(directory, 'package.json'), '{"packageManager":"pnpm@9.0.0"}');
  setToolPathHome(homedir());
  setAppToolsDirectory(tools);
  const child = spawn(process.execPath, ['-e', 'process.exitCode = 1;'], {
    stdio: 'pipe',
    shell: false,
  });
  let cwd: unknown;
  context.mock.method(childProcess, 'spawn', (executable: string, argumentsList: readonly string[], options: SpawnOptionsWithoutStdio) => {
    assert.equal(typeof executable, 'string');
    assert.ok(argumentsList.includes('--ignore-scripts'), 'no package code runs while installing');
    assert.ok(argumentsList.includes('--prefix'), 'npm writes only into the staging folder');
    assert.equal(options.shell, false);
    cwd = options.cwd;
    return child;
  });
  const account = new PublishingAccount(undefined, () => false);
  assert.equal(account.request(directory, { ...request, action: 'start' }).kind, 'installing');
  assert.equal(typeof cwd, 'string');
  assert.ok(String(cwd).startsWith(path.join(tools, 'wrangler', '.staging-')), 'npm runs in a staging folder beside the pinned target');
  await once(child, 'close');
  assert.equal(account.request(directory, { ...request, action: 'status' }).kind, 'failed');
});
