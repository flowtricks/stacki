// Goal: Netlify works like the other hosts and fails loudly and safely: sign-in without a terminal, discovery, Add
// site, and a production deploy that can never create a site by accident, upload the project's source, change the
// project's files or repeat what the CLI printed.
// Method: the real services drive a fake netlify-cli (test/helpers/fakeNetlifyCLI.ts) installed in a temporary site,
// printing what netlify-cli 27.20.1 prints for each case. No account, network, or real tools folder is touched.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PublishingAccount, netlifySignInArguments } from '#dist/electron/project/publishAccount.js';
import { netlifySignInTicket } from '#dist/electron/project/publishNetlifySignIn.js';
import { classifyNetlifyFailure } from '#dist/electron/project/publishNetlifyCommand.js';
import { createNetlifySite } from '#dist/electron/project/publishNetlify.js';
import { netlifyBuildPlan, netlifyDeployResult, siteDirectory } from '#dist/electron/project/publishNetlifyDeploy.js';
import { checkHostingReady, deployHosting } from '#dist/electron/project/publishCommands.js';
import { discoverPublishing } from '#dist/electron/project/publishDiscovery.js';
import { publishedSiteURL } from '#dist/electron/project/publishSite.js';
import { setAppToolsDirectory, toolInstallPlan, prepareToolInstall, finishToolInstall, NETLIFY_PIN } from '#dist/electron/project/publishToolInstall.js';
import { netlifyAvailableWithoutPATH } from '#dist/electron/project/publishExecutable.js';
import { setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import { parseSignInURL, type AccountState } from '#dist/shared/ipc/publishAccount.js';
import { DEFAULT_PUBLISH_CONFIG, parsePublishConfig, type PublishConfig } from '#dist/shared/properties/publishConfig.js';
import { parseNetlifySiteRequest, parseNetlifySiteResult } from '#dist/shared/properties/publishNetlify.js';
import { parseDiscoveryRequest, parsePublishDiscovery } from '#dist/shared/properties/publishDiscovery.js';
import { findMissingPublishField } from '#dist/shared/properties/publishMissing.js';
import { waitFor, waitForSteady } from '../../helpers/waitFor.js';
import { FAKE_SECRET, FAKE_SITE, installFakeNetlify, type FakeNetlifyChanges, type FakeNetlifyScenario } from '../../helpers/fakeNetlifyCLI.ts';

const request = { id: '00000000-0000-4000-8000-000000000000', provider: 'netlify' as const };
const hosting = { provider: 'netlify' as const, siteId: FAKE_SITE.id };
const config: PublishConfig = { ...DEFAULT_PUBLISH_CONFIG, hosting };

function temporary(context: TestContext, prefix: string): string {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  context.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  return folder;
}

function write(root: string, file: string, source: string): void {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), source);
}

// A built static site with the fake CLI installed, and a tools folder that is never the person's own.
function site(context: TestContext, scenario: FakeNetlifyChanges = {}) {
  const root = temporary(context, 'stacki-netlify-site-');
  setAppToolsDirectory(temporary(context, 'stacki-netlify-tools-'));
  context.after(() => setAppToolsDirectory(undefined));
  write(root, 'package.json', '{"name":"site","dependencies":{"astro":"^5.0.0"}}');
  write(root, 'dist/index.html', '<h1>Built</h1>');
  return { root, cli: installFakeNetlify(root, scenario) };
}

function signIn(context: TestContext, root: string): PublishingAccount {
  setToolPathHome(root);
  const account = new PublishingAccount();
  account.netlifyTiming = { intervalMs: 5, checkTimeoutMs: 600, failuresMax: 3 };
  context.after(() => {
    account.request(root, { ...request, action: 'cancel' });
  });
  return account;
}

async function until(account: PublishingAccount, root: string, kind: AccountState['kind'], id: string = request.id): Promise<AccountState> {
  return waitFor({
    what: `the sign-in reaching ${kind}`,
    read: () => account.request(root, { ...request, id, action: 'status' }),
    until: (state: AccountState) => state.kind === kind,
    pollCountMax: 600,
  });
}

