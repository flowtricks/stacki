// Goal: a coordinator's subagents read as units. Each Agent call (and each SendMessage follow-up) gathers the calls
// its subagent made, however they interleave with other subagents' and the coordinator's own calls; the coordinator's
// own calls stay outside every unit and fold into its ordinary groups; each unit knows its task, its role, the model
// it asked for (or that it inherits the session's), its status (queued, running, waiting, done, failed, stopped) and a
// time measured from its start to the last thing it or its work reported, and its result once it finished. The
// negative space: a call naming a parent the transcript does not hold belongs to no unit, a missing model is
// "inherited", a run the person stopped stops its subagents, a failed subagent is failed, and a subagent started in
// the background is timed by its work, not by its call that returned within seconds.
// Method: test/fixtures/ai/subagentStream.jsonl holds session/update lines in the shape claude-agent-acp 0.105.0 sends
// them (AgentReporter's title and prompt content, `_meta.claudeCode.parentToolUseId` on a subagent's updates, progress
// beats as `in_progress`), one scenario per tag. Each line goes through the real pipeline: parseAcpLine and
// parseSessionNotification (shared/properties/ai/acpWire.ts), eventsForUpdate (electron/handlers/ai/chatEvents.ts),
// the wire check parseChatEvent (shared/properties/ai/chatModel.ts), the reducer (chatReducer.ts), then the pure model
// (src/features/ai/subagents.ts) and the row folding (transcript/transcriptModel.ts) are read directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const loadRenderer = require('../../helpers/rendererModule.js');
const { repoPath } = require('../../helpers/sources.js');

const wire = loadRenderer('shared/properties/ai/acpWire.ts');
const { eventsForUpdate } = loadRenderer('electron/handlers/ai/chatEvents.ts');
const { parseChatEvent } = loadRenderer('shared/properties/ai/chatModel.ts');
const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');
const model = loadRenderer('src/features/ai/subagents.ts');
const { buildRows } = loadRenderer('src/features/ai/transcript/transcriptModel.ts');

const TURN = `t${'1'.padStart(16, '0')}`;
const LINES = fs
  .readFileSync(repoPath('test/fixtures/ai/subagentStream.jsonl'), 'utf8')
  .split('\n')
  .filter((line) => line !== '')
  .map((line) => JSON.parse(line));

/** The chat events a scenario's recorded lines become, as the host stores them. */
function eventsOf(scenario) {
  const lines = LINES.filter((entry) => entry.scenario === scenario);
  assert.ok(lines.length > 0, `the fixture has the ${scenario} scenario`);
  return lines.flatMap((entry) => {
    const message = wire.parseAcpLine(entry.line);
    assert.ok(message.ok && message.value.kind === 'notification', entry.line);
    const notification = wire.parseSessionNotification(message.value.params);
    assert.ok(notification.ok, entry.line);
    return eventsForUpdate(notification.value.update, TURN, { at: entry.at }).map((event) => parseChatEvent(JSON.parse(JSON.stringify(event))));
  });
}

/** A chat that ran the scenario: the person's message, its events, and (when given) how the turn ended. */
function chat(scenario, end) {
  const events = [{ kind: 'turn-start', turn: TURN, at: 0 }, { kind: 'user', turn: TURN, text: 'go', attachments: [], at: 0 }, ...eventsOf(scenario)];
  if (end !== undefined) {
    events.push({ kind: 'turn-end', turn: TURN, stop: end.stop, message: undefined, at: end.at });
  }
  return reduceChat(EMPTY_CHAT, events);
}

const callsOf = (unit) => unit.children.map((item) => item.call);

