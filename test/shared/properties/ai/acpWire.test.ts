// Goal: Stacki reads exactly the ACP messages the real adapters send, refuses
// each malformed shape as a value (never a crash), holds every bound, and keeps
// an update kind it does not know as `unknown-update`.
// Methodology: replay lines recorded from @agentclientprotocol/claude-agent-acp
// 0.105.0 and @agentclientprotocol/codex-acp 2.6.0 in the spike
// (test/fixtures/ai/acpTrace.jsonl, paths and accounts redacted), then feed each
// parser its known-bad shapes and inputs one past each bound.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  parseAcpLine,
  parseInitializeResult,
  parsePermissionRequest,
  parsePromptResult,
  parseReadFileRequest,
  parseSessionNotification,
  parseSessionResult,
  parseWriteFileRequest,
} from '#dist/shared/properties/ai/acpWire.js';
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

function message(name: string) {
  const line = fixtures.get(name);
  assert.ok(line !== undefined, `fixture ${name}`);
  const parsed = parseAcpLine(line);
  assert.ok(parsed.ok, `fixture ${name} parses`);
  return parsed.value;
}

function update(name: string) {
  const parsed = message(name);
  assert.equal(parsed.kind, 'notification');
  assert.ok(parsed.kind === 'notification');
  const notification = parseSessionNotification(parsed.params);
  assert.ok(notification.ok, `${name}: ${notification.ok ? '' : notification.error.message}`);
  return notification.value.update;
}

test('every recorded line is JSON-RPC Stacki understands', () => {
  assert.ok(fixtures.size >= 15);
  for (const [name, line] of fixtures) {
    const parsed = parseAcpLine(line);
    assert.ok(parsed.ok, name);
    if (parsed.value.kind === 'notification' && parsed.value.method === 'session/update') {
      const notification = parseSessionNotification(parsed.value.params);
      assert.ok(notification.ok, name);
      assert.notEqual(notification.value.update.kind, 'unknown-update', `${name} is a known update`);
    }
  }
});

test('initialize answers carry what the host decides by', () => {
  const claude = message('claude-initialize');
  assert.ok(claude.kind === 'result');
  const claudeInit = parseInitializeResult(claude.result);
  assert.ok(claudeInit.ok);
  assert.equal(claudeInit.value.protocolVersion, 1);
  assert.equal(claudeInit.value.loadSession, true);
  assert.equal(claudeInit.value.resumeSession, true);
  assert.equal(claudeInit.value.images, true);
  const codex = message('codex-initialize');
  assert.ok(codex.kind === 'result');
  const codexInit = parseInitializeResult(codex.result);
  assert.ok(codexInit.ok);
  assert.equal(codexInit.value.agentName, '@agentclientprotocol/codex-acp');
});

test('a new session lists its modes and its select options, model and mode among them', () => {
  for (const agent of ['claude', 'codex']) {
    const answer = message(`${agent}-session-new`);
    assert.ok(answer.kind === 'result');
    const session = parseSessionResult(answer.result, undefined);
    assert.ok(session.ok, agent);
    assert.ok(session.value.sessionId.length > 0);
    assert.ok(session.value.modes.length >= 3);
    const categories = session.value.options.map((option) => option.category);
    assert.ok(categories.includes('mode'), agent);
    assert.ok(categories.includes('model'), agent);
    for (const option of session.value.options) {
      assert.ok(option.choices.some((choice) => choice.value === option.currentValue) || option.choices.length > 0, `${agent} ${option.id}`);
    }
  }
});

test('tool calls: diffs, streamed output, exit codes and subagents', () => {
  const diff = update('codex-tool_call-diff');
  assert.ok(diff.kind === 'tool-call');
  assert.equal(diff.call.toolKind, 'edit');
  const content = diff.call.content?.[0];
  assert.ok(content?.kind === 'diff');
  assert.equal(content.oldText, 'line one\nline two\n');
  assert.equal(content.newText, 'line one\nline 2\n');
  const output = update('codex-tool_call_update-output');
  assert.ok(output.kind === 'tool-call-update');
  assert.ok((output.call.outputDelta ?? '').length > 0);
  const subagent = update('codex-tool_call-subagent');
  assert.ok(subagent.kind === 'tool-call');
  assert.match(subagent.call.title ?? '', /subagent/i);
  const executed = update('codex-tool_call-execute');
  assert.ok(executed.kind === 'tool-call');
  assert.equal(executed.call.toolKind, 'execute');
  // Claude marks a subagent's calls with the call they run under.
  const nested = parseSessionNotification({
    sessionId: 's',
    update: {
      sessionUpdate: 'tool_call',
      toolCallId: 'child',
      title: 'Read',
      kind: 'read',
      status: 'pending',
      _meta: { claudeCode: { parentToolUseId: 'parent' } },
    },
  });
  assert.ok(nested.ok);
  assert.ok(nested.value.update.kind === 'tool-call');
  assert.equal(nested.value.update.call.parent, 'parent');
});

