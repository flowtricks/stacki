// Goal: with several destinations, publishing one changes neither production nor any other, whatever a hand-edited
// destinations file, the Wrangler file or the host says; and what changes while a publish is building is checked
// again before anything leaves this computer.
// Method: the real publisher on temporary Git projects with a local bare remote. Stand-in wrangler, vercel and netlify
// CLIs record what they were asked to do, and every question only a host can answer is stubbed. Nothing reaches a
// real host.
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import { readDeploymentReceipt } from '#dist/electron/project/publishReceipt.js';
import { parseNetlifyProject, parsePagesProject, parseVercelProject, parseWorkerHostnames } from '#dist/electron/project/publishDestinationHost.js';
import type { DeployTransport } from '#dist/electron/project/deployRequest.js';
import type { Hosting } from '#dist/shared/properties/publishConfig.js';
import type { DestinationTarget } from '#dist/shared/properties/publishDestinations.js';
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
  type ServiceAnswers,
  type Site,
} from '../../helpers/publishDestinations.ts';

const WORKERS: Hosting = { provider: 'cloudflare-workers', accountId: 'account-1', project: 'my-site' };
const PAGES: Hosting = { provider: 'cloudflare', accountId: 'account-1', project: 'my-pages', branch: 'main', directory: 'dist' };
const VERCEL: Hosting = { provider: 'vercel', organizationId: 'team_1', projectId: 'prj_1' };
const NETLIFY: Hosting = { provider: 'netlify', siteId: 'site-1' };
const NONE: Hosting = { provider: 'none' };

const ownNetlify: DestinationTarget = { kind: 'host', hosting: { provider: 'netlify', siteId: 'site-2' } };
const ownVercel: DestinationTarget = { kind: 'host', hosting: { provider: 'vercel', organizationId: 'team_2', projectId: 'prj_2' } };
const ownPages: DestinationTarget = {
  kind: 'host',
  hosting: { provider: 'cloudflare', accountId: 'account-2', project: 'review-pages', branch: 'main', directory: 'dist' },
};
const ownWorker: DestinationTarget = { kind: 'host', hosting: { provider: 'cloudflare-workers', accountId: 'account-2', project: 'review' } };
const ASTRO = { 'astro.config.mjs': 'export default {};' };

const served = (domains: readonly string[], repository?: string) => ({ domains, repository });

async function site(context: TestContext, hosting: Hosting, entries: readonly ReturnType<typeof entry>[], files: SiteOptions['files'] = ASTRO) {
  return destinationSite(context, hosting, destinationsFile(entries), { files: files ?? {} });
}

const answering = (changes: ServiceAnswers) => publisherFor({ services: services(changes) });

test('publishing one destination deploys it alone and changes no other destination’s record', async (context) => {
  const project = await site(context, NETLIFY, [
    entry('staging', { kind: 'netlify', alias: 'staging' }),
    entry('qa', { kind: 'netlify', alias: 'qa' }),
    entry('review', ownNetlify),
  ]);
  const publisher = publisherFor();
  assert.equal((await publishDestination(project, publisher, 'qa')).kind, 'done');
  assert.deepEqual(
    deployCalls(project.calls()).map((call) => call.argv),
    [['deploy', '--site', 'site-1', '--json', '--alias', 'qa', '--no-build', '--dir', 'dist']],
  );
  assert.ok(project.calls().every((call) => call.env['STACKI_PUBLISH_DESTINATION'] === 'qa'));
  const first = await readDeploymentReceipt(project.root, 'qa');
  project.forget();
  assert.equal((await publishDestination(project, publisher, 'staging')).kind, 'done');
  assert.deepEqual(
    deployCalls(project.calls()).map((call) => call.argv.slice(3, 6)),
    [['--json', '--alias', 'staging']],
  );
  assert.deepEqual(await readDeploymentReceipt(project.root, 'qa'), first);
  assert.equal(await readDeploymentReceipt(project.root, 'review'), undefined);
  const states = (await readPublishAvailability(project.root)).destinations?.map((status) => [status.id, status.state]);
  assert.deepEqual(states, [
    ['staging', 'current'],
    ['qa', 'current'],
    ['review', 'pending'],
  ]);
});

