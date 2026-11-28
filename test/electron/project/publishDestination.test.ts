// Goal: publishing to a destination can never change production, for every provider, and a destination that resolves
// to production's target is refused before anything runs. The first tests are the setup of issue 105 (Cloudflare
// Workers, env.staging in wrangler.jsonc, its own build:staging script). Several destinations at once, and what keeps
// them from changing each other, are in publishDestinationPairs.test.ts.
// Method: the real publisher on temporary Git projects with a local bare remote. Stand-in wrangler, vercel and
// netlify CLIs record the exact arguments, environment and config they were given; the questions only a host can
// answer are stubbed. Each publish is followed by the invariant: GitHub's main, the person's branch and
// production's deployment record are unchanged, and no command could have targeted production.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '#dist/electron/lib/nodeTools.js';
import { claimsHost, readWorkerEnvironments } from '#dist/electron/project/publishDestinationWorker.js';
import { readPackageScripts } from '#dist/electron/project/publishCustom.js';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import { readDeploymentReceipt } from '#dist/electron/project/publishReceipt.js';
import type { DeployTransport } from '#dist/electron/project/deployRequest.js';
import type { Hosting } from '#dist/shared/properties/publishConfig.js';
import { suggestDestination } from '#dist/shared/properties/publishDestinationDefaults.js';
import type { DestinationTarget } from '#dist/shared/properties/publishDestinations.js';
import { publishNeedsWorkerSetup } from '#dist/shared/properties/publishWorkerSetup.js';
import { deployCalls, fakeLinkStore, finished, publishSite, scriptsRun, write, type SiteOptions } from '../../helpers/publishSite.ts';
import {
  destinationsFile,
  destinationSite,
  entry,
  production,
  publishDestination,
  publisherFor,
  refusedAs,
  services,
  type Site,
} from '../../helpers/publishDestinations.ts';

const WORKERS: Hosting = { provider: 'cloudflare-workers', accountId: 'account-1', project: 'my-site' };
const PAGES: Hosting = { provider: 'cloudflare', accountId: 'account-1', project: 'my-pages', branch: 'main', directory: 'dist' };
const VERCEL: Hosting = { provider: 'vercel', organizationId: 'team_1', projectId: 'prj_1' };
const NETLIFY: Hosting = { provider: 'netlify', siteId: 'site-1' };

// Issue 105's wrangler.jsonc, comments and all.
const REPORTER_WRANGLER = `{
  // Production
  "name": "my-site",
  "compatibility_date": "2026-01-01",
  "assets": { "directory": "./dist" },
  "routes": [{ "pattern": "example.com", "custom_domain": true }],
  "env": {
    "staging": {
      "routes": [{ "pattern": "staging.example.com", "custom_domain": true }],
      "workers_dev": false,
      "vars": { "STAGING": "true" }
    }
  }
}`;

/** The one destination of these tests: `staging`, built with its own script. */
const destinations = (target: DestinationTarget, extra: Readonly<Record<string, unknown>> = {}) => destinationsFile([entry('staging', target, extra)]);

const stagingSite = (context: TestContext, hosting: Hosting, target: DestinationTarget, options: Pick<SiteOptions, 'files'> = {}) =>
  destinationSite(context, hosting, destinations(target), options);

const publishStaging = (site: Site, publisher: ReturnType<typeof publisherFor>) => publishDestination(site, publisher, 'staging');
const STAGING = { id: 'staging', label: 'Staging' };

test('issue 105: env.staging and build:staging are found and preselected', async (context) => {
  const site = await publishSite(context, { publish: production(WORKERS), files: { 'wrangler.jsonc': REPORTER_WRANGLER } });
  const environments = await readWorkerEnvironments(site.root);
  assert.deepEqual(environments, [{ name: 'staging', worker: 'my-site-staging', siteUrl: 'https://staging.example.com' }]);
  const detected = { scripts: await readPackageScripts(site.root), environments };
  const suggested = suggestDestination(production(WORKERS), detected, STAGING, []);
  assert.deepEqual(suggested, {
    ...STAGING,
    target: { kind: 'cloudflare-environment', environment: 'staging' },
    buildScript: 'build:staging',
    beforePublish: [],
    afterPublish: [],
    siteUrl: 'https://staging.example.com',
  });
});

