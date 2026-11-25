// Goal: the Share and Publish popups decide as docs/apps.md says. The publish
// chooser lists "Your GitHub apps" (tagged repositories only) and "Uploaded to
// this project" (apps installed from a file), both filtered by what is typed. A
// share offers the account first, then its organizations, and private first as
// the default. The make-public confirmation names the repository and that all
// its code and history become public; each refusal (scope, admin, policy) says
// what to do. The checklist names every requirement, the MIT license among them.
// The owner menu groups owners by signed-in account; the name check says a name
// breaks GitHub's rules, already exists, or is available (only where the
// account's listing is complete), and only the first two block Share.
// Share applies to an uploaded app and to one added to the project folder;
// Submit to marketplace opens a GitHub app's own repository, leads an uploaded
// or folder app through Share (only for a role that may share), and is absent
// for a marketplace app. An uploaded or folder app that is already published (the
// marketplace lists its id, or its manifest names a repository) is not shared again:
// its Submit opens that repository's checklist, and a listed id always yields the
// listing's own repository, never the manifest's. An app the marketplace lists has no
// Submit at all: the marketplace follows its repository's releases.
// Method: the pure model (src/features/apps/publishFlow.ts) over hand-made
// repositories and installed apps.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const flow = load('src/features/apps/publishFlow.ts');
const { ENGLISH_TRANSLATE } = load('shared/properties/i18n/englishTranslator.ts');

const repository = (owner, name, stackiApp, organization) => ({
  owner,
  name,
  private: false,
  updatedAt: '2026-11-01T00:00:00Z',
  stackiApp,
  organization,
});
const installed = (id, kind) => ({
  manifest: { id, name: id.replace('-', ' '), version: '1.0.0' },
  lock: { id, source: kind === 'file' ? { kind: 'file', fileName: `${id}.zip` } : { kind: 'marketplace', id, version: '1.0.0' } },
});

test('the publish chooser lists tagged repositories and uploaded apps in two sections', () => {
  const rows = flow.publishChooserRows({
    query: '',
    repositories: [repository('octocat', 'heat-map', true, false), repository('octocat', 'site', false, false)],
    uploaded: flow.uploadedApps([installed('alt-text', 'file'), installed('charts', 'marketplace')], { published: () => false }),
  });
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'section' ? `# ${row.label}` : row.kind === 'uploaded' ? `up ${row.app.manifest.id}` : `${row.repository.owner}/${row.repository.name}`,
    ),
    ['# Your GitHub apps', 'octocat/heat-map', '# Uploaded to this project', 'up alt-text'],
  );
  const filtered = flow.publishChooserRows({
    query: 'alt',
    repositories: [repository('octocat', 'heat-map', true, false)],
    uploaded: [installed('alt-text', 'file')],
  });
  assert.ok(filtered.some((row) => row.kind === 'uploaded'));
  assert.ok(!filtered.some((row) => row.kind === 'repository'));
  assert.equal(flow.publishPickables(filtered).length, 1);
});

test('a share offers the account first, then its organizations, private by default', () => {
  const owners = flow.shareOwners('octocat', [
    repository('acme', 'notes', true, true),
    repository('zeta-co', 'site', false, true),
    repository('hubot', 'tools', false, false),
    repository('acme', 'charts', false, true),
  ]);
  assert.deepEqual(owners, [
    { login: 'octocat', kind: 'user' },
    { login: 'acme', kind: 'organization' },
    { login: 'zeta-co', kind: 'organization' },
  ]);
  const choices = flow.visibilityChoices('acme', 'organization', ENGLISH_TRANSLATE);
  assert.equal(choices[0].visibility, 'private', 'private is the default and comes first');
  assert.equal(choices[0].detail, 'People in acme can install it with Load App From GitHub.');
  assert.match(choices[1].detail, /Adds an MIT license/);
  assert.match(flow.visibilityChoices('octocat', 'user', ENGLISH_TRANSLATE)[0].detail, /Only you and people you invite/);
});

test('the owner menu groups each signed-in account with its organizations, keys unique across accounts', () => {
  const listings = {
    octocat: [repository('acme', 'notes', true, true)],
    hubot: [repository('acme', 'site', false, true), repository('zeta-co', 'x', false, true)],
  };
  const choices = flow.shareOwnerChoices(['octocat', 'hubot'], (account) => listings[account]);
  assert.deepEqual(
    choices.map((choice) => choice.key),
    ['octocat/octocat', 'octocat/acme', 'hubot/hubot', 'hubot/acme', 'hubot/zeta-co'],
  );
  assert.equal(choices[3].account, 'hubot', 'an organization shared by two accounts is created by the account it is listed under');
  assert.equal(flow.shareOwnerChoices(['solo'], () => []).length, 1, 'one account offers itself');
});

