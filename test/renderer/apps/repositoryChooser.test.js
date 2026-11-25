// Goal: the Load App From GitHub chooser lists the rows docs/apps.md
// describes. Only repositories carrying the `stacki-app` topic are listed, under
// "Stacki apps", and typing searches only those; an untagged repository is never
// a row. Text that names a repository (owner/repo, a github.com address) pins a
// "Use owner/repo" row first, for any repository, unless it is already a row, so
// it never shows twice. The arrows move the highlight one row at a time, held to
// the ends.
// Method: the pure row model (src/features/apps/repositoryChooser.ts) over a
// hand-made account of tagged and untagged repositories, a list not there yet,
// and each kind of typed text.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');

const { chooserRows, chooserPickables, hasStackiApps, moveChooserActive } = load('src/features/apps/repositoryChooser.ts');

const repository = (owner, name, stackiApp) => ({ owner, name, private: false, updatedAt: '2026-11-01T00:00:00Z', stackiApp });
const ACCOUNT = [repository('octocat', 'heat-map', true), repository('octocat', 'website', false), repository('acme', 'notes', false)];
// Each row as one short string, so a whole list reads at a glance.
const shape = (rows) =>
  rows.map((row) => {
    switch (row.kind) {
      case 'use':
        return `use ${row.owner}/${row.repository}`;
      case 'section':
        return `# ${row.label}`;
      case 'repository':
        return `${row.repository.owner}/${row.repository.name}`;
      case 'notice':
        return `! ${row.notice}`;
      default:
        throw new Error(`unknown row ${row.kind}`);
    }
  });

test('only tagged repositories are listed, under Stacki apps', () => {
  assert.deepEqual(shape(chooserRows({ query: '', repositories: ACCOUNT })), ['# Stacki apps', 'octocat/heat-map']);
  assert.equal(hasStackiApps(ACCOUNT), true);
});

test('with nothing tagged there are no rows: the empty state speaks', () => {
  const untagged = ACCOUNT.map((entry) => ({ ...entry, stackiApp: false }));
  assert.equal(hasStackiApps(untagged), false);
  assert.equal(hasStackiApps([]), false);
  assert.deepEqual(shape(chooserRows({ query: '', repositories: untagged })), []);
  assert.deepEqual(shape(chooserRows({ query: 'web', repositories: untagged })), [], 'a search does not reveal untagged repositories');
  assert.deepEqual(shape(chooserRows({ query: '', repositories: [] })), []);
});

test('a search covers only the tagged repositories, and says when none match', () => {
  assert.deepEqual(shape(chooserRows({ query: 'HEAT', repositories: ACCOUNT })), ['# Stacki apps', 'octocat/heat-map']);
  assert.deepEqual(shape(chooserRows({ query: 'web', repositories: ACCOUNT })), ['! no-match'], 'an untagged match is not listed');
  assert.deepEqual(shape(chooserRows({ query: 'nothing-like-it', repositories: ACCOUNT })), ['! no-match']);
});

test('a pasted repository pins a Use row first, and Enter picks it', () => {
  for (const query of ['someone/thing', 'github.com/someone/thing', 'https://github.com/someone/thing.git']) {
    const rows = chooserRows({ query, repositories: ACCOUNT });
    assert.deepEqual(shape(rows), ['use someone/thing', '! no-match'], query);
    assert.equal(chooserPickables(rows)[0].kind, 'use', 'the first pickable row, highlighted by default, is the Use row');
  }
  // Without a list (loading, signed out, Studio) the Use row is all there is.
  assert.deepEqual(shape(chooserRows({ query: 'someone/thing', repositories: undefined })), ['use someone/thing']);
  assert.deepEqual(shape(chooserRows({ query: 'just words', repositories: undefined })), []);
});

test('a pasted repository already in the list shows as its normal row, not twice', () => {
  for (const query of ['octocat/heat-map', 'https://github.com/OctoCat/Heat-Map']) {
    const rows = chooserRows({ query, repositories: ACCOUNT });
    assert.equal(
      rows.some((row) => row.kind === 'use'),
      false,
      query,
    );
    assert.equal(chooserPickables(rows).length, 1, query);
  }
  // An untagged repository is not a row, so pasting it offers Use; the bundle check guards it.
  assert.deepEqual(shape(chooserRows({ query: 'octocat/website', repositories: ACCOUNT })), ['use octocat/website', '! no-match']);
  // A prefix of a listed repository is a different repository: both show.
  const rows = chooserRows({ query: 'octocat/heat', repositories: ACCOUNT });
  assert.deepEqual(shape(rows), ['use octocat/heat', '# Stacki apps', 'octocat/heat-map']);
});

test('the arrows move over the pickable rows only, held to the ends', () => {
  const tagged = ACCOUNT.map((entry) => ({ ...entry, stackiApp: true }));
  const rows = chooserRows({ query: '', repositories: tagged });
  const pickables = chooserPickables(rows);
  assert.deepEqual(
    pickables.map((row) => row.kind),
    ['repository', 'repository', 'repository'],
    'headings are not pickable',
  );
  assert.equal(moveChooserActive(0, 1, pickables.length), 1);
  assert.equal(moveChooserActive(2, 1, pickables.length), 2, 'held at the last row');
  assert.equal(moveChooserActive(0, -1, pickables.length), 0, 'held at the first row');
  assert.equal(moveChooserActive(0, 1, 0), 0, 'an empty list has nowhere to go');
  assert.throws(() => moveChooserActive(0.5, 1, 3), /The active row is an index/);
  assert.throws(() => moveChooserActive(0, 1, -1), /The row count is not negative/);
});
