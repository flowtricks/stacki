// Goal: the subagents of a run are derived truthfully from the transcript, and one subagent's work reads
// as a chat of its own. A subagent is a top-level Agent/Task call (Codex: "Start subagent …"); its status
// moves running → waiting (a request of its own waits) → done or failed, and a run stopped by the person
// stops (an error fails) the subagents it left open; one left open by a turn that ended well is at work only while a
// turn runs and it reports in it, so a step whose close never came cannot tick for a day; what it is doing is its newest call or message; the strip
// is hidden without subagents, live while one works, a folded summary once all are done, and opens again;
// the lists are bounded (SUBAGENTS_SHOWN_MAX, SUBAGENT_ITEMS_MAX) and say what they left out. The reducer
// keeps each speaker's streamed words in order however they interleave, and never joins two speakers.
// Method: views are folded by the real reducer from events shaped as the host writes them; the pure model
// (src/features/ai/subagents.ts) is called directly; a seeded generator (xorshift, so a failing seed
// reproduces) interleaves three speakers over 300 streams for the ordering property.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { EMPTY_CHAT, reduceChat, applyEvent } = loadRenderer('src/features/ai/chatReducer.ts');
const model = loadRenderer('src/features/ai/subagents.ts');

const turnId = (number) => `t${String(number).padStart(16, '0')}`;
const TURN = turnId(1);