test('sign-in asks for a ticket, offers its page, then checks until approved', async (context) => {
  const { root, cli } = site(context, { checks: ['pending', 'pending', 'authorized'] });
  const previous = process.env['NETLIFY_AUTH_TOKEN'];
  process.env['NETLIFY_AUTH_TOKEN'] = FAKE_SECRET;
  context.after(() => restore('NETLIFY_AUTH_TOKEN', previous));
  const account = signIn(context, root);
  assert.equal(account.request(root, { ...request, action: 'start' }).kind, 'starting');
  const browser = await until(account, root, 'browser');
  assert.ok(browser.kind === 'browser');
  assert.equal(new URL(browser.url).origin, 'https://app.netlify.com');
  await until(account, root, 'complete');
  const calls = cli.calls();
  assert.deepEqual(calls[0]?.argv, ['login', '--request', 'Stacki', '--json']);
  assert.deepEqual(calls[1]?.argv, ['login', '--check', 'ticket123', '--json']);
  assert.equal(calls.length, 4);
  for (const call of calls) {
    assert.equal(call.env['BROWSER'], 'none', 'the CLI never opens a page itself');
    assert.equal(call.env['CI'], 'true');
    assert.equal(call.env['NETLIFY_TELEMETRY_DISABLED'], '1');
    assert.equal(call.env['NETLIFY_AUTH_TOKEN'], undefined, 'a shell token never stands in for signing in');
  }
});

test('a refused, unreachable, hanging or cancelled sign-in ends without CLI output', async (context) => {
  const { root, cli } = site(context, { checks: ['denied'] });
  const account = signIn(context, root);
  account.request(root, { ...request, action: 'start' });
  const denied = await until(account, root, 'failed');
  assert.match(JSON.stringify(denied), /Netlify sign-in did not finish/);

  const next = (id: string) => ({ id, provider: 'netlify' as const });
  const run = async (id: string, scenario: FakeNetlifyChanges, pattern: RegExp) => {
    cli.set(scenario);
    account.request(root, { ...next(id), action: 'start' });
    const state = await until(account, root, 'failed', id);
    assert.ok(state.kind === 'failed');
    assert.match(state.message, pattern);
    assert.equal(JSON.stringify(state).includes(FAKE_SECRET), false);
  };
  await run('00000000-0000-4000-8000-000000000001', { request: 'offline' }, /Could not reach Netlify/);
  await run('00000000-0000-4000-8000-000000000002', { checks: ['offline'] }, /Could not reach Netlify/);
  await run('00000000-0000-4000-8000-000000000003', { checks: ['hang'] }, /Netlify sign-in did not finish/);
  await run('00000000-0000-4000-8000-000000000004', { request: 'foreign-url' }, /Netlify sign-in did not finish/);

  cli.set({ checks: ['pending'] });
  cli.forget();
  const cancelled = next('00000000-0000-4000-8000-000000000005');
  account.request(root, { ...cancelled, action: 'start' });
  const checks = () => cli.calls().length;
  await waitFor({ what: 'the first approval check', read: checks, until: (count: number) => count >= 2 });
  assert.equal(account.request(root, { ...cancelled, action: 'cancel' }).kind, 'cancelled');
  // Far longer than the 5 ms between checks: a session still checking would keep the count moving.
  const count = await waitForSteady({ what: 'checks stopping after cancel', read: checks, until: () => true, steadyPollCount: 12 });
  assert.equal(await waitForSteady({ what: 'no check after cancel', read: checks, until: () => true, steadyPollCount: 12 }), count);
});