test('the name check: rules first, then existence, available only where the listing is complete', () => {
  const listed = { kind: 'ready', repositories: [repository('octocat', 'Heat-Map', true, false), repository('acme', 'tools', false, true)] };
  const status = (owner, ownerKind, name, listing = listed) => flow.repositoryNameStatus({ owner, ownerKind, name, listing });
  assert.deepEqual(status('octocat', 'user', ''), { kind: 'invalid', message: 'Name the repository.', messageRef: { key: 'apps.publish.nameEmpty' } });
  assert.equal(status('octocat', 'user', 'bad name').kind, 'invalid');
  assert.equal(status('octocat', 'user', 'tool.git').kind, 'invalid');
  assert.deepEqual(status('octocat', 'user', 'heat-map'), { kind: 'exists' }, 'GitHub compares names without case');
  assert.deepEqual(status('ACME', 'organization', 'tools'), { kind: 'exists' });
  assert.deepEqual(status('octocat', 'user', 'new-app'), { kind: 'available' });
  assert.deepEqual(status('acme', 'organization', 'new-app'), { kind: 'unchecked' }, 'an organization can hide repositories');
  assert.deepEqual(status('octocat', 'user', 'new-app', { kind: 'loading' }), { kind: 'checking' });
  assert.deepEqual(status('octocat', 'user', 'new-app', { kind: 'unknown' }), { kind: 'unchecked' });
  const full = { kind: 'ready', repositories: Array.from({ length: 300 }, (_, index) => repository('octocat', `r${index}`, false, false)) };
  assert.deepEqual(status('octocat', 'user', 'new-app', full), { kind: 'unchecked' }, 'a capped listing may miss one');
  assert.deepEqual(
    ['available', 'unchecked', 'checking', 'invalid', 'exists'].map((kind) => flow.repositoryNameUsable({ kind, message: 'x' })),
    [true, true, true, false, false],
  );
  assert.throws(() => status('', 'user', 'name'), /Assertion failed: A name is checked for an owner/);
});

test('the confirmations say what becomes public and what is committed', () => {
  const makePublic = flow.makePublicConfirmation('acme', 'tool', ENGLISH_TRANSLATE);
  assert.equal(makePublic.title, 'Make acme/tool public?');
  assert.match(makePublic.body, /all of its code and its whole history/);
  assert.equal(makePublic.confirmLabel, 'Make public');
  assert.match(flow.licenseConfirmation('acme', 'tool', 'Acme Inc', 2026, ENGLISH_TRANSLATE).body, /Copyright \(c\) 2026 Acme Inc/);
  assert.match(flow.publicShareConfirmation('acme', 'tool', ENGLISH_TRANSLATE).title, /public repository acme\/tool/);
});

test('each refusal to make a repository public says why and what to do', () => {
  const settingsURL = 'https://github.com/acme/tool/settings';
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'scope', settingsURL }, ENGLISH_TRANSLATE).title, /cannot change repositories/);
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'admin', settingsURL }, ENGLISH_TRANSLATE).title, /Only an admin/);
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'policy', settingsURL }, ENGLISH_TRANSLATE).title, /does not allow public repositories/);
  assert.deepEqual(
    ['public', 'topic', 'release', 'license', 'scan'].map((check) => flow.marketplaceCheckLabel(check, ENGLISH_TRANSLATE)),
    [
      'The repository is public',
      'It carries the stacki-app topic',
      'It has a release with the app’s .zip',
      'It uses the MIT license',
      'The secret scan is clean',
    ],
  );
});

test('Share applies to uploaded and folder apps; Submit routes each source', () => {
  const github = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', tag: 'v1.0.0' };
  const file = { kind: 'file', fileName: 'heat-map.zip' };
  const local = { kind: 'local' };
  const marketplace = { kind: 'marketplace', id: 'heat-map', version: '1.0.0' };
  assert.equal(flow.appShareable(file), true);
  assert.equal(flow.appShareable(local), true);
  assert.equal(flow.appShareable(github), false, 'a GitHub app already has its repository');
  assert.equal(flow.appShareable(marketplace), false);
  assert.deepEqual(flow.marketplaceSubmitRoute(github, { mayShare: false, publication: undefined }), {
    kind: 'publish',
    owner: 'octocat',
    repository: 'heat-map',
    account: undefined,
  });
  assert.deepEqual(
    flow.marketplaceSubmitRoute({ ...github, account: 'acme-bot' }, { mayShare: true, publication: undefined }).account,
    'acme-bot',
    'a private repository keeps its reader',
  );
  for (const source of [file, local]) {
    assert.deepEqual(flow.marketplaceSubmitRoute(source, { mayShare: true, publication: undefined }), { kind: 'share-first' });
    assert.deepEqual(
      flow.marketplaceSubmitRoute(source, { mayShare: false, publication: undefined }),
      { kind: 'none' },
      'no dead end for a role that cannot share',
    );
  }
  assert.deepEqual(flow.marketplaceSubmitRoute(marketplace, { mayShare: true, publication: undefined }), { kind: 'none' }, 'already listed');
  const apps = [{ lock: { source: file } }, { lock: { source: local } }, { lock: { source: github } }];
  assert.equal(flow.uploadedApps(apps, { published: () => false }).length, 2, 'the publish chooser lists uploaded and folder apps');
});

