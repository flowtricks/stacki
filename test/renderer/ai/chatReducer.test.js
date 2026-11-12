// Goal: the AI panel's transcript fold is a pure, order-preserving reduction.
// Properties over random event streams: folding in any batching equals folding
// one event at a time; each tool call is one item however many updates it gets,
// and its output is the concatenation of what was sent; streamed agent text is
// never lost or reordered; the transcript never has more items than events; a
// turn's end clears exactly that running turn; reviews only settle files the
// turn changed; item ids only ever grow; timings never run backwards; a
// compaction is one transcript item however often it is reported and never goes
// back from a finished state; background tasks are derived from open tool calls.
// Method: bundle the reducer with esbuild and drive it with a seeded generator
// (a small xorshift, so a failing seed reproduces) over 400 streams, plus
// directed cases for permissions, reviews and duplicate notices.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { EMPTY_CHAT, reduceChat, applyEvent, waitingPermissions, pendingChanges } = loadRenderer('src/features/ai/chatReducer.ts');
const { matchingCommands } = loadRenderer('src/features/ai/composer/ComposerInput.tsx');
const { lineDiff, compactRows } = loadRenderer('src/features/ai/lineDiff.ts');
const { filterChats, sortChats } = loadRenderer('src/features/ai/sessions/SessionsView.tsx');

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

// ---------------------------------------------------------------------------
// The panel overhaul: ids, timings, compaction and background tasks.
// ---------------------------------------------------------------------------

const tool = (over) => ({
  kind: 'tool',
  turn: turnId(1),
  call: 'c1',
  title: undefined,
  toolKind: undefined,
  status: undefined,
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  ...over,
});
const compaction = (id, status, at = 1, turn = turnId(1)) => ({ kind: 'compaction', turn, id, status, at });

// A stream with the new fields: stamps never run backwards, as the host's clock does not.
function stampedStream(seed) {
  const next = random(seed);
  const pick = (values) => values[Math.floor(next() * values.length)];
  const events = [];
  let turn = 0;
  let clock = 1000;
  const length = 1 + Math.floor(next() * 80);
  for (let index = 0; index < length; index++) {
    clock += Math.floor(next() * 50);
    const roll = next();
    const current = turnId(turn);
    if (roll < 0.08) {
      turn += 1;
      events.push({ kind: 'turn-start', turn: turnId(turn), at: clock });
      events.push({ kind: 'user', turn: turnId(turn), text: 'ask', attachments: [], at: clock });
    } else if (roll < 0.3) {
      events.push({ kind: 'text', turn: current, role: pick(['agent', 'thought']), text: 'x', at: clock, until: clock + 5 });
    } else if (roll < 0.6) {
      events.push(
        tool({
          turn: current,
          call: pick(['c1', 'c2', 'c3', 'c4']),
          toolKind: pick([undefined, 'execute', 'read', 'edit']),
          status: pick([undefined, 'pending', 'in_progress', 'completed', 'failed']),
          toolName: pick([undefined, 'Bash', 'Task']),
          background: pick([undefined, true, false]),
          parent: pick([undefined, undefined, 'c1']),
          output: pick([undefined, 'line one\nline two']),
          at: clock,
        }),
      );
    } else if (roll < 0.72) {
      events.push(compaction(pick(['k1', 'k2', 'k3']), pick(['in_progress', 'completed', 'failed', 'cancelled']), clock, pick([current, undefined])));
    } else if (roll < 0.85) {
      events.push({ kind: 'turn-end', turn: current, stop: pick(['end_turn', 'cancelled', 'error']), message: undefined, at: clock });
    } else {
      events.push({ kind: 'usage', used: index, size: 1000 });
    }
  }
  return { events, next };
}

