// Goal: publishing one destination can never change production or another destination, as far as the settings alone
// can say. Every kind of destination is paired with every other, including pairs a hand-edited file could hold.
// Method: a table of destinations under each kind of production. Pairs that name the same place are refused from both
// sides; every other pair is allowed. A pair is judged both ways, so the answer cannot depend on which is published.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_PUBLISH_CONFIG, type Hosting, type PublishConfig } from '#dist/shared/properties/publishConfig.js';
import { destinationConflict, previewName, sameProject } from '#dist/shared/properties/publishDestinationConflicts.js';
import type { Destination, DestinationTarget } from '#dist/shared/properties/publishDestinations.js';

const WORKERS: Hosting = { provider: 'cloudflare-workers', accountId: 'acct', project: 'site' };
const PAGES: Hosting = { provider: 'cloudflare', accountId: 'acct', project: 'site-pages', branch: 'main', directory: 'dist' };
const VERCEL: Hosting = { provider: 'vercel', organizationId: 'team', projectId: 'prj_live' };
const NETLIFY: Hosting = { provider: 'netlify', siteId: 'live-site' };
const NONE: Hosting = { provider: 'none' };

const on = (hosting: Hosting, extra: Pick<PublishConfig, 'customHosting' | 'publishedSite'> = {}): PublishConfig => ({
  ...DEFAULT_PUBLISH_CONFIG,
  hosting,
  ...extra,
});

type Details = { readonly [Key in 'siteUrl' | 'buildScript' | 'beforePublish' | 'afterPublish']?: Destination[Key] };

function destination(id: string, target: DestinationTarget, extra: Details = {}): Destination {
  return { id, label: id.toUpperCase(), target, buildScript: 'build', beforePublish: [], afterPublish: [], ...extra };
}

const worker = (accountId: string, project: string): DestinationTarget => ({ kind: 'host', hosting: { provider: 'cloudflare-workers', accountId, project } });
const ownPages = (project: string, branch = 'main'): DestinationTarget => ({
  kind: 'host',
  hosting: { provider: 'cloudflare', accountId: 'acct', project, branch, directory: 'dist' },
});
const ownVercel = (projectId: string, organizationId = 'team'): DestinationTarget => ({
  kind: 'host',
  hosting: { provider: 'vercel', organizationId, projectId },
});
const ownNetlify = (siteId: string): DestinationTarget => ({ kind: 'host', hosting: { provider: 'netlify', siteId } });
const branch = (name: string): DestinationTarget => ({ kind: 'github-branch', branch: name });
const link = (name: string): DestinationTarget => ({ kind: 'link', branch: name });
const script = (name: string): DestinationTarget => ({ kind: 'script', script: name });

function refusal(production: PublishConfig, first: Destination, others: readonly Destination[]): string | undefined {
  const result = destinationConflict(production, first, others);
  return result.ok ? undefined : result.error.messageRef?.key.replace('publish.destination.error.', '');
}

/** Pairs that publish to one place, by the production they sit beside. */
const SAME_PLACE: readonly (readonly [string, Hosting, DestinationTarget, DestinationTarget])[] = [
  ['the same Wrangler environment', WORKERS, { kind: 'cloudflare-environment', environment: 'qa' }, { kind: 'cloudflare-environment', environment: 'QA' }],
  ['the same separate Worker', WORKERS, { kind: 'cloudflare-worker', project: 'site-qa' }, { kind: 'cloudflare-worker', project: 'site-qa' }],
  ['a separate Worker and the same Worker as an own host', WORKERS, { kind: 'cloudflare-worker', project: 'site-qa' }, worker('ACCT', 'site-qa')],
  ['the same Worker in another account twice', WORKERS, worker('other', 'review'), worker('other', 'review')],
  ['the same Pages preview branch', PAGES, { kind: 'cloudflare-pages', branch: 'qa' }, { kind: 'cloudflare-pages', branch: 'QA' }],
  [
    'two Pages branches that share a preview address',
    PAGES,
    { kind: 'cloudflare-pages', branch: 'review/design' },
    { kind: 'cloudflare-pages', branch: 'review-design' },
  ],
  [
    'two Pages branches alike in their first 28 characters',
    PAGES,
    { kind: 'cloudflare-pages', branch: `${'a'.repeat(28)}-one` },
    { kind: 'cloudflare-pages', branch: `${'a'.repeat(28)}-two` },
  ],
  ['the same own Pages project', NONE, ownPages('review'), ownPages('Review', 'release')],
  ['the same Netlify alias', NETLIFY, { kind: 'netlify', alias: 'qa' }, { kind: 'netlify', alias: 'qa' }],
  ['the same own Netlify site', NONE, ownNetlify('site-2'), ownNetlify('SITE-2')],
  ['the same own Vercel project under two teams', NONE, ownVercel('prj_2', 'a'), ownVercel('prj_2', 'b')],
  ['the same git branch', NONE, branch('qa'), branch('QA')],
  ['a branch pushed by two methods', NONE, branch('qa'), link('qa')],
  ['a git branch that builds a Pages preview', PAGES, branch('qa'), { kind: 'cloudflare-pages', branch: 'qa' }],
  ['a git branch that builds a Netlify alias', NETLIFY, link('qa'), { kind: 'netlify', alias: 'qa' }],
  ['a git branch that is an own Pages project’s live branch', NONE, branch('release'), ownPages('review', 'release')],
  ['the same script', NONE, script('deploy:qa'), script('Deploy:QA')],
];

