// Goal: the protocol facts the panel overhaul relies on are read exactly as the
// real adapters send them: capability flags from `initialize`, compaction in
// both of Claude's shapes, a tool's name and the three fields of its input,
// steering and fork results; and every malformed variant is refused as a value.
// Methodology: replay the lines recorded from the installed Claude adapter 0.105.0
// (spike of the overhaul: test/fixtures/ai/acpTrace.jsonl, accounts redacted) and
// Codex 2.6.0, then feed each parser hand-made shapes, one past each bound.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { parseAcpLine, parseForkResult, parseInitializeResult, parseSessionNotification, parseSteerResult } from '#dist/shared/properties/ai/acpWire.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';

const fixtures = new Map<string, string>(
  fs
    .readFileSync(path.resolve('test/fixtures/ai/acpTrace.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const entry: unknown = JSON.parse(line);
      assert.ok(typeof entry === 'object' && entry !== null && 'name' in entry && 'line' in entry);
      return [String(entry.name), String(entry.line)];
    }),
);

function recorded(name: string) {
  const line = fixtures.get(name);
  assert.ok(line !== undefined, `fixture ${name}`);
  const parsed = parseAcpLine(line);
  assert.ok(parsed.ok, name);
  return parsed.value;
}

function recordedUpdate(name: string) {
  const message = recorded(name);
  assert.ok(message.kind === 'notification');
  const notification = parseSessionNotification(message.params);
  assert.ok(notification.ok, name);
  return notification.value.update;
}

function updateOf(body: Record<string, unknown>) {
  const parsed = parseSessionNotification({ sessionId: 's', update: body });
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.error.message);
  return parsed.value.update;
}

test('initialize: steering, queueing, fork, close, delete and title come from the capabilities', () => {
  const claude = recorded('claude-initialize');
  assert.ok(claude.kind === 'result');
  const claudeInit = parseInitializeResult(claude.result);
  assert.ok(claudeInit.ok);
  assert.deepEqual(
    [
      claudeInit.value.steering,
      claudeInit.value.promptQueueing,
      claudeInit.value.fork,
      claudeInit.value.close,
      claudeInit.value.delete,
      claudeInit.value.title,
    ],
    [true, true, true, true, true, true],
  );
  const codex = recorded('codex-initialize');
  assert.ok(codex.kind === 'result');
  const codexInit = parseInitializeResult(codex.result);
  assert.ok(codexInit.ok);
  assert.equal(codexInit.value.steering, true, 'Codex advertises steering (semantics unverified)');
  assert.equal(codexInit.value.promptQueueing, false, 'Codex does not queue');
  assert.equal(codexInit.value.fork, true);
  const bare = parseInitializeResult({ protocolVersion: 1 });
  assert.ok(bare.ok);
  assert.deepEqual(
    [bare.value.steering, bare.value.promptQueueing, bare.value.fork, bare.value.close, bare.value.delete, bare.value.title],
    [false, false, false, false, false, false],
    'an agent that says nothing offers nothing',
  );
  const lookalike = parseInitializeResult({
    protocolVersion: 1,
    _meta: { steering: { supported: 'yes' } },
    agentCapabilities: { sessionCapabilities: { fork: true } },
  });
  assert.ok(lookalike.ok);
  assert.equal(lookalike.value.steering, false, 'only `supported: true` counts');
  assert.equal(lookalike.value.fork, false, 'a capability is an object, not a boolean');
});

test('compaction: the lifecycle update with the capability, the synthetic tool call without', () => {
  const started = recordedUpdate('claude-compaction_update-in-progress');
  assert.ok(started.kind === 'compaction');
  assert.equal(started.status, 'in_progress');
  assert.ok(started.id.length > 0);
  const failed = recordedUpdate('claude-compaction_update-failed');
  assert.ok(failed.kind === 'compaction');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.id, started.id, 'the same compaction, patched');
  assert.match(failed.error ?? '', /compaction/i);
  const call = recordedUpdate('claude-compact-tool_call');
  assert.ok(call.kind === 'tool-call');
  assert.equal(call.call.toolName, 'compact');
  assert.equal(call.call.title, 'Compact conversation');
  const later = recordedUpdate('claude-compact-tool_call_update-failed');
  assert.ok(later.kind === 'tool-call-update');
  assert.equal(later.call.toolName, 'compact', 'the recorded update repeats the tool name; the host still remembers the call id for adapters that do not');
  assert.equal(later.call.id, call.call.id);
});