test('with timings, compaction and tasks in the stream, batching still never changes the fold', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const { events, next } = stampedStream(seed);
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

test('item ids are the order items were added: strictly increasing, never reused', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const view = reduceChat(EMPTY_CHAT, stampedStream(seed).events);
    assert.deepEqual(
      view.items.map((item) => item.id),
      view.items.map((_, position) => position),
      `seed ${seed}`,
    );
    assert.equal(view.nextItemId, view.items.length, `seed ${seed}: the next id follows the last`);
  }
  // Updating an existing item (a tool call, streamed text, a compaction) never gives it a new id.
  let view = reduceChat(EMPTY_CHAT, [tool({ status: 'in_progress', at: 1 }), compaction('k', 'in_progress')]);
  const ids = view.items.map((item) => item.id);
  view = reduceChat(view, [tool({ status: 'completed', at: 2 }), compaction('k', 'completed')]);
  assert.deepEqual(
    view.items.map((item) => item.id),
    ids,
  );
});

test('durations never run backwards, and a chat stored before timings shows none (and no NaN)', () => {
  for (let seed = 1; seed <= 300; seed++) {
    const view = reduceChat(EMPTY_CHAT, stampedStream(seed).events);
    for (const item of view.items) {
      if (item.kind === 'tool' && item.at !== undefined && item.endedAt !== undefined) {
        assert.ok(item.endedAt >= item.at, `seed ${seed}: a call ends after it begins`);
      }
      if (item.kind === 'text' && item.at !== undefined && item.until !== undefined) {
        assert.ok(item.until >= item.at, `seed ${seed}: streamed text ends after it begins`);
      }
      if (item.kind === 'turn-end' && item.startedAt !== undefined) {
        assert.ok(item.at >= item.startedAt, `seed ${seed}: a turn ends after it begins`);
      }
    }
  }
  const old = reduceChat(EMPTY_CHAT, [{ kind: 'text', turn: turnId(1), role: 'thought', text: 'hm' }, tool({ status: 'completed' })]);
  const thought = old.items[0];
  const call = old.items[1];
  assert.equal(thought.at, undefined);
  assert.equal(thought.until, undefined);
  assert.equal(call.at, undefined);
  assert.equal(call.endedAt, undefined);
  assert.equal(JSON.stringify(old).includes('NaN'), false);
});

test('streamed text keeps its first arrival and the last chunk’s stamp; a call keeps its first end', () => {
  const view = reduceChat(EMPTY_CHAT, [
    { kind: 'text', turn: turnId(1), role: 'thought', text: 'a', at: 10, until: 12 },
    { kind: 'text', turn: turnId(1), role: 'thought', text: 'b', at: 20, until: 25 },
    tool({ call: 'x', status: 'in_progress', at: 30 }),
    tool({ call: 'x', status: 'completed', at: 40 }),
    tool({ call: 'x', status: 'completed', at: 90 }),
  ]);
  const thought = view.items.find((item) => item.kind === 'text');
  assert.deepEqual([thought.text, thought.at, thought.until], ['ab', 10, 25]);
  const call = view.items.find((item) => item.kind === 'tool');
  assert.deepEqual([call.at, call.endedAt], [30, 40], 'a repeated completion does not move the end');
});

test('a turn’s start is kept while it runs and cleared by its own end only; the end remembers it', () => {
  let view = reduceChat(EMPTY_CHAT, [{ kind: 'turn-start', turn: turnId(1), at: 100 }]);
  assert.equal(view.turnStartedAt, 100);
  view = applyEvent(view, { kind: 'turn-end', turn: turnId(2), stop: 'end_turn', message: undefined, at: 150 });
  assert.equal(view.running, turnId(1), 'another turn’s end leaves it running');
  assert.equal(view.turnStartedAt, 100);
  view = applyEvent(view, { kind: 'turn-end', turn: turnId(1), stop: 'end_turn', message: undefined, at: 400 });
  assert.equal(view.running, undefined);
  assert.equal(view.turnStartedAt, undefined);
  const end = view.items.find((item) => item.kind === 'turn-end' && item.turn === turnId(1));
  assert.deepEqual([end.startedAt, end.at], [100, 400]);
});