for (const [name, hosting, left, right] of SAME_PLACE) {
  test(`two destinations are refused from both sides for ${name}`, () => {
    const first = destination('one', left);
    const second = destination('two', right);
    assert.equal(refusal(on(hosting), first, [second]), 'shared');
    assert.equal(refusal(on(hosting), second, [first]), 'shared');
    // The refusal does not depend on its neighbours or their order.
    const harmless = destination('three', script('deploy:other'));
    assert.equal(refusal(on(hosting), first, [harmless, second]), 'shared');
  });
}

/** Every kind that may sit beside every other kind, by production: all pairs must be allowed. */
const APART: readonly (readonly [string, Hosting, readonly DestinationTarget[]])[] = [
  [
    'Worker production',
    WORKERS,
    [
      { kind: 'cloudflare-environment', environment: 'staging' },
      { kind: 'cloudflare-environment', environment: 'qa' },
      { kind: 'cloudflare-worker', project: 'site-demo' },
      worker('other', 'site-demo'),
      worker('other', 'site'),
      ownVercel('prj_2'),
      ownNetlify('site-2'),
      branch('review'),
      link('client'),
      script('deploy:preview'),
    ],
  ],
  [
    'Pages production',
    PAGES,
    [
      { kind: 'cloudflare-pages', branch: 'staging' },
      { kind: 'cloudflare-pages', branch: 'qa' },
      ownPages('review'),
      worker('acct', 'site-pages'),
      branch('client'),
      script('deploy:preview'),
    ],
  ],
  // Each Vercel preview gets an address of its own, so two previews change nothing of each other's.
  ['Vercel production', VERCEL, [{ kind: 'vercel' }, { kind: 'vercel' }, ownVercel('prj_2'), ownVercel('prj_3'), branch('client')]],
  [
    'Netlify production',
    NETLIFY,
    [{ kind: 'netlify', alias: 'staging' }, { kind: 'netlify', alias: 'qa' }, ownNetlify('site-2'), ownNetlify('site-3'), script('deploy:preview')],
  ],
];

for (const [name, hosting, targets] of APART) {
  test(`beside ${name}, destinations in different places are all allowed`, () => {
    const destinations = targets.map((target, index) => destination(`d${index}`, target));
    for (const one of destinations) {
      const others = destinations.filter((other) => other !== one);
      assert.equal(refusal(on(hosting), one, others), undefined, JSON.stringify(one.target));
    }
  });
}

