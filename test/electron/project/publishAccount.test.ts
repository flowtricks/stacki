// Goal: account sign-in has one owner, bounded output and time, and no credential disclosure.
// Method: use real child processes with deterministic CLI output; never authenticate with GitHub.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { PublishingAccount } from '#dist/electron/project/publishAccount.js';
import { ACCOUNT_SIGN_IN_TIMEOUT_MS } from '#dist/shared/ipc/publishAccount.js';

const id = '00000000-0000-4000-8000-000000000000';
const other = '11111111-1111-4111-8111-111111111111';
const root = process.cwd();
const waiting = "process.stderr.write('First copy your one-time code: ABCD-1234\\n');" + 'setInterval(() => {}, 1000);';

test('sign-in extracts the device code and scopes status and cancellation', async () => {
  const child = spawn(process.execPath, ['-e', waiting], { stdio: 'pipe', shell: false });
  const account = new PublishingAccount(
    () => child,
    () => true,
  );
  assert.equal(account.request(root, { action: 'start', id }).kind, 'starting');
  await once(child.stderr, 'data');
  assert.deepEqual(account.request(root, { action: 'status', id }), {
    kind: 'waiting',
    code: 'ABCD-1234',
  });
  assert.equal(account.request(root, { action: 'start', id: other }).kind, 'failed');
  assert.equal(account.request(root + '/other', { action: 'cancel', id }).kind, 'failed');
  assert.equal(account.request(root, { action: 'cancel', id }).kind, 'cancelled');
  await once(child, 'close');
  assert.equal(account.request(root, { action: 'status', id }).kind, 'cancelled');
});

test('sign-in reports success and sanitizes CLI failures', async () => {
  for (const code of [0, 1]) {
    const child = spawn(process.execPath, ['-e', `process.stderr.write('secret-token'); process.exit(${code});`], {
      stdio: 'pipe',
      shell: false,
    });
    const account = new PublishingAccount(
      () => child,
      () => true,
    );
    account.request(root, { action: 'start', id });
    await once(child, 'close');
    const state = account.request(root, { action: 'status', id });
    assert.equal(state.kind, code === 0 ? 'complete' : 'failed');
    assert.equal(JSON.stringify(state).includes('secret-token'), false);
  }
});

test('sign-in limits output before retaining it', async () => {
  const child = spawn(process.execPath, ['-e', "process.stderr.write('x'.repeat(9000)); setInterval(() => {}, 1000);"], {
    stdio: 'pipe',
    shell: false,
  });
  const account = new PublishingAccount(
    () => child,
    () => true,
  );
  account.request(root, { action: 'start', id });
  await once(child, 'close');
  assert.deepEqual(account.request(root, { action: 'status', id }), {
    kind: 'failed',
    message: 'GitHub sign-in returned too much output.',
  });
});

test('sign-in expires and terminates a stalled child', async (context) => {
  const child = spawn(process.execPath, ['-e', waiting], { stdio: 'pipe', shell: false });
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const account = new PublishingAccount(
    () => child,
    () => true,
  );
  account.request(root, { action: 'start', id });
  await once(child.stderr, 'data');
  context.mock.timers.tick(ACCOUNT_SIGN_IN_TIMEOUT_MS);
  await once(child, 'close');
  assert.deepEqual(account.request(root, { action: 'status', id }), {
    kind: 'failed',
    message: 'GitHub sign-in expired. Please try again.',
  });
});

test('Cloudflare sign-in exposes a complete browser URL and isolates its session', async () => {
  const url = 'https://dash.cloudflare.com/oauth2/auth?client_id=test&state=nonce';
  const script = `process.stdout.write('Visit this link to authenticate: ${url}\\n');` + 'setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['-e', script], { stdio: 'pipe', shell: false });
  const account = new PublishingAccount(
    (_root, provider) => {
      assert.equal(provider, 'cloudflare');
      return child;
    },
    () => true,
  );
  const request = { id, provider: 'cloudflare' as const };
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'starting');
  await once(child.stdout, 'data');
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), {
    kind: 'browser',
    url,
  });
  assert.equal(account.request(root, { id, action: 'cancel' }).kind, 'failed');
  assert.equal(account.request(root, { ...request, action: 'cancel' }).kind, 'cancelled');
  await once(child, 'close');
});

test('Cloudflare cancellation also stops the launcher child', { timeout: 5000 }, async (context) => {
  const script =
    "require('node:child_process').spawn(process.execPath," +
    "['-e', 'setInterval(() => {}, 1000)'], {stdio:'inherit'});" +
    "process.stdout.write('ready'); setInterval(() => {}, 1000);";
  const child = spawn(process.execPath, ['-e', script], {
    stdio: 'pipe',
    shell: false,
    detached: process.platform !== 'win32',
  });
  const account = new PublishingAccount(
    () => child,
    () => true,
  );
  const request = { id, provider: 'cloudflare' as const };
  context.after(() => account.request(root, { ...request, action: 'cancel' }));
  account.request(root, { ...request, action: 'start' });
  await once(child.stdout, 'data');
  account.request(root, { ...request, action: 'cancel' });
  // Close waits for inherited output streams too, so a surviving child cannot pass this check.
  await once(child, 'close');
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'cancelled');
});
