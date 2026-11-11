// Goal: the AI panel's channels accept exactly their declared payloads and
// replies — chat ids, turn ids, attachments, permission answers and review
// actions — and refuse every other shape and anything past a bound.
// Methodology: known-good and each known-bad payload through the shared payload
// inventory, and replies and pushes through the renderer's parsers.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import {
  parseAgentAvailability,
  parseAiAck,
  parseAiEventsPush,
  parseAiResult,
  parseChatTranscript,
  parseReviewOutcome,
  parsePromptTurn,
} from '#dist/shared/ipc/aiChat.js';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import { parseChatEvent } from '#dist/shared/properties/ai/chatModel.js';

const projectPath = '/projects/site';
const chat = `c${'a'.repeat(24)}`;
const turn = `t${'b'.repeat(16)}`;

test('good payloads parse for every AI channel', () => {
  assert.deepEqual(parseIpcPayload('ai:agents', { projectPath }), { projectPath });
  assert.deepEqual(parseIpcPayload('ai:chatCreate', { projectPath, agent: 'codex' }), { projectPath, agent: 'codex' });
  assert.deepEqual(parseIpcPayload('ai:chatUpdate', { projectPath, chat, pinned: true }), { projectPath, chat, pinned: true });
  const prompt = parseIpcPayload('ai:prompt', {
    projectPath,
    chat,
    text: 'Fix the heading',
    attachments: [
      { kind: 'image', name: 'shot.png', mimeType: 'image/png', data: 'aGVsbG8=' },
      { kind: 'file', path: 'src/pages/index.astro' },
    ],
  });
  assert.equal(prompt.attachments.length, 2);
  assert.deepEqual(parseIpcPayload('ai:permission', { projectPath, chat, request: 'p3', answer: { kind: 'option', optionId: 'allow_once' } }).answer, {
    kind: 'option',
    optionId: 'allow_once',
  });
  assert.deepEqual(
    parseIpcPayload('ai:review', { projectPath, chat, turn, path: 'notes.txt', action: { kind: 'resolve', resolution: ['ours', 'theirs'] } }).action,
    {
      kind: 'resolve',
      resolution: ['ours', 'theirs'],
    },
  );
  assert.deepEqual(parseAiAck({ chars: 12 }), { chars: 12 });
});

test('each bad payload shape is refused before main acts', () => {
  const bad: readonly (readonly [string, () => unknown])[] = [
    ['ai:chatCreate', () => parseIpcPayload('ai:chatCreate', { projectPath, agent: 'gemini' })],
    ['ai:chatUpdate', () => parseIpcPayload('ai:chatUpdate', { projectPath, chat: 'c123', title: 'x' })],
    ['ai:chatUpdate', () => parseIpcPayload('ai:chatUpdate', { projectPath, chat, title: '   ' })],
    ['ai:chatUpdate', () => parseIpcPayload('ai:chatUpdate', { projectPath, chat, title: 'x'.repeat(AI_LIMITS.titleCharsMax + 1) })],
    ['ai:prompt', () => parseIpcPayload('ai:prompt', { projectPath, chat, text: 'x'.repeat(AI_LIMITS.promptCharsMax + 1), attachments: [] })],
    [
      'ai:prompt',
      () =>
        parseIpcPayload('ai:prompt', {
          projectPath,
          chat,
          text: 'hi',
          attachments: Array.from({ length: AI_LIMITS.attachmentsMax + 1 }, () => ({ kind: 'file', path: 'a' })),
        }),
    ],
    [
      'ai:prompt',
      () => parseIpcPayload('ai:prompt', { projectPath, chat, text: 'hi', attachments: [{ kind: 'image', name: 'a', mimeType: 'image/svg+xml', data: '' }] }),
    ],
    [
      'ai:prompt',
      () =>
        parseIpcPayload('ai:prompt', {
          projectPath,
          chat,
          text: 'hi',
          attachments: [{ kind: 'image', name: 'a', mimeType: 'image/png', data: 'not base64!' }],
        }),
    ],
    ['ai:prompt', () => parseIpcPayload('ai:prompt', { projectPath, chat, text: 'hi', attachments: [{ kind: 'url', href: 'x' }] })],
    ['ai:permission', () => parseIpcPayload('ai:permission', { projectPath, chat, request: '3', answer: { kind: 'cancel' } })],
    ['ai:permission', () => parseIpcPayload('ai:permission', { projectPath, chat, request: 'p3', answer: { kind: 'always' } })],
    ['ai:review', () => parseIpcPayload('ai:review', { projectPath, chat, turn: 'turn', path: 'a', action: { kind: 'keep' } })],
    ['ai:review', () => parseIpcPayload('ai:review', { projectPath, chat, turn, path: 'a', action: { kind: 'delete' } })],
    ['ai:setOption', () => parseIpcPayload('ai:setOption', { projectPath, chat, option: 'model', value: 'x'.repeat(AI_LIMITS.idCharsMax + 1) })],
  ];
  for (const [channel, parse] of bad) {
    assert.throws(parse, Error, channel);
  }
  assert.throws(() => parseAiAck({ chars: -1 }));
  assert.throws(() => parseAiAck({ chars: Number.NaN }));
});