test('ten destinations each report their own status', async (context) => {
  const entries = Array.from({ length: 10 }, (_, index) => entry(`d${index}`, { kind: 'github-branch', branch: `review-${index}` }));
  const project = await site(context, NONE, entries);
  assert.equal((await publishDestination(project, publisherFor(), 'd7')).kind, 'done');
  const statuses = (await readPublishAvailability(project.root)).destinations ?? [];
  assert.deepEqual(
    statuses.map((status) => status.state),
    entries.map((_, index) => (index === 7 ? 'current' : 'pending')),
  );
  assert.equal(await project.refs().then((refs) => refs.split('\n').length), 2, 'Only main and the published branch exist');
});

test('a renamed destination keeps its status', async (context) => {
  const target: DestinationTarget = { kind: 'github-branch', branch: 'review' };
  const project = await site(context, NONE, [entry('d1', target)]);
  assert.equal((await publishDestination(project, publisherFor(), 'd1')).kind, 'done');
  const renamed = destinationsFile([entry('d1', target, { label: 'Client sign-off' })]);
  write(project.root, '.stacki/publish-destinations.json', JSON.stringify(renamed));
  // The settings file is part of what is published, so the files changed; the record and its time are still the same ones.
  assert.ok((await readPublishAvailability(project.root)).destinations?.[0]?.publishedAtMs !== undefined);
});

test('an own Netlify site is published as that site’s live site, and never as production’s', async (context) => {
  const project = await site(context, NETLIFY, [entry('review', ownNetlify)]);
  const state = await publishDestination(project, publisherFor(), 'review');
  assert.deepEqual(state, { kind: 'done', github: false, hosting: true, destination: { id: 'review', label: 'REVIEW' } });
  assert.deepEqual(
    deployCalls(project.calls()).map((call) => call.argv),
    [['deploy', '--prod', '--site', 'site-2', '--json', '--no-build', '--dir', 'dist']],
  );
  assert.equal((await readPublishAvailability(project.root)).destinations?.[0]?.url, 'https://site.netlify.app');
});

test('an own Vercel project deploys to its own project, and tells Vercel’s build which destination it is', async (context) => {
  const project = await site(context, VERCEL, [entry('review', ownVercel)]);
  assert.equal((await publishDestination(project, publisherFor(), 'review')).kind, 'done');
  assert.deepEqual(scriptsRun(project.calls()), []);
  const [deploy] = deployCalls(project.calls());
  assert.deepEqual(deploy?.argv.slice(0, 7), [
    'deploy',
    '--prod',
    '--yes',
    '--build-env',
    'STACKI_PUBLISH_ENV=staging',
    '--build-env',
    'STACKI_PUBLISH_DESTINATION=review',
  ]);
  assert.equal(deploy?.env['VERCEL_PROJECT_ID'], 'prj_2');
  assert.equal(deploy?.env['VERCEL_ORG_ID'], 'team_2');
});

test('an own Pages project deploys the branch Cloudflare says is its live one', async (context) => {
  const project = await site(context, PAGES, [entry('review', ownPages)]);
  const publisher = answering({ pagesProject: async () => ({ ...served([]), productionBranch: 'live' }) });
  assert.equal((await publishDestination(project, publisher, 'review')).kind, 'done');
  const [deploy] = deployCalls(project.calls());
  assert.deepEqual(deploy?.argv, ['pages', 'deploy', 'dist', '--project-name', 'review-pages', '--branch', 'live', '--commit-dirty=true']);
  assert.equal(deploy?.env['CLOUDFLARE_ACCOUNT_ID'], 'account-2');
});

test('an own Worker takes none of the site’s routes, schedules or queue consumers, in its own account', async (context) => {
  const wrangler = { name: 'my-site', main: 'worker.js', routes: ['example.com/*'], triggers: { crons: ['0 * * * *'] }, env: { qa: {} } };
  const project = await site(context, WORKERS, [entry('review', ownWorker)], { 'wrangler.json': JSON.stringify(wrangler) });
  assert.equal((await publishDestination(project, publisherFor(), 'review')).kind, 'done');
  const [deploy] = deployCalls(project.calls());
  assert.deepEqual(deploy?.argv.slice(0, 3), ['deploy', '--name', 'review']);
  assert.ok(!deploy?.argv.includes('--env'));
  assert.deepEqual(deploy?.config, { name: 'review', main: 'worker.js', account_id: 'account-2', workers_dev: true });
});