const turnStart = (turn, at) => ({ kind: 'turn-start', turn, at });
const turnEnd = (turn, at, stop = 'end_turn') => ({ kind: 'turn-end', turn, stop, message: undefined, at });
const user = (turn, text, at) => ({ kind: 'user', turn, text, attachments: [], at });
const said = (turn, text, over = {}) => ({ kind: 'text', turn, role: 'agent', text, ...over });
const tool = (turn, call, over = {}) => ({
  kind: 'tool',
  turn,
  call,
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
const task = (turn, call, over = {}) => tool(turn, call, { title: `Task ${call}`, toolKind: 'think', toolName: 'Agent', ...over });
const permission = (turn, request, call) => ({
  kind: 'permission',
  turn,
  request,
  call,
  title: 'Allow?',
  options: [{ optionId: 'yes', name: 'Allow', kind: 'allow_once' }],
});
const fold = (...events) => reduceChat(EMPTY_CHAT, events.flat());

function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// The reducer: speakers stay apart
// ---------------------------------------------------------------------------

test('each speaker’s streamed words stay whole and in order however they interleave, and two speakers never join', () => {
  const speakers = [undefined, 'sub1', 'sub2'];
  for (let seed = 1; seed <= 300; seed++) {
    const next = random(seed);
    const events = [turnStart(TURN, 0), user(TURN, 'go', 0)];
    const sent = new Map(speakers.map((speaker) => [speaker, '']));
    const length = 1 + Math.floor(next() * 80);
    for (let index = 0; index < length; index++) {
      const speaker = speakers[Math.floor(next() * speakers.length)];
      if (next() < 0.15) {
        events.push(tool(TURN, `k${index}`, { parent: speaker, status: 'completed' }));
        continue;
      }
      const text = `${index},`;
      sent.set(speaker, sent.get(speaker) + text);
      events.push(said(TURN, text, speaker === undefined ? {} : { parent: speaker }));
    }
    const view = events.reduce((current, event) => applyEvent(current, event), EMPTY_CHAT);
    for (const speaker of speakers) {
      const words = view.items
        .filter((item) => item.kind === 'text' && item.parent === speaker)
        .map((item) => item.text)
        .join('');
      assert.equal(words, sent.get(speaker), `seed ${seed}, speaker ${speaker}`);
    }
    assert.deepEqual(reduceChat(EMPTY_CHAT, events), view, `seed ${seed}: batching never changes the fold`);
  }
});

test('a chunk joins its own speaker’s message across another speaker’s, and stops at a message, a stop or a request', () => {
  const view = fold(turnStart(TURN, 0), user(TURN, 'go', 0), said(TURN, 'Let me '), said(TURN, 'sub says', { parent: 'sub' }), said(TURN, 'look.'));
  const texts = view.items.filter((item) => item.kind === 'text');
  assert.deepEqual(
    texts.map((item) => [item.parent, item.text]),
    [
      [undefined, 'Let me look.'],
      ['sub', 'sub says'],
    ],
  );
  const stopped = reduceChat(view, [permission(TURN, 'r1', 'k'), said(TURN, ' Again')]);
  assert.equal(stopped.items.filter((item) => item.kind === 'text' && item.parent === undefined).length, 2, 'a request ends the message');
  const own = fold(said(TURN, 'a'), tool(TURN, 'k'), said(TURN, 'b'));
  assert.equal(own.items.filter((item) => item.kind === 'text').length, 2, 'the agent’s own call still ends its message');
});

// ---------------------------------------------------------------------------
// Statuses and activity
// ---------------------------------------------------------------------------

test('a subagent runs, waits for the person, then finishes or fails; its time comes from the host’s stamps', () => {
  let view = fold(turnStart(TURN, 1000), user(TURN, 'go', 1000), task(TURN, 'a', { at: 2000, agentType: 'Explore', title: 'Explore the repo' }));
  let [agent] = model.deriveSubagents(view).agents;
  assert.deepEqual(agent.status, { kind: 'running', startedAt: 2000 });
  assert.equal(agent.role, 'Explore');
  assert.equal(agent.title, 'Explore the repo');
  assert.deepEqual(agent.activity, { kind: 'starting' }, 'nothing reported yet');

  view = reduceChat(view, [tool(TURN, 'k1', { parent: 'a', toolKind: 'edit', title: 'Edit', paths: ['/site/src/components/Hero.astro'], at: 2100 })]);
  [agent] = model.deriveSubagents(view).agents;
  assert.deepEqual(agent.activity, { kind: 'file', verb: 'editing', file: 'Hero.astro' });

  view = reduceChat(view, [permission(TURN, 'p1', 'k1')]);
  [agent] = model.deriveSubagents(view).agents;
  assert.equal(agent.status.kind, 'waiting', 'a request of its own call waits for the person');
  view = reduceChat(view, [{ kind: 'permission-answered', request: 'p1', outcome: 'selected', optionId: 'yes' }]);
  assert.equal(model.deriveSubagents(view).agents[0].status.kind, 'running');

  view = reduceChat(view, [tool(TURN, 'a', { status: 'completed', at: 9000 })]);
  assert.deepEqual(model.deriveSubagents(view).agents[0].status, { kind: 'done', durationMs: 7000 });
  const failed = reduceChat(view, [task(TURN, 'b', { at: 3000 }), tool(TURN, 'b', { status: 'failed', at: 4000 })]);
  assert.deepEqual(model.deriveSubagents(failed).agents[1].status, { kind: 'failed', durationMs: 1000 });
});

test('a run that was stopped or failed takes the subagents it left open with it; a run that ended well leaves them running', () => {
  for (const [stop, kind] of [
    ['cancelled', 'stopped'],
    ['error', 'failed'],
  ]) {
    const view = fold(turnStart(TURN, 1), user(TURN, 'go', 1), task(TURN, 'a', { at: 2 }), turnEnd(TURN, 5, stop));
    assert.deepEqual(model.deriveSubagents(view).agents[0].status, { kind, durationMs: undefined }, stop);
  }
  const background = fold(turnStart(TURN, 1), user(TURN, 'go', 1), task(TURN, 'a', { at: 2 }), turnEnd(TURN, 5));
  assert.equal(
    model.deriveSubagents(reduceChat(background, [turnStart(turnId(2), 6), tool(turnId(2), 'k', { parent: 'a', at: 7 })])).agents[0].status.kind,
    'running',
    'a subagent can outlive a turn that ended well, and is at work once it reports in a later turn',
  );
});

test('a subagent left open by an ended turn is not at work while the chat waits, nor through a later turn it is silent in', () => {
  const HOUR_MS = 3_600_000;
  const second = turnId(2);
  // The owner's case: a background agent works 16m 47s, its last step never closes, the turn ends well, and a day passes.
  const started = 1_000_000;
  const worked = 16 * 60_000 + 47_000;
  const stale = fold(
    turnStart(TURN, started),
    user(TURN, 'go', started),
    task(TURN, 'a', { at: started, background: true }),
    tool(TURN, 'a', { status: 'completed', at: started + 500 }),
    tool(TURN, 'k1', { parent: 'a', at: started + 1000, status: 'completed' }),
    tool(TURN, 'k2', { parent: 'a', at: started + worked }),
    turnEnd(TURN, started + worked + 1000),
  );
  assert.deepEqual(
    model.deriveSubagents(stale).agents.map((agent) => agent.status.kind),
    ['done'],
    'idle: the strip lists it as done, not working',
  );
  const idle = model.deriveSubagentWork(stale).units.get('a').agent.status;
  assert.deepEqual(idle, { kind: 'done', durationMs: worked }, 'idle: done, with the time it worked, not the time since it began');
  // A later turn a day on, in which it says nothing: still not at work.
  const later = reduceChat(stale, [turnStart(second, started + 23 * HOUR_MS), user(second, 'next', started + 23 * HOUR_MS)]);
  assert.equal(model.deriveSubagentWork(later).units.get('a').agent.status.kind, 'done', 'silent through a later turn: not at work');
  // It reports in that turn (its buffered work arrives): at work again, its start its own.
  const reported = reduceChat(later, [tool(TURN, 'k3', { parent: 'a', at: started + 23 * HOUR_MS + 10 })]);
  assert.deepEqual(model.deriveSubagentWork(reported).units.get('a').agent.status, { kind: 'running', startedAt: started });
  // An open subagent call (not sent to the background) whose turn ended well: done while the chat waits.
  const open = fold(turnStart(TURN, 1), user(TURN, 'go', 1), task(TURN, 'b', { at: 2 }), tool(TURN, 'kb', { parent: 'b', at: 3 }), turnEnd(TURN, 5));
  assert.deepEqual(model.deriveSubagentWork(open).units.get('b').agent.status, { kind: 'done', durationMs: 1 });
  // Its own running turn: at work, whatever the stamps.
  const live = fold(turnStart(TURN, 1), user(TURN, 'go', 1), task(TURN, 'c', { at: 2 }));
  assert.equal(model.deriveSubagentWork(live).units.get('c').agent.status.kind, 'running');
  // A turn the view never saw end (no turn-end): no evidence it stopped, so it keeps its open state.
  const unseen = fold(user(TURN, 'go', 1), task(TURN, 'd', { at: 2 }));
  assert.equal(model.deriveSubagentWork(unseen).units.get('d').agent.status.kind, 'running');
});

test('what a subagent is doing: a file it reads or edits, a command, a tool’s title, a thought or its words', () => {
  const doing = (child) => model.deriveSubagents(fold(turnStart(TURN, 1), user(TURN, 'go', 1), task(TURN, 'a'), child)).agents[0].activity;
  assert.deepEqual(doing(tool(TURN, 'k', { parent: 'a', toolKind: 'read', title: 'Read', paths: ['C:\\site\\index.astro'] })), {
    kind: 'file',
    verb: 'reading',
    file: 'index.astro',
  });
  assert.deepEqual(doing(tool(TURN, 'k', { parent: 'a', toolKind: 'execute', title: 'Terminal', command: 'npm test\nmore' })), {
    kind: 'command',
    command: 'npm test',
  });
  const long = doing(tool(TURN, 'k', { parent: 'a', toolKind: 'execute', title: 'x'.repeat(500) }));
  assert.equal(long.command.length, 120, 'a command is cut to one short line');
  assert.deepEqual(doing(tool(TURN, 'k', { parent: 'a', toolKind: 'search', title: 'grep "Hero"' })), { kind: 'tool', title: 'grep "Hero"' });
  assert.deepEqual(doing(said(TURN, 'hm', { role: 'thought', parent: 'a' })), { kind: 'thinking' });
  assert.deepEqual(doing(said(TURN, 'Found it', { parent: 'a' })), { kind: 'writing' });
  assert.deepEqual(doing(said(TURN, 'mine')), { kind: 'starting' }, 'the agent’s own words are not the subagent’s');
});

test('the current run: the running turn’s subagents, or the last asked turn’s, plus any still open from earlier', () => {
  const first = turnId(1);
  const second = turnId(2);
  const view = fold(
    turnStart(first, 1),
    user(first, 'one', 1),
    task(first, 'old', { status: 'completed' }),
    task(first, 'lingering'),
    turnEnd(first, 3),
    turnStart(second, 4),
    user(second, 'two', 4),
    task(second, 'new'),
    tool(second, 'nested', { toolName: 'Agent', parent: 'new' }),
  );
  assert.deepEqual(
    model.deriveSubagents(view).agents.map((agent) => agent.call),
    ['lingering', 'new'],
    'a finished subagent of an earlier run is gone; a nested one is its parent’s work, not a pill',
  );
  const codex = fold(turnStart(TURN, 1), user(TURN, 'go', 1), tool(TURN, 'cx', { title: 'Start subagent count_lines', toolKind: 'other' }));
  const [agent] = model.deriveSubagents(codex).agents;
  assert.equal(agent.call, 'cx', 'Codex’s subagent call is found by its title');
  assert.equal(model.subagentName(agent), 'count_lines');
  assert.deepEqual(model.deriveSubagents(fold(user(TURN, 'go', 1), tool(TURN, 'k'))).agents, [], 'no subagent, no list');
});

test('the list is bounded to the newest subagents and counts the rest', () => {
  const count = model.SUBAGENTS_SHOWN_MAX + 3;
  const view = fold(
    turnStart(TURN, 1),
    user(TURN, 'go', 1),
    Array.from({ length: count }, (_, index) => task(TURN, `s${index}`)),
  );
  const list = model.deriveSubagents(view);
  assert.equal(list.agents.length, model.SUBAGENTS_SHOWN_MAX);
  assert.equal(list.omitted, 3);
  assert.equal(list.agents[0].call, 's3', 'the oldest are the ones left out');
  assert.equal(list.agents.at(-1).call, `s${count - 1}`);
});

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

test('the strip: hidden without subagents, live while one works, a summary once all are done, open again on request', () => {
  const list = (statuses) => ({
    agents: statuses.map((status, index) => ({ call: `s${index}`, turn: TURN, role: undefined, title: 't', status, activity: { kind: 'starting' } })),
    omitted: 0,
  });
  const running = { kind: 'running', startedAt: 1 };
  const waiting = { kind: 'waiting', startedAt: 1 };
  const done = { kind: 'done', durationMs: 5 };
  const failed = { kind: 'failed', durationMs: undefined };
  assert.deepEqual(model.stripState({ agents: [], omitted: 0 }, { open: true }), { kind: 'hidden' });
  const live = model.stripState(list([running, done, waiting]), { open: false });
  assert.equal(live.kind, 'live');
  assert.equal(live.active, 2, 'waiting still counts as working');
  assert.equal(model.stripState(list([running]), { open: true }).kind, 'live', 'opening has no say while one works');
  assert.deepEqual(model.stripState(list([done, failed, done]), { open: false }), { kind: 'summary', finished: 3, failed: 1 });
  const review = model.stripState(list([done, failed, done]), { open: true });
  assert.equal(review.kind, 'review');
  assert.equal(review.finished, 3);
  const omitted = model.stripState({ ...list([done]), omitted: 4 }, { open: false });
  assert.deepEqual(omitted, { kind: 'summary', finished: 5, failed: 0 }, 'the summary counts the ones left out too');
});

// ---------------------------------------------------------------------------
// One subagent's transcript
// ---------------------------------------------------------------------------

test('a subagent’s transcript is its own work re-rooted, its words joined, its requests, and its own run state', () => {
  const view = fold(
    turnStart(TURN, 100),
    user(TURN, 'go', 100),
    said(TURN, 'Starting two agents'),
    task(TURN, 'a', { at: 200 }),
    task(TURN, 'b', { at: 210 }),
    said(TURN, 'Looking ', { parent: 'a' }),
    said(TURN, 'b speaks', { parent: 'b' }),
    said(TURN, 'around', { parent: 'a' }),
    tool(TURN, 'ka', { parent: 'a', toolKind: 'read', title: 'Read x' }),
    tool(TURN, 'kb', { parent: 'b', toolKind: 'read', title: 'Read y' }),
    permission(TURN, 'pa', 'ka'),
    task(TURN, 'deep', { parent: 'a' }),
    said(TURN, 'deep says', { parent: 'deep' }),
  );
  const sub = model.subagentView(view, 'a');
  assert.deepEqual(
    sub.items.map((item) => [item.kind, item.kind === 'text' ? item.text : item.kind === 'tool' ? item.call : item.request, item.parent]),
    [
      ['text', 'Looking around', undefined],
      ['tool', 'ka', undefined],
      ['permission', 'pa', undefined],
      ['tool', 'deep', undefined],
    ],
    'its words read as one message, its calls are top-level, its nested subagent stays a call and that one’s words are not here',
  );
  assert.equal(sub.running, TURN, 'it runs while the turn does and it is open');
  assert.equal(sub.turnStartedAt, 200, 'its clock starts with it');
  assert.deepEqual([sub.plan, sub.lastPrompt, sub.activeTasks.length], [undefined, undefined, 0], 'nothing of the chat’s own state');
  const again = model.subagentView(reduceChat(view, [{ kind: 'usage', used: 1, size: 2 }]), 'a');
  assert.equal(again.items[1], sub.items[1], 'an unchanged call is the same object, so its row is not drawn again');
  const finished = model.subagentView(reduceChat(view, [tool(TURN, 'a', { status: 'completed', at: 900 })]), 'a');
  assert.equal(finished.running, undefined, 'a finished subagent is not running, though the turn is');
  assert.equal(model.subagentView(view, 'missing'), undefined);
  assert.equal(view.items.find((item) => item.kind === 'tool' && item.call === 'ka').parent, 'a', 'the chat’s own items are untouched');
});

test('a subagent’s transcript keeps its newest items within the bound', () => {
  const extra = 5;
  const view = fold(
    turnStart(TURN, 1),
    user(TURN, 'go', 1),
    task(TURN, 'a'),
    Array.from({ length: model.SUBAGENT_ITEMS_MAX + extra }, (_, index) => tool(TURN, `k${index}`, { parent: 'a', status: 'completed' })),
  );
  const sub = model.subagentView(view, 'a');
  assert.equal(sub.items.length, model.SUBAGENT_ITEMS_MAX);
  assert.equal(sub.items[0].call, `k${extra}`, 'the oldest are dropped');
});