test('issue 105: staging builds with build:staging and deploys env.staging to its own Worker', async (context) => {
  const site = await stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-environment', environment: 'staging' },
    {
      files: { 'wrangler.jsonc': REPORTER_WRANGLER },
    },
  );
  // Variables of this computer that would send a Wrangler deploy elsewhere.
  process.env['WRANGLER_CI_OVERRIDE_NAME'] = 'my-site';
  process.env['CLOUDFLARE_ENV'] = 'production';
  context.after(() => {
    delete process.env['WRANGLER_CI_OVERRIDE_NAME'];
    delete process.env['CLOUDFLARE_ENV'];
  });
  const refs = await site.refs();
  const publisher = publisherFor();
  assert.deepEqual(await publishStaging(site, publisher), { kind: 'done', github: false, hosting: true, destination: STAGING });
  assert.equal(await site.refs(), refs, 'A Workers staging publish never touches GitHub');
  assert.deepEqual(scriptsRun(site.calls()), ['build:staging']);
  assert.deepEqual(site.calls()[0]?.env, {
    STACKI_PUBLISH_ENV: 'staging',
    STACKI_PUBLISH_TARGET: 'staging',
    STACKI_PUBLISH_DESTINATION: 'staging',
    CLOUDFLARE_ENV: 'staging',
  });
  const [deploy, ...more] = deployCalls(site.calls());
  assert.deepEqual(more, []);
  const configAt = deploy?.argv.indexOf('--config') ?? -1;
  assert.deepEqual(deploy?.argv.slice(0, configAt), ['deploy', '--name', 'my-site-staging', '--env', 'staging']);
  assert.equal(deploy?.argv.length, configAt + 2);
  assert.deepEqual(deploy?.env, { CLOUDFLARE_ACCOUNT_ID: 'account-1', STACKI_PUBLISH_ENV: 'staging', STACKI_PUBLISH_DESTINATION: 'staging' });
  assert.equal(deploy?.config?.['account_id'], 'account-1');
  assert.deepEqual(deploy?.config?.['env'], {
    staging: {
      routes: [{ pattern: 'staging.example.com', custom_domain: true }],
      workers_dev: false,
      vars: { STAGING: 'true' },
      account_id: 'account-1',
    },
  });
  const availability = await readPublishAvailability(site.root);
  assert.equal(availability.destinations?.[0]?.state, 'current');
  assert.ok(availability.destinations?.[0]?.publishedAtMs !== undefined);
  assert.equal(availability.hosting, 'pending', 'Publishing staging does not mark production current');
});

test('publishing production leaves staging’s record alone, and its command is what it was', async (context) => {
  const site = await publishSite(context, {
    publish: production(WORKERS),
    destinations: destinations({ kind: 'cloudflare-environment', environment: 'staging' }),
    files: { 'wrangler.jsonc': REPORTER_WRANGLER },
  });
  const publisher = publisherFor();
  assert.equal((await publishStaging(site, publisher)).kind, 'done');
  const staged = await readDeploymentReceipt(site.root, 'staging');
  site.forget();
  write(site.root, 'page.txt', 'Ready for production');
  publisher.start(site.root, 'hosting');
  // The real readiness check looks for Wrangler; the site's stand-in is the one it finds.
  assert.deepEqual(await finished(publisher, site.root), { kind: 'done', github: false, hosting: true });
  assert.deepEqual(scriptsRun(site.calls()), ['before', 'build', 'after']);
  const [deploy] = deployCalls(site.calls());
  assert.deepEqual(deploy?.argv.slice(0, 3), ['deploy', '--name', 'my-site']);
  assert.ok(!deploy?.argv.includes('--env'));
  assert.deepEqual(await readDeploymentReceipt(site.root, 'staging'), staged);
  const availability = await readPublishAvailability(site.root);
  assert.equal(availability.hosting, 'current');
  assert.equal(availability.destinations?.[0]?.state, 'pending', 'Publishing production does not mark staging current');
});

