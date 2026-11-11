// Goal: the share and publish contract (shared/properties/appPublish.ts) holds
// to docs/apps.md. A share is private unless chosen otherwise; a repository name
// keeps to GitHub's rules; the marketplace checklist blocks a repository that is
// private, untagged, unreleased, not MIT licensed or not scanned clean; a
// submission needs the terms accepted and sends only the release address and
// `accept`; the Worker's replies read as submitted, updated, refused (its
// message as is) or unavailable; the pre-submission check reads as ready,
// refused or unavailable. The marketplace index accepts `license: "MIT"` only,
// and roles gate `marketplace:publish` and `apps:share` like the other features.
// Method: the pure functions over known-good values and one bad field at a time.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_SHARE_VISIBILITIES,
  DEFAULT_APP_SHARE_VISIBILITY,
  MARKETPLACE_TERMS,
  marketplaceCheckAddress,
  marketplaceReadiness,
  mitLicenseText,
  parseAppShareRequest,
  parseAppVisibilityOutcome,
  parseMarketplaceSubmission,
  precheckOutcome,
  repositoryNameProblem,
  shareStepStates,
  submissionBody,
  submissionOutcome,
  suggestedRepositoryName,
} from '#dist/shared/properties/appPublish.js';
import { MARKETPLACE_CHECK_URL, MARKETPLACE_SUBMISSIONS_URL, parseMarketplaceApp } from '#dist/shared/properties/appMarketplace.js';
import { ADMIN_VIEW, CLIENT_ROLE_ID, DEFAULT_PROJECT_ROLES, can, parseProjectRoles, roleViewOf } from '#dist/shared/properties/projectRoles.js';

const STATUS = {
  owner: 'octocat',
  repository: 'heat-map',
  private: false,
  topic: true,
  license: 'MIT',
  release: { tag: 'v1.0.0', asset: 'heat-map.zip' },
  holder: 'The Octocat',
};

test('a share is private by default, and private is offered first', () => {
  assert.equal(DEFAULT_APP_SHARE_VISIBILITY, 'private');
  assert.deepEqual(APP_SHARE_VISIBILITIES, ['private', 'public']);
  const request = { id: 'heat-map', account: 'octocat', owner: 'acme', ownerKind: 'organization', name: 'heat-map', visibility: 'private' };
  assert.deepEqual(parseAppShareRequest(request), request);
  assert.throws(() => parseAppShareRequest({ ...request, visibility: 'internal' }), /private or public/);
  assert.throws(() => parseAppShareRequest({ ...request, name: 'bad name' }), /letters, digits/);
});

test('repository names keep to GitHub’s rules', () => {
  assert.equal(repositoryNameProblem('heat-map'), undefined);
  assert.equal(repositoryNameProblem('heat.map_2'), undefined);
  assert.match(repositoryNameProblem('') ?? '', /Name the repository/);
  assert.match(repositoryNameProblem('a b') ?? '', /letters, digits/);
  assert.match(repositoryNameProblem('..') ?? '', /reserved/);
  assert.match(repositoryNameProblem('app.git') ?? '', /\.git/);
  assert.match(repositoryNameProblem('x'.repeat(101)) ?? '', /at most 100/);
  assert.equal(suggestedRepositoryName('heat-map'), 'heat-map');
  assert.equal(suggestedRepositoryName('tools.git'), 'tools-app');
});

test('the step states move done, running, pending, and mark the failed step', () => {
  assert.deepEqual(
    shareStepStates('commit-files', { failed: false }).map((state) => state.status),
    ['done', 'done', 'running', 'pending'],
  );
  assert.deepEqual(
    shareStepStates('add-topic', { failed: true }).map((state) => state.status),
    ['done', 'failed', 'pending', 'pending'],
  );
  assert.ok(shareStepStates('finished', { failed: false }).every((state) => state.status === 'done'));
});

test('the marketplace blocks a repository that is not MIT licensed, and every other unmet requirement', () => {
  assert.equal(marketplaceReadiness(STATUS, { clean: true }).ready, true);
  const failing = (status: Record<string, unknown>, scan: { readonly clean: boolean }) =>
    marketplaceReadiness({ ...STATUS, ...status }, scan)
      .checks.filter((entry) => !entry.passed)
      .map((entry) => entry.check);
  assert.deepEqual(failing({ license: 'Apache-2.0' }, { clean: true }), ['license']);
  assert.deepEqual(failing({ license: undefined }, { clean: true }), ['license']);
  assert.deepEqual(failing({ private: true }, { clean: true }), ['public']);
  assert.deepEqual(failing({ topic: false }, { clean: true }), ['topic']);
  assert.deepEqual(failing({ release: undefined }, { clean: true }), ['release']);
  assert.deepEqual(failing({}, { clean: false }), ['scan']);
});

test('the MIT license names the year and holder', () => {
  const text = mitLicenseText(2026, 'The Octocat');
  assert.ok(text.startsWith('MIT License\n\nCopyright (c) 2026 The Octocat\n'));
  assert.ok(text.includes('THE SOFTWARE IS PROVIDED "AS IS"'));
});

