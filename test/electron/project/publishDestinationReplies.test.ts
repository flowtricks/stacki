// Goal: no safety check ever reads a missing or renamed field as "no clash". Every field a check reads from Netlify,
// Cloudflare Pages, Cloudflare Worker domains and Vercel is taken out and renamed in turn, and the answer must become a
// refusal or `unread`. Replies shaped as the public references document them must still be read, so ordinary publishes
// are not refused.
// Method: the parsers on replies built to each documented shape (docs/contracts.md lists the pages; the values here are
// invented). Then the real publisher with those parsers answering for the host, on temporary projects whose deploy
// CLIs only record. Nothing reaches a real host.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseNetlifyProject,
  parsePagesProductionBranch,
  parsePagesProject,
  parseVercelProduction,
  parseVercelProject,
  parseWorkerHostnames,
  readPagesDomains,
  readVercelDomains,
  type HostDomains,
} from '#dist/electron/project/publishDestinationReplies.js';
import type { Hosting } from '#dist/shared/properties/publishConfig.js';
import type { DestinationTarget } from '#dist/shared/properties/publishDestinations.js';
import { readPublishAvailability } from '#dist/electron/project/publishAvailability.js';
import { deployCalls, finished, publishSite, scriptsRun } from '../../helpers/publishSite.ts';
import {
  destinationsFile,
  entry,
  production,
  publishDestination,
  publisherFor,
  refusedAs,
  services,
  type ServiceAnswers,
} from '../../helpers/publishDestinations.ts';

// The null a host sends, read from JSON as it arrives; Stacki's own values never hold one.
const SENT_NULL: unknown = JSON.parse('null');

type Reply = Readonly<Record<string, unknown>>;

/** The reply without one key, and with that key under another name, as a host that renamed it would send it. */
function changed(reply: Reply, key: string): readonly (readonly [string, Reply])[] {
  const { [key]: value, ...rest } = reply;
  assert.notEqual(value, undefined, `${key} is in the documented reply`);
  return [
    [`without ${key}`, rest],
    [`with ${key} renamed`, { ...rest, [`${key}V2`]: value }],
  ];
}

const NETLIFY = { provider: 'netlify', siteId: '3970e0fe' } as const;
const VERCEL = { provider: 'vercel', organizationId: 'team_2', projectId: 'prj_2' } as const;
const PAGES = { provider: 'cloudflare', accountId: 'account-2', project: 'review-pages', branch: 'main', directory: 'dist' } as const;

// The properties of `site` in Netlify's swagger.yml that the checks read, with the guide's example values around them.
const SITE: Reply = {
  id: '3970e0fe',
  name: 'synergy',
  custom_domain: 'www.example.com',
  domain_aliases: ['alias.example.com'],
  url: 'http://www.example.com',
  ssl_url: 'https://synergy.netlify.app',
  admin_url: 'https://api.netlify.com/sites/synergy',
  build_settings: { provider: 'github', repo_path: 'Owner/Site', repo_url: 'https://github.com/Owner/Site', repo_branch: 'main', public_repo: false },
};

test('a documented Netlify site is read whole', () => {
  assert.deepEqual(parseNetlifyProject(SITE, NETLIFY), {
    domains: { kind: 'listed', hosts: ['www.example.com', 'alias.example.com', 'synergy.netlify.app'] },
    repository: { kind: 'github', repository: 'github.com/owner/site' },
  });
  // A site with no custom domain and no repository: null or empty, an empty list, and empty build settings.
  for (const custom of [SENT_NULL, '']) {
    const plain = { ...SITE, custom_domain: custom, domain_aliases: [], url: 'http://synergy.netlify.app', build_settings: {} };
    assert.deepEqual(parseNetlifyProject(plain, NETLIFY), {
      domains: { kind: 'listed', hosts: ['synergy.netlify.app'] },
      repository: { kind: 'not-connected' },
    });
  }
  // Only one of the two addresses is needed, and empty repository fields are no repository.
  const { ssl_url: unused, ...one } = SITE;
  void unused;
  assert.equal(parseNetlifyProject(one, NETLIFY).domains.kind, 'listed');
  const unlinked = { ...SITE, build_settings: { repo_url: '', repo_branch: SENT_NULL, public_repo: false, cmd: 'npm run build' } };
  assert.equal(parseNetlifyProject(unlinked, NETLIFY).repository.kind, 'not-connected');
});