for (const [name, wrangler, key] of [
  [
    'an environment without routes, which would inherit production’s domain',
    { name: 'my-site', assets: { directory: './dist' }, routes: ['example.com/*'], env: { staging: {} } },
    'publish.destination.error.productionRoute',
  ],
  [
    'a route naming production’s hostname under another path',
    { name: 'my-site', routes: [{ pattern: 'example.com/*' }], env: { staging: { routes: ['https://EXAMPLE.com/preview/*'] } } },
    'publish.destination.error.productionRoute',
  ],
  [
    'a wildcard that covers production',
    { name: 'my-site', route: 'www.example.com/*', env: { staging: { route: '*.example.com/*' } } },
    'publish.destination.error.productionRoute',
  ],
  ['a route that cannot be read', { name: 'my-site', env: { staging: { routes: [{ zone: 'x' }] } } }, 'publish.destination.error.routesUnreadable'],
  ['an environment named as the production Worker', { name: 'my-site', env: { staging: { name: 'my-site' } } }, 'publish.destination.error.sameAsProduction'],
  [
    'an environment deploying env.production’s Worker',
    { name: 'my-site', env: { production: { name: 'live-worker' }, staging: { name: 'live-worker' } } },
    'publish.destination.error.sameAsProduction',
  ],
  [
    'an environment declaring production’s workflow',
    { name: 'my-site', workflows: [{ name: 'orders' }], env: { staging: { routes: [], workflows: [{ name: 'orders' }] } } },
    'publish.destination.error.sharedResource',
  ],
  [
    'an environment consuming production’s queue',
    { name: 'my-site', queues: { consumers: [{ queue: 'mail' }] }, env: { staging: { queues: { consumers: [{ queue: 'mail' }] } } } },
    'publish.destination.error.sharedResource',
  ],
  ['an environment that is not there', { name: 'my-site', env: { preview: {} } }, 'publish.destination.error.noEnvironment'],
] as const) {
  test(`Workers staging refuses ${name}`, async (context) => {
    const site = await stagingSite(
      context,
      WORKERS,
      { kind: 'cloudflare-environment', environment: 'staging' },
      {
        files: { 'wrangler.json': JSON.stringify(wrangler) },
      },
    );
    await refusedAs(site, publisherFor(), key);
  });
}

test('a production wildcard over a staging subdomain is not a claim on production', () => {
  assert.equal(claimsHost('staging.example.com', '*.example.com'), false);
  assert.equal(claimsHost('*example.com', 'example.com'), true);
  assert.equal(claimsHost('example.com', 'example.com'), true);
  assert.equal(claimsHost('*.example.com', 'example.org'), false);
});

test('the published production site is production’s hostname even when Wrangler does not list it', async (context) => {
  const site = await publishSite(context, {
    publish: { ...production(WORKERS), publishedSite: { hosting: WORKERS, source: 'manual', url: 'https://live.example.com' } },
    destinations: destinations({ kind: 'cloudflare-environment', environment: 'staging' }),
    files: { 'wrangler.json': JSON.stringify({ name: 'my-site', env: { staging: { routes: ['live.example.com/*'] } } }) },
  });
  await refusedAs(site, publisherFor(), 'publish.destination.error.productionRoute');
});

test('a separate Worker takes none of production’s routes, schedules or queue consumers', async (context) => {
  const wrangler = {
    name: 'my-site',
    main: 'worker.js',
    routes: ['example.com/*'],
    triggers: { crons: ['0 * * * *'] },
    queues: { producers: [{ binding: 'MAIL', queue: 'mail' }], consumers: [{ queue: 'mail' }] },
    env: { production: {} },
  };
  const site = await stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-worker', project: 'my-site-preview' },
    {
      files: { 'wrangler.json': JSON.stringify(wrangler) },
    },
  );
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  const [deploy] = deployCalls(site.calls());
  assert.deepEqual(deploy?.argv.slice(0, 3), ['deploy', '--name', 'my-site-preview']);
  assert.ok(!deploy?.argv.includes('--env'));
  assert.deepEqual(deploy?.config, {
    name: 'my-site-preview',
    main: 'worker.js',
    queues: { producers: [{ binding: 'MAIL', queue: 'mail' }] },
    account_id: 'account-1',
    workers_dev: true,
  });
});