test('only a Netlify page for the ticket Stacki checks is accepted', () => {
  const url = 'https://app.netlify.com/authorize?response_type=ticket&ticket=abc';
  assert.equal(parseSignInURL(url), url);
  assert.deepEqual(netlifySignInTicket(JSON.stringify({ ticket_id: 'abc', url })), { ticket: 'abc', url });
  for (const reply of [
    'not json',
    JSON.stringify({ ticket_id: 'other', url }),
    JSON.stringify({ ticket_id: '--auth', url }),
    JSON.stringify({ ticket_id: 'abc', url: 'https://evil.example/authorize?response_type=ticket&ticket=abc' }),
  ]) {
    assert.equal(netlifySignInTicket(reply), undefined, reply);
  }
  assert.throws(() => parseSignInURL('https://app.netlify.com/teams'), /authorization page/);
  assert.throws(() => parseSignInURL('https://app.netlify.com/authorize?response_type=token&ticket=a'), /ticket/);
  assert.deepEqual(netlifySignInArguments({ kind: 'checking', ticket: 'abc' }), ['login', '--check', 'abc', '--json']);
});

test('the Netlify CLI installs pinned, into Stacki’s own folder, and only the pinned bytes are used', (context) => {
  const tools = temporary(context, 'stacki-netlify-install-');
  const plan = toolInstallPlan(tools, NETLIFY_PIN, 'nonce');
  assert.equal(plan.target, path.join(tools, 'netlify-cli', NETLIFY_PIN.version));
  assert.ok(plan.arguments.includes('--ignore-scripts'));
  assert.ok(plan.arguments.includes('--global=false'));
  const stage = (integrity: string) => {
    const prepared = prepareToolInstall(tools, NETLIFY_PIN);
    assert.ok(prepared.ok);
    const installed = { version: NETLIFY_PIN.version, integrity };
    write(prepared.value.staging, 'package-lock.json', JSON.stringify({ packages: { 'node_modules/netlify-cli': installed } }));
    const manifest = { name: 'netlify-cli', version: NETLIFY_PIN.version, bin: { netlify: 'bin/run.js' } };
    write(prepared.value.staging, 'node_modules/netlify-cli/package.json', JSON.stringify(manifest));
    write(prepared.value.staging, 'node_modules/netlify-cli/bin/run.js', '');
    return prepared.value;
  };
  assert.deepEqual(finishToolInstall(stage('sha512-other')), { ok: false, error: 'verify' });
  setAppToolsDirectory(tools);
  context.after(() => setAppToolsDirectory(undefined));
  const empty = temporary(context, 'stacki-netlify-empty-');
  assert.equal(netlifyAvailableWithoutPATH(empty), false);
  assert.ok(finishToolInstall(stage(NETLIFY_PIN.integrity)).ok);
  assert.equal(netlifyAvailableWithoutPATH(empty), true);
});

test('a missing CLI makes sign-in install the pinned one first', (context) => {
  const root = temporary(context, 'stacki-netlify-bare-');
  setAppToolsDirectory(temporary(context, 'stacki-netlify-tools-'));
  context.after(() => setAppToolsDirectory(undefined));
  const steps: string[] = [];
  const account = new PublishingAccount((_root, _provider, step) => {
    steps.push(step.kind);
    throw new Error('no process in this test');
  });
  const state = account.request(root, { ...request, action: 'start' });
  assert.deepEqual(steps, ['installing']);
  assert.ok(state.kind === 'failed');
  assert.match(state.message, /needs Node\.js/);
});

test('discovery lists teams and sites across pages, with each site’s team', async (context) => {
  const many = Array.from({ length: 60 }, (_, index) => ({ ...FAKE_SITE, id: `site-${index}`, name: `site-${index}` }));
  const { root, cli } = site(context, { sites: many });
  const result = parsePublishDiscovery(await discoverPublishing(root, parseDiscoveryRequest({ provider: 'netlify', account: '' })));
  assert.ok(result.kind === 'ready');
  assert.deepEqual(result.accounts, [{ id: 'acme', name: 'Acme team' }]);
  assert.equal(result.projects.length, 60);
  assert.deepEqual(result.projects[0], { name: 'site-0', account: 'acme', hosting: { provider: 'netlify', siteId: 'site-0' } });
  assert.equal(cli.calls().filter((call) => call.argv[1] === 'listSitesForAccount').length, 2);
});