for (const key of ['custom_domain', 'domain_aliases']) {
  for (const [name, reply] of changed(SITE, key)) {
    test(`a Netlify site ${name} has unread domains`, () => {
      assert.deepEqual(parseNetlifyProject(reply, NETLIFY).domains, { kind: 'unread' });
    });
  }
}

test('a Netlify site with no address, or a domain field of another shape, has unread domains', () => {
  const { url, ssl_url: secure, ...bare } = SITE;
  void url;
  void secure;
  for (const reply of [
    bare,
    { ...bare, urls: [url] },
    { ...SITE, domain_aliases: 'alias.example.com' },
    { ...SITE, domain_aliases: [{ domain: 'alias.example.com' }] },
    { ...SITE, custom_domain: { name: 'www.example.com' } },
    { ...SITE, custom_domain: 'https://www.example.com' },
    { ...SITE, ssl_url: 'not an address' },
    { ...SITE, domain_aliases: Array.from({ length: 501 }, () => 'a.example.com') },
  ]) {
    assert.deepEqual(parseNetlifyProject(reply, NETLIFY).domains, { kind: 'unread' }, JSON.stringify(reply).slice(0, 200));
  }
});

test('a Netlify repository is never taken as absent when its settings are missing, renamed or partial', () => {
  const repository = (settings: unknown) => parseNetlifyProject({ ...SITE, build_settings: settings }, NETLIFY).repository;
  for (const [name, reply] of changed(SITE, 'build_settings')) {
    assert.deepEqual(parseNetlifyProject(reply, NETLIFY).repository, { kind: 'unread' }, name);
  }
  for (const settings of [
    SENT_NULL,
    'github.com/owner/site',
    { repoUrl: 'https://github.com/owner/site' },
    { repository_url: 'https://github.com/owner/site' },
    { provider: 'github' },
    { provider: 'github', repo_path: 'owner' },
    { repo_branch: 'main' },
    { installation_id: 4 },
    { repo_url: 'github.com/owner/site/tree/main' },
    { repo_url: 'owner/site' },
    { repo_url: 'https://www.github.example/owner/site' },
    { git_repository: { owner: 'owner' } },
  ]) {
    assert.deepEqual(repository(settings), { kind: 'unread' }, JSON.stringify(settings));
  }
  assert.deepEqual(repository({ repo_url: 'git@github.com:Owner/Site.git' }), { kind: 'github', repository: 'github.com/owner/site' });
  assert.deepEqual(repository({ provider: 'github', repo_path: 'Owner/Site' }), { kind: 'github', repository: 'github.com/owner/site' });
  assert.deepEqual(repository({ provider: 'gitlab', repo_path: 'group/site' }), { kind: 'elsewhere' });
  assert.deepEqual(repository({ repo_url: 'https://gitlab.com/group/site' }), { kind: 'elsewhere' });
});

test('a Netlify reply that does not name the saved site is refused', () => {
  for (const [, reply] of changed(SITE, 'id')) {
    assert.throws(() => parseNetlifyProject(reply, NETLIFY));
  }
  assert.throws(() => parseNetlifyProject({ ...SITE, id: 'another' }, NETLIFY), 'The API also answers to a domain');
});

