// Goal: the Custom host, destination and deploy link shapes accept what the app writes and refuse everything else, so a
// deploy link cannot pass as a tracked setting, a command cannot pass as a script name, and a settings file from
// this version keeps Stacki 1.4.21 publishing to GitHub only.
// Method: parse known-good documents, then each known-bad shape, asserting a refusal never repeats the input.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_PUBLISH_CONFIG,
  deploysFromStacki,
  parsePublishConfig,
  parsePublishTarget,
  publishDefaultTarget,
  withHosting,
} from '#dist/shared/properties/publishConfig.js';
import {
  DESTINATION_LIMITS,
  destinationLabelProblem,
  nextDestinationLabel,
  parseDestinationsSource,
  parsePublishDestinations,
  parsePublishRequestTarget,
  requestedDestination,
} from '#dist/shared/properties/publishDestinations.js';
import { destinationConflict } from '#dist/shared/properties/publishDestinationConflicts.js';
import { suggestDestination } from '#dist/shared/properties/publishDestinationDefaults.js';
import {
  maskDeployLink,
  packageScriptNames,
  parseCustomPublishRequest,
  parseCustomPublishResult,
  parseDeployLink,
  parseDeployLinkState,
} from '#dist/shared/properties/publishDeployLink.js';
import { parseDesktopPublishState, parsePublishAvailability } from '#dist/shared/properties/publishState.js';
import { EMPTY_PUBLISH_AVAILABILITY_MEMORY, reducePublishAvailability, shownPublishAvailability } from '#dist/shared/properties/publishAvailabilityMemory.js';
import { findMissingPublishField, findMissingDestinationField } from '#dist/shared/properties/publishMissing.js';

const SECRET = 'SECRETtoken99';
const LINK = `https://hooks.example.com/build/${SECRET}`;

function refusal(work: () => unknown): string {
  try {
    work();
  } catch (error: unknown) {
    return String(error);
  }
  assert.fail('Expected a refusal');
}

test('a custom host keeps hosting at none, the shape Stacki 1.4.21 reads as GitHub only', () => {
  const config = parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, customHosting: { deploy: 'script', script: 'ship', hostName: ' My server ' } });
  assert.deepEqual(config.hosting, { provider: 'none' });
  assert.deepEqual(config.customHosting, { deploy: 'script', script: 'ship', hostName: 'My server' });
  assert.equal(deploysFromStacki(config), true);
  assert.equal(withHosting(config, { provider: 'netlify', siteId: 'a' }).customHosting, undefined);
  // 1.4.21 knows only these targets and providers; nothing new is written where it would refuse it.
  assert.equal(parsePublishTarget(config.defaultTarget), 'all');
});

test('a project without a custom host is written exactly as before', () => {
  assert.deepEqual(parsePublishConfig(DEFAULT_PUBLISH_CONFIG), DEFAULT_PUBLISH_CONFIG);
});

test('a host that deploys from GitHub makes GitHub the only thing Publish does', () => {
  const config = parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, defaultTarget: 'hosting', customHosting: { deploy: 'github' } });
  assert.equal(publishDefaultTarget(config), 'github');
  assert.equal(deploysFromStacki(config), false);
});

for (const [name, customHosting] of [
  ['an unknown way to deploy', { deploy: 'ftp' }],
  ['a script with no name', { deploy: 'script' }],
  ['a command as a script name', { deploy: 'script', script: 'npm run ship && curl evil' }],
  ['a link saved in the file', { deploy: 'link', link: LINK }],
  ['a link under any other key', { deploy: 'github', [LINK]: true }],
  ['a link as the host name', { deploy: 'link', hostName: LINK }],
  ['a link as the site address', { deploy: 'link', siteUrl: LINK }],
  ['a script on a deploy that runs none', { deploy: 'github', script: 'ship' }],
  ['a long host name', { deploy: 'github', hostName: 'x'.repeat(61) }],
  ['a site address over http', { deploy: 'github', siteUrl: 'http://example.com' }],
] as const) {
  test(`custom hosting refuses ${name} without repeating it`, () => {
    assert.ok(!refusal(() => parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, customHosting })).includes(SECRET));
  });
}

test('a file naming a provider and a custom host is refused, never guessed', () => {
  refusal(() => parsePublishConfig({ ...DEFAULT_PUBLISH_CONFIG, hosting: { provider: 'netlify', siteId: 'a' }, customHosting: { deploy: 'github' } }));
});