test('discovery says why it cannot connect, never what the CLI printed', async (context) => {
  const { root, cli } = site(context);
  const reasons: readonly (readonly [FakeNetlifyChanges, string])[] = [
    [{ auth: 'signed-out' }, 'signed-out'],
    [{ auth: 'expired' }, 'expired'],
    [{ network: 'offline' }, 'network'],
  ];
  for (const [scenario, reason] of reasons) {
    cli.set(scenario);
    const result = await discoverPublishing(root, { provider: 'netlify', account: '' });
    assert.ok(result.kind === 'failed');
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  }
  const bare = temporary(context, 'stacki-netlify-none-');
  const previous = process.env['PATH'];
  process.env['PATH'] = bare;
  try {
    const result = await discoverPublishing(bare, { provider: 'netlify', account: '' });
    assert.ok(result.kind === 'failed');
    assert.equal(result.reason, 'missing-cli');
  } finally {
    restore('PATH', previous);
  }
});

test('an existing netlify link is imported, and a listed entry keeps its name', async (context) => {
  const { root, cli } = site(context);
  write(root, '.netlify/state.json', JSON.stringify({ siteId: FAKE_SITE.id }));
  const linked = await discoverPublishing(root, { provider: 'linked', account: '' });
  assert.ok(linked.kind === 'ready');
  assert.deepEqual(linked.projects, [{ name: 'Linked Netlify site', hosting }]);
  const listed = await discoverPublishing(root, { provider: 'netlify', account: '' });
  assert.ok(listed.kind === 'ready');
  assert.deepEqual(listed.projects, [{ name: FAKE_SITE.name, account: 'acme', hosting }]);
  cli.set({ auth: 'signed-out' });
  const offline = await discoverPublishing(root, { provider: 'netlify', account: '' });
  assert.ok(offline.kind === 'ready');
  assert.equal(offline.notice?.reason, 'signed-out');
  write(root, '.netlify/state.json', '{}');
  const unlinked = await discoverPublishing(root, { provider: 'linked', account: '' });
  assert.ok(unlinked.kind === 'ready');
  assert.deepEqual(unlinked.projects, []);
});

test('Add site creates exactly the requested name, or says why not', async (context) => {
  const { root, cli } = site(context);
  const created = await createNetlifySite(root, { team: 'acme', name: 'fresh-site' });
  assert.deepEqual(created, { kind: 'ready', name: 'fresh-site', hosting: { provider: 'netlify', siteId: 'new-fresh-site' } });
  assert.deepEqual(parseNetlifySiteResult(created), created);
  const argv = cli.calls()[0]?.argv;
  assert.deepEqual(argv?.slice(0, 3), ['api', 'createSiteInTeam', '--data']);
  assert.deepEqual(JSON.parse(argv?.[3] ?? ''), { account_slug: 'acme', body: { name: 'fresh-site' } });
  const refusals: readonly (readonly [FakeNetlifyChanges, string, RegExp])[] = [
    [{}, 'taken', /may already be taken/],
    [{ auth: 'signed-out' }, 'a', /not signed in|Sign in/i],
    [{ auth: 'expired' }, 'a', /expired/i],
    [{ network: 'offline' }, 'a', /Could not reach Netlify/],
    [{ create: 'garbled' }, 'a', /could not create the site/i],
  ];
  for (const [scenario, name, pattern] of refusals) {
    cli.set(scenario);
    const result = await createNetlifySite(root, { team: 'acme', name });
    assert.ok(result.kind === 'failed', JSON.stringify(result));
    assert.match(result.message, pattern);
    assert.equal(JSON.stringify(result).includes(FAKE_SECRET), false);
  }
});

test('Add site refuses names and teams that are not names', () => {
  for (const input of [
    { team: 'acme', name: 'Bad Name' },
    { team: 'acme', name: '-leading' },
    { team: 'acme', name: 'a'.repeat(64) },
    { team: 'acme', name: 'x; rm -rf /' },
    { team: '--auth', name: 'ok' },
    { team: '', name: 'ok' },
    { team: 'acme' },
  ]) {
    assert.throws(() => parseNetlifySiteRequest(input), JSON.stringify(input));
  }
  assert.throws(() => parseNetlifySiteResult({ kind: 'ready', name: 'ok', hosting: { provider: 'vercel', organizationId: 'a', projectId: 'b' } }));
  assert.throws(() => parseNetlifySiteResult({ kind: 'failed', message: '' }));
});