// Cloudflare's documented Pages project: `name` and `production_branch` required, `domains` and `source` optional.
const PAGES_RESULT: Reply = {
  name: 'review-pages',
  production_branch: 'main',
  subdomain: 'review-pages.pages.dev',
  domains: ['customdomain.com', 'customdomain.org'],
  source: { type: 'github', config: { owner: 'My-Org', repo_name: 'My-Repo', production_branch: 'main', deployments_enabled: true } },
};
const envelope = (result: unknown, extra: Reply = {}): Reply => ({ success: true, errors: [], messages: [], result, ...extra });
// One entry of the documented list of a project's domains.
const pagesDomain = (name: string) => ({ id: 'id', name, status: 'active', certificate_authority: 'lets_encrypt', zone_tag: 'zone' });
const listed = (...hosts: string[]): HostDomains => ({ kind: 'listed', hosts });

test('a documented Pages project is read, with its optional fields and without them', () => {
  assert.deepEqual(parsePagesProject(envelope(PAGES_RESULT), listed('custom.example.com'), PAGES), {
    productionBranch: 'main',
    domains: listed('custom.example.com', 'customdomain.com', 'customdomain.org', 'review-pages.pages.dev'),
    repository: { kind: 'github', repository: 'github.com/my-org/my-repo' },
  });
  // Only the two required fields: the domains list still answers, and a project without a source is a direct upload.
  const required = envelope({ name: 'review-pages', production_branch: 'main' });
  assert.deepEqual(parsePagesProject(required, listed('custom.example.com'), PAGES), {
    productionBranch: 'main',
    domains: listed('custom.example.com'),
    repository: { kind: 'not-connected' },
  });
});

test('a Pages domain list that was not read is never replaced by the optional field', () => {
  assert.deepEqual(parsePagesProject(envelope(PAGES_RESULT), { kind: 'unread' }, PAGES).domains, { kind: 'unread' });
  for (const domains of ['customdomain.com', [{ name: 'customdomain.com' }], SENT_NULL]) {
    assert.deepEqual(parsePagesProject(envelope({ ...PAGES_RESULT, domains }), listed(), PAGES).domains, { kind: 'unread' }, JSON.stringify(domains));
  }
});

for (const key of ['name', 'production_branch']) {
  for (const [name, result] of changed(PAGES_RESULT, key)) {
    test(`a Pages project ${name} is refused`, () => {
      assert.throws(() => parsePagesProductionBranch(envelope(result), PAGES));
      assert.throws(() => parsePagesProject(envelope(result), listed(), PAGES));
    });
  }
}

test('a Pages reply that failed, has another envelope or describes another project is refused', () => {
  for (const reply of [{ result: PAGES_RESULT }, { success: false, result: PAGES_RESULT }, PAGES_RESULT, envelope({ ...PAGES_RESULT, name: 'other' })]) {
    assert.throws(() => parsePagesProductionBranch(reply, PAGES));
  }
});

test('a Pages source of another shape is unread, and one on GitLab is not this repository', () => {
  const repository = (source: unknown) => parsePagesProject(envelope({ ...PAGES_RESULT, source }), listed(), PAGES).repository;
  for (const source of [
    {},
    'github',
    { type: 'github' },
    { type: 'github', config: { owner: 'o' } },
    { type: 'github', config: { owner: 'o', repoName: 'r' } },
    { type: 'github', config: { owner_login: 'o', repo_name: 'r' } },
    { kind: 'github', config: { owner: 'o', repo_name: 'r' } },
    { type: 'github-enterprise', config: { owner: 'o', repo_name: 'r' } },
  ]) {
    assert.deepEqual(repository(source), { kind: 'unread' }, JSON.stringify(source));
  }
  assert.deepEqual(repository({ type: 'gitlab', config: {} }), { kind: 'elsewhere' });
  assert.deepEqual(repository(SENT_NULL), { kind: 'not-connected' });
});