const listing = (id, owner, repositoryName) => ({
  id,
  name: id,
  description: 'd',
  author: owner,
  iconURL: 'https://stacki.build/api/marketplace/icons/x.png',
  categories: [],
  source: { kind: 'github', owner, repository: repositoryName, asset: `${id}.zip` },
  versions: [{ version: '1.8.1', tag: 'v1.8.1', sha256: 'a'.repeat(64) }],
  license: 'MIT',
  network: undefined,
});
const indexOf = (...apps) => ({ version: 1, apps });
const local = (id, manifestSource) => ({
  manifest: { id, name: id, version: '1.0.0', source: manifestSource },
  lock: { id, source: { kind: 'local' } },
});

test('an app added from the project folder that the marketplace lists is already shared: it has nothing to submit', () => {
  const index = indexOf(listing('feedback-pins', 'flowtricks', 'feedback-pins'));
  const publication = flow.appPublication(local('feedback-pins', undefined), index);
  assert.deepEqual(publication, { owner: 'flowtricks', repository: 'feedback-pins', account: undefined, listed: true });
  assert.equal(flow.appNeedsShare({ kind: 'local' }, publication), false, 'no Share to GitHub');
  for (const mayShare of [true, false]) {
    assert.deepEqual(flow.marketplaceSubmitRoute({ kind: 'local' }, { mayShare, publication }), { kind: 'none' }, 'listed: no submit item');
  }
  // The same for an app installed from a file.
  assert.equal(flow.appPublication({ manifest: { id: 'feedback-pins' }, lock: { source: { kind: 'file', fileName: 'x.zip' } } }, index).listed, true);
  // Negative space: an app the index does not list, with no repository named, still has to be shared first.
  const alone = flow.appPublication(local('notes', undefined), index);
  assert.equal(alone, undefined);
  assert.equal(flow.appNeedsShare({ kind: 'local' }, alone), true);
  assert.deepEqual(flow.marketplaceSubmitRoute({ kind: 'local' }, { mayShare: true, publication: alone }), { kind: 'share-first' });
  assert.equal(flow.appPublication(local('notes', undefined), undefined), undefined, 'no index, no listing');
});

test('a listed id yields only the listing’s repository, whatever the manifest names', () => {
  const index = indexOf(listing('feedback-pins', 'flowtricks', 'feedback-pins'));
  const hijack = flow.appPublication(local('feedback-pins', { kind: 'github', owner: 'mallory', repository: 'feedback-pins', asset: 'x.zip' }), index);
  assert.equal(hijack.owner, 'flowtricks');
  assert.equal(hijack.repository, 'feedback-pins');
  assert.equal(hijack.listed, true);
  const route = flow.marketplaceSubmitRoute({ kind: 'local' }, { mayShare: true, publication: hijack });
  assert.notEqual(route.owner, 'mallory', 'the route never names another repository');
  assert.equal(route.kind, 'none', 'and a listed app has nothing to submit at all');
});

test('an unlisted folder app whose manifest names its repository is shared already; a GitHub app is published to its own', () => {
  const named = { kind: 'github', owner: 'octocat', repository: 'heat-map', asset: 'heat-map.zip', account: 'acme-bot' };
  const publication = flow.appPublication(local('heat-map', named), indexOf());
  assert.deepEqual(publication, { owner: 'octocat', repository: 'heat-map', account: 'acme-bot', listed: false });
  assert.deepEqual(
    flow.marketplaceSubmitRoute({ kind: 'local' }, { mayShare: false, publication }),
    { kind: 'publish', owner: 'octocat', repository: 'heat-map', account: 'acme-bot' },
    'not listed yet: a first submission',
  );
  assert.equal(flow.appNeedsShare({ kind: 'local' }, publication), false);
  const github = { manifest: { id: 'heat-map' }, lock: { source: { ...named, kind: 'github', tag: 'v1.0.0' } } };
  assert.equal(flow.appPublication(github, indexOf()).listed, false);
  assert.equal(flow.appPublication(github, indexOf(listing('heat-map', 'octocat', 'heat-map'))).listed, true, 'a listed GitHub app is listed');
  const listedGithub = flow.appPublication(github, indexOf(listing('heat-map', 'octocat', 'heat-map')));
  assert.deepEqual(
    flow.marketplaceSubmitRoute(github.lock.source, { mayShare: true, publication: listedGithub }),
    { kind: 'none' },
    'a listed GitHub app has nothing to submit',
  );
  assert.equal(
    flow.marketplaceSubmitRoute(github.lock.source, { mayShare: true, publication: flow.appPublication(github, indexOf()) }).kind,
    'publish',
    'unlisted: first submission',
  );
  assert.equal(
    flow.appPublication(github, indexOf(listing('heat-map', 'someone-else', 'heat-map'))).listed,
    false,
    'another repository’s listing is not this app’s',
  );
  assert.equal(
    flow.appPublication({ manifest: { id: 'heat-map' }, lock: { source: { kind: 'marketplace', id: 'heat-map', version: '1.0.0' } } }, indexOf()),
    undefined,
  );
  const apps = [local('a', undefined), local('b', undefined)];
  assert.equal(flow.uploadedApps(apps, { published: (app) => app.manifest.id === 'a' }).length, 1, 'a published app leaves the uploaded section');
});
