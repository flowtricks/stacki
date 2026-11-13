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
  parseChatList,
  parseChatTranscript,
  parseCompactStarted,
  parseDiffReply,
  parseMentionReply,
  parseSteerReply,
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
  assert.deepEqual(parseIpcPayload('ai:prewarm', { projectPath, agent: 'claude', action: 'warm' }), { projectPath, agent: 'claude', action: 'warm' });
  assert.deepEqual(parseIpcPayload('ai:prewarm', { projectPath, agent: 'codex', action: 'release' }), { projectPath, agent: 'codex', action: 'release' });
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
    ['ai:remember', () => parseIpcPayload('ai:remember', { projectPath, agent: 'gemini', action: { kind: 'reset' } })],
    ['ai:prewarm', () => parseIpcPayload('ai:prewarm', { projectPath, agent: 'claude', action: 'start' })],
    ['ai:prewarm', () => parseIpcPayload('ai:prewarm', { projectPath, agent: 'claude' })],
    ['ai:prewarm', () => parseIpcPayload('ai:prewarm', { projectPath, agent: 'gemini', action: 'warm' })],
    ['ai:remember', () => parseIpcPayload('ai:remember', { projectPath, agent: 'claude', action: { kind: 'forget' } })],
    ['ai:remember', () => parseIpcPayload('ai:remember', { projectPath, agent: 'claude', action: { kind: 'set', option: '', value: 'x' } })],
    [
      'ai:remember',
      () =>
        parseIpcPayload('ai:remember', { projectPath, agent: 'claude', action: { kind: 'set', option: 'model', value: 'x'.repeat(AI_LIMITS.idCharsMax + 1) } }),
    ],
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
    summary: { id: chat, agent: 'codex', title: 'T', pinned: false, createdAt: 1, updatedAt: 2, rank: 0, unread: false },
    events: [{ kind: 'turn-start', turn, at: 1 }],
    full: false,
  });
  assert.equal(transcript.events.length, 1);
  assert.throws(
    () =>
      parseChatTranscript({
        summary: { id: chat, agent: 'codex', title: 'T', pinned: false, createdAt: 3, updatedAt: 2, rank: 0, unread: false },
        events: [],
        full: false,
      }),
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
  // A sign-in ends a turn as its own stop; a stored chat's old `sign-in` notice still parses.
  assert.equal(parseChatEvent({ kind: 'turn-end', turn, stop: 'sign-in', message: undefined, at: 1 }).kind, 'turn-end');
  assert.throws(() => parseChatEvent({ kind: 'turn-end', turn, stop: 'logged-out', message: undefined, at: 1 }));
  assert.equal(parseChatEvent({ kind: 'notice', severity: 'sign-in', text: 'Sign in to Claude to continue.' }).kind, 'notice');
});

// ---------------------------------------------------------------------------
// The panel overhaul's channels: steer, compact, fork, move, sections, diff, mentions.
// ---------------------------------------------------------------------------

const firstSection = `s${'1'.repeat(16)}`;

test('the new payloads parse, and undefined stands for "the first section" and "the end"', () => {
  const steer = parseIpcPayload('ai:steer', {
    projectPath,
    chat,
    text: 'Also the footer',
    attachments: [],
    parts: [{ kind: 'text', text: 'Also the footer' }],
  });
  assert.equal(steer.parts?.length, 1);
  assert.deepEqual(parseIpcPayload('ai:compact', { projectPath, chat }), { projectPath, chat });
  assert.deepEqual(parseIpcPayload('ai:chatFork', { projectPath, chat }), { projectPath, chat });
  assert.deepEqual(parseIpcPayload('ai:chatMove', { projectPath, chat }), { projectPath, chat }, 'no section and no anchor: last in the first section');
  const move = parseIpcPayload('ai:chatMove', { projectPath, chat, section: firstSection, before: `c${'d'.repeat(24)}` });
  assert.equal(move.section, firstSection);
  for (const action of [
    { kind: 'create', name: ' Launch ' },
    { kind: 'rename', section: firstSection, name: 'Ship' },
    { kind: 'delete', section: firstSection },
    { kind: 'collapse', section: firstSection, collapsed: true },
    { kind: 'move', section: firstSection },
    { kind: 'move', section: firstSection, before: `s${'3'.repeat(16)}` },
  ]) {
    assert.equal(parseIpcPayload('ai:sections', { projectPath, action }).action.kind, action.kind);
  }
  assert.equal(parseIpcPayload('ai:sections', { projectPath, action: { kind: 'create', name: ' Launch ' } }).action.kind, 'create');
  assert.deepEqual(parseIpcPayload('ai:diff', { projectPath, chat, turn, path: 'src/a.astro' }).path, 'src/a.astro');
  assert.deepEqual(parseIpcPayload('ai:mentions', { projectPath, query: '', kinds: [] }).kinds, []);
  const update = parseIpcPayload('ai:chatUpdate', { projectPath, chat, archived: true, unread: false });
  assert.equal(update.archived, true);
  assert.equal(update.unread, false);
  assert.equal(parseIpcPayload('ai:prompt', { projectPath, chat, text: 'x', attachments: [], mode: 'steer' }).mode, 'steer');
});

