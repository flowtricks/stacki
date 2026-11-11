// Goal: the AI panel's transcript fold is a pure, order-preserving reduction.
// Properties over random event streams: folding in any batching equals folding
// one event at a time; each tool call is one item however many updates it gets,
// and its output is the concatenation of what was sent; streamed agent text is
// never lost or reordered; the transcript never has more items than events; a
// turn's end clears exactly that running turn; reviews only settle files the
// turn changed.
// Method: bundle the reducer with esbuild and drive it with a seeded generator
// (a small xorshift, so a failing seed reproduces) over 400 streams, plus
// directed cases for permissions, reviews and duplicate notices.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { EMPTY_CHAT, reduceChat, applyEvent, waitingPermissions, pendingChanges } = loadRenderer('src/features/ai/chatReducer.ts');
const { matchingCommands } = loadRenderer('src/features/ai/ChatComposer.tsx');
const { lineDiff, compactRows } = loadRenderer('src/features/ai/lineDiff.ts');
const { filterChats, sortChats } = loadRenderer('src/features/ai/ChatList.tsx');

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

const turnId = (index) => `t${index.toString(16).padStart(16, '0')}`;

function stream(seed) {
  const next = random(seed);
  const pick = (values) => values[Math.floor(next() * values.length)];
  const events = [];
  let turn = 0;
  const length = 1 + Math.floor(next() * 60);
  for (let index = 0; index < length; index++) {
    const roll = next();
    const current = turnId(turn);
    if (roll < 0.1) {
      turn += 1;
      events.push({ kind: 'turn-start', turn: turnId(turn), at: index });
      events.push({ kind: 'user', turn: turnId(turn), text: `ask ${index}`, attachments: [], at: index });
    } else if (roll < 0.45) {
      events.push({ kind: 'text', turn: current, role: pick(['agent', 'thought']), text: pick(['a', 'bc', ' ', 'def']) });
    } else if (roll < 0.75) {
      events.push({
        kind: 'tool',
        turn: current,
        call: pick(['c1', 'c2', 'c3']),
        title: pick([undefined, 'Read', 'Edit']),
        toolKind: pick([undefined, 'read', 'edit']),
        status: pick([undefined, 'pending', 'completed']),
        paths: undefined,
        diffs: undefined,
        output: pick([undefined, 'x', 'yz']),
        exitCode: undefined,
        parent: undefined,
      });
    } else if (roll < 0.85) {
      events.push({ kind: 'turn-end', turn: current, stop: pick(['end_turn', 'cancelled', 'error']), message: undefined, at: index });
    } else if (roll < 0.95) {
      events.push({ kind: 'usage', used: index, size: 100 });
    } else {
      events.push({ kind: 'notice', severity: 'info', text: 'n' });
    }
  }
  return { events, next };
}

test('batching never changes the fold', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { events, next } = stream(seed);
    const single = events.reduce((view, event) => applyEvent(view, event), EMPTY_CHAT);
    let batched = EMPTY_CHAT;
    let index = 0;
    while (index < events.length) {
      const size = 1 + Math.floor(next() * 8);
      batched = reduceChat(batched, events.slice(index, index + size));
      index += size;
    }
    assert.deepEqual(batched, single, `seed ${seed}`);
  }
});

test('tool calls stay one item each, text is never lost, and the transcript is bounded by its events', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { events } = stream(seed);
    const view = reduceChat(EMPTY_CHAT, events);
    assert.ok(view.items.length <= events.length, `seed ${seed}: items`);
    const calls = view.items.filter((item) => item.kind === 'tool').map((item) => item.call);
    assert.equal(new Set(calls).size, calls.length, `seed ${seed}: one item per call`);
    for (const call of calls) {
      const sent = events
        .filter((event) => event.kind === 'tool' && event.call === call)
        .map((event) => event.output ?? '')
        .join('');
      assert.equal(view.items.find((item) => item.kind === 'tool' && item.call === call).output, sent, `seed ${seed}: output of ${call}`);
    }
    for (const role of ['agent', 'thought']) {
      const sent = events
        .filter((event) => event.kind === 'text' && event.role === role)
        .map((event) => event.text)
        .join('');
      const shown = view.items
        .filter((item) => item.kind === 'text' && item.role === role)
        .map((item) => item.text)
        .join('');
      assert.equal(shown, sent, `seed ${seed}: ${role} text in order`);
    }
  }
});