const OWN_PROJECTS = [
  ['Netlify site', ownNetlify, 'netlifyProject'],
  ['Vercel project', ownVercel, 'vercelProject'],
  ['Pages project', ownPages, 'pagesProject'],
] as const;

for (const [name, target, question] of OWN_PROJECTS) {
  const answer = (domains: readonly string[], repository?: string): ServiceAnswers => ({
    [question]: async () => ({ ...served(domains, repository), productionBranch: 'main' }),
  });

  test(`an own ${name} is refused when the host cannot describe it`, async (context) => {
    const project = await site(context, NONE, [entry('staging', target)]);
    const offline: ServiceAnswers = {
      [question]: async () => {
        throw new Error('offline');
      },
    };
    await refusedAs(project, answering(offline), 'publish.destination.error.hostUnconfirmed');
  });

  test(`an own ${name} that serves production’s address or another destination’s is refused`, async (context) => {
    const live = await publishSite(context, {
      publish: { ...production(NONE, { customHosting: { deploy: 'github', siteUrl: 'https://example.com' } }) },
      destinations: destinationsFile([entry('staging', target)]),
      files: ASTRO,
    });
    await refusedAs(live, answering(answer(['EXAMPLE.com'.toLowerCase()])), 'publish.destination.error.servesAddress');
    const wildcard = await publishSite(context, {
      publish: { ...production(NONE, { customHosting: { deploy: 'github', siteUrl: 'https://www.example.com' } }) },
      destinations: destinationsFile([entry('staging', target)]),
      files: ASTRO,
    });
    await refusedAs(wildcard, answering(answer(['*.example.com'])), 'publish.destination.error.servesAddress');
    const neighbour = await site(context, NONE, [
      entry('staging', target),
      entry('qa', { kind: 'script', script: 'ship' }, { siteUrl: 'https://qa.example.com' }),
    ]);
    await refusedAs(neighbour, answering(answer(['qa.example.com'])), 'publish.destination.error.servesAddress');
  });

  test(`an own ${name} building from this repository is refused only where production may be the host’s own build`, async (context) => {
    const repository = 'github.com/example/fixture';
    const unknown = await site(context, NONE, [entry('staging', target)]);
    await refusedAs(unknown, answering(answer([], repository)), 'publish.destination.error.sameRepository');
    // Stacki deploys production itself here, to a project that is not this one.
    const direct = await site(context, WORKERS, [entry('staging', target)]);
    assert.equal((await publishDestination(direct, answering(answer([], repository)), 'staging')).kind, 'done');
    const elsewhere = await site(context, NONE, [entry('staging', target)]);
    assert.equal((await publishDestination(elsewhere, answering(answer([], 'github.com/example/other')), 'staging')).kind, 'done');
  });
}

test('a hostname the Wrangler file gives production protects it from an own project too', async (context) => {
  const files = { ...ASTRO, 'wrangler.json': JSON.stringify({ name: 'my-site', routes: ['example.com/*'] }) };
  const project = await site(context, WORKERS, [entry('staging', ownNetlify)], files);
  await refusedAs(project, answering({ netlifyProject: async () => served(['example.com']) }), 'publish.destination.error.servesAddress');
});

test('the project a folder is linked to is production while no publish settings are saved', async (context) => {
  for (const [target, file, contents] of [
    [ownVercel, '.vercel/project.json', { orgId: 'team_2', projectId: 'prj_2' }],
    [ownNetlify, '.netlify/state.json', { siteId: 'site-2' }],
  ] as const) {
    const project = await site(context, NONE, [entry('staging', target)]);
    fs.rmSync(path.join(project.root, '.stacki/publish.json'));
    write(project.root, file, JSON.stringify(contents));
    const publisher = publisherFor();
    publisher.start(project.root, 'destination:staging');
    const state = await finished(publisher, project.root);
    assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, 'publish.destination.error.linkedProject');
    assert.deepEqual(project.calls(), []);
  }
});

