// Goal: provider discovery retrieves identifiers without changing account state or leaking secrets.
// Method: exercise real discovery orchestration and boundary parsers against recorded API shapes,
// Use temporary linked files and intercepted CLI/HTTP boundaries; never contact a live provider.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import command from '#dist/electron/project/publishDiscoveryCommand.js';
import { discoverPublishing } from '#dist/electron/project/publishDiscovery.js';
import { cloudflareProjects } from '#dist/electron/project/publishDiscoveryCloudflare.js';
import { vercelProjects } from '#dist/electron/project/publishDiscoveryVercel.js';

async function fixture(context: TestContext) {
  const root = await mkdtemp(path.join(tmpdir(), 'stacki-discovery-'));
  context.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('Cloudflare discovery fills the production branch and output directory', async (context) => {
  const root = await fixture(context);
  context.mock.method(command, 'discoveryCommand', async (_root: string, executable: string, args: readonly string[]) => {
    assert.equal(executable, 'wrangler');
    if (args[0] === 'whoami') {
      return { loggedIn: true, accounts: [{ id: 'account123', name: 'Work' }] };
    }
    assert.deepEqual(args, ['auth', 'token', '--json']);
    return { type: 'oauth', token: 'private-token' };
  });
  context.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    if (url.endsWith('/workers/scripts')) {
      return new Response(JSON.stringify({ success: true, result: [] }));
    }
    assert.equal(url, 'https://api.cloudflare.com/client/v4/accounts/account123/pages/projects' + '?per_page=10&page=1');
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    return new Response(
      JSON.stringify({
        success: true,
        result: [
          {
            name: 'website',
            production_branch: 'production',
            build_config: { destination_dir: './build' },
          },
        ],
        result_info: { total_pages: 1 },
      }),
    );
  });
  const accounts = await discoverPublishing(root, { provider: 'cloudflare', account: '' });
  assert.equal(accounts.kind, 'ready');
  if (accounts.kind === 'ready') {
    assert.deepEqual(accounts.accounts, [{ id: 'account123', name: 'Work' }]);
    assert.equal(accounts.projects[0]?.name, 'website');
    assert.equal(accounts.notice, undefined);
  }
  const projects = await discoverPublishing(root, {
    provider: 'cloudflare',
    account: 'account123',
  });
  assert.deepEqual(projects, {
    kind: 'ready',
    accounts: [],
    projects: [
      {
        name: 'website',
        hosting: {
          provider: 'cloudflare',
          accountId: 'account123',
          project: 'website',
          branch: 'production',
          directory: 'build',
        },
      },
    ],
  });
  assert.equal(JSON.stringify(projects).includes('private-token'), false);
});

test('Vercel uses explicit scope and pages without switching the global team', async (context) => {
  const root = await fixture(context);
  const mutableCalls: string[][] = [];
  context.mock.method(command, 'discoveryCommand', async (_root: string, executable: string, args: readonly string[]) => {
    assert.equal(executable, 'vercel');
    mutableCalls.push([...args]);
    return {
      projects: [{ name: 'Website', id: 'prj_123', accountId: 'team_123' }],
      pagination: { next: args[1]?.includes('until=') ? undefined : 123 },
    };
  });
  const projects = await vercelProjects(root, 'team_123');
  assert.equal(projects.length, 2);
  assert.equal(mutableCalls.length, 2);
  assert.deepEqual(mutableCalls[1], ['api', '/v9/projects?limit=100&until=123', '--method', 'GET', '--raw', '--scope', 'team_123']);
});

test('linked Vercel project remains selectable without CLI authentication', async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, '.vercel'));
  await writeFile(path.join(root, '.vercel/project.json'), JSON.stringify({ orgId: 'team_123', projectId: 'prj_123' }));
  context.mock.method(command, 'discoveryCommand', async () => {
    throw new Error('private-token');
  });
  const result = await discoverPublishing(root, { provider: 'vercel', account: '' });
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.deepEqual(result.projects[0]?.hosting, {
      provider: 'vercel',
      organizationId: 'team_123',
      projectId: 'prj_123',
    });
  }
});

