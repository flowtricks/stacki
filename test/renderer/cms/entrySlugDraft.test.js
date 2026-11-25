// Goal: a new Astro item's slug follows its name by the list's title rule until one is typed,
// Create waits while that slug is taken or too long (an empty one is made under a free name),
// a copy cannot keep its source's slug, and an existing item commits only a changed, valid slug.
// Method: the pure decisions behind EntrySlugField and RemotePendingItem are fed templates
// shaped like the pigeon project's stats collection, filled in and typed over step by step.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { committable, copiedSlug, draftName, draftSlugBlock, draftSlugText, draftSlugToSave, FOLLOWS_NAME } = loadRenderer('src/features/cms/entrySlugDraft.ts');
const { checkEntrySlug } = loadRenderer('shared/properties/entrySlug.ts');

const text = (name) => ({ name, title: name, description: '', required: true, rules: [], type: { kind: 'string', options: [] } });
const slug = { folder: '', value: '', taken: ['untitled', '61-4-copy'], rename: { kind: 'editable' } };
const stats = (values) => ({
  fields: [
    { ...text('cover'), type: { kind: 'string', options: [], asset: 'image' }, value: values.cover },
    { ...text('Number'), value: values.Number },
    { ...text('Header'), value: values.Header },
  ],
  slug,
});

test('a new item’s slug follows its first text field once typed: "61.4%" makes "61-4"', () => {
  assert.equal(draftSlugText(stats({}), FOLLOWS_NAME), '', 'nothing typed, nothing made');
  assert.equal(draftSlugText(stats({ cover: './bird.png', Number: '61.4%', Header: 'Uptime' }), FOLLOWS_NAME), '61-4');
  assert.equal(draftName(stats({ Header: 'Uptime' })), 'Uptime', 'an empty first field passes to the next');
  assert.equal(draftSlugText(stats({ Number: '61.4%' }), { kind: 'typed', text: 'mine' }), 'mine', 'a typed slug stops following');
});

test('Create waits while the slug is taken or too long, and an empty one is left to the panel', () => {
  assert.equal(draftSlugBlock(slug, '')?.kind, undefined, 'empty: made under a free name');
  assert.equal(draftSlugToSave(slug, ''), undefined);
  assert.equal(draftSlugBlock(slug, 'untitled')?.kind, 'taken');
  assert.equal(draftSlugBlock(slug, 'Untitled')?.kind, 'taken', 'compared as it would be saved');
  assert.equal(draftSlugBlock(slug, 'x'.repeat(200))?.kind, 'tooLong');
  assert.equal(draftSlugBlock(slug, '61.4%'), undefined, 'allowed once free');
  assert.equal(draftSlugToSave(slug, '61.4%'), '61-4');
  const locked = { ...slug, rename: { kind: 'locked', reason: 'Built by code.' } };
  assert.equal(draftSlugBlock(locked, 'untitled'), undefined, 'a locked slug never blocks');
  assert.equal(draftSlugToSave(locked, 'mine'), undefined);
  assert.equal(draftSlugBlock(undefined, 'untitled'), undefined, 'a CMS document has no slug field');
});

test('a copy’s slug starts empty, with its source’s slug taken', () => {
  const copied = copiedSlug({ ...slug, value: '61-4', taken: ['untitled'] });
  assert.equal(copied.value, '');
  assert.deepEqual(copied.taken, ['untitled', '61-4']);
});

test('an existing item commits only a valid slug that differs from the stored one', () => {
  const taken = { taken: ['untitled-2'] };
  assert.equal(committable(checkEntrySlug('61.4%', taken), 'untitled'), '61-4');
  assert.equal(committable(checkEntrySlug('untitled', taken), 'untitled'), undefined, 'unchanged: nothing to rename');
  assert.equal(committable(checkEntrySlug('untitled-2', taken), 'untitled'), undefined, 'a duplicate is never saved');
  assert.equal(committable(checkEntrySlug('', taken), 'untitled'), undefined, 'nor an empty one');
});