test('a separate Worker is refused when it is production’s, or when it would take a workflow', async (context) => {
  const same = await stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-worker', project: 'my-site' },
    {
      files: { 'wrangler.json': JSON.stringify({ name: 'my-site' }) },
    },
  );
  await refusedAs(same, publisherFor(), 'publish.destination.error.sameAsProduction');
  const workflow = await stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-worker', project: 'other' },
    {
      files: { 'wrangler.json': JSON.stringify({ name: 'my-site', workflows: [{ name: 'orders' }] }) },
    },
  );
  await refusedAs(workflow, publisherFor(), 'publish.destination.error.separateShared');
});

// A build that stands in for the Cloudflare Vite adapter: it writes a generated config and redirects Wrangler to it.
async function generatedConfigSite(context: TestContext, generated: Readonly<Record<string, unknown>>) {
  const adapter = `const fs = require('node:fs');
fs.mkdirSync('dist/server', { recursive: true });
fs.mkdirSync('.wrangler/deploy', { recursive: true });
fs.writeFileSync('dist/server/wrangler.json', ${JSON.stringify(JSON.stringify(generated))});
fs.writeFileSync('.wrangler/deploy/config.json', JSON.stringify({ configPath: require('node:path').relative('.wrangler/deploy', 'dist/server/wrangler.json') }));`;
  return stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-environment', environment: 'staging' },
    {
      files: {
        'wrangler.jsonc': REPORTER_WRANGLER,
        'adapter.cjs': adapter,
        'package.json': JSON.stringify({ scripts: { 'build:staging': 'node adapter.cjs' } }),
      },
    },
  );
}

test('an adapter build made for staging deploys its generated config without naming the environment again', async (context) => {
  const site = await generatedConfigSite(context, {
    name: 'my-site-staging',
    targetEnvironment: 'staging',
    main: 'entry.js',
    routes: [{ pattern: 'staging.example.com', custom_domain: true }],
  });
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  const [deploy] = deployCalls(site.calls());
  assert.deepEqual(deploy?.argv.slice(0, 3), ['deploy', '--name', 'my-site-staging']);
  assert.ok(!deploy?.argv.includes('--env'));
});

for (const [name, generated, key] of [
  ['for production', { name: 'my-site', main: 'entry.js', routes: ['example.com'] }, 'publish.destination.error.builtForProduction'],
  [
    'with production’s route',
    { name: 'my-site-staging', targetEnvironment: 'staging', main: 'entry.js', routes: ['example.com'] },
    'publish.destination.error.productionRoute',
  ],
] as const) {
  test(`an adapter build made ${name} is never deployed as staging`, async (context) => {
    const site = await generatedConfigSite(context, generated);
    const state = await publishStaging(site, publisherFor());
    assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, key);
    assert.deepEqual(deployCalls(site.calls()), []);
  });
}

test('a Pages preview deploys the staging branch of the Pages project, and nothing else', async (context) => {
  const site = await stagingSite(context, PAGES, { kind: 'cloudflare-pages', branch: 'staging' });
  const refs = await site.refs();
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  assert.equal(await site.refs(), refs);
  assert.deepEqual(
    deployCalls(site.calls()).map((call) => call.argv),
    [['pages', 'deploy', 'dist', '--project-name', 'my-pages', '--branch', 'staging', '--commit-dirty=true']],
  );
  assert.equal((await readPublishAvailability(site.root)).destinations?.[0]?.url, 'https://staging.site.pages.dev');
});

test('Pages staging asks Cloudflare which branch is production, and fails closed', async (context) => {
  // The settings say production is main; the real project's production branch is the staging one.
  const wrong = await stagingSite(context, PAGES, { kind: 'cloudflare-pages', branch: 'staging' });
  await refusedAs(wrong, publisherFor({ services: services({ pagesProductionBranch: async () => 'Staging' }) }), 'publish.destination.error.sameAsProduction');
  const unknown = await stagingSite(context, PAGES, { kind: 'cloudflare-pages', branch: 'staging' });
  const offline = services({
    pagesProductionBranch: async () => {
      throw new Error('offline');
    },
  });
  await refusedAs(unknown, publisherFor({ services: offline }), 'publish.destination.error.pagesUnconfirmed');
  const named = await stagingSite(context, { ...PAGES, branch: 'release' }, { kind: 'cloudflare-pages', branch: 'release' });
  await refusedAs(named, publisherFor(), 'publish.destination.error.sameAsProduction');
});