/** Targets that name production, whatever the file says. */
const PRODUCTION_PLACES: readonly (readonly [string, PublishConfig, DestinationTarget, string])[] = [
  ['production’s Worker as a separate one', on(WORKERS), { kind: 'cloudflare-worker', project: 'site' }, 'sameAsProduction'],
  ['production’s Worker as an own host', on(WORKERS), worker('ACCT', 'Site'), 'productionProject'],
  ['the production environment', on(WORKERS), { kind: 'cloudflare-environment', environment: 'Production' }, 'sameAsProduction'],
  ['the Pages production branch', on(PAGES), { kind: 'cloudflare-pages', branch: 'Main' }, 'sameAsProduction'],
  [
    'a branch sharing the production branch’s address',
    on({ ...PAGES, branch: 'live/site' }),
    { kind: 'cloudflare-pages', branch: 'live-site' },
    'sameAsProduction',
  ],
  ['production’s Pages project as an own host', on(PAGES), ownPages('Site-Pages', 'other'), 'productionProject'],
  ['production’s Vercel project under another team', on(VERCEL), ownVercel('PRJ_LIVE', 'elsewhere'), 'productionProject'],
  ['production’s Netlify site', on(NETLIFY), ownNetlify('Live-Site'), 'productionProject'],
  ['the production Netlify alias', on(NETLIFY), { kind: 'netlify', alias: 'main' }, 'sameAsProduction'],
  ['a production branch name', on(NONE), branch('Production'), 'sameAsProduction'],
  ['a production branch through a link', on(NONE), link('gh-pages'), 'sameAsProduction'],
  ['a script named like a production deploy', on(NONE), script('deploy:prod'), 'sameAsProduction'],
  ['production’s own script', on(NONE, { customHosting: { deploy: 'script', script: 'ship' } }), script('SHIP'), 'sameAsProduction'],
  ['a host production no longer uses', on(VERCEL), { kind: 'netlify', alias: 'qa' }, 'providerChanged'],
  ['a Pages preview with Worker production', on(WORKERS), { kind: 'cloudflare-pages', branch: 'qa' }, 'providerChanged'],
  ['a Worker form with Pages production', on(PAGES), { kind: 'cloudflare-worker', project: 'x' }, 'providerChanged'],
];

for (const [name, config, target, key] of PRODUCTION_PLACES) {
  test(`a destination naming ${name} is refused`, () => {
    assert.equal(refusal(config, destination('one', target), []), key);
  });
}

test('production’s address cannot be a destination’s, and no two destinations share an address', () => {
  const published = on(VERCEL, { publishedSite: { hosting: VERCEL, source: 'manual', url: 'https://example.com' } });
  const claimed = destination('one', { kind: 'vercel' }, { siteUrl: 'https://example.com' });
  assert.equal(refusal(published, claimed, []), 'productionAddress');
  const custom = on(NONE, { customHosting: { deploy: 'github', siteUrl: 'https://live.example.com' } });
  assert.equal(refusal(custom, destination('one', branch('qa'), { siteUrl: 'https://live.example.com' }), []), 'productionAddress');
  const first = destination('one', { kind: 'vercel' }, { siteUrl: 'https://qa.example.com' });
  const second = destination('two', branch('qa'), { siteUrl: 'https://qa.example.com' });
  assert.equal(refusal(on(VERCEL), first, [second]), 'shared');
});

test('no destination’s build or hook may run production’s deploy or another destination’s', () => {
  const ship = on(NONE, { customHosting: { deploy: 'script', script: 'ship' } });
  for (const extra of [{ beforePublish: ['ship'] }, { afterPublish: ['deploy'] }, { buildScript: 'deploy:production' }]) {
    assert.equal(refusal(ship, destination('one', script('deploy:preview'), extra), []), 'productionScript');
  }
  // Where the host builds, the saved build script never runs, so it is not held against the destination.
  assert.equal(refusal(ship, destination('one', branch('qa'), { buildScript: 'ship' }), []), undefined);
  const other = destination('two', script('deploy:qa'));
  for (const extra of [{ beforePublish: ['deploy:qa'] }, { afterPublish: ['DEPLOY:QA'] }]) {
    assert.equal(refusal(on(NONE), destination('one', branch('client'), extra), [other]), 'shared');
  }
});

test('projects are one identity however they are spelled, and preview names are what a host would make', () => {
  assert.equal(sameProject(VERCEL, { provider: 'vercel', organizationId: 'x', projectId: 'PRJ_LIVE' }), true);
  assert.equal(sameProject(WORKERS, { provider: 'cloudflare-workers', accountId: 'b', project: 'site' }), false);
  assert.equal(sameProject(NONE, NONE), false, 'Two projects without a host are not one project');
  assert.equal(previewName('Feature/Login_2'), 'feature-login-2');
  assert.equal(previewName(`${'a'.repeat(27)}-b`), 'a'.repeat(27));
});