test('compaction: summary chunks are acknowledged; unknown and malformed variants are not guessed at', () => {
  assert.deepEqual(updateOf({ sessionUpdate: 'compaction_summary_chunk', compactionId: 'c1', content: { type: 'text', text: 'x' } }), {
    kind: 'compaction-summary',
    id: 'c1',
  });
  const future = updateOf({ sessionUpdate: 'compaction_update', compactionId: 'c1', status: '_vendor_paused' });
  assert.deepEqual(future, { kind: 'unknown-update', sessionUpdate: 'compaction_update' }, 'a reserved status is shown as unsupported');
  for (const status of ['completed', 'cancelled'] as const) {
    const update = updateOf({ sessionUpdate: 'compaction_update', compactionId: 'c1', status });
    assert.ok(update.kind === 'compaction');
    assert.equal(update.status, status);
  }
  const bad = [
    { sessionUpdate: 'compaction_update', status: 'completed' },
    { sessionUpdate: 'compaction_update', compactionId: 7, status: 'completed' },
    { sessionUpdate: 'compaction_update', compactionId: 'x'.repeat(AI_LIMITS.idCharsMax + 1), status: 'completed' },
    { sessionUpdate: 'compaction_summary_chunk' },
  ];
  for (const body of bad) {
    assert.equal(parseSessionNotification({ sessionId: 's', update: body }).ok, false, JSON.stringify(body));
  }
});

test('tool calls keep the agent’s tool name and only three fields of its input', () => {
  const bash = updateOf({
    sessionUpdate: 'tool_call',
    toolCallId: 't1',
    title: 'Terminal',
    kind: 'execute',
    status: 'in_progress',
    rawInput: { command: 'sleep 20; echo done', description: 'Wait', run_in_background: true, content: 'x'.repeat(10_000) },
    _meta: { claudeCode: { toolName: 'Bash' } },
  });
  assert.ok(bash.kind === 'tool-call');
  assert.equal(bash.call.toolName, 'Bash');
  assert.deepEqual(bash.call.rawInput, { command: 'sleep 20; echo done', description: 'Wait', runInBackground: true });
  const odd = updateOf({ sessionUpdate: 'tool_call', toolCallId: 't2', rawInput: { command: ['ls'], run_in_background: 'yes', other: 1 } });
  assert.ok(odd.kind === 'tool-call');
  assert.equal(odd.call.rawInput, undefined, 'a command that is not text and a flag that is not boolean are dropped');
  const none = updateOf({ sessionUpdate: 'tool_call', toolCallId: 't3', rawInput: 'text' });
  assert.ok(none.kind === 'tool-call');
  assert.equal(none.call.rawInput, undefined);
  const subagent = recordedUpdate('codex-tool_call-subagent');
  assert.ok(subagent.kind === 'tool-call');
  assert.equal(subagent.call.activityKind, 'started', 'Codex says what a subagent call did in rawInput.activityKind');
  const executed = recordedUpdate('codex-tool_call-execute');
  assert.ok(executed.kind === 'tool-call');
  assert.match(executed.call.rawInput?.command ?? '', /^pwd/);
});

test('usage is a count within the sanity ceiling', () => {
  const ok = updateOf({ sessionUpdate: 'usage_update', used: 41_250, size: 1_000_000 });
  assert.deepEqual(ok, { kind: 'usage', used: 41_250, size: 1_000_000 });
  for (const body of [
    { used: -1, size: 10 },
    { used: 1.5, size: 10 },
    { used: AI_LIMITS.contextTokensMax + 1, size: 10 },
    { used: 1, size: AI_LIMITS.contextTokensMax + 1 },
  ]) {
    assert.equal(parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'usage_update', ...body } }).ok, false, JSON.stringify(body));
  }
});

test('steering results: idle without a turn asks for a prompt; any other outcome is refused', () => {
  const idle = recorded('claude-steer-idle');
  assert.ok(idle.kind === 'result');
  const parsed = parseSteerResult(idle.result);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.outcome, 'promptRequired');
  for (const outcome of ['steered', 'startedNewTurn'] as const) {
    const result = parseSteerResult({ outcome });
    assert.ok(result.ok);
    assert.equal(result.value.outcome, outcome);
  }
  for (const bad of [{ outcome: 'queued' }, { outcome: 7 }, {}, 'steered', undefined]) {
    assert.equal(parseSteerResult(bad).ok, false, JSON.stringify(bad));
  }
});

test('a fork answers with a session of its own, shaped like a new one', () => {
  const fork = recorded('claude-fork-result');
  assert.ok(fork.kind === 'result');
  const session = parseForkResult(fork.result);
  assert.ok(session.ok);
  assert.ok(session.value.sessionId.length > 0);
  assert.ok(session.value.modes.length >= 3);
  assert.equal(parseForkResult({ modes: {} }).ok, false, 'a fork names its session');
  assert.equal(parseForkResult(undefined).ok, false);
});
