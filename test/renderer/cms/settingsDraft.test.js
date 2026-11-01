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
const { applyDraft } = require(output);

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
