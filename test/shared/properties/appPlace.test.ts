// Goal: where an installed app lives reads the same everywhere
// (shared/properties/appPlace.ts). Each install source maps to its pills: an
// uploaded file and a folder app are "Local"; a GitHub or marketplace install is
// "GitHub", with "· Private" or "· Public" only once the host answered, and
// "Marketplace" follows only when the index lists the app. The marketplace match
// needs the same id and, for a GitHub install, the same repository (any case);
// a local app never matches. A marketplace install's repository comes from the
// index. The reply parser accepts the known-good shapes and refuses every bad one.
// Method: pure calls on hand-built sources and a parsed index; no network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  APP_PLACE_LIMITS,
  appListedInMarketplace,
  appPlacePills,
  appRepositoryLocation,
  parseAppRepositoryPlaceReply,
} from '#dist/shared/properties/appPlace.js';
import { parseMarketplaceIndex } from '#dist/shared/properties/appMarketplace.js';

const INDEX = parseMarketplaceIndex({
  version: 1,
  apps: [
    {
      id: 'heat-map',
      name: 'Heat map',
      description: 'Clicks over the canvas.',
      author: 'octocat',
      icon: 'https://stacki.build/api/marketplace/icons/heat-map.png',
      categories: [],
      source: { owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip' },
      versions: [{ version: '1.0.0', tag: 'v1.0.0', sha256: 'a'.repeat(64) }],
    },
  ],
});

const FILE = { kind: 'file', fileName: 'pins.zip' } as const;
const LOCAL = { kind: 'local' } as const;
const GITHUB = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' } as const;
const MARKETPLACE = { kind: 'marketplace', id: 'heat-map', version: '1.0.0' } as const;
const NONE = { place: undefined, listed: false } as const;
const labels = (pills: readonly { readonly label: string }[]) => pills.map((pill) => pill.label);

test('each source kind maps to its pills', () => {
  assert.deepEqual(labels(appPlacePills(FILE, NONE)), ['Local']);
  assert.match(appPlacePills(FILE, NONE)[0]?.tooltip ?? '', /pins\.zip; only in this project's \.stacki\/apps folder/);
  assert.deepEqual(labels(appPlacePills(LOCAL, NONE)), ['Local']);
  assert.equal(appPlacePills(LOCAL, NONE)[0]?.tooltip, "Only in this project's .stacki/apps folder");
  assert.deepEqual(labels(appPlacePills(GITHUB, NONE)), ['GitHub'], 'no visibility before the host answers');
  assert.deepEqual(labels(appPlacePills(MARKETPLACE, NONE)), ['GitHub']);
  const place = (visibility: 'private' | 'public' | undefined) => ({ place: { owner: 'octocat', repository: 'heat-map', visibility }, listed: false });
  assert.deepEqual(labels(appPlacePills(GITHUB, place('private'))), ['GitHub · Private']);
  assert.deepEqual(labels(appPlacePills(GITHUB, place('public'))), ['GitHub · Public']);
  assert.deepEqual(labels(appPlacePills(GITHUB, place(undefined))), ['GitHub'], 'a failed lookup says nothing');
  assert.match(appPlacePills(GITHUB, place('private'))[0]?.tooltip ?? '', /octocat\/heat-map, a private GitHub repository/);
  assert.deepEqual(labels(appPlacePills(MARKETPLACE, { ...place('public'), listed: true })), ['GitHub · Public', 'Marketplace']);
  assert.deepEqual(
    appPlacePills(GITHUB, { place: undefined, listed: true }).map((pill) => pill.kind),
    ['github', 'marketplace'],
  );
});

test('the marketplace lists an app by id and repository; a local app never matches', () => {
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: GITHUB }), true);
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: { ...GITHUB, owner: 'OctoCat', repository: 'Heat-Map' } }), true, 'names ignore case');
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: { ...GITHUB, owner: 'someone-else' } }), false, 'same id, other repository');
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: { ...GITHUB, repository: 'fork' } }), false);
  assert.equal(appListedInMarketplace(INDEX, { id: 'other', source: { ...GITHUB } }), false, 'same repository, other id');
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: MARKETPLACE }), true);
  assert.equal(appListedInMarketplace(INDEX, { id: 'gone', source: { kind: 'marketplace', id: 'gone', version: '1.0.0' } }), false, 'a withdrawn app');
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: FILE }), false);
  assert.equal(appListedInMarketplace(INDEX, { id: 'heat-map', source: LOCAL }), false);
  assert.throws(() => appListedInMarketplace(INDEX, { id: 'other', source: MARKETPLACE }), /Assertion failed: A marketplace install names its own entry/);
});

test('an app’s repository: its own for GitHub, the index’s for the marketplace, none for a local app', () => {
  assert.deepEqual(appRepositoryLocation({ ...GITHUB, account: 'octocat' }, undefined), { owner: 'octocat', repository: 'heat-map', account: 'octocat' });
  assert.deepEqual(appRepositoryLocation(GITHUB, undefined), { owner: 'octocat', repository: 'heat-map', account: undefined });
  assert.deepEqual(appRepositoryLocation(MARKETPLACE, INDEX), { owner: 'octocat', repository: 'heat-map', account: undefined });
  assert.equal(appRepositoryLocation(MARKETPLACE, undefined), undefined, 'no index, no repository');
  assert.equal(appRepositoryLocation({ kind: 'marketplace', id: 'gone', version: '1.0.0' }, INDEX), undefined);
  assert.equal(appRepositoryLocation(FILE, INDEX), undefined);
  assert.equal(appRepositoryLocation(LOCAL, INDEX), undefined);
});

test('the reply parser accepts each known-good shape and refuses each bad one', () => {
  assert.deepEqual(parseAppRepositoryPlaceReply({}), { place: undefined });
  assert.deepEqual(parseAppRepositoryPlaceReply({ place: { owner: 'octocat', repository: 'heat-map' } }), {
    place: { owner: 'octocat', repository: 'heat-map', visibility: undefined },
  });
  for (const visibility of ['private', 'public'] as const) {
    assert.equal(parseAppRepositoryPlaceReply({ place: { owner: 'octocat', repository: 'heat-map', visibility } }).place?.visibility, visibility);
  }
  for (const bad of [
    undefined,
    'public',
    { place: 'octocat/heat-map' },
    { place: { owner: 'octocat', repository: 'heat-map', visibility: 'internal' } },
    { place: { owner: 'octocat', repository: 'heat-map', visibility: true } },
    { place: { owner: '', repository: 'heat-map' } },
    { place: { owner: 'octocat', repository: '../x' } },
    { place: { owner: 'o'.repeat(500), repository: 'heat-map' } },
  ]) {
    assert.throws(() => parseAppRepositoryPlaceReply(bad), `refuses ${JSON.stringify(bad)}`);
  }
  assert.ok(APP_PLACE_LIMITS.visibilityReposMax > 0);
  assert.ok(APP_PLACE_LIMITS.visibilityFailureMsMax < APP_PLACE_LIMITS.visibilityCacheMsMax, 'a failure is retried sooner than an answer');
});