test('a deploy link must be a whole https address', () => {
  assert.deepEqual(parseDeployLink(`  ${LINK}  `), { ok: true, value: LINK });
  for (const bad of [
    `http://hooks.example.com/${SECRET}`,
    `ftp://hooks.example.com/${SECRET}`,
    `hooks.example.com/${SECRET}`,
    `https://user:${SECRET}@hooks.example.com/a`,
    `https://hooks.example.com/a#${SECRET}`,
    `https://hooks.example.com/${SECRET} extra`,
    `https://hooks.example.com/\n${SECRET}`,
    `https://hooks.example.com\\@evil.example/${SECRET}`,
    `https://${SECRET}:99999999`,
    `https://hooks.example.com/${'a'.repeat(2048)}`,
    'https://',
    '',
    42,
  ]) {
    const result = parseDeployLink(bad);
    assert.equal(result.ok, false, String(bad));
    assert.ok(!JSON.stringify(result).includes(SECRET));
  }
});

test('only the host of a saved link is ever shown, and a state carrying more is refused', () => {
  assert.equal(maskDeployLink(`${LINK}?token=${SECRET}`), 'https://hooks.example.com/••••••••');
  refusal(() => parseDeployLinkState({ kind: 'saved', mask: LINK }));
  refusal(() => parseDeployLinkState({ kind: 'saved', mask: `https://hooks.example.com/${SECRET}/••••••••` }));
  refusal(() => parseDeployLinkState({ kind: 'other' }));
});

test('custom publishing requests and results are bounded and typed', () => {
  assert.deepEqual(parseCustomPublishRequest({ action: 'saveLink', destination: 'd-1a2b', link: LINK }).action, 'saveLink');
  assert.deepEqual(parseCustomPublishRequest({ action: 'removeLink', destination: 'production' }), { action: 'removeLink', destination: 'production' });
  for (const bad of [
    { action: 'send' },
    { action: 'saveLink', link: LINK },
    { action: 'removeLink', destination: '../production' },
    { action: 'removeLink', destination: 'all' },
    { action: 'saveLink', destination: 'staging', link: 'x'.repeat(3000) },
  ]) {
    assert.ok(!refusal(() => parseCustomPublishRequest(bad)).includes(SECRET));
  }
  const links = { production: { kind: 'none' }, destinations: { staging: { kind: 'none' } }, unsaved: { kind: 'none' } };
  const ready = { kind: 'ready', scripts: ['build'], environments: [], links };
  assert.deepEqual(parseCustomPublishResult(ready), ready);
  refusal(() => parseCustomPublishResult({ ...ready, scripts: ['rm -rf /'] }));
  refusal(() => parseCustomPublishResult({ ...ready, links: { production: { kind: 'none' } } }));
  const many = Object.fromEntries(Array.from({ length: DESTINATION_LIMITS.destinationsMax + 1 }, (_, index) => [`d${index}`, { kind: 'none' }]));
  refusal(() => parseCustomPublishResult({ ...ready, links: { ...links, destinations: many } }));
  refusal(() => parseCustomPublishResult({ ...ready, links: { ...links, destinations: { '../x': { kind: 'none' } } } }));
});

test('only script names that settings can hold are offered, and never their commands', () => {
  const names = packageScriptNames(JSON.stringify({ scripts: { build: 'astro build', 'deploy:staging': 'x', 'bad name': 'x', 'a/b': 'x', n: 4 } }));
  assert.deepEqual(names, ['build', 'deploy:staging']);
  assert.deepEqual(packageScriptNames('{}'), []);
});

const STAGING = { id: 'staging', label: 'Staging', target: { kind: 'vercel' }, buildScript: 'build', beforePublish: [], afterPublish: [] };
const numbered = (count: number) => Array.from({ length: count }, (_, index) => ({ ...STAGING, id: `d${index}`, label: `Review ${index}` }));

test('destinations parse in their order, up to the limit, and an absent file has none', () => {
  assert.deepEqual(parsePublishDestinations({ version: 1, destinations: [STAGING] }).destinations, [STAGING]);
  const ten = numbered(DESTINATION_LIMITS.destinationsMax);
  assert.deepEqual(parsePublishDestinations({ version: 1, destinations: ten }).destinations, ten);
  assert.deepEqual(parseDestinationsSource(undefined).destinations, []);
});

test('an own host keeps its account and project, whichever provider it is', () => {
  for (const hosting of [
    { provider: 'cloudflare-workers', accountId: 'a', project: 'review' },
    { provider: 'cloudflare', accountId: 'a', project: 'review', branch: 'main', directory: 'dist' },
    { provider: 'vercel', organizationId: 'team', projectId: 'prj' },
    { provider: 'netlify', siteId: 'site' },
  ]) {
    const saved = { ...STAGING, target: { kind: 'host', hosting } };
    assert.deepEqual(parsePublishDestinations({ version: 1, destinations: [saved] }).destinations, [saved]);
  }
});