test('the Pages domains list is followed to its end, or is unread', async () => {
  const page = (count: number, from: number) => Array.from({ length: count }, (_, index) => pagesDomain(`d${from + index}.example.com`));
  const asked: number[] = [];
  const two = await readPagesDomains(async (number) => {
    asked.push(number);
    return envelope(number === 1 ? page(25, 0) : page(1, 25), { result_info: { count: 1, page: number, per_page: 25, total_count: 26, total_pages: 2 } });
  });
  assert.deepEqual(asked, [1, 2]);
  assert.equal(two.kind === 'listed' ? two.hosts.length : 0, 26);
  // `result_info` is optional: a short page is then the last one.
  assert.deepEqual(await readPagesDomains(async () => envelope([pagesDomain('A.example.com')])), listed('a.example.com'));
  assert.deepEqual(await readPagesDomains(async () => envelope([])), listed());
  for (const reply of [
    envelope(undefined),
    envelope({ domains: [] }),
    envelope([{ domain: 'a.example.com' }]),
    envelope([{ hostname: 'a.example.com' }]),
    { success: false, result: [] },
    { result: [] },
    envelope([pagesDomain('a.example.com')], { result_info: { total_count: 40, total_pages: 1 } }),
    envelope([], { result_info: { total_pages: 'two' } }),
    // Never ending: the bound is reached.
    envelope(page(25, 0)),
  ]) {
    assert.deepEqual(await readPagesDomains(async () => reply), { kind: 'unread' }, JSON.stringify(reply).slice(0, 160));
  }
  await assert.rejects(readPagesDomains(async () => Promise.reject(new Error('offline'))));
});

// Cloudflare's documented Worker domain.
const WORKER_DOMAIN: Reply = {
  id: 'dbe10b4bc17c295377eabd600e1787fd',
  cert_id: '9fdf92c8-64c2-4a3d-b1af-e15304961145',
  enabled: true,
  environment: 'production',
  hostname: 'app.example.com',
  previews_enabled: false,
  service: 'my-worker',
  zone_id: '593c9c94de529bbbfaac7c53ced0447d',
  zone_name: 'example.com',
};

test('documented Worker domains are read, and a Worker with none serves none', () => {
  assert.deepEqual(parseWorkerHostnames(envelope([WORKER_DOMAIN]), 'My-Worker'), ['app.example.com']);
  assert.deepEqual(
    parseWorkerHostnames(envelope([WORKER_DOMAIN], { result_info: { count: 1, page: 1, per_page: 20, total_count: 1, total_pages: 1 } }), 'my-worker'),
    ['app.example.com'],
  );
  assert.deepEqual(parseWorkerHostnames(envelope([]), 'my-worker'), []);
  assert.deepEqual(parseWorkerHostnames(envelope([WORKER_DOMAIN]), 'another'), []);
});

for (const key of ['service', 'hostname']) {
  for (const [name, domain] of changed(WORKER_DOMAIN, key)) {
    test(`a Worker domain ${name} is refused, even for another Worker`, () => {
      assert.throws(() => parseWorkerHostnames(envelope([domain]), 'my-worker'));
      assert.throws(() => parseWorkerHostnames(envelope([domain]), 'another'));
    });
  }
}

test('a Worker domain list that is not whole, or not the documented envelope, is refused', () => {
  for (const reply of [
    { success: true },
    { success: true, results: [WORKER_DOMAIN] },
    { result: [WORKER_DOMAIN] },
    envelope({ domains: [WORKER_DOMAIN] }),
    envelope([WORKER_DOMAIN], { result_info: { total_count: 2 } }),
    envelope([WORKER_DOMAIN], { result_info: { total_pages: 3 } }),
  ]) {
    assert.throws(() => parseWorkerHostnames(reply, 'my-worker'), JSON.stringify(reply).slice(0, 160));
  }
});