test('a vercel.json that hands production’s domain to a deploy refuses an own Vercel project', async (context) => {
  const live = await publishSite(context, {
    publish: { ...production(NONE, { customHosting: { deploy: 'github', siteUrl: 'https://example.com' } }) },
    destinations: destinationsFile([entry('staging', ownVercel)]),
    files: { 'vercel.json': JSON.stringify({ alias: ['example.com'] }) },
  });
  await refusedAs(live, publisherFor(), 'publish.destination.error.servesAddress');
});

test('an own project that is production’s own, written by hand, never deploys', async (context) => {
  for (const [hosting, target] of [
    [NETLIFY, { kind: 'host', hosting: NETLIFY }],
    [VERCEL, { kind: 'host', hosting: { ...VERCEL, organizationId: 'another' } }],
    [PAGES, { kind: 'host', hosting: { ...PAGES, branch: 'preview' } }],
    [WORKERS, { kind: 'host', hosting: WORKERS }],
  ] as const) {
    const project = await site(context, hosting, [entry('staging', target)]);
    await refusedAs(project, publisherFor(), 'publish.destination.error.productionProject');
  }
});

test('two destinations naming one place, written by hand, both refuse', async (context) => {
  const project = await site(context, NONE, [entry('staging', ownNetlify), entry('qa', ownNetlify)]);
  await refusedAs(project, publisherFor(), 'publish.destination.error.shared', 'staging');
  await refusedAs(project, publisherFor(), 'publish.destination.error.shared', 'qa');
});

const TWO_ENVIRONMENTS = (qa: Readonly<Record<string, unknown>>) => ({
  'wrangler.json': JSON.stringify({
    name: 'my-site',
    main: 'worker.js',
    routes: ['example.com/*'],
    env: { staging: { routes: ['staging.example.com/*'], workflows: [{ name: 'orders-staging' }] }, qa },
  }),
});

for (const [name, qa, other, key] of [
  [
    'an environment deploying another environment’s Worker',
    { routes: [], name: 'my-site-staging' },
    { kind: 'cloudflare-environment', environment: 'staging' },
    'publish.destination.error.shared',
  ],
  [
    'an environment deploying another destination’s separate Worker',
    { routes: [], name: 'my-demo' },
    { kind: 'cloudflare-worker', project: 'my-demo' },
    'publish.destination.error.shared',
  ],
  [
    'an environment deploying an own Worker in the same account',
    { routes: [], name: 'my-demo' },
    { kind: 'host', hosting: { provider: 'cloudflare-workers', accountId: 'account-1', project: 'my-demo' } },
    'publish.destination.error.shared',
  ],
  [
    'an environment taking another environment’s route',
    { routes: ['staging.example.com/*'] },
    { kind: 'cloudflare-environment', environment: 'staging' },
    'publish.destination.error.sharedRoute',
  ],
  [
    'an environment declaring another environment’s workflow',
    { routes: [], workflows: [{ name: 'orders-staging' }] },
    { kind: 'cloudflare-environment', environment: 'staging' },
    'publish.destination.error.shared',
  ],
] as const) {
  test(`Workers refuses ${name}`, async (context) => {
    const project = await site(
      context,
      WORKERS,
      [entry('qa', { kind: 'cloudflare-environment', environment: 'qa' }), entry('d1', other)],
      TWO_ENVIRONMENTS(qa),
    );
    await refusedAs(project, publisherFor(), key, 'qa');
  });
}

test('a route over another destination’s own address is refused', async (context) => {
  const project = await site(
    context,
    WORKERS,
    [
      entry('qa', { kind: 'cloudflare-environment', environment: 'qa' }),
      entry('d1', { kind: 'script', script: 'ship' }, { siteUrl: 'https://client.example.com' }),
    ],
    TWO_ENVIRONMENTS({ routes: ['client.example.com/*'] }),
  );
  await refusedAs(project, publisherFor(), 'publish.destination.error.sharedRoute', 'qa');
});

test('two environments apart both publish, each to its own Worker', async (context) => {
  const entries = [
    entry('staging', { kind: 'cloudflare-environment', environment: 'staging' }),
    entry('qa', { kind: 'cloudflare-environment', environment: 'qa' }),
  ];
  const project = await site(context, WORKERS, entries, TWO_ENVIRONMENTS({ routes: ['qa.example.com/*'] }));
  for (const id of ['staging', 'qa']) {
    project.forget();
    const state = await publishDestination(project, publisherFor(), id);
    assert.equal(state.kind === 'failed' ? `${id}: ${state.message}` : state.kind, 'done');
    assert.deepEqual(deployCalls(project.calls())[0]?.argv.slice(0, 5), ['deploy', '--name', `my-site-${id}`, '--env', id]);
  }
});