test('without a netlify.toml build command, Stacki’s own build is uploaded', async (context) => {
  const { root, cli } = site(context);
  await deployHosting(root, config);
  const calls = cli.calls();
  assert.deepEqual(
    calls.map((call) => call.argv.slice(0, 2)),
    [
      ['api', 'getSite'],
      ['deploy', '--prod'],
    ],
  );
  assert.deepEqual(calls[1]?.argv, ['deploy', '--prod', '--site', FAKE_SITE.id, '--json', '--no-build', '--dir', 'dist']);
  assert.equal(calls[1]?.env['CI'], 'true');
  assert.equal(fs.existsSync(path.join(root, 'netlify.toml')), false, 'nothing writes a netlify.toml');
});

test('netlify.toml decides the folder and whether Netlify builds, and is never rewritten', async (context) => {
  const { root, cli } = site(context);
  const cases: readonly (readonly [string, readonly string[]])[] = [
    ['[build]\n  publish = "dist/"\n', ['--no-build', '--dir', 'dist']],
    ['[build]\n  command = "npm run build"\n  publish = "dist"\n', ['--context', 'production']],
    ['[build]\n  command = "npm run build"\n', ['--context', 'production', '--dir', 'dist']],
    ['[context.production]\n  command = "npm run build"\n', ['--context', 'production', '--dir', 'dist']],
  ];
  for (const [source, flags] of cases) {
    write(root, 'netlify.toml', source);
    cli.forget();
    await deployHosting(root, config);
    assert.deepEqual(cli.calls().at(-1)?.argv.slice(5), flags, source);
    assert.equal(fs.readFileSync(path.join(root, 'netlify.toml'), 'utf8'), source);
  }
});

test('a build folder that is the project, or outside it, is never uploaded', async (context) => {
  const { root, cli } = site(context);
  for (const publish of ['.', './', '/', '../elsewhere', 'dist/../..']) {
    write(root, 'netlify.toml', `[build]\n  publish = "${publish}"\n`);
    await assert.rejects(deployHosting(root, config), /build folder/, publish);
  }
  write(root, 'netlify.toml', '[build\n');
  await assert.rejects(deployHosting(root, config), /could not read netlify\.toml/);
  write(root, 'netlify.toml', '[build]\n  publish = "missing"\n');
  await assert.rejects(deployHosting(root, config), /build folder/);
  fs.symlinkSync(root, path.join(root, 'loop'), 'junction');
  write(root, 'netlify.toml', '[build]\n  publish = "loop"\n');
  await assert.rejects(deployHosting(root, config), /build folder/);
  assert.equal(
    cli.calls().some((call) => call.argv[0] === 'deploy'),
    false,
  );
  assert.equal(siteDirectory('web', 'dist'), 'web/dist');
  assert.equal(siteDirectory('web', '.'), undefined);
});

test('a deploy never runs for a site Netlify cannot confirm, so the CLI cannot create one', async (context) => {
  const { root, cli } = site(context);
  const cases: readonly (readonly [FakeNetlifyChanges, RegExp])[] = [
    [{ sites: [] }, /cannot find this site/],
    [{ auth: 'signed-out' }, /Netlify/],
    [{ auth: 'expired' }, /expired/i],
    [{ network: 'offline' }, /Could not reach Netlify/],
  ];
  for (const [scenario, pattern] of cases) {
    cli.set(scenario);
    cli.forget();
    await assert.rejects(deployHosting(root, config), (error: unknown) => {
      assert.match(String(error), pattern);
      assert.equal(String(error).includes(FAKE_SECRET), false);
      return true;
    });
    assert.equal(
      cli.calls().some((call) => call.argv[0] === 'deploy'),
      false,
    );
  }
});