test('a Vercel preview never passes --prod and tells Vercel’s own build it is staging', async (context) => {
  const site = await stagingSite(context, VERCEL, { kind: 'vercel' });
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  // Vercel builds on its servers: no local build runs, whatever the settings name.
  assert.deepEqual(scriptsRun(site.calls()), []);
  const [deploy] = deployCalls(site.calls());
  assert.deepEqual(deploy?.argv.slice(0, 6), [
    'deploy',
    '--yes',
    '--build-env',
    'STACKI_PUBLISH_ENV=staging',
    '--build-env',
    'STACKI_PUBLISH_DESTINATION=staging',
  ]);
  assert.ok(!deploy?.argv.some((argument) => argument.startsWith('--prod')));
  assert.equal(deploy?.env['VERCEL_PROJECT_ID'], 'prj_1');
  assert.equal((await readPublishAvailability(site.root)).destinations?.[0]?.url, 'https://site-abc123.vercel.app');
});

test('Vercel staging is refused until production exists, because a first deployment is production', async (context) => {
  const first = await stagingSite(context, VERCEL, { kind: 'vercel' });
  await refusedAs(first, publisherFor({ services: services({ vercelHasProduction: async () => false }) }), 'publish.destination.error.vercelFirstDeploy');
  const unknown = await stagingSite(context, VERCEL, { kind: 'vercel' });
  const offline = services({
    vercelHasProduction: async () => {
      throw new Error('offline');
    },
  });
  await refusedAs(unknown, publisherFor({ services: offline }), 'publish.destination.error.vercelUnconfirmed');
});

test('Netlify staging is a draft under its alias, built with staging’s build', async (context) => {
  const site = await stagingSite(context, NETLIFY, { kind: 'netlify', alias: 'staging' }, { files: { 'astro.config.mjs': 'export default {};' } });
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  assert.deepEqual(scriptsRun(site.calls()), ['build:staging']);
  assert.deepEqual(
    deployCalls(site.calls()).map((call) => call.argv),
    [['deploy', '--site', 'site-1', '--json', '--alias', 'staging', '--no-build', '--dir', 'dist']],
  );
  assert.equal((await readPublishAvailability(site.root)).destinations?.[0]?.url, 'https://draft1--site.netlify.app');
});

test('Netlify’s own build runs in the staging branch’s context, never production’s', async (context) => {
  const toml = '[build]\ncommand = "npm run build"\n[context.production]\npublish = "production-output"\n[context.staging]\npublish = "staging-output"\n';
  const site = await stagingSite(context, NETLIFY, { kind: 'netlify', alias: 'staging' }, { files: { 'netlify.toml': toml } });
  assert.equal((await publishStaging(site, publisherFor())).kind, 'done');
  const [deploy] = deployCalls(site.calls());
  assert.deepEqual(deploy?.argv, ['deploy', '--site', 'site-1', '--json', '--alias', 'staging', '--context', 'branch:staging']);
});

const OWN_HOST = { provider: 'none' } as const;

test('a staging branch receives the current files, uncommitted ones included, and nothing else moves', async (context) => {
  const site = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: 'staging' });
  // A tag that a push could carry along, and so start a release.
  await git(site.root, ['config', 'push.followTags', 'true']);
  await git(site.root, ['tag', '--annotate', '--message', 'v1', 'v1']);
  const publisher = publisherFor();
  assert.deepEqual(await publishStaging(site, publisher), { kind: 'done', github: true, hosting: false, destination: STAGING, handoff: 'github' });
  const names = (await site.refs()).split('\n').map((line) => line.split(' ')[0]);
  assert.deepEqual(names, ['refs/heads/main', 'refs/heads/staging']);
  assert.equal((await git(site.remote, ['show', 'staging:page.txt'])).stdout, 'A draft');
  const first = await site.revision(site.remote, 'refs/heads/staging');
  // A second publish builds on the first without forcing.
  write(site.root, 'page.txt', 'Another draft');
  assert.equal((await publishStaging(site, publisher)).kind, 'done');
  await git(site.remote, ['merge-base', '--is-ancestor', first, 'refs/heads/staging']);
  assert.equal((await readPublishAvailability(site.root)).destinations?.[0]?.state, 'current');
  assert.deepEqual(site.calls(), []);
});