test('a submission requires the terms checkbox and sends the release address with accept', () => {
  assert.throws(() => parseMarketplaceSubmission({ owner: 'octocat', repository: 'heat-map', account: 'octocat' }), /Accept the marketplace terms/);
  assert.throws(() => parseMarketplaceSubmission({ owner: 'octocat', repository: 'heat-map', account: 'octocat', acceptedTerms: 'yes' }), /Accept/);
  const submission = parseMarketplaceSubmission({ owner: 'octocat', repository: 'heat-map', account: 'octocat', acceptedTerms: true });
  assert.deepEqual(JSON.parse(submissionBody(submission, { tag: 'v1.0.0' })), {
    repository: 'https://github.com/octocat/heat-map/releases/tag/v1.0.0',
    accept: true,
  });
  assert.match(MARKETPLACE_TERMS, /^I confirm this app is open source under the MIT license, I own the rights to publish it/);
  assert.equal(MARKETPLACE_SUBMISSIONS_URL, 'https://stacki.build/api/marketplace/submissions');
});

test('the Worker’s replies read as submitted, updated, refused or unavailable', () => {
  assert.deepEqual(submissionOutcome(201, '{"ok":true,"id":7,"status":"pending"}'), { kind: 'submitted', id: 7, updated: false });
  assert.deepEqual(submissionOutcome(200, '{"ok":true,"id":7,"status":"pending","updated":true}'), { kind: 'submitted', id: 7, updated: true });
  assert.deepEqual(submissionOutcome(400, '{"ok":false,"code":"license","message":"The app must use the MIT license"}'), {
    kind: 'refused',
    code: 'license',
    message: 'The app must use the MIT license',
  });
  assert.equal(submissionOutcome(429, '{"ok":false,"code":"rate-limited","message":"Try again in an hour."}').kind, 'refused');
  assert.equal(submissionOutcome(401, '{"ok":false,"code":"github-token","message":"Sign in again."}').kind, 'refused');
  assert.equal(submissionOutcome(503, '{"ok":false,"code":"unconfigured","message":"Not set up"}').kind, 'unavailable');
  assert.equal(submissionOutcome(404, '<html>Not found</html>').kind, 'unavailable');
  assert.equal(submissionOutcome(502, '').kind, 'unavailable');
});

test('the pre-submission check reads as ready, refused or unavailable', () => {
  assert.equal(
    marketplaceCheckAddress(MARKETPLACE_CHECK_URL, 'octocat', 'heat-map'),
    'https://stacki.build/api/marketplace/check?repository=octocat%2Fheat-map',
  );
  assert.deepEqual(precheckOutcome(200, '{"ok":true,"app":{"id":"heat-map","name":"Heat map","version":"1.0.0","iconPresent":true}}'), {
    kind: 'ready',
    id: 'heat-map',
    name: 'Heat map',
    version: '1.0.0',
    iconPresent: true,
  });
  assert.deepEqual(precheckOutcome(400, '{"ok":false,"code":"license","message":"No MIT license"}'), {
    kind: 'refused',
    code: 'license',
    message: 'No MIT license',
  });
  assert.equal(precheckOutcome(503, '{"ok":false,"code":"unconfigured","message":"Soon"}').kind, 'unavailable');
  assert.equal(precheckOutcome(200, '{"ok":true,"app":{"id":"Bad Id"}}').kind, 'unavailable');
});

test('a visibility refusal says why and links to the repository settings', () => {
  assert.deepEqual(parseAppVisibilityOutcome({ kind: 'public' }), { kind: 'public' });
  const refusal = { kind: 'forbidden', reason: 'admin', settingsURL: 'https://github.com/acme/tool/settings' };
  assert.deepEqual(parseAppVisibilityOutcome(refusal), refusal);
  assert.throws(() => parseAppVisibilityOutcome({ ...refusal, settingsURL: 'https://example.test/settings' }), /settings on GitHub/);
  assert.throws(() => parseAppVisibilityOutcome({ ...refusal, reason: 'other' }), /says why/);
});

test('the index accepts license "MIT" only', () => {
  const entry = {
    id: 'heat-map',
    name: 'Heat map',
    description: 'Clicks over the canvas.',
    author: 'octocat',
    icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
    categories: [],
    source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' },
    versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: 'a'.repeat(64) }],
  };
  assert.equal(parseMarketplaceApp(entry).license, undefined);
  assert.equal(parseMarketplaceApp({ ...entry, license: 'MIT' }).license, 'MIT');
  assert.throws(() => parseMarketplaceApp({ ...entry, license: 'GPL-3.0' }), /licensed MIT/);
  assert.throws(() => parseMarketplaceApp({ ...entry, license: 'mit' }), /licensed MIT/);
});

test('admin may share and publish; client may not, and a grant needs its panel', () => {
  assert.equal(can(ADMIN_VIEW, 'marketplace:publish'), true);
  assert.equal(can(ADMIN_VIEW, 'apps:share'), true);
  const client = roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID);
  assert.equal(can(client, 'marketplace:publish'), false);
  assert.equal(can(client, 'apps:share'), false);
  const custom = (access: readonly string[]) =>
    roleViewOf(
      parseProjectRoles({
        version: 1,
        roles: [
          { id: 'admin', members: ['octocat'] },
          { id: 'helper', name: 'Helper', access },
        ],
      }),
      'helper',
    );
  assert.equal(can(custom(['apps:share']), 'apps:share'), false, 'Sharing needs the Apps panel');
  assert.equal(can(custom(['panel:apps', 'apps:share']), 'apps:share'), true);
  assert.equal(can(custom(['panel:apps', 'marketplace:publish']), 'marketplace:publish'), false, 'Publishing needs the marketplace');
  assert.equal(can(custom(['panel:apps', 'marketplace:view', 'marketplace:publish']), 'marketplace:publish'), true);
});