test('parallel subagents: each gathers its own calls however they interleave, and the coordinator keeps its own', () => {
  const view = chat('parallel');
  const work = model.deriveSubagentWork(view);
  assert.deepEqual([...work.units.keys()], ['toolu_a', 'toolu_b'], 'one unit per Agent call, in the order they started');
  const audit = work.units.get('toolu_a');
  const build = work.units.get('toolu_b');
  assert.deepEqual(callsOf(audit), ['k_a1', 'k_a2']);
  assert.deepEqual(callsOf(build), ['k_b1', 'k_b2']);
  assert.equal(work.unitOf.has('toolu_own'), false, 'the coordinator’s own call is in no unit');
  assert.equal(work.unitOf.get('k_b2'), 'toolu_b');
  assert.equal(audit.agent.title, 'Audit the hero', 'the task is the Agent call’s description');
  assert.equal(audit.agent.role, 'general-purpose');
  assert.deepEqual(audit.agent.model, { kind: 'chosen', id: 'sonnet' }, 'the model the call asked for');
  assert.deepEqual(build.agent.model, { kind: 'inherited' }, 'no model asked for: the session’s');
  assert.deepEqual(audit.agent.status, { kind: 'done', durationMs: 58_000 }, 'from its start to its end');
  assert.equal(audit.agent.result, 'The hero has a stray margin.\n\nDetails follow.', 'its report, without the prompt it was shown');
  assert.equal(model.resultSummary(audit.agent.result), 'The hero has a stray margin.');
  assert.deepEqual(build.agent.status, { kind: 'running', startedAt: 2010 });
  assert.deepEqual(build.agent.activity, { kind: 'command', command: 'npm run build' }, 'what it is doing now');
  assert.equal(build.agent.result, undefined, 'no result while it works');

  // The rows: the coordinator's calls fold into groups around the units; the subagents' calls are in none of them.
  const positioned = view.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !(item.kind === 'text' && item.parent !== undefined) && !(item.kind === 'tool' && work.unitOf.has(item.call)));
  const rows = buildRows(positioned, []);
  assert.deepEqual(
    rows.map((row) =>
      row.kind === 'group'
        ? `group:${row.items.map((item) => item.call).join(',')}`
        : `${row.kind}:${row.item.kind === 'tool' ? row.item.call : row.item.kind}`,
    ),
    ['item:user', 'item:text', 'group:toolu_own', 'subagent:toolu_a', 'subagent:toolu_b', 'group:toolu_own2'],
  );
  const again = model.deriveSubagentWork(reduceChat(view, [{ kind: 'usage', used: 1, size: 2 }]), work);
  assert.equal(again.units.get('toolu_a'), audit, 'an unchanged unit is the same object, so its row is not drawn again');
  const moved = model.deriveSubagentWork(reduceChat(view, eventsOf('parallel').slice(-1)), work);
  assert.equal(moved.units.get('toolu_b'), build, 'another subagent’s or the coordinator’s update leaves this unit as it was');
});

test('a failed subagent is failed with its time; its result says why', () => {
  const unit = model.deriveSubagentWork(chat('failed')).units.get('toolu_f');
  assert.deepEqual(unit.agent.status, { kind: 'failed', durationMs: 8000 });
  assert.match(unit.agent.result, /exited 1/);
  assert.deepEqual(unit.agent.model, { kind: 'chosen', id: 'haiku' });
  assert.deepEqual(callsOf(unit), ['k_f1']);
});

test('a run the person stopped stops the subagents it left open; one that failed in error fails them', () => {
  const stopped = model.deriveSubagentWork(chat('stopped', { stop: 'cancelled', at: 5000 })).units.get('toolu_s');
  assert.deepEqual(stopped.agent.status, { kind: 'stopped', durationMs: 1000 }, 'timed to its last report');
  const errored = model.deriveSubagentWork(chat('stopped', { stop: 'error', at: 5000 })).units.get('toolu_s');
  assert.equal(errored.agent.status.kind, 'failed');
  const ended = model.deriveSubagentWork(chat('stopped', { stop: 'end_turn', at: 5000 })).units.get('toolu_s');
  assert.equal(ended.agent.status.kind, 'running', 'a subagent can outlive a turn that ended well');
});

test('a subagent that asked for no model inherits the session’s, and one that reported nothing is queued', () => {
  const unit = model.deriveSubagentWork(chat('missing-model')).units.get('toolu_m');
  assert.deepEqual(unit.agent.model, { kind: 'inherited' });
  assert.deepEqual(unit.agent.status, { kind: 'queued', startedAt: 1000 }, 'pending with no work of its own yet');
  assert.deepEqual(unit.children, []);
  const options = [
    {
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: 'default',
      choices: [
        { value: 'default', name: 'Default (recommended)', description: 'Opus 4.7' },
        { value: 'sonnet', name: 'Sonnet 4.6', description: undefined },
      ],
    },
  ];
  assert.equal(model.sessionModelName(options), 'Opus 4.7', 'the default entry names the model it resolves to');
  assert.equal(model.sessionModelName([]), undefined, 'no model option: the name is unknown');
  assert.equal(model.chosenModelName('sonnet', options), 'Sonnet 4.6', 'the session’s own name for the model');
  assert.equal(model.chosenModelName('haiku', options), 'Haiku', 'a model the session does not list keeps its id, capitalised');
  assert.throws(() => model.chosenModelName('', options), /a model id/);
});

