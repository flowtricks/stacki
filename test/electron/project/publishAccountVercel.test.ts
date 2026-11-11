// Goal: a designer without the Vercel CLI can install it and sign in from Stacki alone: a missing
// CLI installs first (globally under ~/.local, no sudo), then `vercel login` runs in the same
// session, and only Vercel's own device page is offered to open.
// Method: drive the real session manager with a fake CLI (a Node child that prints what the CLI
// prints) through the injected launcher. Nothing is downloaded and no account is touched.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { PublishingAccount, vercelInstallArguments, vercelSignInURL } from '#dist/electron/project/publishAccount.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { parseSignInURL } from '#dist/shared/ipc/publishAccount.js';

const id = '00000000-0000-4000-8000-000000000000';
const request = { id, provider: 'vercel' as const };
const root = process.cwd();
const deviceURL = 'https://vercel.com/oauth/device?user_code=ABCD-EFGH';
const login = `process.stdout.write('> Visit ${deviceURL}\\n'); process.stdin.resume(); setInterval(() => {}, 1000);`;

function fakeCLI(context: TestContext, options: { readonly installed: boolean; readonly installScript: string }) {
  const { installed, installScript } = options;
  const steps: string[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const account = new PublishingAccount(
    (_root, provider, step) => {
      assert.equal(provider, 'vercel');
      steps.push(step.kind);
      const child = spawn(process.execPath, ['-e', step.kind === 'installing' ? installScript : login], { stdio: 'pipe', shell: false });
      children.push(child);
      return child;
    },
    () => installed,
  );
  context.after(() => {
    account.request(root, { ...request, action: 'cancel' });
    for (const child of children) {
      child.kill('SIGKILL');
    }
  });
  return { account, children, steps };
}

async function until(kind: string, read: () => string): Promise<void> {
  for (let tries = 0; tries < 200; tries++) {
    if (read() === kind) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`never reached ${kind}`);
}

test('a missing Vercel CLI installs, then sign-in offers the device page', async (context) => {
  setToolPathHome(root);
  const { account, children, steps } = fakeCLI(context, { installed: false, installScript: "console.log('added 1 package');" });
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'installing');
  const installer = children[0];
  assert.ok(installer);
  await once(installer, 'close');
  await until('browser', () => account.request(root, { ...request, action: 'status' }).kind);
  assert.deepEqual(steps, ['installing', 'starting']);
  assert.deepEqual(account.request(root, { ...request, action: 'status' }), { kind: 'browser', url: deviceURL });
});

test('an installed Vercel CLI goes straight to sign-in, and a finished login completes', async (context) => {
  const { account, children, steps } = fakeCLI(context, { installed: true, installScript: '' });
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'starting');
  await until('browser', () => account.request(root, { ...request, action: 'status' }).kind);
  assert.deepEqual(steps, ['starting']);
  const child = children[0];
  assert.ok(child);
  child.kill('SIGTERM');
  await once(child, 'close');
  assert.equal(account.request(root, { ...request, action: 'status' }).kind, 'failed');
});

test('a failed install says so without CLI output', async (context) => {
  const { account, children } = fakeCLI(context, { installed: false, installScript: "process.stderr.write('npm ERR! secret-token'); process.exit(1);" });
  account.request(root, { ...request, action: 'start' });
  const installer = children[0];
  assert.ok(installer);
  await once(installer, 'close');
  const state = account.request(root, { ...request, action: 'status' });
  assert.equal(state.kind, 'failed');
  assert.match(JSON.stringify(state), /Could not install the Vercel CLI/);
  assert.equal(JSON.stringify(state).includes('secret-token'), false);
});

test('only Vercel device pages are opened', () => {
  assert.equal(vercelSignInURL(`Visit ${deviceURL}\n`), deviceURL);
  assert.equal(vercelSignInURL('Visit vercel.com/device\n'), undefined);
  assert.equal(vercelSignInURL('https://evil.example/oauth/device?user_code=X'), undefined);
  assert.throws(() => parseSignInURL('https://vercel.com/login?next=x'), /device authorization/);
  assert.throws(() => parseSignInURL('https://evil.example/oauth2/auth'), /Cloudflare sign-in/);
});

test('the Vercel CLI installs per user, never with sudo', () => {
  assert.deepEqual(vercelInstallArguments('/Users/designer', 'darwin'), ['install', '--global', '--prefix', path.join('/Users/designer', '.local'), 'vercel']);
  assert.deepEqual(vercelInstallArguments('C:\\Users\\designer', 'win32'), ['install', '--global', 'vercel']);
});
