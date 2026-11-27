// Goal: the Custom host, staging and deploy link shapes accept what the app writes and refuse everything else, so a
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
  parseDestinationsSource,
  parsePublishDestinations,
  parsePublishRequestTarget,
  stagingConflict,
  suggestStaging,
} from '#dist/shared/properties/publishDestinations.js';
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
import { findMissingPublishField, findMissingStagingField } from '#dist/shared/properties/publishMissing.js';

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
  assert.deepEqual(parseCustomPublishRequest({ action: 'saveLink', destination: 'staging', link: LINK }).action, 'saveLink');
  for (const bad of [
    { action: 'send' },
    { action: 'saveLink', link: LINK },
    { action: 'removeLink', destination: 'preview' },
    { action: 'saveLink', destination: 'staging', link: 'x'.repeat(3000) },
  ]) {
    assert.ok(!refusal(() => parseCustomPublishRequest(bad)).includes(SECRET));
  }
  const ready = { kind: 'ready', scripts: ['build'], environments: [], links: { production: { kind: 'none' }, staging: { kind: 'none' } } };
  assert.deepEqual(parseCustomPublishResult(ready), ready);
  refusal(() => parseCustomPublishResult({ ...ready, scripts: ['rm -rf /'] }));
  refusal(() => parseCustomPublishResult({ ...ready, links: { production: { kind: 'none' } } }));
});

test('only script names that settings can hold are offered, and never their commands', () => {
  const names = packageScriptNames(JSON.stringify({ scripts: { build: 'astro build', 'deploy:staging': 'x', 'bad name': 'x', 'a/b': 'x', n: 4 } }));
  assert.deepEqual(names, ['build', 'deploy:staging']);
  assert.deepEqual(packageScriptNames('{}'), []);
});

const STAGING = { id: 'staging', target: { kind: 'vercel' }, buildScript: 'build', beforePublish: [], afterPublish: [] };

test('a staging destination parses, and an absent file has none', () => {
  assert.deepEqual(parsePublishDestinations({ version: 1, destinations: [STAGING] }).destinations, [STAGING]);
  assert.deepEqual(parseDestinationsSource(undefined).destinations, []);
});

for (const [name, document] of [
  ['another version', { version: 2, destinations: [] }],
  ['an unknown key', { version: 1, destinations: [], link: LINK }],
  ['a destination twice', { version: 1, destinations: [STAGING, STAGING] }],
  ['an unknown destination', { version: 1, destinations: [{ ...STAGING, id: 'production' }] }],
  ['too many destinations', { version: 1, destinations: Array.from({ length: 5 }, () => STAGING) }],
  ['a link in a destination', { version: 1, destinations: [{ ...STAGING, link: LINK }] }],
  ['a link in a target', { version: 1, destinations: [{ ...STAGING, target: { kind: 'link', branch: 'staging', link: LINK } }] }],
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
  refusal(() => parseDestinationsSource(' '.repeat(16_385)));
});

test('staging is something a publish can ask for, never a default 1.4.21 would meet', () => {
  assert.equal(parsePublishRequestTarget('staging'), 'staging');
  refusal(() => parsePublishTarget('staging'));
  refusal(() => parsePublishRequestTarget('preview'));
});

test('each provider’s suggested staging differs from production', () => {
  const hostings = [
    { provider: 'cloudflare-workers', accountId: 'a', project: 'site' },
    { provider: 'cloudflare', accountId: 'a', project: 'site', branch: 'staging', directory: 'dist' },
    { provider: 'vercel', organizationId: 'a', projectId: 'b' },
    { provider: 'netlify', siteId: 'a' },
    { provider: 'none' },
  ] as const;
  for (const hosting of hostings) {
    const production = { ...DEFAULT_PUBLISH_CONFIG, hosting };
    const suggested = suggestStaging(production, { scripts: ['build'], environments: [] });
    const conflict = stagingConflict(production, suggested);
    // A project whose production branch is already "staging" is the one suggestion that is refused.
    assert.equal(conflict.ok, !(hosting.provider === 'cloudflare'), hosting.provider);
  }
  assert.deepEqual(suggestStaging(DEFAULT_PUBLISH_CONFIG, { scripts: ['deploy', 'deploy:staging'], environments: [] }).target, {
    kind: 'script',
    script: 'deploy:staging',
  });
});

test('Save names the empty field of a custom host or staging', () => {
  const missing = findMissingPublishField({ hosting: { provider: 'none' }, customHosting: { deploy: 'script', script: '' }, buildScript: 'build' });
  assert.equal(missing.ok ? '' : missing.error.field, 'deployScript');
  const staging = findMissingStagingField({ target: { kind: 'github-branch', branch: ' ' } });
  assert.equal(staging.ok ? '' : staging.error.field, 'stagingBranch');
});

test('publish states and availability carry staging and refuse what is not theirs', () => {
  assert.deepEqual(parseDesktopPublishState({ kind: 'done', github: true, hosting: false, handoff: 'github', destination: 'staging' }), {
    kind: 'done',
    github: true,
    hosting: false,
    handoff: 'github',
    destination: 'staging',
  });
  refusal(() => parseDesktopPublishState({ kind: 'done', github: true, hosting: false, destination: 'preview' }));
  refusal(() => parseDesktopPublishState({ kind: 'done', github: true, hosting: false, handoff: 'live' }));
  const availability = parsePublishAvailability({
    github: 'current',
    hosting: 'pending',
    staging: { state: 'current', publishedAtMs: 5, url: 'https://s.example.com' },
  });
  assert.equal(availability.staging?.state, 'current');
  refusal(() => parsePublishAvailability({ github: 'current', hosting: 'pending', staging: { state: 'unconfigured' } }));
  refusal(() => parsePublishAvailability({ github: 'current', hosting: 'pending', staging: { state: 'current', url: 'javascript:alert(1)' } }));
});

test('the remembered availability keeps staging apart from production', () => {
  const first = reducePublishAvailability(EMPTY_PUBLISH_AVAILABILITY_MEMORY, {
    kind: 'checked',
    result: { github: 'current', hosting: 'current', hostingPublishedAtMs: 1, staging: { state: 'current', publishedAtMs: 2 } },
  });
  assert.deepEqual(shownPublishAvailability(first).staging, { state: 'current', publishedAtMs: 2 });
  const unjudged = reducePublishAvailability(first, { kind: 'checked', result: { github: 'current', hosting: 'current', staging: { state: 'unknown' } } });
  assert.equal(shownPublishAvailability(unjudged).staging?.state, 'current');
  const removed = reducePublishAvailability(first, { kind: 'checked', result: { github: 'current', hosting: 'current' } });
  assert.equal(shownPublishAvailability(removed).staging, undefined);
});