test('GitHub lists healthy accounts and sanitizes provider failures', async (context) => {
  const root = await fixture(context);
  context.mock.method(command, 'discoveryCommand', async () => ({
    hosts: {
      'github.com': [
        { login: 'personal', state: 'success', token: 'masked' },
        { login: 'work', state: 'success' },
        { login: 'expired', state: 'error' },
      ],
    },
  }));
  assert.deepEqual(await discoverPublishing(root, { provider: 'github', account: '' }), {
    kind: 'ready',
    projects: [],
    accounts: [
      { id: 'personal', name: 'personal' },
      { id: 'work', name: 'work' },
    ],
  });
  context.mock.restoreAll();
  context.mock.method(command, 'discoveryCommand', async () => {
    throw new Error('private-token');
  });
  const failed = await discoverPublishing(root, { provider: 'cloudflare', account: '' });
  assert.equal(failed.kind, 'failed');
  assert.equal(JSON.stringify(failed).includes('private-token'), false);
});

test('Cloudflare bounds pagination and Vercel refuses another account', async (context) => {
  context.mock.method(command, 'discoveryCommand', async () => ({
    type: 'oauth',
    token: 'secret',
  }));
  context.mock.method(
    globalThis,
    'fetch',
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          result: Array.from({ length: 10 }, () => ({
            name: 'site',
            production_branch: 'main',
            build_config: { destination_dir: 'dist' },
          })),
          result_info: { total_pages: 100 },
        }),
      ),
  );
  await assert.rejects(cloudflareProjects('/site', 'account'), /too many projects/);
  context.mock.restoreAll();
  context.mock.method(command, 'discoveryCommand', async () => ({
    projects: [{ id: 'prj_1', name: 'Wrong', accountId: 'team_other' }],
    pagination: {},
  }));
  await assert.rejects(vercelProjects('/site', 'team_123'), /different account/);
});

test('assets-only Workers match their owning account', async (context) => {
  const root = await fixture(context);
  await writeFile(path.join(root, 'wrangler.jsonc'), '{ // Existing assets-only Worker.\n"name":"website","assets":{"directory":"./dist"}}');
  context.mock.method(command, 'discoveryCommand', async (_root: string, _tool: string, args: readonly string[]) =>
    args[0] === 'whoami' ? { accounts: [{ id: 'account123', name: 'Work' }] } : { type: 'oauth', token: 'private-token' },
  );
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    assert.ok(url.endsWith('/accounts/account123/workers/scripts'));
    return new Response(JSON.stringify({ success: true, result: [{ id: 'website' }] }));
  });
  assert.deepEqual(await discoverPublishing(root, { provider: 'linked', account: '' }), {
    kind: 'ready',
    accounts: [],
    projects: [
      {
        name: 'website',
        hosting: {
          provider: 'cloudflare-workers',
          accountId: 'account123',
          project: 'website',
        },
      },
    ],
  });
  context.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ success: true, result: [{ id: 'other-worker' }] })));
  const unavailable = await discoverPublishing(root, { provider: 'linked', account: '' });
  assert.equal(unavailable.kind, 'ready');
  if (unavailable.kind === 'ready') {
    assert.deepEqual(unavailable.projects[0]?.hosting, {
      provider: 'cloudflare-workers',
      accountId: '',
      project: 'website',
    });
  }
});