test('a file written by the preview build is read without losing anything', () => {
  const preview = {
    id: 'staging',
    name: 'Client review',
    target: { kind: 'link', branch: 'staging' },
    buildScript: 'build:staging',
    beforePublish: ['a'],
    afterPublish: ['b'],
    siteUrl: 'https://staging.example.com',
  };
  const { name, ...rest } = preview;
  assert.deepEqual(parsePublishDestinations({ version: 1, destinations: [preview] }).destinations, [{ ...rest, label: name }]);
  assert.equal(parsePublishDestinations({ version: 1, destinations: [rest] }).destinations[0]?.label, 'Staging');
  // The preview allowed a name that now reads as production's own row.
  assert.equal(parsePublishDestinations({ version: 1, destinations: [{ ...rest, name: 'Production' }] }).destinations[0]?.label, 'Staging');
  // What is read can be saved and read again, and is then the new shape.
  const upgraded = parsePublishDestinations({ version: 1, destinations: [preview] });
  assert.deepEqual(parseDestinationsSource(JSON.stringify(upgraded)), upgraded);
  assert.ok(!JSON.stringify(upgraded).includes('"name"'));
});

for (const [name, document] of [
  ['another version', { version: 2, destinations: [] }],
  ['an unknown key', { version: 1, destinations: [], link: LINK }],
  ['one id twice', { version: 1, destinations: [STAGING, { ...STAGING, label: 'Other' }] }],
  ['one label twice', { version: 1, destinations: [STAGING, { ...STAGING, id: 'other' }] }],
  ['labels differing only in case', { version: 1, destinations: [STAGING, { ...STAGING, id: 'other', label: 'STAGING' }] }],
  [
    'labels differing only in spacing',
    {
      version: 1,
      destinations: [
        { ...STAGING, label: 'Client review' },
        { ...STAGING, id: 'b', label: 'Client   review' },
      ],
    },
  ],
  ['labels differing only in an invisible character', { version: 1, destinations: [STAGING, { ...STAGING, id: 'other', label: 'Stag\u200bing' }] }],
  ['labels differing only in width', { version: 1, destinations: [STAGING, { ...STAGING, id: 'other', label: 'Ｓtaging' }] }],
  ['a blank label', { version: 1, destinations: [{ ...STAGING, label: '   ' }] }],
  ['an invisible label', { version: 1, destinations: [{ ...STAGING, label: '\u200b\u200b' }] }],
  ['no label', { version: 1, destinations: [{ ...STAGING, id: 'other', label: undefined }] }],
  ['a long label', { version: 1, destinations: [{ ...STAGING, label: 'x'.repeat(61) }] }],
  ['a link as a label', { version: 1, destinations: [{ ...STAGING, label: LINK }] }],
  ['a label that reverses text', { version: 1, destinations: [{ ...STAGING, label: 'ab\u202ecd' }] }],
  ['a label that reads as production', { version: 1, destinations: [{ ...STAGING, label: ' PRODUCTION ' }] }],
  ['a label that reads as GitHub', { version: 1, destinations: [{ ...STAGING, label: 'GitHub' }] }],
  ['a name beside a label', { version: 1, destinations: [{ ...STAGING, name: 'Two' }] }],
  ['a name on a new destination', { version: 1, destinations: [{ ...STAGING, id: 'd-1', label: undefined, name: 'Two' }] }],
  ['the id production', { version: 1, destinations: [{ ...STAGING, id: 'production' }] }],
  ['the id all', { version: 1, destinations: [{ ...STAGING, id: 'all' }] }],
  ['an id that is a path', { version: 1, destinations: [{ ...STAGING, id: '../../stacki-deployment' }] }],
  ['an id with capitals', { version: 1, destinations: [{ ...STAGING, id: 'Staging' }] }],
  ['a long id', { version: 1, destinations: [{ ...STAGING, id: 'a'.repeat(41) }] }],
  ['one destination too many', { version: 1, destinations: numbered(DESTINATION_LIMITS.destinationsMax + 1) }],
  ['a link in a destination', { version: 1, destinations: [{ ...STAGING, link: LINK }] }],
  ['a link in a target', { version: 1, destinations: [{ ...STAGING, target: { kind: 'link', branch: 'staging', link: LINK } }] }],
  [
    'a link in an own host',
    { version: 1, destinations: [{ ...STAGING, target: { kind: 'host', hosting: { provider: 'netlify', siteId: 'a', link: LINK } } }] },
  ],
  ['an own host with no provider', { version: 1, destinations: [{ ...STAGING, target: { kind: 'host', hosting: { provider: 'none' } } }] }],
  [
    'an own Worker name that is an option',
    { version: 1, destinations: [{ ...STAGING, target: { kind: 'host', hosting: { provider: 'cloudflare-workers', accountId: 'a', project: 'A_b' } } }] },
  ],
  [
    'an own output folder outside the site',
    {
      version: 1,
      destinations: [
        { ...STAGING, target: { kind: 'host', hosting: { provider: 'cloudflare', accountId: 'a', project: 'p', branch: 'main', directory: '../..' } } },
      ],
    },
  ],
  ['a branch that forces', { version: 1, destinations: [{ ...STAGING, target: { kind: 'github-branch', branch: '+main' } }] }],
  ['an environment that is an option', { version: 1, destinations: [{ ...STAGING, target: { kind: 'cloudflare-environment', environment: '--name' } }] }],
  ['a Worker name that is an option', { version: 1, destinations: [{ ...STAGING, target: { kind: 'cloudflare-worker', project: '-x' } }] }],
  ['a long Netlify alias', { version: 1, destinations: [{ ...STAGING, target: { kind: 'netlify', alias: 'a'.repeat(38) } }] }],
  ['a command as a hook', { version: 1, destinations: [{ ...STAGING, beforePublish: ['a && b'] }] }],
  ['nine hooks', { version: 1, destinations: [{ ...STAGING, afterPublish: Array.from({ length: 9 }, () => 'a') }] }],
] as const) {
  test(`publish destinations refuse ${name}`, () => {
    assert.ok(!refusal(() => parsePublishDestinations(document)).includes(SECRET));
  });
}