test('a turn ends only itself', () => {
  for (let seed = 1; seed <= 400; seed++) {
    const { events } = stream(seed);
    let view = EMPTY_CHAT;
    for (const event of events) {
      const before = view.running;
      view = applyEvent(view, event);
      if (event.kind === 'turn-end') {
        assert.equal(view.running, before === event.turn ? undefined : before, `seed ${seed}`);
      }
    }
  }
});

test('permissions wait until answered; reviews settle only the files the turn changed', () => {
  const turn = turnId(1);
  let view = reduceChat(EMPTY_CHAT, [
    { kind: 'turn-start', turn, at: 0 },
    { kind: 'permission', turn, request: 'p1', call: 'c', title: 'Edit', options: [{ id: 'yes', name: 'Allow', kind: 'allow_once' }] },
  ]);
  assert.equal(waitingPermissions(view).length, 1);
  view = applyEvent(view, { kind: 'permission-answered', request: 'p1', outcome: 'selected', optionId: 'yes' });
  assert.equal(waitingPermissions(view).length, 0);
  view = reduceChat(view, [
    {
      kind: 'changes',
      turn,
      files: [
        { path: 'a', change: 'modified', review: 'pending' },
        { path: 'b', change: 'created', review: 'pending' },
      ],
    },
    { kind: 'review', turn, path: 'a', review: 'undone' },
    { kind: 'review', turn, path: 'zzz', review: 'kept' },
    { kind: 'review', turn: turnId(2), path: 'b', review: 'kept' },
  ]);
  assert.equal(pendingChanges(view), 1);
  const changes = view.items.find((item) => item.kind === 'changes');
  assert.deepEqual(
    changes.files.map((file) => file.review),
    ['undone', 'pending'],
  );
  const repeated = reduceChat(view, [
    { kind: 'unsupported', label: 'x' },
    { kind: 'unsupported', label: 'x' },
  ]);
  assert.equal(repeated.items.length, view.items.length + 1, 'a repeated unsupported row shows once');
});

test('the slash menu matches commands by name, prefix matches first, and closes at a space', () => {
  const commands = [
    { name: 'review', description: 'Review', hint: undefined },
    { name: 'plan', description: 'Plan', hint: undefined },
    { name: 'preview-deploy', description: 'Deploy', hint: undefined },
  ];
  assert.deepEqual(
    matchingCommands(commands, '/p').map((command) => command.name),
    ['plan', 'preview-deploy'],
  );
  assert.deepEqual(
    matchingCommands(commands, '/view').map((command) => command.name),
    ['review', 'preview-deploy'],
  );
  assert.deepEqual(matchingCommands(commands, '/plan now'), []);
  assert.deepEqual(matchingCommands(commands, 'plan'), []);
});

test('the diff shows every line once, and compacts long runs of context', () => {
  const rows = lineDiff('a\nb\nc\nd\ne\nf\ng\nh', 'a\nb\nC\nd\ne\nf\ng\nh\ni');
  assert.equal(
    rows
      .filter((row) => row.kind === 'added')
      .map((row) => row.text)
      .join(','),
    'C,i',
  );
  assert.equal(
    rows
      .filter((row) => row.kind === 'deleted')
      .map((row) => row.text)
      .join(','),
    'c',
  );
  const compact = compactRows(rows, 1);
  assert.ok(compact.some((row) => row.kind === 'gap'));
  assert.deepEqual(
    lineDiff(undefined, 'x\ny').map((row) => row.kind),
    ['added', 'added'],
  );
});

test('the chat list filters by every word and puts pinned chats first, then the newest', () => {
  const chats = [
    { id: 'c1', agent: 'claude', title: 'Fix hero heading', pinned: false, createdAt: 1, updatedAt: 5 },
    { id: 'c2', agent: 'codex', title: 'Hero image', pinned: true, createdAt: 1, updatedAt: 1 },
    { id: 'c3', agent: 'codex', title: 'Footer links', pinned: false, createdAt: 1, updatedAt: 9 },
  ];
  assert.deepEqual(
    filterChats(chats, 'hero').map((chat) => chat.id),
    ['c1', 'c2'],
  );
  assert.deepEqual(
    filterChats(chats, 'hero fix').map((chat) => chat.id),
    ['c1'],
  );
  assert.deepEqual(
    sortChats(chats).map((chat) => chat.id),
    ['c2', 'c3', 'c1'],
  );
});
