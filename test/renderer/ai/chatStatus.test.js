// Goal: the words and colours the panel puts on the agent's progress are fixed by pure functions,
// so the composer and the transcript say the same thing and a change to one is a test failure.
// Covered: the context ring's tone at and around its thresholds (70% amber, 90% red, unknown without
// a window); durations (`1.4s`, `12s`, `1m 17s`, `1h 2m`, never negative); the line under a running
// turn (the phase from the newest event, the live timer, a slow rotation of neutral verbs, "worked
// for" afterwards, nothing for a turn this view did not see begin); the one-line summary of a group
// of tool calls; and the list move behind a drag or Alt+Arrow (a permutation, bounded).
// Method: bundle the modules with esbuild and drive them with fixed clock readings and views built
// by the real reducer, plus a seeded generator for the move.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { contextTone, contextPercent, formatDuration, buildTurnStatus, activityHeadline } = loadRenderer('src/features/ai/chatStatus.ts');
const { moveInList } = loadRenderer('src/features/ai/moveInList.ts');
const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');

const TURN = `t${'1'.repeat(16)}`;
const start = { kind: 'turn-start', turn: TURN, at: 1000 };
const tool = (over) => ({
  kind: 'tool',
  turn: TURN,
  call: 'c1',
  title: undefined,
  toolKind: undefined,
  status: 'in_progress',
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  ...over,
});

test('the ring is neutral below 70%, amber from 70%, red from 90%, unknown without a window', () => {
  assert.equal(contextTone(0, 1000), 'neutral');
  assert.equal(contextTone(699, 1000), 'neutral');
  assert.equal(contextTone(700, 1000), 'amber');
  assert.equal(contextTone(899, 1000), 'amber');
  assert.equal(contextTone(900, 1000), 'red');
  assert.equal(contextTone(5000, 1000), 'red', 'past the window is still red');
  assert.equal(contextTone(10, 0), 'unknown');
  assert.equal(contextTone(-1, 1000), 'unknown');
  assert.equal(contextTone(41_250, 1_000_000), 'neutral');
  assert.throws(() => contextTone(Number.NaN, 1000), /finite/);
  assert.throws(() => contextTone(1, Number.POSITIVE_INFINITY), /finite/);
});

test('the share of the window is rounded down, and absent while the window is unknown', () => {
  assert.equal(contextPercent(41_250, 1_000_000), 4);
  assert.equal(contextPercent(999, 1000), 99);
  assert.equal(contextPercent(1, 0), undefined);
  assert.equal(contextPercent(-5, 100), undefined);
});

test('durations read as people say them', () => {
  assert.equal(formatDuration(0), '0.0s');
  assert.equal(formatDuration(1400), '1.4s');
  assert.equal(formatDuration(9999), '9.9s');
  assert.equal(formatDuration(10_000), '10s');
  assert.equal(formatDuration(12_900), '12s');
  assert.equal(formatDuration(77_000), '1m 17s');
  assert.equal(formatDuration(60_000), '1m 0s');
  assert.equal(formatDuration(184_000), '3m 4s');
  assert.equal(formatDuration(3_720_000), '1h 2m');
  assert.equal(formatDuration(-500), '0.0s', 'a clock that ran backwards shows nothing negative');
  assert.throws(() => formatDuration(Number.NaN), /finite/);
});

test('a running turn says what it is doing from its newest event, with a live timer', () => {
  const running = (events) => reduceChat(EMPTY_CHAT, [start, ...events]);
  const label = (view, now = 5000) => buildTurnStatus(view, now).label;
  assert.equal(label(running([tool({ toolKind: 'execute' })])), 'Running a command');
  assert.equal(label(running([tool({ toolKind: 'read' })])), 'Reading files');
  assert.equal(label(running([tool({ toolKind: 'search' })])), 'Searching');
  assert.equal(label(running([tool({ toolKind: 'edit' })])), 'Editing files');
  assert.equal(label(running([tool({ toolKind: 'delete' })])), 'Editing files');
  assert.equal(label(running([tool({ toolKind: 'fetch' })])), 'Fetching');
  assert.equal(label(running([{ kind: 'text', turn: TURN, role: 'thought', text: 'hm' }])), 'Thinking');
  assert.equal(label(running([{ kind: 'permission', turn: TURN, request: 'p1', call: 'c', title: 'Edit', options: [] }])), 'Waiting for you');
  assert.equal(label(running([{ kind: 'compaction', turn: TURN, id: 'k', status: 'in_progress', at: 1 }])), 'Compacting conversation');
  const status = buildTurnStatus(running([tool({ toolKind: 'execute' })]), 78_000);
  assert.deepEqual([status.kind, status.phase, status.elapsedMs], ['running', 'command', 77_000]);
  assert.equal(formatDuration(status.elapsedMs), '1m 17s');
  // A finished call or the agent's own text is between steps: a slow rotation of neutral verbs.
  const between = running([tool({ toolKind: 'execute', status: 'completed' })]);
  const verbs = new Set([0, 4000, 8000, 12_000].map((now) => buildTurnStatus(between, now).label));
  assert.deepEqual([...verbs].sort(), ['Looking around', 'Thinking it through', 'Working']);
  assert.equal(buildTurnStatus(between, 100).label, buildTurnStatus(between, 3900).label, 'the verb holds for four seconds');
  assert.equal(buildTurnStatus(between, 100).phase, 'working');
});

