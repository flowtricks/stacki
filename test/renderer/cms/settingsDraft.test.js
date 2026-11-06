// Goal: collection settings are edited as a copy, and every change the config would refuse
// is refused while it is made, so a Save never stops halfway on a change known to fail.
// Method: the pure draft applier runs over settings written here, through each change kind
// and the invalid ones beside them.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/settings-draft.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  entryPoints: [repoPath('src/features/cms/settingsDraft.ts')],
  absWorkingDir: ROOT,
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const { applyDraft, applyDrafts, newFieldFormState, openFieldFormState, replayDrafts } = require(output);

const field = (name, kind = 'text') => ({
  name,
  kind,
  description: undefined,
  required: false,
  checks: {},
  options: undefined,
  defaultValue: undefined,
  editable: true,
  target: undefined,
});
const settings = {
  name: 'blog',
  source: 'src/content/blog',
  fields: [field('title'), field('views', 'number')],
};
const names = (result) => result.value.fields.map((each) => each.name);

test('each change is made to the copy, in the order it comes', () => {
  const added = applyDraft(settings, {
    kind: 'addField',
    name: 'cover',
    fieldKind: 'image',
    target: undefined,
    settings: {
      description: 'Shown above the post',
      required: true,
      checks: { minWidth: 800 },
      options: undefined,
      defaultValue: undefined,
    },
  });
  assert.deepEqual(names(added), ['title', 'views', 'cover']);
  assert.equal(added.value.fields[2].required, true, 'a new field shows the settings it was added with');
  assert.deepEqual(added.value.fields[2].checks, { minWidth: 800 });
  const renamed = applyDraft(added.value, { kind: 'renameField', from: 'views', to: 'reads' });
  assert.deepEqual(names(renamed), ['title', 'reads', 'cover']);
  const updated = applyDraft(renamed.value, {
    kind: 'updateField',
    update: { name: 'reads', description: 'Times read', required: true, checks: { min: 0 } },
  });
  assert.equal(updated.value.fields[1].description, 'Times read');
  assert.equal(updated.value.fields[1].required, true);
  const reordered = applyDraft(updated.value, {
    kind: 'reorder',
    order: ['cover', 'title', 'reads'],
  });
  assert.deepEqual(names(reordered), ['cover', 'title', 'reads']);
  const removed = applyDraft(reordered.value, { kind: 'removeField', name: 'title' });
  assert.deepEqual(names(removed), ['cover', 'reads']);
  assert.equal(applyDraft(settings, { kind: 'renameCollection', to: 'posts' }).value.name, 'posts');
  assert.deepEqual(
    settings.fields.map((each) => each.name),
    ['title', 'views'],
    'the saved copy stays',
  );
});

test('a change the config would refuse is refused while it is made', () => {
  assert.equal(applyDraft(settings, { kind: 'renameField', from: 'views', to: 'title' }).ok, false);
  assert.equal(applyDraft(settings, { kind: 'renameField', from: 'gone', to: 'x' }).ok, false);
  assert.equal(
    applyDraft(settings, {
      kind: 'addField',
      name: 'title',
      fieldKind: 'text',
      target: undefined,
      settings: {
        description: undefined,
        required: false,
        checks: {},
        options: undefined,
        defaultValue: undefined,
      },
    }).ok,
    false,
  );
  assert.equal(applyDraft(settings, { kind: 'reorder', order: ['title'] }).ok, false);
  const update = {
    name: 'gone',
    description: undefined,
    required: true,
    min: undefined,
    max: undefined,
  };
  assert.equal(applyDraft(settings, { kind: 'updateField', update }).ok, false);
});

const addition = (name) => ({
  kind: 'addField',
  name,
  fieldKind: 'text',
  target: undefined,
  settings: { description: undefined, required: false, checks: {}, options: undefined, defaultValue: undefined },
});