test('a call under a parent the transcript does not hold belongs to no unit and stays the coordinator’s', () => {
  const view = chat('unknown-parent');
  const work = model.deriveSubagentWork(view);
  assert.deepEqual(callsOf(work.units.get('toolu_u')), ['k_u1']);
  assert.equal(work.unitOf.has('k_ghost'), false);
  assert.deepEqual([...work.units.keys()], ['toolu_u'], 'an unknown parent is not a unit');
  const cycle = reduceChat(view, [
    { kind: 'tool', turn: TURN, call: 'x1', parent: 'x2', title: 'x', toolKind: 'execute', status: 'pending' },
    { kind: 'tool', turn: TURN, call: 'x2', parent: 'x1', title: 'y', toolKind: 'execute', status: 'pending' },
  ]);
  assert.equal(model.deriveSubagentWork(cycle).unitOf.has('x1'), false, 'a cycle of parents ends at the depth bound, in no unit');
});

test('a subagent started in the background is timed by its work, not by its call that returned at once', () => {
  const running = model.deriveSubagentWork(chat('background')).units.get('toolu_bg');
  assert.equal(running.agent.status.kind, 'running', 'its call returned, but it works on while the run does');
  const idle = model.deriveSubagentWork(chat('background', { stop: 'end_turn', at: 250_000 })).units.get('toolu_bg');
  assert.deepEqual(idle.agent.status, { kind: 'done', durationMs: 239_000 }, 'minutes, not the seconds its call took');
  assert.deepEqual(idle.agent.model, { kind: 'chosen', id: 'fable' });
});

test('a follow-up message is a unit of its own with the work it woke', () => {
  const unit = model.deriveSubagentWork(chat('follow-up')).units.get('toolu_msg');
  assert.equal(unit.agent.kind, 'follow-up');
  assert.equal(model.subagentName(unit.agent), '', 'the bare tool name is no task; the row says "Follow-up message"');
  assert.deepEqual(callsOf(unit), ['k_m1']);
  assert.equal(unit.agent.status.kind, 'done');
});

test('a unit’s calls are bounded to the newest SUBAGENT_ITEMS_MAX and count the rest', () => {
  const extra = 3;
  const events = eventsOf('missing-model');
  for (let index = 0; index < model.SUBAGENT_ITEMS_MAX + extra; index++) {
    events.push({ kind: 'tool', turn: TURN, call: `n${index}`, title: 'ls', toolKind: 'execute', status: 'completed', parent: 'toolu_m' });
  }
  const unit = model.deriveSubagentWork(reduceChat(EMPTY_CHAT, [{ kind: 'turn-start', turn: TURN, at: 0 }, ...events])).units.get('toolu_m');
  assert.equal(unit.children.length, model.SUBAGENT_ITEMS_MAX);
  assert.equal(unit.omitted, extra);
  assert.equal(unit.children[0].call, `n${extra}`, 'the oldest are the ones left out');
});

test('a result summary is the first paragraph on one line, cut to its bound', () => {
  assert.equal(model.resultSummary(undefined), undefined);
  assert.equal(model.resultSummary('  \n\n  '), undefined);
  assert.equal(model.resultSummary('one\ntwo\n\nthree'), 'one two');
  const long = model.resultSummary('x'.repeat(1000));
  assert.equal(long.length, model.RESULT_SUMMARY_CHARS_MAX);
  assert.ok(long.endsWith('…'));
});

test('the result is what the finishing update carried, and stays put when the output is cut to its bound from the front', () => {
  const { AI_LIMITS } = loadRenderer('shared/properties/ai/aiLimits.ts');
  const max = AI_LIMITS.toolOutputCharsMax;
  const start = { kind: 'tool', turn: TURN, call: 'r', title: 'Task', toolKind: 'think', toolName: 'Agent', status: 'pending', output: 'prompt ' };
  let view = reduceChat(EMPTY_CHAT, [start, { kind: 'tool', turn: TURN, call: 'r', status: 'completed', output: 'report' }]);
  const tool = () => view.items.find((item) => item.kind === 'tool');
  assert.equal(tool().resultFrom, 'prompt '.length);
  assert.equal(model.deriveSubagentWork(view).units.get('r').agent.result, 'report');
  view = reduceChat(view, [{ kind: 'tool', turn: TURN, call: 'r', output: 'x'.repeat(max) }]);
  assert.equal(tool().output.length, max);
  assert.equal(tool().resultFrom, 0, 'the start moves back by what was cut, never before the output');
  const open = reduceChat(EMPTY_CHAT, [start]);
  assert.equal(open.items[0].resultFrom, undefined, 'an open call has no result');
  const once = reduceChat(EMPTY_CHAT, [{ ...start, status: 'completed' }]);
  assert.equal(once.items[0].resultFrom, 0, 'a call first seen finished: its whole output is the result');
});