test('a sent message keeps its parts and how it was sent', () => {
  const parts = [
    { kind: 'text', text: 'see ' },
    { kind: 'file', path: 'src/a.ts', truncated: false, excerpt: 'x' },
  ];
  const view = applyEvent(EMPTY_CHAT, { kind: 'user', turn: turnId(1), text: 'see @src/a.ts', attachments: [], at: 1, parts, mode: 'steer' });
  const item = view.items[0];
  assert.deepEqual(item.parts, parts);
  assert.equal(item.mode, 'steer');
  assert.equal(view.lastPrompt.text, 'see @src/a.ts');
  const plain = applyEvent(EMPTY_CHAT, { kind: 'user', turn: turnId(1), text: 'hi', attachments: [], at: 1 });
  assert.equal(plain.items[0].parts, undefined);
  assert.equal(plain.items[0].mode, undefined);
});

test('compaction: one item per id, progressing from in progress to a final state and never back', () => {
  let view = reduceChat(EMPTY_CHAT, [{ kind: 'usage', used: 820, size: 1000 }, compaction('k1', 'in_progress', 5)]);
  assert.equal(view.items.filter((item) => item.kind === 'compaction').length, 1);
  assert.deepEqual(view.compaction, { id: 'k1', status: 'in_progress', at: 5 });
  // The same report again changes nothing, down to the object identity.
  assert.equal(applyEvent(view, compaction('k1', 'in_progress', 5)), view);
  view = applyEvent(view, compaction('k1', 'completed', 9));
  assert.equal(view.items.filter((item) => item.kind === 'compaction').length, 1);
  assert.equal(view.compaction.status, 'completed');
  const settled = view;
  assert.equal(applyEvent(view, compaction('k1', 'completed', 9)), settled, 'a duplicate completion is a no-op');
  assert.equal(applyEvent(view, compaction('k1', 'in_progress', 5)), settled, 'a late in-progress report does not undo it');
  assert.equal(applyEvent(view, compaction('k1', 'failed', 20)), settled, 'a final state is not replaced by another');
  // A second compaction is a second row, and the view follows the newest.
  view = applyEvent(view, compaction('k2', 'in_progress', 30));
  assert.equal(view.items.filter((item) => item.kind === 'compaction').length, 2);
  assert.equal(view.compaction.id, 'k2');
});

test('a failed compaction keeps the reason the agent gave, whether it arrives with the first report or the last', () => {
  const first = reduceChat(EMPTY_CHAT, [{ ...compaction('k1', 'failed', 5), error: 'OAuth expired' }]);
  assert.equal(first.items.find((item) => item.kind === 'compaction').error, 'OAuth expired');
  let later = reduceChat(EMPTY_CHAT, [compaction('k2', 'in_progress', 5)]);
  assert.equal(later.items.find((item) => item.kind === 'compaction').error, undefined);
  later = applyEvent(later, { ...compaction('k2', 'failed', 9), error: 'Out of memory' });
  assert.equal(later.items.find((item) => item.kind === 'compaction').error, 'Out of memory');
});

test('compaction numbers are derived: the usage before it began, and the first report after it completed', () => {
  let view = reduceChat(EMPTY_CHAT, [{ kind: 'usage', used: 820, size: 1000 }, compaction('k1', 'in_progress'), { kind: 'usage', used: 900, size: 1000 }]);
  const row = () => view.items.find((item) => item.kind === 'compaction');
  assert.deepEqual(row().before, { used: 820, size: 1000 });
  assert.equal(row().after, undefined, 'a report while it is running is not the result');
  view = reduceChat(view, [compaction('k1', 'completed'), { kind: 'usage', used: 110, size: 1000 }, { kind: 'usage', used: 130, size: 1000 }]);
  assert.deepEqual(row().after, { used: 110, size: 1000 }, 'the first report after completion, kept');
  assert.deepEqual(view.usage, { used: 130, size: 1000 });
  // An agent that reported no usage leaves both undefined; nothing is invented.
  const bare = reduceChat(EMPTY_CHAT, [compaction('k', 'in_progress'), compaction('k', 'failed')]);
  assert.equal(bare.items[0].before, undefined);
  assert.equal(bare.items[0].after, undefined);
});

