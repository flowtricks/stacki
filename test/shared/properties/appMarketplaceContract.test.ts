// Goal: the marketplace contract (shared/properties/appMarketplace.ts) accepts
// exactly the index the docs describe and refuses every other shape: wrong
// version, missing or duplicate apps, icons outside stacki.build's icon path,
// sources with an account, empty or duplicate version lists, malformed digests,
// and every list or string past its bound. Its questions (newest approved
// version, approved update, search) answer from the parsed index. The lockfile
// side of the marketplace (apps.ts) records `source.kind: 'marketplace'` and the
// per-app auto-update switch, and an older lockfile without the switch reads it
// as off. Projects roles gain `marketplace:view` and `marketplace:install`.
// Method: the example index under test/fixtures/marketplace/ is the known-good
// value; each known-bad variation changes one field of a copy of it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  MARKETPLACE_ICON_PREFIX,
  MARKETPLACE_INDEX_URL,
  MARKETPLACE_LIMITS,
  MARKETPLACE_SUBMIT_URL,
  approvedUpdate,
  approvedVersion,
  latestApprovedVersion,
  marketplaceApp,
  parseMarketplaceIndex,
  parseMarketplaceIndexSource,
  searchMarketplace,
} from '#dist/shared/properties/appMarketplace.js';
import { parseAppUpdateOutcome, parseAppsLock, serializeAppsLock } from '#dist/shared/properties/apps.js';
import { ADMIN_VIEW, CLIENT_ROLE_ID, DEFAULT_PROJECT_ROLES, can, parseProjectRoles, roleViewOf } from '#dist/shared/properties/projectRoles.js';

const FIXTURE = new URL('../../fixtures/marketplace/apps.json', import.meta.url);
const source = readFileSync(FIXTURE, 'utf8');
const SHA = 'a'.repeat(64);
// One known-good entry; each bad case replaces one of its fields.
const APP = {
  id: 'heat-map',
  name: 'Heat map',
  description: 'Clicks over the canvas.',
  author: 'octocat',
  icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
  categories: ['analytics'],
  source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' },
  versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: SHA }],
} as const;
const withApp = (change: Readonly<Record<string, unknown>>) => ({ version: 1, apps: [{ ...APP, ...change }] });

test('the example index parses, versions newest first', () => {
  const index = parseMarketplaceIndexSource(source);
  assert.equal(MARKETPLACE_INDEX_URL, 'https://stacki.build/api/marketplace/index.json');
  assert.equal(MARKETPLACE_ICON_PREFIX, 'https://stacki.build/api/marketplace/icons/');
  assert.equal(MARKETPLACE_SUBMIT_URL, 'https://stacki.build/marketplace/submit');
  assert.equal(index.apps.length, 2);
  const heat = marketplaceApp(index, 'heat-map');
  assert.ok(heat);
  assert.deepEqual(
    heat.versions.map((entry) => entry.version),
    ['1.1.0', '1.0.0'],
  );
  assert.equal(latestApprovedVersion(heat).tag, 'v1.1.0');
  assert.equal(approvedVersion(heat, '1.0.0')?.sha256, '1'.repeat(64));
  assert.equal(approvedVersion(heat, '9.9.9'), undefined);
  assert.equal(approvedUpdate(heat, '1.0.0')?.version, '1.1.0');
  assert.equal(approvedUpdate(heat, '1.1.0'), undefined);
  assert.equal(approvedUpdate(heat, '2.0.0'), undefined, 'a newer local version is not downgraded');
  assert.equal(heat.source.account, undefined);
  assert.equal(marketplaceApp(index, 'missing'), undefined);
});

test('search matches every word across name, description, id, author and categories', () => {
  const index = parseMarketplaceIndexSource(source);
  assert.deepEqual(
    searchMarketplace(index, '').map((app) => app.id),
    ['heat-map', 'alt-text-check'],
  );
  assert.deepEqual(
    searchMarketplace(index, 'ACCESSIBILITY').map((app) => app.id),
    ['alt-text-check'],
  );
  assert.deepEqual(
    searchMarketplace(index, 'octocat clicks').map((app) => app.id),
    [],
  );
  assert.deepEqual(
    searchMarketplace(index, 'octocat click').map((app) => app.id),
    ['heat-map'],
  );
});