test('a staging branch with someone else’s commits is refused as diverged, and never forced', async (context) => {
  const site = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: 'staging' });
  const tree = await site.revision(site.root, 'HEAD^{tree}');
  const other = (await git(site.root, ['commit-tree', tree, '-m', 'Written by hand'])).stdout.trim();
  await git(site.root, ['push', '--quiet', 'https://github.com/example/fixture.git', `${other}:refs/heads/staging`]);
  await refusedAs(site, publisherFor(), 'publish.destination.error.diverged');
  assert.equal(await site.revision(site.remote, 'refs/heads/staging'), other);
});

test('a staging branch is never main, the default branch or the branch the person is on', async (context) => {
  for (const branch of ['main', 'Master', 'production']) {
    const site = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch });
    await refusedAs(site, publisherFor(), 'publish.destination.error.sameAsProduction');
  }
  const current = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: 'feature' });
  await git(current.root, ['switch', '--quiet', '--create', 'feature']);
  await refusedAs(current, publisherFor(), 'publish.destination.error.currentBranch');
  // The repository's default branch under an unusual name is only known by asking.
  const trunk = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: 'trunk' });
  await git(trunk.remote, ['branch', 'trunk', 'main']);
  await git(trunk.remote, ['symbolic-ref', 'HEAD', 'refs/heads/trunk']);
  await refusedAs(trunk, publisherFor(), 'publish.destination.error.sameAsProduction');
  const empty = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: 'staging' });
  await git(empty.remote, ['update-ref', '-d', 'refs/heads/main']);
  await refusedAsWithoutMain(empty);
});

// In an empty repository the first branch pushed becomes the default, so staging must not go first.
async function refusedAsWithoutMain(site: Site) {
  const publisher = publisherFor();
  publisher.start(site.root, 'destination:staging');
  const state = await finished(publisher, site.root);
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, 'publish.destination.error.defaultUnknown');
  assert.equal(await site.refs(), '');
}

for (const name of ['+main', 'main:main', '-f', 'refs/heads/main', 'a..b', 'staging.lock']) {
  test(`a saved staging branch of ${JSON.stringify(name)} is refused by the settings parser`, async (context) => {
    const site = await stagingSite(context, OWN_HOST, { kind: 'github-branch', branch: name });
    const refs = await site.refs();
    const state = await publishStaging(site, publisherFor());
    assert.equal(state.kind, 'failed');
    assert.equal(await site.refs(), refs);
  });
}

test('with Pages as production, a staging branch is checked against the project’s real production branch', async (context) => {
  const site = await stagingSite(context, PAGES, { kind: 'github-branch', branch: 'release' });
  await refusedAs(site, publisherFor({ services: services({ pagesProductionBranch: async () => 'release' }) }), 'publish.destination.error.sameAsProduction');
  const offline = services({
    pagesProductionBranch: async () => {
      throw new Error('offline');
    },
  });
  await refusedAs(site, publisherFor({ services: offline }), 'publish.destination.error.pagesUnconfirmed');
});

test('a staging deploy link pushes the staging branch, then sends staging’s link only', async (context) => {
  const site = await publishSite(context, {
    publish: { ...production(OWN_HOST), customHosting: { deploy: 'link' } },
    destinations: destinations({ kind: 'link', branch: 'staging' }),
  });
  const store = fakeLinkStore(site.userData);
  await store.save(site.root, 'https://host.example/production-hook', 'production');
  const sent: string[] = [];
  const send: DeployTransport = async (address) => {
    sent.push(address);
    return { status: 200, location: undefined };
  };
  await refusedAs(site, publisherFor({ store, transport: send }), 'publish.custom.link.missing');
  await store.save(site.root, 'https://host.example/staging-hook', 'staging');
  assert.deepEqual(await publishStaging(site, publisherFor({ store, transport: send })), {
    kind: 'done',
    github: true,
    hosting: true,
    destination: STAGING,
    handoff: 'link',
  });
  assert.deepEqual(sent, ['https://host.example/staging-hook']);
  assert.deepEqual(site.calls(), []);
});