// Vercel's documented project: `accountId` and `id` required, `link` optional.
const PROJECT: Reply = {
  accountId: 'team_2',
  id: 'prj_2',
  name: 'review',
  link: { type: 'github', org: 'Owner', repo: 'Site', productionBranch: 'main', gitCredentialId: 'cred', deployHooks: [] },
};

test('a documented Vercel project is read, linked or not', () => {
  const repository = (project: Reply) => parseVercelProject(project, listed(), VERCEL).repository;
  assert.deepEqual(repository(PROJECT), { kind: 'github', repository: 'github.com/owner/site' });
  assert.deepEqual(repository({ accountId: 'team_2', id: 'prj_2', name: 'review' }), { kind: 'not-connected' });
  assert.deepEqual(repository({ ...PROJECT, link: { type: 'github-limited', org: 'Owner', repo: 'Site' } }), {
    kind: 'github',
    repository: 'github.com/owner/site',
  });
  assert.deepEqual(repository({ ...PROJECT, link: { type: 'github-custom-host', host: 'git.example.com', org: 'o', repo: 'r' } }), { kind: 'elsewhere' });
  for (const type of ['gitlab', 'bitbucket']) {
    assert.deepEqual(repository({ ...PROJECT, link: { type } }), { kind: 'elsewhere' });
  }
});

test('a Vercel link of an unknown type or without its fields is unread', () => {
  for (const link of [
    {},
    'github',
    { type: 'something-new', org: 'o', repo: 'r' },
    { kind: 'github', org: 'o', repo: 'r' },
    // The reference does not require `repo`, so a link without it cannot say which repository it is.
    { type: 'github', org: 'o' },
    { type: 'github', organisation: 'o', repo: 'r' },
    { type: 'github', org: 'o', repository: 'r' },
    { type: 'github-custom-host', org: 'o', repo: 'r' },
  ]) {
    assert.deepEqual(parseVercelProject({ ...PROJECT, link }, listed(), VERCEL).repository, { kind: 'unread' }, JSON.stringify(link));
  }
});

for (const key of ['id', 'accountId']) {
  for (const [name, project] of changed(PROJECT, key)) {
    test(`a Vercel project ${name} is refused`, () => {
      assert.throws(() => parseVercelProject(project, listed(), VERCEL));
    });
  }
}

// One entry of Vercel's documented project domains, with the required `apexName`, `name`, `projectId`, `verified`.
const DOMAIN: Reply = { apexName: 'example.com', name: 'Review.example.com', projectId: 'prj_2', verified: true };
const domainsReply = (domains: unknown, next: unknown = SENT_NULL): Reply => ({ domains, pagination: { count: 1, next, prev: SENT_NULL } });

test('documented Vercel domains are followed to a null `next`', async () => {
  const asked: (number | undefined)[] = [];
  const both = await readVercelDomains(VERCEL, async (until) => {
    asked.push(until);
    return until === undefined ? domainsReply([DOMAIN], 1_540_095_775_951) : domainsReply([{ ...DOMAIN, name: 'b.example.com', redirect: 'a.example.com' }]);
  });
  assert.deepEqual(asked, [undefined, 1_540_095_775_951]);
  assert.deepEqual(both, listed('review.example.com', 'b.example.com'));
  assert.deepEqual(await readVercelDomains(VERCEL, async () => domainsReply([])), listed());
});

test('Vercel domains are unread when a field or the end of the list is missing or renamed', async () => {
  const replies: unknown[] = [
    { domains: [DOMAIN] },
    { domains: [DOMAIN], pagination: { count: 1, prev: SENT_NULL } },
    { domains: [DOMAIN], pagination: { count: 1, nextCursor: 5, prev: SENT_NULL } },
    domainsReply([DOMAIN], 'later'),
    { items: [DOMAIN], pagination: { next: SENT_NULL } },
    domainsReply(undefined),
    ...changed(DOMAIN, 'name').map(([, entry]) => domainsReply([entry])),
    ...changed(DOMAIN, 'projectId').map(([, entry]) => domainsReply([entry])),
    domainsReply([{ ...DOMAIN, projectId: 'prj_1' }]),
  ];
  for (const reply of replies) {
    assert.deepEqual(await readVercelDomains(VERCEL, async () => reply), { kind: 'unread' }, JSON.stringify(reply));
  }
  // Pages that never end stop at the bound.
  let next = 100;
  assert.deepEqual(await readVercelDomains(VERCEL, async () => domainsReply([DOMAIN], next--)), { kind: 'unread' });
  await assert.rejects(readVercelDomains(VERCEL, async () => Promise.reject(new Error('offline'))));
});