test('a name the boundary would refuse is refused here, so it is never staged', () => {
  for (const name of ['', 'My Field', '9lives', 'a'.repeat(65)]) {
    assert.equal(applyDraft(settings, addition(name)).ok, false, `add ${name}`);
    assert.equal(applyDraft(settings, { kind: 'renameField', from: 'title', to: name }).ok, false, `rename to ${name}`);
  }
  assert.match(applyDraft(settings, addition('My Field')).message, /starts with a letter/);
  assert.match(applyDraft(settings, addition('a'.repeat(65))).message, /at most 64/);
  assert.equal(applyDraft(settings, addition('a'.repeat(64))).ok, true, 'the longest name passes');
});

test('changes are staged together: a later one sees the earlier, and one refused stages none', () => {
  const renamed = applyDrafts(settings, [
    { kind: 'renameField', from: 'title', to: 'heading' },
    { kind: 'updateField', update: { name: 'heading', description: 'Shown first', required: true, checks: {} } },
  ]);
  assert.deepEqual(names(renamed), ['heading', 'views']);
  assert.equal(renamed.value.fields[0].description, 'Shown first', 'the update reached the renamed field');
  const refused = applyDrafts(settings, [addition('fresh'), addition('title')]);
  assert.equal(refused.ok, false);
  assert.match(refused.message, /already exists/);
});

test('changes left over from a refused save are made again on the config as it stands', () => {
  const replayed = replayDrafts(settings, [addition('fresh'), addition('title'), { kind: 'renameField', from: 'views', to: 'reads' }]);
  assert.deepEqual(
    replayed.value.fields.map((each) => each.name),
    ['title', 'reads', 'fresh'],
  );
  assert.deepEqual(
    replayed.changes.map((change) => change.kind),
    ['addField', 'renameField'],
    'one the config has made impossible is left out',
  );
});

test('a new field form is blank until named, and then saved under its key', () => {
  const form = (name, kind = 'text', target = '') => ({ draft: { ...field(name, kind) }, kind, target });
  assert.deepEqual(newFieldFormState(settings, form('')), { kind: 'blank' });
  assert.deepEqual(newFieldFormState(settings, form('  ')), { kind: 'blank' });
  const ready = newFieldFormState(settings, form(' My Field '));
  assert.equal(ready.kind, 'ready');
  assert.equal(ready.changes[0].name, 'my-field');
  assert.equal(newFieldFormState(settings, form('Title')).changes[0].name, 'Title', 'a key is kept as written');
  assert.match(newFieldFormState(settings, form('title')).message, /title already exists/);
  assert.match(newFieldFormState(settings, form('9 lives')).message, /starts with a letter/);
  assert.match(newFieldFormState(settings, form('author', 'reference')).message, /Choose the collection/);
  assert.equal(newFieldFormState(settings, form('author', 'reference', 'people')).changes[0].target, 'people');
  assert.equal(newFieldFormState(settings, form('note', 'text', 'people')).changes[0].target, undefined, 'only a reference has a target');
});

test('an open field form changes only what changed, renaming first', () => {
  const [title] = settings.fields;
  assert.deepEqual(openFieldFormState(settings, title, title), { kind: 'ready', changes: [] });
  assert.deepEqual(openFieldFormState(settings, title, { ...title, name: ' title ' }), { kind: 'ready', changes: [] }, 'spaces around a name are no rename');
  assert.deepEqual(openFieldFormState(settings, title, { ...title, name: 'Main Title' }).changes, [{ kind: 'renameField', from: 'title', to: 'main-title' }]);
  const both = openFieldFormState(settings, title, { ...title, name: 'heading', required: true });
  assert.deepEqual(
    both.changes.map((change) => change.kind),
    ['renameField', 'updateField'],
  );
  assert.equal(both.changes[1].update.name, 'heading');
  assert.match(openFieldFormState(settings, title, { ...title, name: 'views' }).message, /views already exists/);
  assert.match(openFieldFormState(settings, title, { ...title, name: '' }).message, /Name the field/);
  const fixed = { ...title, editable: false };
  assert.deepEqual(openFieldFormState(settings, fixed, { ...fixed, required: true }).changes, [], 'a field written as a method keeps its settings');
});