test('a failed or unconfirmed deploy is reported without the build log', async (context) => {
  const { root, cli } = site(context);
  const cases: readonly (readonly [FakeNetlifyScenario['deploy'], RegExp])[] = [
    ['build-failure', /netlify failed \(exit 1\)/],
    ['no-result', /did not confirm the deploy/],
    ['other-site', /different site/],
  ];
  for (const [deploy, pattern] of cases) {
    cli.set({ deploy });
    await assert.rejects(deployHosting(root, config), (error: unknown) => {
      assert.match(String(error), pattern);
      assert.equal(String(error).includes(FAKE_SECRET), false);
      return true;
    });
  }
  assert.deepEqual(netlifyDeployResult('log\n{ broken\n{\n  "site_id": "a",\n  "deploy_id": "b"\n}'), { siteId: 'a', deployId: 'b' });
  assert.equal(netlifyDeployResult('{"site_id":"a"}'), undefined);
});

test('on-demand and other-host sites are refused before anything is built; the Netlify adapter passes', async (context) => {
  const { root } = site(context);
  const cases: readonly (readonly [string, RegExp | undefined])[] = [
    ["export default { output: 'server' };", /@astrojs\/netlify adapter/],
    ["import vercel from '@astrojs/vercel'; export default { adapter: vercel() };", /another host/],
    ["import netlify from '@astrojs/netlify'; export default { output: 'server', adapter: netlify() };", undefined],
    ['export default {};', undefined],
    ['export default { outDir: process.env.OUT };', /build folder/],
  ];
  for (const [source, pattern] of cases) {
    write(root, 'astro.config.mjs', source);
    const ready = await checkHostingReady(root, config);
    if (pattern === undefined) {
      assert.ok(ready.ok, source);
    } else {
      assert.ok(!ready.ok, source);
      assert.match(ready.error.message, pattern);
    }
  }
  write(root, 'astro.config.mjs', "export default { outDir: './build-output' };");
  assert.deepEqual(await netlifyBuildPlan(root), { ok: true, value: { kind: 'prebuilt', directory: 'build-output' } });
});

test('the published site prefers its custom domain over netlify.app', async (context) => {
  const { root, cli } = site(context);
  assert.equal(await publishedSiteURL(root, hosting), 'https://my-astro-site.netlify.app');
  cli.set({ sites: [{ ...FAKE_SITE, custom_domain: 'www.example.com' }] });
  assert.equal(await publishedSiteURL(root, hosting), 'https://www.example.com');
});

test('publish settings accept a Netlify site and refuse anything that is not an id', () => {
  const source = { ...DEFAULT_PUBLISH_CONFIG, hosting };
  assert.deepEqual(parsePublishConfig(source).hosting, hosting);
  for (const siteId of ['', '--auth', 'a b', 'a'.repeat(101), 7]) {
    assert.throws(() => parsePublishConfig({ ...source, hosting: { provider: 'netlify', siteId } }), String(siteId));
  }
  assert.deepEqual(findMissingPublishField({ ...source, hosting: { provider: 'netlify', siteId: '' } }), {
    ok: false,
    error: { field: 'hostingProject' },
  });
});

test('Netlify failures are classified from what the CLI prints', () => {
  const cases: readonly (readonly [string, string])[] = [
    ['JSONHTTPError: Unauthorized', 'expired'],
    ['Authentication required. NETLIFY_AUTH_TOKEN is not set', 'signed-out'],
    ['JSONHTTPError: Unprocessable Entity', 'refused'],
    ['JSONHTTPError: Not Found', 'not-found'],
    ['getaddrinfo ENOTFOUND api.netlify.com', 'network'],
    ['something else', 'unknown'],
  ];
  for (const [output, reason] of cases) {
    assert.equal(classifyNetlifyFailure({ code: 1 }, output), reason, output);
  }
  assert.equal(classifyNetlifyFailure({ code: 'ENOENT' }, ''), 'missing-cli');
  assert.equal(classifyNetlifyFailure({ killed: true }, ''), 'timeout');
});

function restore(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