// One entry of Vercel's documented deployment list: `projectId` and `readyState` required, `target` nullable.
const DEPLOYMENT: Reply = { uid: 'dpl_1', projectId: 'prj_2', readyState: 'READY', state: 'READY', target: 'production' };

test('only a ready production deployment of this project counts as one', () => {
  const has = (...deployments: unknown[]) => parseVercelProduction({ deployments, pagination: { count: 1, next: SENT_NULL, prev: SENT_NULL } }, VERCEL);
  assert.equal(has(DEPLOYMENT), true);
  assert.equal(has(), false);
  for (const other of [
    { ...DEPLOYMENT, target: SENT_NULL },
    { ...DEPLOYMENT, target: 'staging' },
    { ...DEPLOYMENT, projectId: 'prj_1' },
  ]) {
    assert.equal(has(other), false, JSON.stringify(other));
  }
  assert.equal(has({ ...DEPLOYMENT, readyState: 'ERROR', state: 'ERROR' }), false);
  // A missing or renamed `target` is never a yes.
  for (const [name, deployment] of changed(DEPLOYMENT, 'target')) {
    assert.equal(has(deployment), false, name);
  }
});

test('a Vercel deployment list of another shape is refused', () => {
  for (const reply of [
    {},
    { items: [DEPLOYMENT] },
    { deployments: DEPLOYMENT },
    ...changed(DEPLOYMENT, 'projectId').map(([, deployment]) => ({ deployments: [deployment] })),
    ...changed(DEPLOYMENT, 'readyState').map(([, deployment]) => ({ deployments: [deployment] })),
  ]) {
    assert.throws(() => parseVercelProduction(reply, VERCEL), JSON.stringify(reply));
  }
});

const NONE: Hosting = { provider: 'none' };
const ASTRO = { 'astro.config.mjs': 'export default {};' };
const ownNetlify: DestinationTarget = { kind: 'host', hosting: NETLIFY };

/** A project whose production is GitHub alone with a known address, so both the domain and repository checks apply. */
async function guarded(context: Parameters<typeof publishSite>[0], target: DestinationTarget, hosting: Hosting = NONE) {
  const custom = hosting.provider === 'none' ? { customHosting: { deploy: 'github', siteUrl: 'https://live.example.com' } as const } : {};
  return publishSite(context, {
    publish: { ...production(hosting, custom) },
    destinations: destinationsFile([entry('staging', target)]),
    files: ASTRO,
  });
}

for (const [name, reply] of [
  ...changed(SITE, 'custom_domain'),
  ...changed(SITE, 'domain_aliases'),
  ...changed(SITE, 'build_settings'),
  ...changed(SITE, 'id'),
]) {
  test(`publishing is refused, with its own sentence, for a Netlify reply ${name}`, async (context) => {
    const project = await guarded(context, ownNetlify);
    const answers: ServiceAnswers = { netlifyProject: async (_root, hosting) => parseNetlifyProject(reply, hosting) };
    await refusedAs(project, publisherFor({ services: services(answers) }), 'publish.destination.error.hostUnconfirmed');
  });
}