test('publish destinations are bounded in size', () => {
  refusal(() => parseDestinationsSource(' '.repeat(DESTINATION_LIMITS.sourceCharsMax + 1)));
});

test('the first default label is Staging, later ones are distinct, and a form can say why a label is refused', () => {
  assert.equal(nextDestinationLabel('Staging', []), 'Staging');
  assert.equal(nextDestinationLabel('Staging', ['Staging']), 'Staging 2');
  assert.equal(nextDestinationLabel('Staging', ['staging ', 'STAGING 2']), 'Staging 3');
  assert.equal(nextDestinationLabel('Staging', ['QA']), 'Staging');
  assert.equal(destinationLabelProblem(' ', []), 'blank');
  assert.equal(destinationLabelProblem('a/b', []), 'invalid');
  assert.equal(destinationLabelProblem('Production', []), 'reserved');
  assert.equal(destinationLabelProblem('qa', ['QA']), 'taken');
  assert.equal(destinationLabelProblem('Révision client 🎨', ['QA']), undefined);
});

test('a publish request names production’s targets or one destination, and nothing else', () => {
  assert.equal(parsePublishRequestTarget('destination:d-1a2b'), 'destination:d-1a2b');
  assert.equal(requestedDestination('destination:staging'), 'staging');
  assert.equal(requestedDestination('hosting'), undefined);
  refusal(() => parsePublishTarget('destination:staging'));
  for (const bad of [
    'staging',
    'destination:',
    'destination:production',
    'destination:../x',
    'destination:a b',
    `destination:${'a'.repeat(41)}`,
    ['destination:a'],
    7,
  ]) {
    refusal(() => parsePublishRequestTarget(bad));
  }
});

const PROVIDERS = [
  { provider: 'cloudflare-workers', accountId: 'a', project: 'site' },
  { provider: 'cloudflare', accountId: 'a', project: 'site', branch: 'main', directory: 'dist' },
  { provider: 'vercel', organizationId: 'a', projectId: 'b' },
  { provider: 'netlify', siteId: 'a' },
  { provider: 'none' },
] as const;

test('ten suggested destinations in a row never publish to one another’s place, whatever production is', () => {
  for (const hosting of PROVIDERS) {
    const production = { ...DEFAULT_PUBLISH_CONFIG, hosting };
    const detected = { scripts: ['build', 'deploy:staging'], environments: [{ name: 'staging', worker: 'site-staging' }] };
    const added = Array.from({ length: DESTINATION_LIMITS.destinationsMax }).reduce<ReturnType<typeof suggestDestination>[]>((done) => {
      const label = nextDestinationLabel(
        'Staging',
        done.map((entry) => entry.label),
      );
      return [...done, suggestDestination(production, detected, { id: `d${done.length}`, label }, done)];
    }, []);
    const saved = parsePublishDestinations({ version: 1, destinations: added }).destinations;
    for (const destination of saved) {
      const conflict = destinationConflict(production, destination, saved);
      assert.ok(conflict.ok, `${hosting.provider}: ${JSON.stringify(destination)}`);
    }
  }
});