test('compactions are bounded: past the limit new ones are ignored, known ones still progress', () => {
  const events = [];
  for (let index = 0; index < 300; index++) {
    events.push(compaction(`k${index}`, 'in_progress'));
  }
  let view = reduceChat(EMPTY_CHAT, events);
  assert.equal(view.items.length, 256);
  view = applyEvent(view, compaction('k3', 'completed'));
  assert.equal(view.items.find((item) => item.kind === 'compaction' && item.compactionId === 'k3').status, 'completed');
});

test('background tasks are open calls that outlive their turn, run in the background, or are subagents', () => {
  const turn = turnId(1);
  let view = reduceChat(EMPTY_CHAT, [
    { kind: 'turn-start', turn, at: 1 },
    tool({ call: 'fg', toolKind: 'execute', status: 'in_progress', title: 'npm test', at: 2 }),
  ]);
  assert.deepEqual(view.activeTasks, [], 'a foreground command of a running turn is the turn, not a task');
  view = reduceChat(view, [
    tool({ call: 'bg', toolKind: 'execute', status: 'in_progress', title: 'npm run dev', background: true, at: 3, output: 'ready\n\nlistening on 4321\n' }),
    tool({ call: 'sub', toolKind: 'other', status: 'in_progress', title: 'Explore', toolName: 'Task', at: 4 }),
    tool({ call: 'kid', toolKind: 'read', status: 'in_progress', title: 'Read a', parent: 'sub', at: 5 }),
  ]);
  assert.deepEqual(
    view.activeTasks.map((task) => [task.call, task.kind]),
    [
      ['bg', 'command'],
      ['sub', 'subagent'],
    ],
    'a child call is not a task of its own',
  );
  assert.equal(view.activeTasks[0].lastOutputLine, 'listening on 4321');
  assert.equal(view.activeTasks[0].startedAt, 3);
  // The turn ends with the foreground command still open: it is now a task too, and a later update keeps it one.
  view = applyEvent(view, { kind: 'turn-end', turn, stop: 'end_turn', message: undefined, at: 10 });
  assert.deepEqual(
    view.activeTasks.map((task) => task.call),
    ['fg', 'bg', 'sub'],
  );
  view = applyEvent(view, tool({ call: 'fg', output: 'still going', at: 11 }));
  assert.ok(
    view.activeTasks.some((task) => task.call === 'fg' && task.lastOutputLine === 'still going'),
    'a tool update after turn-end keeps the task',
  );
  view = applyEvent(view, tool({ call: 'fg', status: 'completed', at: 12 }));
  assert.deepEqual(
    view.activeTasks.map((task) => task.call),
    ['bg', 'sub'],
    'a finished call leaves the tray',
  );
  view = reduceChat(view, [tool({ call: 'bg', status: 'failed', at: 13 }), tool({ call: 'sub', status: 'completed', at: 14 })]);
  assert.deepEqual(view.activeTasks, []);
});

test('the task list keeps its identity while nothing about the tasks changes, so memoized rows hold', () => {
  const turn = turnId(1);
  const view = reduceChat(EMPTY_CHAT, [{ kind: 'turn-start', turn, at: 1 }, tool({ call: 'sub', toolName: 'Task', status: 'in_progress', at: 2 })]);
  assert.equal(view.activeTasks.length, 1);
  const after = reduceChat(view, [
    { kind: 'text', turn, role: 'agent', text: 'hello', at: 3, until: 3 },
    tool({ call: 'other', toolKind: 'read', status: 'completed', at: 4 }),
  ]);
  assert.equal(after.activeTasks, view.activeTasks);
  assert.equal(after.activeTasks[0], view.activeTasks[0]);
});

test('Codex’s subagent calls are tasks by their title', () => {
  const view = reduceChat(EMPTY_CHAT, [tool({ call: 's', toolKind: 'other', status: 'in_progress', title: 'Start subagent reviewer' })]);
  assert.deepEqual(
    view.activeTasks.map((task) => task.kind),
    ['subagent'],
  );
});

test('the open tasks are bounded', () => {
  const events = [];
  for (let index = 0; index < 100; index++) {
    events.push(tool({ call: `t${index}`, toolName: 'Task', status: 'in_progress' }));
  }
  assert.equal(reduceChat(EMPTY_CHAT, events).activeTasks.length, 64);
});