test('Cloudflare combines Pages and Workers across accounts', async (context) => {
  const root = await fixture(context);
  context.mock.method(command, 'discoveryCommand', async (_root: string, _tool: string, args: readonly string[]) =>
    args[0] === 'whoami'
      ? {
          accounts: [
            { id: 'personal', name: 'Personal' },
            { id: 'work', name: 'Work' },
          ],
        }
      : { type: 'oauth', token: 'private-token' },
  );
  context.mock.method(globalThis, 'fetch', async (url: string) => {
    const result = url.includes('/workers/scripts') ? [{ id: 'worker' }] : [{ name: 'pages-site', production_branch: 'main', build_config: {} }];
    return new Response(JSON.stringify({ success: true, result }));
  });
  const result = await discoverPublishing(root, { provider: 'cloudflare', account: '' });
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(result.accounts.length, 2);
    assert.equal(result.projects.length, 4);
    assert.deepEqual(
      result.projects.map((project) => project.hosting.provider),
      ['cloudflare', 'cloudflare-workers', 'cloudflare', 'cloudflare-workers'],
    );
    const worker = result.projects[3]?.hosting;
    assert.equal(worker?.provider, 'cloudflare-workers');
    if (worker?.provider === 'cloudflare-workers') {
      assert.equal(worker.accountId, 'work');
    }
  }
});

// Connection failures carry a reason, never the CLI's output, so settings can offer the right
// next step: install the CLI, sign in, sign in again, or refresh.
test('Vercel failures report why: no CLI, signed out, expired or offline', async (context) => {
  const root = await fixture(context);
  const cases = [
    ['missing-cli', /not installed/],
    ['signed-out', /not signed in to Vercel/],
    ['expired', /expired or was revoked/],
    ['network', /Could not reach Vercel/],
  ] as const;
  for (const [reason, message] of cases) {
    context.mock.restoreAll();
    context.mock.method(command, 'discoveryCommand', async () => {
      throw new command.DiscoveryCommandError(reason, 'vercel');
    });
    const result = await discoverPublishing(root, { provider: 'vercel', account: '' });
    assert.equal(result.kind, 'failed');
    if (result.kind === 'failed') {
      assert.equal(result.reason, reason);
      assert.match(result.message, message);
    }
  }
});

test('a linked Vercel project with an expired login still asks to sign in again', async (context) => {
  const root = await fixture(context);
  await mkdir(path.join(root, '.vercel'));
  await writeFile(path.join(root, '.vercel/project.json'), JSON.stringify({ orgId: 'team_123', projectId: 'prj_123' }));
  context.mock.method(command, 'discoveryCommand', async () => {
    throw new command.DiscoveryCommandError('expired', 'vercel');
  });
  const result = await discoverPublishing(root, { provider: 'vercel', account: '' });
  assert.equal(result.kind, 'ready');
  if (result.kind === 'ready') {
    assert.equal(result.projects.length, 1);
    assert.equal(result.notice?.reason, 'expired');
  }
});

test('CLI failures are classified from the exit and the printed text', () => {
  const classify = command.classifyCommandFailure;
  assert.equal(classify({ code: 'ENOENT' }, ''), 'missing-cli');
  assert.equal(classify({ code: 1, killed: true }, ''), 'network');
  assert.equal(classify({ code: 1 }, 'Error: No existing credentials found. Please run `vercel login` or pass "--token"'), 'signed-out');
  assert.equal(classify({ code: 1 }, 'Error: The specified token is not valid. Use `vercel login` to generate a new token.'), 'expired');
  assert.equal(classify({ code: 1 }, 'Error: The token provided via VERCEL_TOKEN environment variable is not valid.'), 'expired');
  assert.equal(classify({ code: 1 }, 'Error: The hostname api.vercel.com could not be resolved.'), 'network');
  assert.equal(classify({ code: 1 }, 'Error: something else'), 'unknown');
});

test('the discovery runner reports a missing Vercel CLI as missing-cli', async (context) => {
  const root = await fixture(context);
  const previous = process.env['PATH'];
  context.after(() => {
    process.env['PATH'] = previous;
  });
  process.env['PATH'] = root;
  await assert.rejects(command.discoveryCommand(root, 'vercel', ['api', '/v2/teams']), (error: unknown) => {
    assert.ok(error instanceof command.DiscoveryCommandError);
    assert.equal(error.reason, 'missing-cli');
    return true;
  });
});
