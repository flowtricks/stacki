// Goal: a "Move styles" journal says exactly where a stopped move stands, from the disk alone: each file is not done
// (its before text), done (its after text), or changed by someone (neither), and the whole move is untouched, done,
// interrupted or changed. Resolving writes in the copy-first order towards the move and the reverse back. The wire
// and disk shapes refuse what a journal cannot be.
// Method: hand-built journals and disk texts through the pure functions, then one known-good and one known-bad case per
// rule of the parsers, and the four channels' payloads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  STYLE_MOVE_LIMITS,
  parsePendingStyleMove,
  parseStyleMoveJournal,
  parseStyleMoveResolution,
  styleMoveCanFinish,
  styleMoveOrder,
  styleMoveProgress,
  styleMoveState,
} from '#dist/shared/properties/styleMoveJournal.js';

const component = { role: 'component', path: '/site/src/components/Card.astro', rel: 'src/components/Card.astro', before: undefined, after: 'card' } as const;
const page = { role: 'page', path: '/site/src/pages/index.astro', rel: 'src/pages/index.astro', before: 'page-before', after: 'page-after' } as const;
const base = { role: 'sheet', path: '/site/src/styles/base.css', rel: 'src/styles/base.css', before: 'base-before', after: 'base-after' } as const;
const journal = { version: 1, id: 'move-1', startedAt: 1, component: 'Card', files: [component, page, base] } as const;

test('progress: before, after or changed, for each kind of file', () => {
  assert.equal(styleMoveProgress(component, undefined), 'before', 'a component not written yet');
  assert.equal(styleMoveProgress(component, 'card'), 'after');
  assert.equal(styleMoveProgress(component, 'edited'), 'changed');
  assert.equal(styleMoveProgress({ ...component, after: undefined }, 'any text'), 'after', 'written, text not journalled yet');
  assert.equal(styleMoveProgress(page, 'page-before'), 'before');
  assert.equal(styleMoveProgress({ ...page, after: undefined }, 'saved'), 'after', 'a page saved before its text was journalled');
  assert.equal(styleMoveProgress(base, 'base-after'), 'after');
  assert.equal(styleMoveProgress(base, 'edited'), 'changed');
  assert.equal(styleMoveProgress(base, undefined), 'changed', 'a stylesheet removed by someone');
});

test('state: untouched, interrupted at each step, done, or changed', () => {
  assert.deepEqual(styleMoveState(journal, [undefined, 'page-before', 'base-before']), { kind: 'untouched' });
  assert.deepEqual(styleMoveState(journal, ['card', 'page-before', 'base-before']), {
    kind: 'interrupted',
    done: ['src/components/Card.astro'],
    left: ['src/pages/index.astro', 'src/styles/base.css'],
  });
  assert.deepEqual(styleMoveState(journal, ['card', 'page-after', 'base-before']), {
    kind: 'interrupted',
    done: ['src/components/Card.astro', 'src/pages/index.astro'],
    left: ['src/styles/base.css'],
  });
  assert.deepEqual(styleMoveState(journal, ['card', 'page-after', 'base-after']), { kind: 'done' });
  assert.deepEqual(styleMoveState(journal, ['card', 'page-after', 'edited']), { kind: 'changed', changed: ['src/styles/base.css'] });
  assert.throws(() => styleMoveState(journal, ['card']), /one disk text per journalled file/);
});

test('a move whose page was not saved yet, and whose saved text the journal never learnt, cannot be finished', () => {
  const unsaved = { ...journal, files: [component, { ...page, after: undefined }, base] };
  assert.equal(
    styleMoveCanFinish(unsaved, ['card', 'page-before', 'base-before']),
    false,
    'finishing would empty the sheets for a page not using the component',
  );
  assert.equal(styleMoveCanFinish(unsaved, ['card', 'saved by the move', 'base-before']), true, 'saved: finishing leaves the page and cleans the sheets');
  assert.equal(styleMoveCanFinish(journal, ['card', 'page-before', 'base-before']), true, 'with the page text known, finishing writes it');
});

test('order: component, page, sheets towards the move; the reverse back to the original', () => {
  const shuffled = [base, page, component];
  assert.deepEqual(
    styleMoveOrder(shuffled, 'moved').map((file) => file.role),
    ['component', 'page', 'sheet'],
  );
  assert.deepEqual(
    styleMoveOrder(shuffled, 'original').map((file) => file.role),
    ['sheet', 'page', 'component'],
  );
});

test('journal parser: one component and one page, distinct files, each rule of a file kind, and the bounds', () => {
  assert.deepEqual(parseStyleMoveJournal(JSON.parse(JSON.stringify(journal))), { ...journal, files: [{ ...component }, page, base] });
  const bad: readonly unknown[] = [
    { ...journal, version: 2 },
    { ...journal, startedAt: -1 },
    { ...journal, id: '' },
    { ...journal, files: [page, base] },
    { ...journal, files: [component, base] },
    { ...journal, files: [component, page, page] },
    { ...journal, files: [component, page, base, base] },
    { ...journal, files: [{ ...component, before: 'x' }, page] },
    { ...journal, files: [component, { ...page, before: undefined }] },
    { ...journal, files: [component, page, { ...base, after: undefined }] },
    { ...journal, files: [component, page, { ...base, role: 'script' }] },
    { ...journal, files: [component, page, { ...base, before: 'x'.repeat(STYLE_MOVE_LIMITS.textCharsMax + 1) }] },
  ];
  for (const input of bad) {
    assert.throws(() => parseStyleMoveJournal(input));
  }
  const sheets = Array.from({ length: STYLE_MOVE_LIMITS.sheetsMax + 1 }, (_, index) => ({ ...base, path: `/site/s${index}.css` }));
  assert.throws(() => parseStyleMoveJournal({ ...journal, files: [component, page, ...sheets] }), /too many stylesheets/);
});

test('pending and resolution parsers, and the channels', () => {
  assert.equal(parsePendingStyleMove({ pending: undefined }), undefined);
  const pending = parsePendingStyleMove({
    pending: { journal, state: { kind: 'interrupted', done: ['src/components/Card.astro'], left: ['src/styles/base.css'] }, canFinish: true },
  });
  assert.equal(pending?.state.kind, 'interrupted');
  assert.equal(pending?.canFinish, true);
  assert.throws(
    () => parsePendingStyleMove({ pending: { journal, state: { kind: 'changed', changed: ['elsewhere.css'] }, canFinish: true } }),
    /only journalled files/,
  );
  assert.throws(() => parsePendingStyleMove({ pending: { journal, state: { kind: 'weird' }, canFinish: true } }));
  assert.throws(() => parsePendingStyleMove({ pending: { journal, state: { kind: 'done' } } }), /whether it can be finished/);
  assert.deepEqual(parseStyleMoveResolution({ ok: true }), { ok: true });
  assert.deepEqual(parseStyleMoveResolution({ ok: false, changed: ['src/styles/base.css'] }), { ok: false, changed: ['src/styles/base.css'] });
  assert.throws(() => parseStyleMoveResolution({}));
  assert.equal(parseIpcPayload('styleMove:resolve', { projectPath: '/site', id: 'move-1', target: 'original' }).target, 'original');
  assert.throws(() => parseIpcPayload('styleMove:resolve', { projectPath: '/site', id: 'move-1', target: 'sideways' }));
  assert.equal(parseIpcPayload('styleMove:record', { projectPath: '/site', journal }).journal.id, 'move-1');
  assert.throws(() => parseIpcPayload('styleMove:record', { projectPath: '/site', journal: { ...journal, files: [] } }));
});
