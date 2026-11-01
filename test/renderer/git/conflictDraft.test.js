// Goal: preserve the engine's automatic result while reviewing individual inline
// edits and typing overrides. Method: use real diff3 output, range edits, and the
// shared payload parser; compare exact source including whitespace and Unicode.
const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { ChangeSet } = require('@codemirror/state');
const { parseConflict, renderResolved } = require('#dist/electron/git/conflicts.js');
const { createConflictDraft, editConflictDraft, chooseConflictRegion, conflictChoiceText, conflictDraftsForSend } = load('src/features/git/conflictDraft.ts');
const { conflictHighlights } = load('src/features/git/conflictHighlights.ts');
const { parseMergeResolution } = load('shared/ipc/mergeResolution.ts');
const { conflictTextChanges } = load('src/features/git/conflictTextChanges.ts');

const base = '<Heading id="hero" class="old">Welcome</Heading>';
const ours = '<Heading id="hero" class="old">Hello world</Heading>';
const theirs = '<Heading id="hero" class="new">Welcome</Heading>';
const parts = parseConflict(
  `---\ntitle: Home\n---\n<<<<<<< HEAD\n${ours}\n||||||| base\n${base}\n` + `=======\n${theirs}\n>>>>>>> topic\n<footer>Keep me</footer>\n`,
);
const file = { path: 'index.astro', ours, theirs, parts };
const conflict = { ok: false, conflicted: true, from: 'main', branch: 'topic', files: [file] };
const choose = (draft, index, choice) =>
  chooseConflictRegion(draft, index, {
    choice,
    text: conflictChoiceText(draft.regions[index].clash, choice),
  });

test('separate heading text and class choices retain automatic combinations', () => {
  const draft = createConflictDraft(file);
  assert.equal(draft.text, renderResolved(parts, ['merged']));
  assert.equal(draft.regions.length, 2);
  const words = draft.regions.findIndex((region) => region.clash.ours === 'Hello world');
  assert.notEqual(words, -1);
  const switched = choose(draft, words, 'theirs');
  assert.match(switched.text, /class="new">Welcome/);
  assert.match(switched.text, /id="hero"/);
  assert.equal(choose(switched, words, 'ours').text, draft.text);
  const highlights = conflictHighlights(
    draft,
    draft.regions.map((region) => region.clash),
  );
  assert.deepEqual(new Set(highlights.map((range) => range.source)), new Set(['ours', 'theirs']));
  const sent = conflictDraftsForSend(conflict, { 'index.astro': switched }, {});
  assert.equal(parseMergeResolution(sent['index.astro']).text, switched.text);
});

test('manual overrides survive toggling other regions and retain CRLF and emoji', () => {
  let draft = createConflictDraft(file);
  const footer = draft.text.indexOf('Keep me');
  draft = editConflictDraft(draft, ChangeSet.of({ from: footer, to: footer + 7, insert: 'Keep 🦊 me\r\nAlways' }, draft.text.length, '\n'));
  const words = draft.regions.findIndex((region) => region.clash.ours === 'Hello world');
  const switched = choose(draft, words, 'theirs');
  assert.match(switched.text, /Keep 🦊 me\r\nAlways/);
  assert.equal(switched.mode, 'edited');
  const region = switched.regions[words];
  const edited = editConflictDraft(switched, ChangeSet.of({ from: region.from, to: region.to, insert: 'Custom words' }, switched.text.length));
  assert.equal(edited.regions[words].choice, 'custom');
  assert.equal(choose(edited, words, 'ours').text, draft.text);
});

test('cross-region overrides cannot be silently replaced by an individual toggle', () => {
  const draft = createConflictDraft(file);
  const changed = editConflictDraft(draft, ChangeSet.of({ from: draft.regions[0].from, to: draft.regions[1].to, insert: 'replacement' }, draft.text.length));
  assert.equal(
    changed.regions.every((region) => !region.selectable),
    true,
  );
  assert.throws(() => choose(changed, 0, 'ours'), /independently/);
  assert.throws(() => editConflictDraft(draft, ChangeSet.empty(1)), /current document/);
});

test('invalid custom resolutions fail at the boundary and expensive diffs stay bounded', () => {
  for (const invalid of [
    { kind: 'text', text: 42, expected: '' },
    { kind: 'text', text: '', expected: false },
    { kind: 'text', text: '', expected: '', expectedBranch: 42 },
    { kind: 'other' },
    ['surprise'],
    'both',
  ]) {
    assert.throws(() => parseMergeResolution(invalid));
  }
  assert.equal(conflictTextChanges('a '.repeat(2001), 'b '.repeat(2001)), undefined);
  for (const [left, right] of [
    ['a🦊b', 'a🐻b'],
    ['', 'new'],
    ['old', ''],
    ['a\r\nb', 'a\r\nc'],
  ]) {
    let output = left;
    for (const change of [...conflictTextChanges(left, right)].reverse()) {
      output = output.slice(0, change.from) + right.slice(change.targetFrom, change.targetTo) + output.slice(change.to);
    }
    assert.equal(output, right);
  }
});

test('a third branch changes the id without losing earlier class and text choices', () => {
  const previous = '<Heading id="hero" class="new">Hello world</Heading>';
  const incoming = '<Heading id="intro" class="old">Welcome</Heading>';
  const thirdParts = parseConflict(`<<<<<<< HEAD\n${previous}\n||||||| base\n${base}\n=======\n${incoming}\n>>>>>>> third`);
  const draft = createConflictDraft({ path: 'index.astro', parts: thirdParts });
  assert.equal(draft.text, '<Heading id="intro" class="new">Hello world</Heading>');
  const words = draft.regions.findIndex((region) => region.clash.ours === 'Hello world');
  assert.notEqual(words, -1);
  assert.equal(choose(draft, words, 'theirs').text, '<Heading id="intro" class="new">Welcome</Heading>');
});