test('permission requests and the end of a prompt', () => {
  const request = message('codex-request-permission');
  assert.ok(request.kind === 'request');
  assert.equal(request.id, 0, 'a request id may be zero');
  const permission = parsePermissionRequest(request.params);
  assert.ok(permission.ok);
  assert.deepEqual(
    permission.value.options.map((option) => option.kind),
    ['allow_once', 'allow_always', 'reject_once'],
  );
  const end = message('codex-prompt-end');
  assert.ok(end.kind === 'result');
  const stop = parsePromptResult(end.result);
  assert.ok(stop.ok);
  assert.equal(stop.value.stopReason, 'end_turn');
  const auth = message('claude-prompt-auth-required');
  assert.ok(auth.kind === 'error');
  assert.equal(auth.code, -32000);
});

test('usage, commands and config updates', () => {
  const usage = update('codex-usage_update');
  assert.ok(usage.kind === 'usage');
  assert.ok(usage.size > usage.used);
  const commands = update('claude-available_commands_update');
  assert.ok(commands.kind === 'commands');
  assert.ok(commands.commands.length > 0);
  const config = update('codex-config_option_update');
  assert.ok(config.kind === 'config');
  assert.ok(config.options.some((option) => option.id === 'mode' && option.currentValue === 'read-only'));
});

test('an update kind Stacki does not know is kept, named, as unknown-update', () => {
  const parsed = parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'hologram_update', depth: 3 } });
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.value.update, { kind: 'unknown-update', sessionUpdate: 'hologram_update' });
  const content = parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'audio', data: 'x' } } });
  assert.ok(content.ok);
  assert.ok(content.value.update.kind === 'message');
  assert.deepEqual(content.value.update.content, { kind: 'other', type: 'audio' });
});

test('malformed envelopes are refused as values', () => {
  assert.deepEqual(parseAcpLine('{not json').ok, false);
  const notRpc = parseAcpLine('{"id":1,"result":{}}');
  assert.ok(!notRpc.ok);
  assert.equal(notRpc.error.code, 'not-json-rpc');
  const noId = parseAcpLine('{"jsonrpc":"2.0","result":{}}');
  assert.ok(!noId.ok);
  assert.equal(noId.error.code, 'bad-shape');
  const badError = parseAcpLine('{"jsonrpc":"2.0","id":1,"error":{"code":"x"}}');
  assert.ok(!badError.ok);
  const longMethod = parseAcpLine(JSON.stringify({ jsonrpc: '2.0', method: 'm'.repeat(AI_LIMITS.idCharsMax + 1) }));
  assert.ok(!longMethod.ok);
  assert.throws(() => parseAcpLine('x'.repeat(AI_LIMITS.lineBytesMax + 1)), /bounds a line/);
});

test('each malformed payload shape is refused, and bounds hold at the edge', () => {
  const bad = [
    parseSessionNotification(undefined),
    parseSessionNotification({ update: { sessionUpdate: 'plan', entries: [] } }),
    parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'plan', entries: 'none' } }),
    parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'plan', entries: [{ content: 'x', status: 'done', priority: 'high' }] } }),
    parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'no id' } }),
    parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'usage_update', used: -1, size: 10 } }),
    parseSessionNotification({
      sessionId: 's',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x'.repeat(AI_LIMITS.textCharsMax + 1) } },
    }),
    parsePermissionRequest({ sessionId: 's', toolCall: { toolCallId: 'c' }, options: [] }),
    parsePermissionRequest({ sessionId: 's', toolCall: { toolCallId: 'c' }, options: [{ optionId: 'a', name: 'A', kind: 'maybe' }] }),
    parsePromptResult({ stopReason: 'tired' }),
    parseInitializeResult({ protocolVersion: '1' }),
    parseReadFileRequest({ sessionId: 's' }),
    parseWriteFileRequest({ sessionId: 's', path: 'a', content: 'x'.repeat(AI_LIMITS.fileCharsMax + 1) }),
  ];
  for (const [index, result] of bad.entries()) {
    assert.equal(result.ok, false, `bad shape ${index}`);
  }
  const plan = Array.from({ length: AI_LIMITS.planEntriesMax }, () => ({ content: 'step', status: 'pending', priority: 'low' }));
  assert.ok(parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'plan', entries: plan } }).ok);
  assert.ok(!parseSessionNotification({ sessionId: 's', update: { sessionUpdate: 'plan', entries: [...plan, plan[0]] } }).ok);
  // One unreadable content item is skipped, as the spec allows, not the whole call.
  const skipped = parseSessionNotification({
    sessionId: 's',
    update: { sessionUpdate: 'tool_call', toolCallId: 'c', title: 't', content: [{ type: 'hologram' }, { type: 'terminal', terminalId: 't1' }] },
  });
  assert.ok(skipped.ok);
  assert.ok(skipped.value.update.kind === 'tool-call');
  assert.equal(skipped.value.update.call.content?.length, 1);
});