test('each bad new payload is refused before main acts', () => {
  const bad: readonly (readonly [string, () => unknown])[] = [
    ['steer without attachments', () => parseIpcPayload('ai:steer', { projectPath, chat, text: 'x' })],
    ['steer too long', () => parseIpcPayload('ai:steer', { projectPath, chat, text: 'x'.repeat(AI_LIMITS.promptCharsMax + 1), attachments: [] })],
    [
      '17 chips',
      () =>
        parseIpcPayload('ai:prompt', {
          projectPath,
          chat,
          text: 'x',
          attachments: [],
          parts: Array.from({ length: AI_LIMITS.mentionsMax + 1 }, () => ({ kind: 'file', path: 'a' })),
        }),
    ],
    ['chip path escapes', () => parseIpcPayload('ai:prompt', { projectPath, chat, text: 'x', attachments: [], parts: [{ kind: 'file', path: '../a' }] })],
    [
      'absolute chip path',
      () => parseIpcPayload('ai:steer', { projectPath, chat, text: 'x', attachments: [], parts: [{ kind: 'file', path: '/etc/passwd' }] }),
    ],
    ['unknown mode', () => parseIpcPayload('ai:prompt', { projectPath, chat, text: 'x', attachments: [], mode: 'queue' })],
    ['compact without chat', () => parseIpcPayload('ai:compact', { projectPath })],
    ['fork with a bad id', () => parseIpcPayload('ai:chatFork', { projectPath, chat: 'c1' })],
    ['move to a chat id as section', () => parseIpcPayload('ai:chatMove', { projectPath, chat, section: chat })],
    ['move before a section id', () => parseIpcPayload('ai:chatMove', { projectPath, chat, before: firstSection })],
    ['null section', () => parseIpcPayload('ai:chatMove', { projectPath, chat, section: null })], // eslint-disable-line stacki/no-null -- the payload must refuse a null section

    ['empty section name', () => parseIpcPayload('ai:sections', { projectPath, action: { kind: 'create', name: '   ' } })],
    [
      'long section name',
      () => parseIpcPayload('ai:sections', { projectPath, action: { kind: 'create', name: 'x'.repeat(AI_LIMITS.sectionNameCharsMax + 1) } }),
    ],
    ['unknown section action', () => parseIpcPayload('ai:sections', { projectPath, action: { kind: 'merge', section: firstSection } })],
    ['collapse without a flag', () => parseIpcPayload('ai:sections', { projectPath, action: { kind: 'collapse', section: firstSection } })],
    ['rename a chat id', () => parseIpcPayload('ai:sections', { projectPath, action: { kind: 'rename', section: chat, name: 'x' } })],
    ['diff without turn', () => parseIpcPayload('ai:diff', { projectPath, chat, path: 'a' })],
    ['diff with NUL path', () => parseIpcPayload('ai:diff', { projectPath, chat, turn, path: 'a\0b' })],
    ['mentions query too long', () => parseIpcPayload('ai:mentions', { projectPath, query: 'x'.repeat(AI_LIMITS.mentionQueryCharsMax + 1), kinds: [] })],
    ['mentions unknown kind', () => parseIpcPayload('ai:mentions', { projectPath, query: '', kinds: ['folder'] })],
    ['mentions repeated kind', () => parseIpcPayload('ai:mentions', { projectPath, query: '', kinds: ['file', 'file'] })],
    ['archived as text', () => parseIpcPayload('ai:chatUpdate', { projectPath, chat, archived: 'yes' })],
  ];
  for (const [name, parse] of bad) {
    assert.throws(parse, Error, name);
  }
});

test('the new replies parse and their bad shapes are refused', () => {
  const summary = { id: chat, agent: 'claude', title: 'T', pinned: false, createdAt: 1, updatedAt: 2, rank: 0, unread: false };
  const list = parseChatList({ chats: [summary], sections: [] });
  assert.equal(list.chats.length, 1);
  assert.throws(() => parseChatList([summary]), Error, 'the old bare array is no longer a reply');
  assert.deepEqual(parseSteerReply({ turn, outcome: 'steered' }), { turn, outcome: 'steered' });
  assert.throws(() => parseSteerReply({ turn, outcome: 'promptRequired' }), /outcome/);
  assert.throws(() => parseSteerReply({ outcome: 'steered' }));
  assert.deepEqual(parseCompactStarted({ started: true }), { started: true });
  assert.throws(() => parseCompactStarted({ started: false }));
  assert.deepEqual(parseDiffReply({ oldText: undefined, newText: 'a' }), { oldText: undefined, newText: 'a' });
  assert.throws(() => parseDiffReply({ oldText: 'x'.repeat(AI_LIMITS.fileCharsMax + 1) }), /exceeds limit/);
  assert.throws(() => parseDiffReply({ newText: 4 }));
  assert.equal(parseMentionReply([{ kind: 'file', path: 'a.md', name: 'a.md' }]).length, 1);
  assert.throws(() => parseMentionReply([{ kind: 'file', path: '../a.md', name: 'a.md' }]));
  for (const code of ['unsupported', 'section-missing', 'invalid']) {
    assert.deepEqual(parseAiResult({ ok: false, error: { code, message: 'm' } }, parseCompactStarted), { ok: false, error: { code, message: 'm' } });
  }
  assert.throws(() => parseAiResult({ ok: false, error: { code: 'nope', message: 'm' } }, parseCompactStarted));
});