test('a label in any language still suggests a branch that can be pushed', () => {
  const suggested = suggestDestination(DEFAULT_PUBLISH_CONFIG, { scripts: [], environments: [] }, { id: 'd1', label: 'ステージング' }, []);
  assert.deepEqual(suggested.target, { kind: 'github-branch', branch: 'staging' });
  const named = suggestDestination(DEFAULT_PUBLISH_CONFIG, { scripts: ['deploy', 'deploy:staging'], environments: [] }, { id: 'd1', label: 'Staging' }, []);
  assert.deepEqual(named.target, { kind: 'script', script: 'deploy:staging' });
});

test('Save names the empty field of a custom host or a destination', () => {
  const missing = findMissingPublishField({ hosting: { provider: 'none' }, customHosting: { deploy: 'script', script: '' }, buildScript: 'build' });
  assert.equal(missing.ok ? '' : missing.error.field, 'deployScript');
  for (const [target, field] of [
    [{ kind: 'github-branch', branch: ' ' }, 'branch'],
    [{ kind: 'host', hosting: { provider: 'cloudflare-workers', accountId: '', project: '' } }, 'cloudflareAccount'],
    [{ kind: 'host', hosting: { provider: 'vercel', organizationId: '', projectId: '' } }, 'hostingProject'],
    [{ kind: 'host', hosting: { provider: 'netlify', siteId: '' } }, 'hostingProject'],
  ] as const) {
    const result = findMissingDestinationField({ target });
    assert.equal(result.ok ? '' : result.error.field, field);
  }
});

test('publish states and availability carry each destination and refuse what is not theirs', () => {
  const done = { kind: 'done', github: true, hosting: false, handoff: 'github', destination: { id: 'd-1', label: 'QA' } };
  assert.deepEqual(parseDesktopPublishState(done), done);
  refusal(() => parseDesktopPublishState({ ...done, destination: 'staging' }));
  refusal(() => parseDesktopPublishState({ ...done, destination: { id: 'production', label: 'QA' } }));
  refusal(() => parseDesktopPublishState({ ...done, destination: { id: 'd-1', label: '' } }));
  refusal(() => parseDesktopPublishState({ ...done, handoff: 'live' }));
  const status = { id: 'd-1', state: 'current', publishedAtMs: 5, url: 'https://s.example.com' };
  const base = { github: 'current', hosting: 'pending' };
  assert.equal(parsePublishAvailability({ ...base, destinations: [status] }).destinations?.[0]?.state, 'current');
  refusal(() => parsePublishAvailability({ ...base, destinations: [status, status] }));
  refusal(() => parsePublishAvailability({ ...base, destinations: [{ id: 'd-1', state: 'unconfigured' }] }));
  refusal(() => parsePublishAvailability({ ...base, destinations: [{ ...status, url: 'javascript:alert(1)' }] }));
  const many = Array.from({ length: DESTINATION_LIMITS.destinationsMax + 1 }, (_, index) => ({ id: `d${index}`, state: 'pending' }));
  refusal(() => parsePublishAvailability({ ...base, destinations: many }));
});

test('the remembered availability keeps each destination apart, and a removed one leaves', () => {
  const shown = (memory: Parameters<typeof shownPublishAvailability>[0]) => shownPublishAvailability(memory).destinations;
  const current = [
    { id: 'a', state: 'current', publishedAtMs: 2 },
    { id: 'b', state: 'pending' },
  ] as const;
  const base = { github: 'current', hosting: 'current' } as const;
  const first = reducePublishAvailability(EMPTY_PUBLISH_AVAILABILITY_MEMORY, { kind: 'checked', result: { ...base, destinations: current } });
  const unjudged = reducePublishAvailability(first, {
    kind: 'checked',
    result: {
      ...base,
      destinations: [
        { id: 'a', state: 'unknown' },
        { id: 'c', state: 'unknown' },
      ],
    },
  });
  assert.deepEqual(shown(unjudged), [current[0], { id: 'c', state: 'unknown' }]);
  // One destination turning stale waits for a second check, like production.
  const stale = [{ id: 'a', state: 'pending' }, current[1]] as const;
  const held = reducePublishAvailability(first, { kind: 'checked', result: { ...base, destinations: stale } });
  assert.equal(shown(held)?.[0]?.state, 'current');
  assert.equal(shown(reducePublishAvailability(held, { kind: 'checked', result: { ...base, destinations: stale } }))?.[0]?.state, 'pending');
  assert.equal(shown(reducePublishAvailability(first, { kind: 'checked', result: base })), undefined);
});