test('a Worker already serving production’s hostname in Cloudflare is refused, and an unanswered question refuses too', async (context) => {
  for (const target of [ownWorker, { kind: 'cloudflare-worker', project: 'my-demo' }] as const) {
    const files = { 'wrangler.json': JSON.stringify({ name: 'my-site', main: 'worker.js', routes: ['example.com/*'] }) };
    const taken = await site(context, WORKERS, [entry('staging', target)], files);
    await refusedAs(taken, answering({ workerHostnames: async () => ['example.com'] }), 'publish.destination.error.servesAddress');
    const unknown = await site(context, WORKERS, [entry('staging', target)], files);
    const offline: ServiceAnswers = {
      workerHostnames: async () => {
        throw new Error('offline');
      },
    };
    await refusedAs(unknown, answering(offline), 'publish.destination.error.hostUnconfirmed');
  }
});

test('the Wrangler name is production’s wherever Cloudflare could be building production from it', async (context) => {
  const files = { 'wrangler.json': JSON.stringify({ name: 'my-site', main: 'worker.js' }) };
  const target: DestinationTarget = { kind: 'host', hosting: { provider: 'cloudflare-workers', accountId: 'account-2', project: 'my-site' } };
  const unknown = await site(context, NONE, [entry('staging', target)], files);
  await refusedAs(unknown, publisherFor(), 'publish.destination.error.sameAsProduction');
  // Stacki deploys production to another provider, so this file says nothing about it.
  const elsewhere = await site(context, NETLIFY, [entry('staging', target)], files);
  assert.equal((await publishDestination(elsewhere, publisherFor(), 'staging')).kind, 'done');
});

/** A hook that rewrites a file of the person's project while the destination's own copy is building. */
async function sabotaged(context: TestContext, name: string, content: unknown, target: DestinationTarget = { kind: 'script', script: 'deploy:staging' }) {
  const project = await publishSite(context, {
    publish: production(NONE),
    destinations: destinationsFile([entry('staging', target, { beforePublish: ['before'] })]),
  });
  const file = path.join(project.root, name);
  const sabotage = `require('node:fs').writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(JSON.stringify(content))});`;
  write(project.root, 'record.cjs', `${sabotage}\n${fs.readFileSync(path.join(project.root, 'record.cjs'), 'utf8')}`);
  return project;
}

async function refusedAfterBuild(project: Site, key: string) {
  const refs = await project.refs();
  const publisher = publisherFor();
  publisher.start(project.root, 'destination:staging');
  const state = await finished(publisher, project.root);
  assert.equal(state.kind === 'failed' ? state.messageRef?.key : state.kind, key);
  assert.equal(await project.refs(), refs, 'Nothing is pushed');
  assert.ok(!scriptsRun(project.calls()).includes('deploy:staging'), 'Nothing is deployed');
  assert.equal(await readDeploymentReceipt(project.root, 'staging'), undefined);
}

const script = entry('staging', { kind: 'script', script: 'deploy:staging' }, { beforePublish: ['before'] });

test('a destination edited while it builds is not deployed', async (context) => {
  const edited = destinationsFile([{ ...script, target: { kind: 'script', script: 'ship' } }]);
  await refusedAfterBuild(await sabotaged(context, '.stacki/publish-destinations.json', edited), 'publish.destination.error.changed');
});

test('a neighbour that starts using the same place while it builds stops the deploy', async (context) => {
  const crowded = destinationsFile([script, entry('qa', { kind: 'script', script: 'deploy:staging' })]);
  await refusedAfterBuild(await sabotaged(context, '.stacki/publish-destinations.json', crowded), 'publish.destination.error.shared');
});

test('production moving while a destination builds stops the deploy', async (context) => {
  const moved = production(NONE, { customHosting: { deploy: 'script', script: 'deploy:staging' } });
  await refusedAfterBuild(await sabotaged(context, '.stacki/publish.json', moved), 'publish.destination.error.changed');
});