test('publishing is refused for a Pages source or a Vercel link Stacki does not know', async (context) => {
  const pages = await guarded(context, { kind: 'host', hosting: PAGES });
  const pagesAnswers: ServiceAnswers = {
    pagesProject: async (_root, hosting) => parsePagesProject(envelope({ ...PAGES_RESULT, domains: [], source: { type: 'new' } }), listed(), hosting),
  };
  await refusedAs(pages, publisherFor({ services: services(pagesAnswers) }), 'publish.destination.error.hostUnconfirmed');
  const vercel = await guarded(context, { kind: 'host', hosting: VERCEL });
  const vercelAnswers: ServiceAnswers = {
    vercelProject: async (_root, hosting) => parseVercelProject({ ...PROJECT, link: { type: 'new' } }, listed(), hosting),
  };
  await refusedAs(vercel, publisherFor({ services: services(vercelAnswers) }), 'publish.destination.error.hostUnconfirmed');
});

test('a documented reply with nothing in common with production publishes', async (context) => {
  const project = await guarded(context, ownNetlify);
  const reply = { ...SITE, custom_domain: SENT_NULL, domain_aliases: [], url: 'http://synergy.netlify.app', build_settings: {} };
  const answers: ServiceAnswers = { netlifyProject: async (_root, hosting) => parseNetlifyProject(reply, hosting) };
  assert.equal((await publishDestination(project, publisherFor({ services: services(answers) }), 'staging')).kind, 'done');
});

test('an unread field refuses only where a check has something to compare', async (context) => {
  // Netlify's guide shows a site without aliases or build settings. Stacki deploys this production itself and knows no
  // hostname for it, so neither the domains nor the repository could clash with anything.
  const { domain_aliases: aliases, build_settings: settings, ...abbreviated } = SITE;
  void aliases;
  void settings;
  const project = await publishSite(context, {
    publish: { ...production({ provider: 'vercel', organizationId: 'team_1', projectId: 'prj_1' }) },
    destinations: destinationsFile([entry('staging', ownNetlify)]),
    files: ASTRO,
  });
  const answers: ServiceAnswers = { netlifyProject: async (_root, hosting) => parseNetlifyProject(abbreviated, hosting) };
  assert.equal((await publishDestination(project, publisherFor({ services: services(answers) }), 'staging')).kind, 'done');
});

/** Every host question fails the test if it is asked. */
function unasked(): ServiceAnswers {
  const refuse = async (): Promise<never> => assert.fail('A project with no extra destinations asks a host nothing new');
  return {
    pagesProductionBranch: refuse,
    pagesProject: refuse,
    vercelHasProduction: refuse,
    vercelProject: refuse,
    netlifyProject: refuse,
    workerHostnames: refuse,
    netlifySite: refuse,
    workerToolInstalled: () => assert.fail('A project with no extra destinations uses production’s own readiness check'),
  };
}

for (const [name, file] of [
  ['no destinations file', undefined],
  ['an empty destinations file', destinationsFile([])],
] as const) {
  test(`with ${name}, production publishes as before and asks none of these questions`, async (context) => {
    const project = await publishSite(context, {
      publish: { ...production({ provider: 'vercel', organizationId: 'team_1', projectId: 'prj_1' }) },
      ...(file === undefined ? {} : { destinations: file }),
    });
    const publisher = publisherFor({ services: services(unasked()) });
    publisher.start(project.root, 'hosting');
    assert.deepEqual(await finished(publisher, project.root), { kind: 'done', github: false, hosting: true });
    assert.deepEqual(scriptsRun(project.calls()), ['before', 'build', 'after']);
    assert.deepEqual(
      deployCalls(project.calls()).map((call) => [call.argv, call.env['STACKI_PUBLISH_DESTINATION'], call.env['STACKI_PUBLISH_ENV']]),
      [[['deploy', '--prod', '--yes'], undefined, undefined]],
    );
    const availability = await readPublishAvailability(project.root);
    assert.equal(availability.hosting, 'current');
    assert.equal(availability.destinations, undefined);
  });
}