test('one link cannot be saved for both destinations, in either order', async (context) => {
  const site = await stagingSite(context, OWN_HOST, { kind: 'link', branch: 'staging' });
  const store = fakeLinkStore(site.userData);
  await store.save(site.root, 'https://host.example/hook', 'staging');
  const saved = await store.save(site.root, 'https://HOST.example/hook', 'production', ['staging']);
  assert.equal(saved.ok, false, 'Another spelling of the same address is the same link');
  store.remove(site.root, 'staging');
  await store.save(site.root, 'https://host.example/hook', 'production', ['staging']);
  // With only production's link saved, staging has none to send.
  await refusedAs(site, publisherFor({ store }), 'publish.custom.link.missing');
});

test('a staging script runs on a copy with staging’s own hooks, and GitHub is not touched', async (context) => {
  const site = await publishSite(context, {
    publish: production(WORKERS),
    destinations: destinations({ kind: 'script', script: 'deploy:staging' }, { beforePublish: ['staging-before'] }),
  });
  write(site.root, 'page.txt', 'A draft');
  const refs = await site.refs();
  assert.deepEqual(await publishStaging(site, publisherFor()), { kind: 'done', github: false, hosting: true, destination: STAGING, handoff: 'script' });
  assert.equal(await site.refs(), refs);
  assert.deepEqual(scriptsRun(site.calls()), ['staging-before', 'build:staging', 'deploy:staging']);
  assert.ok(site.calls().every((call) => call.env['STACKI_PUBLISH_ENV'] === 'staging' && call.env['CLOUDFLARE_ENV'] === undefined));
});

test('a staging script that deploys production by name, or is production’s script, is refused', async (context) => {
  const named = await stagingSite(context, WORKERS, { kind: 'script', script: 'deploy' });
  await refusedAs(named, publisherFor(), 'publish.destination.error.sameAsProduction');
  const shared = await publishSite(context, {
    publish: { ...production(OWN_HOST), customHosting: { deploy: 'script', script: 'ship' } },
    destinations: destinations({ kind: 'script', script: 'ship' }),
  });
  await refusedAs(shared, publisherFor(), 'publish.destination.error.sameAsProduction');
});

test('a destination borrowing a provider production no longer uses is refused', async (context) => {
  const site = await stagingSite(context, VERCEL, { kind: 'netlify', alias: 'staging' });
  await refusedAs(site, publisherFor(), 'publish.destination.error.providerChanged');
});

test('a project that publishes through review sends nothing out to staging', async (context) => {
  const site = await publishSite(context, {
    publish: { ...production(OWN_HOST), githubWorkflow: { kind: 'pull-request' } },
    destinations: destinations({ kind: 'github-branch', branch: 'staging' }),
  });
  await refusedAs(site, publisherFor(), 'publish.destination.error.review');
});

test('with no staging saved, a staging publish does nothing at all', async (context) => {
  const site = await publishSite(context, { publish: production(WORKERS) });
  await refusedAs(site, publisherFor(), 'publish.destination.error.notSetUp');
  assert.equal(fs.existsSync(path.join(site.root, '.stacki/publish-destinations.json')), false);
});

test('a staging publish that lacks Wrangler never offers production’s Worker setup', async (context) => {
  const site = await stagingSite(
    context,
    WORKERS,
    { kind: 'cloudflare-environment', environment: 'staging' },
    {
      files: { 'wrangler.jsonc': REPORTER_WRANGLER },
    },
  );
  const state = await publishStaging(site, publisherFor({ services: services({ workerToolInstalled: () => false }) }));
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, 'publish.worker.setup.needed');
  assert.equal(publishNeedsWorkerSetup(state), false);
});