test('a destination removed while it builds is not pushed', async (context) => {
  const project = await sabotaged(context, '.stacki/publish-destinations.json', destinationsFile([]), { kind: 'github-branch', branch: 'staging' });
  await refusedAfterBuild(project, 'publish.destination.error.notSetUp');
});

test('each link destination sends only its own link, and a copied link is never sent', async (context) => {
  const entries = [entry('staging', { kind: 'link', branch: 'staging' }), entry('qa', { kind: 'link', branch: 'qa' })];
  const project = await site(context, NONE, entries);
  const store = fakeLinkStore(project.userData);
  const sent: string[] = [];
  const transport: DeployTransport = async (address) => {
    sent.push(address);
    return { status: 200, location: undefined };
  };
  const publisher = publisherFor({ store, transport });
  await store.save(project.root, 'https://host.example/staging', 'staging', ['staging', 'qa']);
  await store.save(project.root, 'https://host.example/qa', 'qa', ['staging', 'qa']);
  assert.equal((await publishDestination(project, publisher, 'qa')).kind, 'done');
  assert.deepEqual(sent, ['https://host.example/qa']);
  // The same link saved for both, as by an older copy of this file: neither may send it.
  await store.save(project.root, 'https://host.example/staging', 'qa');
  await refusedAs(project, publisher, 'publish.destination.error.sharedLink', 'staging');
  assert.equal(sent.length, 1);
});

test('production’s scripts never learn of a destination, even one set on this computer', async (context) => {
  process.env['STACKI_PUBLISH_DESTINATION'] = 'staging';
  context.after(() => {
    delete process.env['STACKI_PUBLISH_DESTINATION'];
  });
  const project = await site(context, NONE, []);
  write(project.root, '.stacki/publish.json', JSON.stringify(production(NONE, { customHosting: { deploy: 'script', script: 'ship' } })));
  const publisher = publisherFor();
  publisher.start(project.root, 'hosting');
  assert.equal((await finished(publisher, project.root)).kind, 'done');
  assert.deepEqual(scriptsRun(project.calls()), ['before', 'build', 'ship', 'after']);
  assert.ok(project.calls().every((call) => call.env['STACKI_PUBLISH_DESTINATION'] === undefined));
});

test('a destination that is not saved does nothing', async (context) => {
  const project = await site(context, NONE, [entry('qa', { kind: 'script', script: 'ship' })]);
  await refusedAs(project, publisherFor(), 'publish.destination.error.notSetUp');
});

test('a host’s reply about another project is not an answer about this one', () => {
  const netlify = { provider: 'netlify', siteId: 'site-2' } as const;
  assert.throws(() => parseNetlifyProject({ id: 'site-1' }, netlify));
  assert.deepEqual(
    parseNetlifyProject(
      { id: 'site-2', custom_domain: 'QA.example.com', domain_aliases: ['b.example.com'], build_settings: { repo_url: 'https://github.com/Owner/Site' } },
      netlify,
    ),
    { domains: ['qa.example.com', 'b.example.com'], repository: 'github.com/owner/site' },
  );
  const vercel = { provider: 'vercel', organizationId: 'team_2', projectId: 'prj_2' } as const;
  assert.throws(() => parseVercelProject({ id: 'prj_1', accountId: 'team_2' }, [], vercel), 'The API also answers to a name');
  assert.throws(() => parseVercelProject({ id: 'prj_2', accountId: 'team_1' }, [], vercel));
  assert.deepEqual(
    parseVercelProject({ id: 'prj_2', accountId: 'team_2', link: { type: 'github', org: 'Owner', repo: 'Site' } }, [{ name: 'A.example.com' }], vercel),
    {
      domains: ['a.example.com'],
      repository: 'github.com/owner/site',
    },
  );
  assert.throws(() => parsePagesProject({ domains: [] }), 'A project without a production branch is not described');
  assert.throws(() => parsePagesProject({ production_branch: 'main', domains: Array.from({ length: 501 }, () => 'a.example.com') }));
  const rows = [
    { service: 'Review', hostname: 'A.example.com' },
    { service: 'other', hostname: 'b.example.com' },
  ];
  assert.deepEqual(parseWorkerHostnames(rows, 'review'), ['a.example.com']);
  assert.throws(() => parseWorkerHostnames([{ service: 'review' }], 'review'));
});
