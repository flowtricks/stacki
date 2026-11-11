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
// for a marketplace app.
// Method: the pure model (src/features/apps/publishFlow.ts) over hand-made
// repositories and installed apps.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const flow = load('src/features/apps/publishFlow.ts');

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
    uploaded: flow.uploadedApps([installed('alt-text', 'file'), installed('charts', 'marketplace')]),
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
  const choices = flow.visibilityChoices('acme', 'organization');
  assert.equal(choices[0].visibility, 'private', 'private is the default and comes first');
  assert.equal(choices[0].detail, 'People in acme can install it with Load App From GitHub.');
  assert.match(choices[1].detail, /Adds an MIT license/);
  assert.match(flow.visibilityChoices('octocat', 'user')[0].detail, /Only you and people you invite/);
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
  assert.deepEqual(status('octocat', 'user', ''), { kind: 'invalid', message: 'Name the repository.' });
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
  const makePublic = flow.makePublicConfirmation('acme', 'tool');
  assert.equal(makePublic.title, 'Make acme/tool public?');
  assert.match(makePublic.body, /all of its code and its whole history/);
  assert.equal(makePublic.confirmLabel, 'Make public');
  assert.match(flow.licenseConfirmation('acme', 'tool', 'Acme Inc', 2026).body, /Copyright \(c\) 2026 Acme Inc/);
  assert.match(flow.publicShareConfirmation('acme', 'tool').title, /public repository acme\/tool/);
});

test('each refusal to make a repository public says why and what to do', () => {
  const settingsURL = 'https://github.com/acme/tool/settings';
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'scope', settingsURL }).title, /cannot change repositories/);
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'admin', settingsURL }).title, /Only an admin/);
  assert.match(flow.visibilityRefusal({ kind: 'forbidden', reason: 'policy', settingsURL }).title, /does not allow public repositories/);
  assert.deepEqual(
    ['public', 'topic', 'release', 'license', 'scan'].map((check) => flow.marketplaceCheckLabel(check)),
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
  assert.deepEqual(flow.marketplaceSubmitRoute(github, { mayShare: false }), {
    kind: 'publish',
    owner: 'octocat',
    repository: 'heat-map',
    account: undefined,
  });
  assert.deepEqual(
    flow.marketplaceSubmitRoute({ ...github, account: 'acme-bot' }, { mayShare: true }).account,
    'acme-bot',
    'a private repository keeps its reader',
  );
  for (const source of [file, local]) {
    assert.deepEqual(flow.marketplaceSubmitRoute(source, { mayShare: true }), { kind: 'share-first' });
    assert.deepEqual(flow.marketplaceSubmitRoute(source, { mayShare: false }), { kind: 'none' }, 'no dead end for a role that cannot share');
  }
  assert.deepEqual(flow.marketplaceSubmitRoute(marketplace, { mayShare: true }), { kind: 'none' }, 'already listed');
  const apps = [{ lock: { source: file } }, { lock: { source: local } }, { lock: { source: github } }];
  assert.equal(flow.uploadedApps(apps).length, 2, 'the publish chooser lists uploaded and folder apps');
});
