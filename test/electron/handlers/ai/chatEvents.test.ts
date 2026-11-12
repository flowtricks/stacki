// Goal: ACP updates become the transcript events the overhaul needs: timings
// only when the caller supplies a clock, compaction in both shapes as one event
// kind, a tool's name, command and background flag, and streamed text joined with
// its first start and last end.
// Methodology: the pure `eventsForUpdate` and `coalesceEvents` from dist/, fed
// updates parsed from the recorded adapter lines and hand-made ones; every output
// event is also run back through `parseChatEvent` so the two sides agree.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { CompactionCalls, coalesceEvents, eventsForUpdate } from '#dist/electron/handlers/ai/chatEvents.js';
import { parseAcpLine, parseSessionNotification } from '#dist/shared/properties/ai/acpWire.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { parseChatEvent, toTurnId } from '#dist/shared/properties/ai/chatModel.js';

const turn = toTurnId(`t${'7'.repeat(16)}`);

function recorded(name: string) {
  const entry = fs
    .readFileSync(path.resolve('test/fixtures/ai/acpTrace.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line): unknown => JSON.parse(line))
    .find((candidate) => typeof candidate === 'object' && candidate !== null && 'name' in candidate && candidate.name === name);
  assert.ok(typeof entry === 'object' && entry !== null && 'line' in entry && typeof entry.line === 'string', name);
  const message = parseAcpLine(entry.line);
  assert.ok(message.ok && message.value.kind === 'notification');
  const notification = parseSessionNotification(message.value.params);
  assert.ok(notification.ok);
  return notification.value.update;
}

function updateOf(body: Record<string, unknown>) {
  const parsed = parseSessionNotification({ sessionId: 's', update: body });
  assert.ok(parsed.ok);
  return parsed.value.update;
}

function checked(events: ReturnType<typeof eventsForUpdate>) {
  for (const event of events) {
    const wire: unknown = JSON.parse(JSON.stringify(event));
    assert.deepEqual(JSON.parse(JSON.stringify(parseChatEvent(wire))), wire);
  }
  return events;
}

test('text and tool events carry a time only when the caller gave one', () => {
  const chunk = updateOf({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
  assert.deepEqual(
    checked(eventsForUpdate(chunk, turn)),
    [{ kind: 'text', turn, role: 'thought', text: 'hmm' }],
    'no clock, no keys: stored exactly as before',
  );
  assert.deepEqual(checked(eventsForUpdate(chunk, turn, { at: 40 })), [{ kind: 'text', turn, role: 'thought', text: 'hmm', at: 40, until: 40 }]);
  const tool = updateOf({
    sessionUpdate: 'tool_call',
    toolCallId: 'k',
    title: 'Terminal',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'npm test', run_in_background: true },
    _meta: { claudeCode: { toolName: 'Bash' } },
  });
  const [event] = checked(eventsForUpdate(tool, turn, { at: 41 }));
  assert.ok(event?.kind === 'tool');
  assert.deepEqual([event.at, event.toolName, event.command, event.background], [41, 'Bash', 'npm test', true]);
  const [plain] = checked(eventsForUpdate(updateOf({ sessionUpdate: 'tool_call', toolCallId: 'k2', kind: 'read' }), turn));
  assert.ok(plain?.kind === 'tool');
  assert.equal('at' in plain, false);
  assert.equal('command' in plain, false);
  assert.deepEqual(eventsForUpdate(chunk, undefined, { at: 1 }), [], 'outside a turn a chunk has no prompt to sit under');
});

test('streamed text joins with the first start and the last end', () => {
  const part = (text: string, at: number) =>
    eventsForUpdate(updateOf({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }), turn, { at })[0];
  const first = part('a', 10);
  const second = part('b', 15);
  const third = part('c', 22);
  assert.ok(first !== undefined && second !== undefined && third !== undefined);
  assert.deepEqual(coalesceEvents([first, second, third]), [{ kind: 'text', turn, role: 'thought', text: 'abc', at: 10, until: 22 }]);
  const old = eventsForUpdate(updateOf({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'x' } }), turn)[0];
  assert.ok(old !== undefined);
  assert.deepEqual(coalesceEvents([old, old]), [{ kind: 'text', turn, role: 'thought', text: 'xx' }]);
  const agent = eventsForUpdate(updateOf({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'y' } }), turn, { at: 30 })[0];
  assert.ok(agent !== undefined);
  assert.equal(coalesceEvents([first, agent]).length, 2, 'different roles stay apart');
});

test('compaction with the capability becomes one event per update', () => {
  const started = checked(eventsForUpdate(recorded('claude-compaction_update-in-progress'), turn, { at: 100 }));
  const failed = checked(eventsForUpdate(recorded('claude-compaction_update-failed'), turn, { at: 105 }));
  assert.ok(started[0]?.kind === 'compaction' && failed[0]?.kind === 'compaction');
  assert.equal(started[0].status, 'in_progress');
  assert.equal(failed[0].status, 'failed');
  assert.equal(started[0].id, failed[0].id);
  assert.equal(failed[0].at, 105);
  assert.deepEqual(eventsForUpdate(updateOf({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'x' }), turn), []);
  const outside = checked(eventsForUpdate(recorded('claude-compaction_update-in-progress'), undefined, { at: 1 }));
  assert.ok(outside[0]?.kind === 'compaction');
  assert.equal(outside[0].turn, undefined, 'an automatic compaction between turns still shows');
  assert.equal(
    eventsForUpdate(recorded('claude-compaction_update-in-progress'), turn)[0]?.kind === 'compaction' && true,
    true,
    'without a clock the event says 0',
  );
});

test('a failed compaction carries the adapter reason, cut to the bound; a good one carries none', () => {
  const failed = checked(eventsForUpdate(recorded('claude-compaction_update-failed'), turn, { at: 105 }));
  assert.ok(failed[0]?.kind === 'compaction');
  assert.match(failed[0].error ?? '', /Failed to authenticate/);
  const started = checked(eventsForUpdate(recorded('claude-compaction_update-in-progress'), turn, { at: 100 }));
  assert.ok(started[0]?.kind === 'compaction');
  assert.equal('error' in started[0], false, 'no reason is invented for a compaction that did not fail');
  const long = updateOf({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'failed', error: 'x'.repeat(AI_LIMITS.compactionErrorCharsMax * 3) });
  const cut = checked(eventsForUpdate(long, turn, { at: 1 }));
  assert.ok(cut[0]?.kind === 'compaction');
  assert.equal(cut[0].error?.length, AI_LIMITS.compactionErrorCharsMax, 'cut, not refused');
  const blank = updateOf({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'failed', error: '   ' });
  assert.equal('error' in (checked(eventsForUpdate(blank, turn, { at: 1 }))[0] ?? {}), false, 'an empty reason is no reason');
  const done = updateOf({ sessionUpdate: 'compaction_update', compactionId: 'c', status: 'completed', error: 'stale' });
  assert.equal('error' in (checked(eventsForUpdate(done, turn, { at: 1 }))[0] ?? {}), false, 'only a failure has a reason');
});

test('a failed compaction call carries its text as the reason', () => {
  const calls = new CompactionCalls();
  eventsForUpdate(recorded('claude-compact-tool_call'), turn, { at: 7, compactions: calls });
  const [failed] = checked(eventsForUpdate(recorded('claude-compact-tool_call_update-failed'), turn, { at: 9, compactions: calls }));
  assert.ok(failed?.kind === 'compaction');
  assert.match(failed.error ?? '', /OAuth access token has expired/);
});

test('compaction as a tool call becomes the same event, and its later updates follow the call id', () => {
  const calls = new CompactionCalls();
  const [started] = checked(eventsForUpdate(recorded('claude-compact-tool_call'), turn, { at: 7, compactions: calls }));
  assert.ok(started?.kind === 'compaction');
  assert.equal(started.status, 'in_progress');
  const [failed] = checked(eventsForUpdate(recorded('claude-compact-tool_call_update-failed'), turn, { at: 9, compactions: calls }));
  assert.ok(failed?.kind === 'compaction');
  assert.deepEqual([failed.id, failed.status], [started.id, 'failed']);
  // An adapter whose updates name only the call id: the host's memory is what recognizes it.
  const bare = updateOf({ sessionUpdate: 'tool_call_update', toolCallId: started.id, status: 'completed' });
  assert.equal(checked(eventsForUpdate(bare, turn, { at: 10, compactions: calls }))[0]?.kind, 'compaction');
  assert.equal(checked(eventsForUpdate(bare, turn, { at: 10 }))[0]?.kind, 'tool', 'without the memory it is an ordinary tool update');
  const noStatus = updateOf({ sessionUpdate: 'tool_call_update', toolCallId: started.id });
  assert.deepEqual(eventsForUpdate(noStatus, turn, { at: 11, compactions: calls }), [], 'an update with no status says nothing new');
});

test('the compaction memory is bounded: the oldest call id is forgotten', () => {
  const calls = new CompactionCalls();
  for (let position = 0; position <= AI_LIMITS.compactionsMax; position++) {
    calls.note(`call-${position}`);
  }
  assert.equal(calls.has('call-0'), false);
  assert.equal(calls.has('call-1'), true);
  assert.equal(calls.has(`call-${AI_LIMITS.compactionsMax}`), true);
});