test('replies and pushes parse, and their bad shapes are refused', () => {
  assert.deepEqual(
    parseAgentAvailability({ agent: 'claude', state: 'needs-install', adapterVersion: '0.105.0', downloadMegabytes: 75 }).state,
    'needs-install',
  );
  assert.throws(() => parseAgentAvailability({ agent: 'claude', state: 'asleep' }));
  assert.deepEqual(parsePromptTurn({ turn }), { turn });
  const failure = parseAiResult({ ok: false, error: { code: 'sign-in', message: 'Sign in' } }, parsePromptTurn);
  assert.ok(!failure.ok);
  assert.equal(failure.error.code, 'sign-in');
  assert.throws(() => parseAiResult({ ok: false, error: { code: 'teapot', message: '' } }, parsePromptTurn));
  const transcript = parseChatTranscript({
    summary: { id: chat, agent: 'codex', title: 'T', pinned: false, createdAt: 1, updatedAt: 2 },
    events: [{ kind: 'turn-start', turn, at: 1 }],
    full: false,
  });
  assert.equal(transcript.events.length, 1);
  assert.throws(
    () => parseChatTranscript({ summary: { id: chat, agent: 'codex', title: 'T', pinned: false, createdAt: 3, updatedAt: 2 }, events: [], full: false }),
    /updated no earlier/,
  );
  assert.equal(
    parseReviewOutcome({ tag: 'drifted', clash: { path: 'a', ours: 'x', theirs: 'y', parts: [{ kind: 'clash', ours: 'x', theirs: 'y', changedBy: 'both' }] } })
      .tag,
    'drifted',
  );
  assert.throws(() => parseReviewOutcome({ tag: 'drifted', clash: { path: 'a', parts: [{ kind: 'clash', ours: 'x', theirs: 'y', changedBy: 'nobody' }] } }));
  const push = parseAiEventsPush({ projectPath, chat, events: [{ kind: 'text', turn, role: 'agent', text: 'hi' }], chars: 40 });
  assert.equal(push.events.length, 1);
  assert.throws(() => parseAiEventsPush({ projectPath, chat, events: [{ kind: 'text', turn, role: 'robot', text: 'hi' }], chars: 1 }));
});

test('chat events refuse unknown kinds and over-long fields', () => {
  assert.throws(() => parseChatEvent({ kind: 'hologram' }), /unknown kind/);
  assert.throws(() => parseChatEvent({ kind: 'notice', severity: 'loud', text: 'x' }));
  assert.throws(() => parseChatEvent({ kind: 'tool', turn, call: 'c', output: 'x'.repeat(AI_LIMITS.toolOutputCharsMax + 1) }));
  assert.equal(parseChatEvent({ kind: 'tool', turn, call: 'c' }).kind, 'tool');
});
