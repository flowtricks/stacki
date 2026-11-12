// The goal is to pin the parts of Studio's chat that carry data and rules rather than drawing: the stored history
// (an old, oldest-first history must still load, in display order), pinning and drag-to-reorder (pinned chats stay
// first, a move keeps every chat once), the chips a draft keeps, the files an `@` can name, and the timer formats.
// The method is plain unit tests over the pure functions; the panel itself is covered by ai.browser.ts.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ageLabel, formatDuration } from '../src/features/ai/chatClock';
import { chatSections, newThread, reorder, restoreChats, type ChatThread } from '../src/features/ai/chatState';
import { matchFiles, mentionFiles, sameDraft, textSegments } from '../src/features/ai/mentionFiles';

function stored(id: string, extra: Record<string, unknown> = {}) {
  return { id, title: id, draft: '', images: [], model: 'm', messages: [], status: 'idle', ...extra };
}
function thread(id: string, pinned: boolean): ChatThread {
  return { ...newThread('m'), id, title: id, pinned };
}

test('a version 1 history (oldest first, no pins or ages) loads newest first', () => {
  const restored = restoreChats({ threads: [stored('old'), stored('new')], active: 'old' });
  assert.deepEqual(
    restored.threads.map((chat) => chat.id),
    ['new', 'old'],
  );
  assert.equal(restored.active, 'old');
  assert.equal(restored.threads[0]?.pinned, false);
  assert.equal(restored.threads[0]?.updatedAt, 0);
});

test('a version 2 history keeps its order, holds pinned chats first, and refuses an unknown version', () => {
  const restored = restoreChats({ version: 2, threads: [stored('a'), stored('b', { pinned: true })], active: 'missing' });
  assert.deepEqual(
    restored.threads.map((chat) => chat.id),
    ['b', 'a'],
  );
  assert.equal(restored.active, 'b');
  assert.throws(() => restoreChats({ version: 3, threads: [stored('a')], active: 'a' }), /Unknown chat history version/);
  assert.throws(() => restoreChats({ version: 2, threads: [], active: '' }), /Invalid chats/);
});

test('a stored draft keeps its file chips; an unreadable draft falls back to its words', () => {
  const chip = { kind: 'chip', chip: { kind: 'file', path: 'src/pages/index.astro', name: 'index.astro' } };
  const withChips = restoreChats({
    version: 2,
    threads: [stored('a', { draft: 'see @src/pages/index.astro', segments: [{ kind: 'text', text: 'see ' }, chip] })],
    active: 'a',
  });
  assert.equal(withChips.threads[0]?.draft, 'see @src/pages/index.astro');
  assert.equal(withChips.threads[0]?.segments.filter((segment) => segment.kind === 'chip').length, 1);
  const broken = restoreChats({
    version: 2,
    threads: [stored('a', { draft: 'plain words', segments: [{ kind: 'chip', chip: { kind: 'file', path: '../secret', name: 'x' } }] })],
    active: 'a',
  });
  assert.deepEqual(broken.threads[0]?.segments, textSegments('plain words'));
});

test('a stored chat running at the time of a reload comes back idle with a warning', () => {
  const restored = restoreChats({ version: 2, threads: [stored('a', { status: 'working' })], active: 'a' });
  assert.equal(restored.threads[0]?.status, 'idle');
  assert.match(restored.threads[0]?.error ?? '', /interrupted/);
});

test('a drag moves a chat within its group, and into the pinned group pins it', () => {
  const chats = [thread('p', true), thread('a', false), thread('b', false), thread('c', false)];
  const within = reorder(chats, { itemId: 'c', sectionId: 'chats', beforeId: 'a', index: 0 });
  assert.deepEqual(
    within.map((chat) => chat.id),
    ['p', 'c', 'a', 'b'],
  );
  const pinned = reorder(chats, { itemId: 'b', sectionId: 'pinned', beforeId: undefined, index: 1 });
  assert.deepEqual(
    pinned.map((chat) => [chat.id, chat.pinned]),
    [
      ['p', true],
      ['b', true],
      ['a', false],
      ['c', false],
    ],
  );
  const unpinned = reorder(chats, { itemId: 'p', sectionId: 'chats', beforeId: undefined, index: 3 });
  assert.equal(unpinned.at(-1)?.id, 'p');
  assert.equal(unpinned.at(-1)?.pinned, false);
  assert.equal(chatSections(unpinned)[0]?.itemIds.length, 0);
});

test('the @ picker searches the project files, names first, bounded', () => {
  const project = {
    pages: ['src/pages/index.astro', 'src/pages/about.astro'],
    components: [{ file: 'src/components/Hero.astro' }, { file: 'src/pages/index.astro' }],
    assets: ['public/logo.svg', '../outside.svg'],
  };
  const files = mentionFiles(
    { ...project, components: project.components.map((component) => ({ ...component, name: 'x' }) as never) },
    'src/components/Hero.astro',
  );
  assert.deepEqual(files, ['src/components/Hero.astro', 'src/pages/index.astro', 'src/pages/about.astro', 'public/logo.svg']);
  assert.deepEqual(matchFiles(files, 'in', 12), ['src/pages/index.astro']);
  assert.deepEqual(matchFiles(files, 'pages/ab', 12), ['src/pages/about.astro']);
  assert.equal(
    matchFiles(
      Array.from({ length: 50 }, (_, index) => `src/f${index}.astro`),
      '',
      12,
    ).length,
    12,
  );
  assert.equal(sameDraft(textSegments('a'), textSegments('a')), true);
  assert.equal(sameDraft(textSegments('a'), textSegments('b')), false);
});

test('durations and ages read the way the transcript and the list show them', () => {
  assert.equal(formatDuration(1400), '1.4s');
  assert.equal(formatDuration(12_300), '12s');
  assert.equal(formatDuration(77_000), '1m 17s');
  assert.equal(formatDuration(-5), '0.0s');
  assert.equal(ageLabel(0, 1000), '');
  assert.equal(ageLabel(1000, 1000), 'now');
  assert.equal(ageLabel(0 + 1, 5 * 60_000 + 1), '5m');
  assert.equal(ageLabel(1, 3 * 3_600_000 + 1), '3h');
  assert.equal(ageLabel(1, 2 * 86_400_000 + 1), '2d');
});