test('a parsed index parses again, as the renderer reads it from IPC, and a version names the Stacki it needs', () => {
  const index = parseMarketplaceIndex(
    withApp({
      versions: [
        { version: '1.1.0', tag: 'v1.1.0', sha256: SHA, stacki: '>=1.1.0', asset: 'heat-map-1.1.0.zip' },
        { version: '1.0.0', tag: 'v1.0.0', sha256: SHA },
      ],
    }),
  );
  const [app] = index.apps;
  assert.ok(app !== undefined);
  assert.equal(app.iconURL, APP.icon);
  assert.equal(latestApprovedVersion(app).stackiVersionMin, '1.1.0');
  assert.equal(approvedVersion(app, '1.0.0')?.stackiVersionMin, undefined);
  // The host sends the parsed index over IPC as JSON; the renderer parses it with the same parser.
  assert.deepEqual(parseMarketplaceIndex(JSON.parse(JSON.stringify(index))), index);
  assert.deepEqual(parseMarketplaceIndex(JSON.parse(JSON.stringify(parseMarketplaceIndexSource(source)))), parseMarketplaceIndexSource(source));
  assert.throws(() => parseMarketplaceIndex(withApp({ iconURL: APP.icon })), /icon or iconURL, not both/);
  assert.throws(() => parseMarketplaceIndex(withApp({ versions: [{ version: '1.0.0', tag: 'v1', sha256: SHA, stacki: '^1.1.0' }] })), /must be ">=/);
  assert.throws(
    () => parseMarketplaceIndex(withApp({ versions: [{ version: '1.0.0', tag: 'v1', sha256: SHA, stacki: '>=1.1.0', stackiVersionMin: '1.1.0' }] })),
    /not both/,
  );
});

test('every known-bad index shape is refused with its reason', () => {
  assert.doesNotThrow(() => parseMarketplaceIndex(withApp({})));
  const icon = (rest: string) => `https://stacki.build/api/marketplace/icons/${rest}`;
  const cases: readonly (readonly [string, unknown, RegExp])[] = [
    ['version', { version: 2, apps: [] }, /version must be 1/],
    ['apps missing', { version: 1 }, /needs an apps list/],
    ['duplicate id', { version: 1, apps: [APP, APP] }, /listed twice/],
    ['bad id', withApp({ id: 'Heat Map' }), /lowercase/],
    ['empty name', withApp({ name: '  ' }), /App name is empty/],
    ['long description', withApp({ description: 'x'.repeat(281) }), /exceeds 280/],
    ['bad author', withApp({ author: 'not a login' }), /not a GitHub username/],
    ['foreign icon', withApp({ icon: 'https://evil.example.com/icon.png' }), /lives under https:\/\/stacki\.build\/api\/marketplace\/icons\//],
    ['old GitHub icon', withApp({ icon: 'https://raw.githubusercontent.com/flowtricks/stacki-marketplace/main/icons/i.png' }), /lives under/],
    ['look-alike host icon', withApp({ icon: 'https://stacki.build.evil.example/api/marketplace/icons/i.png' }), /lives under/],
    ['plain HTTP icon', withApp({ icon: 'http://stacki.build/api/marketplace/icons/i.png' }), /lives under/],
    ['icon outside the icon path', withApp({ icon: 'https://stacki.build/api/marketplace/index.json' }), /lives under/],
    ['climbing icon', withApp({ icon: icon('a/../x.png') }), /PNG, SVG or WebP/],
    ['empty segment icon', withApp({ icon: icon('a//x.png') }), /PNG, SVG or WebP/],
    ['icon type', withApp({ icon: icon('icon.gif') }), /PNG, SVG or WebP/],
    ['long icon', withApp({ icon: icon(`${'a'.repeat(300)}.png`) }), /exceeds its limit/],
    ['categories not a list', withApp({ categories: 'analytics' }), /categories are a list/],
    ['too many categories', withApp({ categories: ['a', 'b', 'c', 'd', 'e'] }), /at most 4 categories/],
    ['bad category', withApp({ categories: ['Analytics'] }), /lowercase letters/],
    ['long category', withApp({ categories: ['a'.repeat(MARKETPLACE_LIMITS.categoryCharsMax + 1)] }), /1 to 32/],
    ['source with account', withApp({ source: { ...APP.source, account: 'octocat' } }), /names no account/],
    ['source asset', withApp({ source: { ...APP.source, asset: 'heat-map.exe' } }), /\.zip/],
    ['no versions', withApp({ versions: [] }), /at least one approved version/],
    [
      'too many versions',
      withApp({ versions: Array.from({ length: MARKETPLACE_LIMITS.versionsMax + 1 }, (_, i) => ({ version: `1.0.${i}`, tag: `v1.0.${i}`, sha256: SHA })) }),
      /at most 20/,
    ],
    [
      'duplicate version',
      withApp({
        versions: [
          { version: '1.0.0', tag: 'a', sha256: SHA },
          { version: '1.0.0', tag: 'b', sha256: SHA },
        ],
      }),
      /approved twice/,
    ],
    [
      'duplicate tag',
      withApp({
        versions: [
          { version: '1.0.0', tag: 'a', sha256: SHA },
          { version: '1.0.1', tag: 'a', sha256: SHA },
        ],
      }),
      /same tag/,
    ],
    ['bad digest', withApp({ versions: [{ version: '1.0.0', tag: 'v1', sha256: 'A'.repeat(64) }] }), /SHA-256/],
    ['bad version', withApp({ versions: [{ version: 'one', tag: 'v1', sha256: SHA }] }), /MAJOR.MINOR.PATCH/],
  ];
  for (const [name, input, reason] of cases) {
    assert.throws(() => parseMarketplaceIndex(input), reason, name);
  }
  assert.throws(() => parseMarketplaceIndexSource('{'), /not JSON/);
  assert.throws(() => parseMarketplaceIndexSource(' '.repeat(MARKETPLACE_LIMITS.indexBytesMax + 1)), /exceeds/);
  const many = { version: 1, apps: Array.from({ length: MARKETPLACE_LIMITS.appsMax + 1 }, () => ({})) };
  assert.throws(() => parseMarketplaceIndex(many), /at most 500 apps/);
});

test('the lockfile records marketplace installs and auto-update; an older lockfile reads auto-update as off', () => {
  const older = {
    version: 1,
    apps: [{ id: 'heat-map', version: '1.0.0', sha256: SHA, installedAt: '2026-11-01T00:00:00Z', source: { kind: 'file', fileName: 'heat-map.zip' } }],
  };
  assert.equal(parseAppsLock(older).apps[0]?.autoUpdate, false);
  const marketplace = {
    version: 1,
    apps: [
      {
        id: 'heat-map',
        version: '1.1.0',
        sha256: SHA,
        installedAt: '2026-11-01T00:00:00Z',
        source: { kind: 'marketplace', id: 'heat-map', version: '1.1.0' },
        autoUpdate: true,
      },
    ],
  };
  const lock = parseAppsLock(marketplace);
  assert.deepEqual(lock.apps[0]?.source, { kind: 'marketplace', id: 'heat-map', version: '1.1.0' });
  assert.equal(lock.apps[0]?.autoUpdate, true);
  assert.match(serializeAppsLock(lock), /"autoUpdate": true/);
  const entry = marketplace.apps[0];
  assert.ok(entry);
  assert.throws(() => parseAppsLock({ version: 1, apps: [{ ...entry, autoUpdate: 'yes' }] }), /autoUpdate must be true or false/);
  assert.throws(
    () => parseAppsLock({ version: 1, apps: [{ ...entry, source: { kind: 'marketplace', id: 'other', version: '1.1.0' } }] }),
    /names the marketplace app/,
  );
  assert.throws(() => parseAppsLock({ version: 1, apps: [{ ...entry, source: { kind: 'store' } }] }), /"file", "github", "marketplace" or "local"/);
  assert.deepEqual(parseAppUpdateOutcome({ kind: 'updated', id: 'heat-map', version: '1.1.0' }), { kind: 'updated', id: 'heat-map', version: '1.1.0' });
});

test('marketplace roles: admin has both, Client neither, older files neither, and each needs its prerequisites', () => {
  assert.ok(can(ADMIN_VIEW, 'marketplace:view'));
  assert.ok(can(ADMIN_VIEW, 'marketplace:install'));
  const client = roleViewOf(DEFAULT_PROJECT_ROLES, CLIENT_ROLE_ID);
  assert.equal(can(client, 'marketplace:view'), false);
  assert.equal(can(client, 'marketplace:install'), false);
  // A roles file from before the marketplace names neither feature: the role gets neither.
  const older = parseProjectRoles({
    version: 1,
    roles: [
      { id: 'admin', members: ['owner'] },
      { id: 'editor', name: 'Editor', members: ['sam'], access: ['panel:apps', 'app:*'] },
    ],
  });
  const editor = roleViewOf(older, 'editor');
  assert.equal(can(editor, 'marketplace:view'), false);
  assert.equal(can(editor, 'marketplace:install'), false);
  const granted = (access: readonly string[]) =>
    roleViewOf(
      parseProjectRoles({
        version: 1,
        roles: [
          { id: 'admin', members: ['owner'] },
          { id: 'r', name: 'R', access },
        ],
      }),
      'r',
    );
  assert.ok(can(granted(['panel:apps', 'marketplace:view']), 'marketplace:view'));
  assert.equal(can(granted(['panel:apps', 'marketplace:view']), 'marketplace:install'), false);
  assert.ok(can(granted(['panel:apps', 'marketplace:view', 'marketplace:install']), 'marketplace:install'));
  assert.equal(can(granted(['marketplace:view', 'marketplace:install']), 'marketplace:view'), false, 'the marketplace lives in the Apps panel');
  assert.equal(can(granted(['panel:apps', 'marketplace:install']), 'marketplace:install'), false, 'installing needs seeing');
  assert.throws(() => granted(['marketplace:browse']), /Unknown access feature/);
});