test('a turn this view did not see begin has no timer, and a clock behind the start shows zero', () => {
  const view = { ...reduceChat(EMPTY_CHAT, [tool({ toolKind: 'read' })]), running: TURN };
  assert.equal(buildTurnStatus(view, 5000).elapsedMs, undefined);
  const early = reduceChat(EMPTY_CHAT, [start]);
  assert.equal(buildTurnStatus(early, 500).elapsedMs, 0);
});

test('after a turn the line says how long it worked; an idle chat and a turn of unknown start say nothing', () => {
  const done = reduceChat(EMPTY_CHAT, [start, { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 185_000 }]);
  assert.deepEqual(buildTurnStatus(done, 999_999), { kind: 'worked', elapsedMs: 184_000 });
  assert.equal(formatDuration(184_000), '3m 4s');
  assert.deepEqual(buildTurnStatus(EMPTY_CHAT, 1), { kind: 'idle' });
  const unknown = reduceChat(EMPTY_CHAT, [{ kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 9 }]);
  assert.deepEqual(buildTurnStatus(unknown, 10), { kind: 'idle' });
  assert.throws(() => buildTurnStatus(EMPTY_CHAT, Number.NaN), /finite/);
});

test('a group of tool calls reads as one line', () => {
  const items = (events) => reduceChat(EMPTY_CHAT, events).items;
  const calls = [
    ...[1, 2, 3, 4].map((index) => tool({ call: `run${index}`, toolKind: 'execute', status: 'completed' })),
    tool({ call: 'e1', toolKind: 'edit', status: 'completed', paths: ['a.ts'] }),
    tool({
      call: 'e2',
      toolKind: 'edit',
      status: 'completed',
      diffs: [
        { path: 'a.ts', oldText: 'x', newText: 'y' },
        { path: 'b.ts', oldText: undefined, newText: 'z' },
      ],
    }),
    ...[1, 2, 3, 4, 5, 6].map((index) => tool({ call: `r${index}`, toolKind: 'read', status: 'completed', paths: [`f${index}.ts`] })),
  ];
  assert.equal(activityHeadline(items(calls)), 'Ran 4 commands, edited 2 files, read 6 files');
  assert.equal(activityHeadline(items([tool({ toolKind: 'execute' })])), 'Ran 1 command');
  assert.equal(activityHeadline(items([tool({ toolKind: 'search' }), tool({ call: 'x', toolKind: 'fetch' })])), 'Searched 1 time, fetched 1 page');
  assert.equal(activityHeadline(items([tool({ toolKind: 'other' })])), 'Used 1 tool');
  assert.equal(
    activityHeadline(items([tool({ toolKind: 'edit' }), tool({ call: 'y', toolKind: 'edit' })])),
    'Edited 2 files',
    'a call that names no file counts once',
  );
  assert.equal(activityHeadline(items([tool({ toolKind: 'read', paths: ['a.ts'] }), tool({ call: 'z', toolKind: 'read', paths: ['a.ts'] })])), 'Read 1 file');
  assert.equal(activityHeadline([]), '');
  assert.equal(
    activityHeadline(items([tool({ toolKind: 'think' }), { kind: 'text', turn: TURN, role: 'agent', text: 'hi' }])),
    '',
    'thinking and text are not activity',
  );
});

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

test('moving a list entry is a permutation that ends the entry where asked and keeps the others in order', () => {
  const next = random(7);
  for (let round = 0; round < 300; round++) {
    const length = 1 + Math.floor(next() * 12);
    const items = Array.from({ length }, (_, index) => `item${index}`);
    const from = Math.floor(next() * length);
    const to = Math.floor(next() * length);
    const moved = moveInList(items, from, to);
    assert.equal(moved.length, length);
    assert.deepEqual([...moved].sort(), [...items].sort(), 'the same entries');
    assert.equal(moved[to], items[from], 'the entry lands at the index asked');
    assert.deepEqual(
      moved.filter((entry) => entry !== items[from]),
      items.filter((entry) => entry !== items[from]),
      'the others keep their order',
    );
    assert.deepEqual(
      items,
      Array.from({ length }, (_, index) => `item${index}`),
      'the input is not changed',
    );
  }
  const same = ['a', 'b'];
  assert.equal(moveInList(same, 1, 1), same, 'moving onto itself is the list as it is');
});

test('moving outside the list is a programmer error', () => {
  assert.throws(() => moveInList(['a', 'b'], 2, 0), /from is inside the list/);
  assert.throws(() => moveInList(['a', 'b'], 0, 2), /to is inside the list/);
  assert.throws(() => moveInList(['a', 'b'], -1, 0), /from is not negative/);
  assert.throws(() => moveInList(['a', 'b'], 0, 0.5), /to is an integer/);
  assert.throws(() => moveInList([], 0, 0), /inside the list/);
});
