// Goal: the chat index (version 2) keeps its promises. A version 1 file from an
// older build reads as version 2 with the list the person last saw; a bad record
// loses only itself; the list operations (move, pin, archive, sections, fork)
// keep every section's ranks a permutation 0..n-1 with pinned chats first, never
// lose or duplicate a chat, and refuse what cannot be applied without writing.
// Methodology: real modules from dist/. A hand-written version 1 index (the exact
// shape the previous build wrote) goes through `parseChatIndex` and a real
// ChatStore on a temporary folder (round trip, write-back, read-back assertion);
// then seeded random sequences of operations check the invariants after each step,
// and each named behaviour (snap to the pinned boundary, section delete, fork copy)
// has its own case. Assertion messages are pinned where a violation throws.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { toChatId, toSectionId, toTurnId, type ChatId, type SectionId } from '#dist/shared/properties/ai/chatModel.js';
import {
  ChatStore,
  chainOperations,
  collapseSection,
  createSection,
  deleteSection,
  forkEvents,
  forkRecord,
  listOf,
  moveChat,
  moveSection,
  normalizeIndex,
  parseChatIndex,
  renameSection,
  setArchived,
  setPinned,
  setUnread,
  type ChatIndex,
  type ChatRecord,
} from '#dist/electron/handlers/ai/chatStore.js';

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-chatstore-${name}-`));
}

function id(position: number): ChatId {
  return toChatId(`c${position.toString(16).padStart(24, '0')}`);
}

function sid(position: number): SectionId {
  return toSectionId(`s${position.toString(16).padStart(16, '0')}`);
}

interface RecordChange {
  readonly pinned?: boolean;
  readonly section?: SectionId | undefined;
  readonly archivedAt?: number;
  readonly title?: string;
  readonly sessionId?: string;
}

function record(position: number, change: RecordChange = {}): ChatRecord {
  return {
    id: id(position),
    agent: 'claude',
    title: `Chat ${position}`,
    pinned: false,
    createdAt: position,
    updatedAt: position,
    section: undefined,
    rank: position,
    archivedAt: undefined,
    unread: false,
    context: undefined,
    forkOf: undefined,
    sessionId: undefined,
    settings: [],
    ...change,
  };
}

function index(chats: readonly ChatRecord[], sections: ChatIndex['sections'] = []): ChatIndex {
  return normalizeIndex({ version: 2, trusted: true, sections, chats });
}

/** The ids of one section's chats in display order. */
function order(value: ChatIndex, section: SectionId | undefined): readonly number[] {
  return value.chats
    .filter((chat) => chat.section === section)
    .sort((left, right) => left.rank - right.rank)
    .map((chat) => Number.parseInt(chat.id.slice(1), 16));
}

/** The invariants every operation must keep. */
function checkInvariants(value: ChatIndex, expectedIds: readonly ChatId[]): void {
  assert.deepEqual([...value.chats.map((chat) => chat.id)].sort(), [...expectedIds].sort(), 'no chat is lost or duplicated');
  const groups = new Map<SectionId | undefined, ChatRecord[]>();
  for (const chat of value.chats) {
    if (chat.section !== undefined) {
      assert.ok(
        value.sections.some((section) => section.id === chat.section),
        'every chat is in a section that exists',
      );
    }
    groups.set(chat.section, [...(groups.get(chat.section) ?? []), chat]);
  }
  for (const group of groups.values()) {
    assert.deepEqual(
      group.map((chat) => chat.rank).sort((left, right) => left - right),
      group.map((_, position) => position),
      'ranks are a permutation 0..n-1',
    );
    const sorted = [...group].sort((left, right) => left.rank - right.rank);
    const firstUnpinned = sorted.findIndex((chat) => !chat.pinned);
    assert.ok(firstUnpinned === -1 || sorted.slice(firstUnpinned).every((chat) => !chat.pinned), 'pinned chats come first');
  }
  assert.deepEqual(
    value.sections.map((section) => section.rank),
    value.sections.map((_, position) => position),
    'section ranks are 0..n-1',
  );
}

// A version 1 index exactly as the previous build wrote it: newest chat first, no sections.
const LEGACY_INDEX = JSON.stringify({
  version: 1,
  trusted: true,
  chats: [
    {
      id: id(3),
      agent: 'claude',
      title: 'Newest',
      pinned: false,
      createdAt: 30,
      updatedAt: 90,
      sessionId: 'session-3',
      settings: [{ option: 'model', value: 'opus' }],
    },
    { id: id(2), agent: 'codex', title: 'Pinned old', pinned: true, createdAt: 20, updatedAt: 20, sessionId: undefined, settings: [] },
    { id: 'c-broken', agent: 'claude', title: 'Bad id', pinned: false, createdAt: 1, updatedAt: 1 },
    { id: id(1), agent: 'claude', title: 'Oldest', pinned: false, createdAt: 10, updatedAt: 40 },
  ],
});

test('a version 1 index reads as version 2 in the order the person saw, dropping only the bad record', () => {
  const migrated = parseChatIndex(LEGACY_INDEX);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.trusted, true);
  assert.deepEqual(migrated.sections, []);
  assert.equal(migrated.chats.length, 3, 'the record with a bad id is lost alone');
  // Pinned first, then the most recently updated: the order the v1 list was drawn in.
  assert.deepEqual(order(migrated, undefined), [2, 3, 1]);
  const newest = migrated.chats.find((chat) => chat.id === id(3));
  assert.equal(newest?.sessionId, 'session-3');
  assert.deepEqual(newest?.settings, [{ option: 'model', value: 'opus' }]);
  assert.equal(newest?.unread, false);
  assert.equal(newest?.archivedAt, undefined);
  assert.equal(newest?.context, undefined);
  checkInvariants(migrated, [1, 2, 3].map(id));
});

test('migration is written back as version 2 on the next write, and reads the same afterwards', () => {
  const root = temporary('migrate');
  const project = temporary('migrate-project');
  const store = new ChatStore(path.join(root, 'ai'));
  const file = path.join(store.projectDirectory(project), 'index.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, LEGACY_INDEX);
  const before = store.list(project);
  const legacyFile: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(typeof legacyFile === 'object' && legacyFile !== null && 'version' in legacyFile);
  assert.equal(legacyFile.version, 1, 'reading alone leaves the old file as it was');
  store.trust(project);
  const written: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(typeof written === 'object' && written !== null && 'version' in written);
  assert.equal(written.version, 2);
  assert.deepEqual(store.list(project), before, 'the list is the same before and after the write-back');
  assert.equal(
    store
      .list(project)
      .chats.map((chat) => chat.title)
      .join(','),
    'Pinned old,Newest,Oldest',
  );
});

test('a transcript written by the previous build still loads after the migration', () => {
  const root = temporary('transcript');
  const project = temporary('transcript-project');
  const store = new ChatStore(path.join(root, 'ai'));
  const file = path.join(store.projectDirectory(project), 'index.json');
  fs.mkdirSync(path.join(path.dirname(file), 'chats'), { recursive: true });
  fs.writeFileSync(file, LEGACY_INDEX);
  const turn = toTurnId(`t${'4'.repeat(16)}`);
  // Events without timings, parts or the compaction kind, as v1 stored them.
  fs.writeFileSync(
    path.join(path.dirname(file), 'chats', `${id(3)}.jsonl`),
    [
      { kind: 'turn-start', turn, at: 1 },
      { kind: 'user', turn, text: 'hello', attachments: [], at: 1 },
      { kind: 'text', turn, role: 'agent', text: 'hi' },
      { kind: 'tool', turn, call: 'k', status: 'completed' },
      { kind: 'turn-end', turn, stop: 'end_turn', at: 2 },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n') + '\n',
  );
  assert.equal(store.read(project, id(3)).events.length, 5);
});

test('anything that is not a readable index of a known version reads as empty', () => {
  for (const source of ['', '{broken', '[]', '{"version":3,"chats":[]}', '{"version":2}', '{"version":0,"chats":[]}', 'null']) {
    const parsed = parseChatIndex(source);
    assert.deepEqual([parsed.version, parsed.trusted, parsed.chats.length, parsed.sections.length], [2, false, 0, 0], source);
  }
});

test('a version 2 index drops a bad record or section alone and sends orphaned chats to the first section', () => {
  const good = record(1, { section: sid(1) });
  const orphan = record(2, { section: sid(9) });
  const source = JSON.stringify({
    version: 2,
    trusted: false,
    sections: [{ id: sid(1), name: 'Launch', collapsed: true, rank: 0 }, { id: 'nope' }, { id: sid(1), name: 'Twin', collapsed: false, rank: 1 }],
    chats: [good, orphan, { ...record(3), rank: 'first' }, { ...record(4), unread: undefined }],
  });
  const parsed = parseChatIndex(source);
  assert.deepEqual(
    parsed.sections.map((section) => [section.name, section.collapsed]),
    [['Launch', true]],
    'the bad section and the repeated id are dropped',
  );
  assert.deepEqual(
    parsed.chats.map((chat) => [chat.id, chat.section]),
    [
      [id(1), sid(1)],
      [id(2), undefined],
    ],
  );
});

test('the store creates at the top, reads back what it wrote and holds the chat bound', () => {
  const store = new ChatStore(path.join(temporary('create'), 'ai'));
  const project = temporary('create-project');
  const first = store.create(project, 'claude', 'First', 1);
  const second = store.create(project, 'codex', 'Second', 2, [{ option: 'model', value: 'x' }]);
  assert.ok(first !== undefined && second !== undefined);
  assert.deepEqual(
    store.list(project).chats.map((chat) => chat.title),
    ['Second', 'First'],
  );
  store.update(project, first.id, (current) => ({ ...current, pinned: true }));
  assert.deepEqual(
    store.list(project).chats.map((chat) => chat.title),
    ['First', 'Second'],
    'a pinned chat is moved ahead by normalization',
  );
  for (let count = 2; count < AI_LIMITS.chatsMax; count++) {
    assert.ok(store.create(project, 'claude', `c${count}`, 3) !== undefined);
  }
  assert.equal(store.create(project, 'claude', 'one too many', 3), undefined);
  assert.throws(
    () =>
      store.writeIndex(project, {
        version: 2,
        trusted: false,
        sections: Array.from({ length: AI_LIMITS.sectionsMax + 1 }, (_, position) => ({
          id: sid(position),
          name: `S${position}`,
          collapsed: false,
          rank: position,
        })),
        chats: [],
      }),
    /Assertion failed: writeIndex: the sections are bounded/,
  );
});

test('move: into a section, before a chat, to the end; on itself nothing changes', () => {
  const sections = [
    { id: sid(1), name: 'A', collapsed: false, rank: 0 },
    { id: sid(2), name: 'B', collapsed: false, rank: 1 },
  ];
  const start = index([record(1), record(2), record(3), record(4, { section: sid(1) })], sections);
  assert.deepEqual(order(start, undefined), [1, 2, 3]);
  const toEnd = moveChat(start, id(1), undefined, undefined);
  assert.ok(toEnd.ok);
  assert.deepEqual(order(normalizeIndex(toEnd.value), undefined), [2, 3, 1]);
  const before = moveChat(start, id(3), undefined, id(1));
  assert.ok(before.ok);
  assert.deepEqual(order(normalizeIndex(before.value), undefined), [3, 1, 2]);
  const across = moveChat(start, id(2), sid(1), id(4));
  assert.ok(across.ok);
  const moved = normalizeIndex(across.value);
  assert.deepEqual(order(moved, sid(1)), [2, 4]);
  assert.deepEqual(order(moved, undefined), [1, 3], 'the section it left is renumbered');
  const same = moveChat(start, id(2), undefined, id(2));
  assert.ok(same.ok);
  assert.equal(same.value, start, 'dropping on itself is a no-op');
  const empty = moveChat(start, id(1), sid(2), undefined);
  assert.ok(empty.ok);
  assert.deepEqual(order(normalizeIndex(empty.value), sid(2)), [1], 'into an empty section');
});

test('move refuses what cannot be applied: no chat, no section, an anchor elsewhere, an archived chat', () => {
  const start = index([record(1), record(2, { section: sid(1) }), record(3, { archivedAt: 5 })], [{ id: sid(1), name: 'A', collapsed: false, rank: 0 }]);
  const cases: readonly [string, ReturnType<typeof moveChat>, string][] = [
    ['unknown chat', moveChat(start, id(99), undefined, undefined), 'chat-missing'],
    ['unknown section', moveChat(start, id(1), sid(9), undefined), 'section-missing'],
    ['unknown anchor', moveChat(start, id(1), undefined, id(99)), 'chat-missing'],
    ['anchor in another section', moveChat(start, id(1), undefined, id(2)), 'invalid'],
    ['archived chat', moveChat(start, id(3), undefined, undefined), 'invalid'],
  ];
  for (const [name, result, code] of cases) {
    assert.ok(!result.ok, name);
    assert.equal(result.error.code, code, name);
  }
});

test('a drop among the wrong group lands at the pinned boundary', () => {
  const start = index([record(1, { pinned: true }), record(2, { pinned: true }), record(3), record(4)]);
  assert.deepEqual(order(start, undefined), [1, 2, 3, 4]);
  const unpinnedAmongPinned = moveChat(start, id(4), undefined, id(1));
  assert.ok(unpinnedAmongPinned.ok);
  assert.deepEqual(order(normalizeIndex(unpinnedAmongPinned.value), undefined), [1, 2, 4, 3], 'an unpinned chat stops at the boundary and is not pinned');
  assert.equal(normalizeIndex(unpinnedAmongPinned.value).chats.find((chat) => chat.id === id(4))?.pinned, false);
  const pinnedAmongUnpinned = moveChat(start, id(1), undefined, undefined);
  assert.ok(pinnedAmongUnpinned.ok);
  assert.deepEqual(order(normalizeIndex(pinnedAmongUnpinned.value), undefined), [2, 1, 3, 4], 'a pinned chat dropped last stays the last pinned one');
});

test('pin, archive and unread change one chat; archiving keeps its place for a restore', () => {
  const start = index([record(1), record(2), record(3)]);
  const pinned = setPinned(start, id(3), { pinned: true });
  assert.ok(pinned.ok);
  assert.deepEqual(order(normalizeIndex(pinned.value), undefined), [3, 1, 2], 'a pinned chat goes to the top');
  const unpinned = setPinned(normalizeIndex(pinned.value), id(3), { pinned: false });
  assert.ok(unpinned.ok);
  assert.deepEqual(order(normalizeIndex(unpinned.value), undefined), [3, 1, 2], 'an unpinned chat goes to the top of the rest');
  const archived = chainOperations(start, [(current) => setArchived(current, id(2), 77), (current) => setUnread(current, id(1), { unread: true })]);
  assert.ok(archived.ok);
  const restored = setArchived(archived.value, id(2), undefined);
  assert.ok(restored.ok);
  assert.deepEqual(order(normalizeIndex(restored.value), undefined), [1, 2, 3]);
  assert.equal(archived.value.chats.find((chat) => chat.id === id(1))?.unread, true);
  assert.equal(archived.value.chats.find((chat) => chat.id === id(2))?.archivedAt, 77);
  for (const result of [setPinned(start, id(99), { pinned: true }), setArchived(start, id(99), 1), setUnread(start, id(99), { unread: true })]) {
    assert.ok(!result.ok && result.error.code === 'chat-missing');
  }
  const stopped = chainOperations(start, [(current) => setUnread(current, id(99), { unread: true }), (current) => setUnread(current, id(1), { unread: true })]);
  assert.ok(!stopped.ok, 'a chain stops at the first refusal');
});

test('sections: create, unique names, rename, collapse, move and delete keep every chat', () => {
  let current = index(
    [record(1), record(2, { section: sid(1) }), record(3, { section: sid(1), pinned: true })],
    [{ id: sid(1), name: 'Launch', collapsed: false, rank: 0 }],
  );
  const created = createSection(current, sid(2), 'Later');
  assert.ok(created.ok);
  current = created.value;
  assert.deepEqual(
    current.sections.map((section) => section.name),
    ['Launch', 'Later'],
  );
  for (const name of ['launch', ' LAUNCH ']) {
    const duplicate = createSection(current, sid(3), name);
    assert.ok(!duplicate.ok && duplicate.error.code === 'invalid', name);
  }
  const renamedTwin = renameSection(current, sid(2), 'launch');
  assert.ok(!renamedTwin.ok && renamedTwin.error.code === 'invalid');
  const renamed = renameSection(current, sid(1), 'LAUNCH');
  assert.ok(renamed.ok, 'a section may change only the case of its own name');
  const collapsed = collapseSection(current, sid(1), { collapsed: true });
  assert.ok(collapsed.ok);
  assert.equal(collapsed.value.sections[0]?.collapsed, true);
  const reordered = moveSection(current, sid(2), sid(1));
  assert.ok(reordered.ok);
  assert.deepEqual(
    normalizeIndex(reordered.value).sections.map((section) => section.name),
    ['Later', 'Launch'],
  );
  const toEnd = moveSection(normalizeIndex(reordered.value), sid(2), undefined);
  assert.ok(toEnd.ok);
  assert.deepEqual(
    normalizeIndex(toEnd.value).sections.map((section) => section.name),
    ['Launch', 'Later'],
  );
  const deleted = deleteSection(current, sid(1));
  assert.ok(deleted.ok);
  const after = normalizeIndex(deleted.value);
  assert.deepEqual(order(after, undefined), [3, 1, 2], 'its chats follow the first section’s own, the pinned one first, none deleted');
  assert.deepEqual(
    after.sections.map((section) => section.id),
    [sid(2)],
  );
  for (const result of [
    renameSection(current, sid(9), 'x'),
    collapseSection(current, sid(9), { collapsed: true }),
    moveSection(current, sid(9), undefined),
    deleteSection(current, sid(9)),
    moveSection(current, sid(1), sid(9)),
  ]) {
    assert.ok(!result.ok && result.error.code === 'section-missing');
  }
  let full = index([]);
  for (let position = 0; position < AI_LIMITS.sectionsMax; position++) {
    const next = createSection(full, sid(position), `S${position}`);
    assert.ok(next.ok);
    full = next.value;
  }
  const over = createSection(full, sid(999), 'one too many');
  assert.ok(!over.ok && over.error.code === 'invalid');
});

test('property: any sequence of operations keeps the invariants and loses no chat', () => {
  let seed = 20_261_111;
  const random = (bound: number): number => {
    seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
    return Math.floor((seed / 4_294_967_296) * bound);
  };
  const ids = Array.from({ length: 12 }, (_, position) => id(position + 1));
  const sectionIds = [sid(1), sid(2), sid(3)];
  for (let run = 0; run < 30; run++) {
    let current = index(
      ids.map((chat, position) => record(position + 1, { pinned: random(4) === 0, section: random(3) === 0 ? sectionIds[random(3)] : undefined })),
      [],
    );
    for (let step = 0; step < 60; step++) {
      const chat = ids[random(ids.length)] ?? id(1);
      const section = sectionIds[random(sectionIds.length)] ?? sid(1);
      const anchor = random(3) === 0 ? undefined : (ids[random(ids.length)] ?? id(1));
      const candidates = [
        moveChat(current, chat, random(2) === 0 ? undefined : section, anchor),
        setPinned(current, chat, { pinned: random(2) === 0 }),
        setArchived(current, chat, random(2) === 0 ? 5 : undefined),
        createSection(current, section, `Section ${random(5)}`),
        deleteSection(current, section),
        moveSection(current, section, random(2) === 0 ? undefined : sectionIds[random(3)]),
      ];
      const attempt = candidates[random(candidates.length)];
      assert.ok(attempt !== undefined);
      if (attempt.ok) {
        current = normalizeIndex(attempt.value);
      }
      checkInvariants(current, ids);
    }
  }
});

test('fork: right below the original, unpinned, no session; the copy settles pending reviews', () => {
  const start = index([record(1), record(2, { pinned: true, sessionId: 'abc', title: 'Hero' }), record(3)]);
  const forked = forkRecord(start, id(2), id(9), 500);
  assert.ok(forked.ok);
  assert.equal(forked.value.record.title, 'Hero (fork)');
  assert.equal(forked.value.record.forkOf, id(2));
  assert.equal(forked.value.record.sessionId, undefined);
  assert.equal(forked.value.record.pinned, false);
  assert.equal(forked.value.record.createdAt, 500);
  assert.deepEqual(order(forked.value.index, undefined), [2, 9, 1, 3], 'the fork is the first unpinned chat, just below its pinned original');
  checkInvariants(forked.value.index, [1, 2, 3, 9].map(id));
  const plainFork = forkRecord(index([record(1), record(2), record(3)]), id(1), id(9), 500);
  assert.ok(plainFork.ok);
  assert.deepEqual(order(plainFork.value.index, undefined), [1, 9, 2, 3]);
  const missing = forkRecord(start, id(99), id(9), 1);
  assert.ok(!missing.ok && missing.error.code === 'chat-missing');
  const full = forkRecord(index(Array.from({ length: AI_LIMITS.chatsMax }, (_, position) => record(position + 1))), id(1), id(9999), 1);
  assert.ok(!full.ok && full.error.code === 'read-only');
  const turn = toTurnId(`t${'5'.repeat(16)}`);
  const copied = forkEvents([
    {
      kind: 'changes',
      turn,
      files: [
        { path: 'a', change: 'modified', review: 'pending' },
        { path: 'b', change: 'created', review: 'undone' },
      ],
    },
    { kind: 'notice', severity: 'info', text: 'n' },
  ]);
  assert.deepEqual(copied[0], {
    kind: 'changes',
    turn,
    files: [
      { path: 'a', change: 'modified', review: 'kept' },
      { path: 'b', change: 'created', review: 'undone' },
    ],
  });
  assert.equal(copied[1]?.kind, 'notice');
});

test('the store forks a transcript, and a deleted chat leaves the others ranked 0..n-1', () => {
  const store = new ChatStore(path.join(temporary('fork'), 'ai'));
  const project = temporary('fork-project');
  const original = store.create(project, 'claude', 'Original', 1);
  assert.ok(original !== undefined);
  const turn = toTurnId(`t${'6'.repeat(16)}`);
  store.append(project, original.id, [
    { kind: 'turn-start', turn, at: 1 },
    { kind: 'changes', turn, files: [{ path: 'a.md', change: 'modified', review: 'pending' }] },
    { kind: 'turn-end', turn, stop: 'end_turn', message: undefined, at: 2 },
  ]);
  const forked = store.fork(project, original.id, 50);
  assert.ok(forked.ok);
  const events = store.read(project, forked.value.id).events;
  assert.deepEqual(
    events.map((event) => event.kind),
    ['turn-start', 'changes', 'turn-end'],
  );
  const changes = events[1];
  assert.ok(changes?.kind === 'changes');
  assert.equal(changes.files[0]?.review, 'kept');
  assert.equal(store.read(project, original.id).events.length, 3, 'the original is untouched');
  assert.deepEqual(
    store.list(project).chats.map((chat) => [chat.title, chat.rank]),
    [
      ['Original', 0],
      ['Original (fork)', 1],
    ],
  );
  store.delete(project, original.id);
  assert.deepEqual(
    store.list(project).chats.map((chat) => chat.rank),
    [0],
  );
  assert.ok(!store.fork(project, id(77), 1).ok);
});

test('mutate writes only when the operation succeeds, and the list reply carries sections', () => {
  const store = new ChatStore(path.join(temporary('mutate'), 'ai'));
  const project = temporary('mutate-project');
  const chat = store.create(project, 'claude', 'One', 1);
  assert.ok(chat !== undefined);
  const file = path.join(store.projectDirectory(project), 'index.json');
  const before = fs.readFileSync(file, 'utf8');
  const refused = store.mutate(project, (current) => moveChat(current, id(99), undefined, undefined));
  assert.ok(!refused.ok);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'a refusal writes nothing');
  const made = store.mutate(project, (current) => createSection(current, sid(1), 'Launch'));
  assert.ok(made.ok);
  assert.deepEqual(
    listOf(made.value).sections.map((section) => section.name),
    ['Launch'],
  );
  assert.equal(store.list(project).sections.length, 1);
});
