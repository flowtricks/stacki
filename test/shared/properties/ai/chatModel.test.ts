// Goal: the chat model's version 2 additions hold: summaries carry their list
// fields, sections and the list reply are consistent, new event fields are
// optional so stored chats still read, compaction and sent parts are bounded.
// Methodology: known-good values, then each bad shape in turn; old events (no
// timings) are replayed to prove nothing stored before this change is refused.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_LIMITS } from '#dist/shared/properties/ai/aiLimits.js';
import {
  parseChatEvent,
  parseChatList,
  parseChatSection,
  parseChatSummary,
  parseChatSummaryLegacy,
  parseSectionName,
  parseSentPart,
  toChatId,
  toSectionId,
} from '#dist/shared/properties/ai/chatModel.js';

const chat = `c${'a'.repeat(24)}`;
const other = `c${'b'.repeat(24)}`;
const turn = `t${'1'.repeat(16)}`;
const sectionId = `s${'2'.repeat(16)}`;
const base = { id: chat, agent: 'claude', title: 'T', pinned: false, createdAt: 1, updatedAt: 2, rank: 0, unread: false };

test('a version 2 summary needs rank and unread, and keeps the optional list fields', () => {
  const full = parseChatSummary({
    ...base,
    section: sectionId,
    archivedAt: 5,
    context: { used: 10, size: 100 },
    forkOf: other,
  });
  assert.equal(full.section, sectionId);
  assert.deepEqual(full.context, { used: 10, size: 100 });
  assert.equal(full.forkOf, other);
  const plain = parseChatSummary(base);
  assert.equal(plain.section, undefined);
  assert.equal(plain.archivedAt, undefined);
  const bad: readonly Record<string, unknown>[] = [
    { ...base, rank: undefined },
    { ...base, rank: -1 },
    { ...base, rank: 1.5 },
    { ...base, unread: undefined },
    { ...base, unread: 'no' },
    { ...base, section: 'x' },
    { ...base, forkOf: chat },
    { ...base, forkOf: 'c1' },
    { ...base, archivedAt: -2 },
    { ...base, context: { used: 1 } },
    { ...base, context: { used: AI_LIMITS.contextTokensMax + 1, size: 1 } },
    { ...base, updatedAt: 0 },
  ];
  for (const input of bad) {
    assert.throws(() => parseChatSummary(input), Error, JSON.stringify(input));
  }
});

test('a version 1 summary migrates to the first section with the rank it is given', () => {
  const legacy = { id: chat, agent: 'codex', title: 'Old', pinned: true, createdAt: 1, updatedAt: 1 };
  const migrated = parseChatSummaryLegacy(legacy, 3);
  assert.equal(migrated.rank, 3);
  assert.equal(migrated.pinned, true);
  assert.equal(migrated.unread, false);
  assert.equal(migrated.section, undefined);
  assert.throws(() => parseChatSummaryLegacy(legacy, -1));
  assert.throws(() => parseChatSummaryLegacy({ ...legacy, agent: 'gemini' }, 0));
});

test('sections: names are trimmed and bounded, ids are branded, the list is consistent', () => {
  assert.equal(parseSectionName('  Launch  '), 'Launch');
  assert.equal(parseSectionName('x'.repeat(AI_LIMITS.sectionNameCharsMax)).length, AI_LIMITS.sectionNameCharsMax);
  for (const name of ['', '   ', 'x'.repeat(AI_LIMITS.sectionNameCharsMax + 1), 4]) {
    assert.throws(() => parseSectionName(name), Error, String(name));
  }
  assert.throws(() => toSectionId('s123'), /SectionId/);
  assert.throws(() => toSectionId(chat), /SectionId/);
  const section = { id: sectionId, name: 'Launch', collapsed: false, rank: 0 };
  assert.deepEqual(parseChatSection(section), section);
  assert.throws(() => parseChatSection({ ...section, collapsed: 'no' }));
  const listed = parseChatList({ sections: [section], chats: [{ ...base, section: sectionId }] });
  assert.equal(listed.chats.length, 1);
  assert.throws(() => parseChatList({ sections: [], chats: [{ ...base, section: sectionId }] }), /not listed/);
  assert.throws(() => parseChatList({ sections: [section, section], chats: [] }), /repeated section/);
  assert.throws(() => parseChatList({ sections: Array.from({ length: AI_LIMITS.sectionsMax + 1 }, () => section), chats: [] }), /exceeds limit/);
  assert.throws(() => parseChatList({ sections: [] }), /expected array/);
});

test('events stored before timings still parse; the new fields parse when present and are bounded', () => {
  const oldText = parseChatEvent({ kind: 'text', turn, role: 'thought', text: 'hm' });
  assert.ok(oldText.kind === 'text');
  assert.equal(oldText.at, undefined);
  const timed = parseChatEvent({ kind: 'text', turn, role: 'thought', text: 'hm', at: 10, until: 22 });
  assert.ok(timed.kind === 'text');
  assert.equal(timed.until, 22);
  assert.throws(() => parseChatEvent({ kind: 'text', turn, role: 'agent', text: 'x', at: -1 }));
  const tool = parseChatEvent({ kind: 'tool', turn, call: 'k', at: 3, toolName: 'Bash', command: 'ls', background: true });
  assert.ok(tool.kind === 'tool');
  assert.equal(tool.background, true);
  assert.throws(() => parseChatEvent({ kind: 'tool', turn, call: 'k', background: 'yes' }));
  assert.throws(() => parseChatEvent({ kind: 'tool', turn, call: 'k', command: 'x'.repeat(AI_LIMITS.labelCharsMax + 1) }));
  const user = parseChatEvent({ kind: 'user', turn, text: 'hi', attachments: [], at: 1, mode: 'steer', parts: [{ kind: 'text', text: 'hi' }] });
  assert.ok(user.kind === 'user');
  assert.equal(user.mode, 'steer');
  assert.throws(() => parseChatEvent({ kind: 'user', turn, text: 'hi', attachments: [], at: 1, mode: 'shout' }));
  assert.throws(() =>
    parseChatEvent({
      kind: 'user',
      turn,
      text: 'hi',
      attachments: [],
      at: 1,
      parts: Array.from({ length: AI_LIMITS.promptPartsMax + 1 }, () => ({ kind: 'text', text: 'a' })),
    }),
  );
});

test('compaction events: status and id are required, the turn is optional', () => {
  const event = parseChatEvent({ kind: 'compaction', id: 'c1', status: 'completed', at: 9 });
  assert.ok(event.kind === 'compaction');
  assert.equal(event.turn, undefined);
  assert.equal(parseChatEvent({ kind: 'compaction', turn, id: 'c1', status: 'cancelled', at: 9 }).kind, 'compaction');
  for (const bad of [
    { kind: 'compaction', id: 'c1', status: 'paused', at: 9 },
    { kind: 'compaction', id: '', status: 'completed', at: 9 },
    { kind: 'compaction', id: 'c1', status: 'completed' },
    { kind: 'compaction', turn: 'nope', id: 'c1', status: 'completed', at: 9 },
  ]) {
    assert.throws(() => parseChatEvent(bad), Error, JSON.stringify(bad));
  }
  assert.throws(() => parseChatEvent({ kind: 'usage', used: AI_LIMITS.contextTokensMax + 1, size: 1 }));
});

test('compaction events: the failure reason is optional, text, and bounded', () => {
  // A JSON null as the wire would carry it, without writing the literal (AGENTS.md section 6).
  const wireNull: unknown = JSON.parse('null');
  const failed = { kind: 'compaction', id: 'c1', status: 'failed', at: 9 };
  const reason = parseChatEvent({ ...failed, error: 'Failed to authenticate' });
  assert.ok(reason.kind === 'compaction');
  assert.equal(reason.error, 'Failed to authenticate');
  const bare = parseChatEvent(failed);
  assert.ok(bare.kind === 'compaction');
  assert.equal(bare.error, undefined, 'a stored event from before the reason reads as before');
  assert.equal(parseChatEvent({ ...failed, error: 'x'.repeat(AI_LIMITS.compactionErrorCharsMax) }).kind, 'compaction', 'the bound itself is allowed');
  for (const bad of [
    { ...failed, error: 'x'.repeat(AI_LIMITS.compactionErrorCharsMax + 1) },
    { ...failed, error: 7 },
    { ...failed, error: wireNull },
  ]) {
    assert.throws(() => parseChatEvent(bad), Error, JSON.stringify(bad));
  }
});

test('sent parts: a file keeps an excerpt within the bound, a built-in only a hash', () => {
  assert.deepEqual(parseSentPart({ kind: 'file', path: 'a.md', truncated: false, excerpt: 'x'.repeat(AI_LIMITS.mentionPreviewCharsMax) }).kind, 'file');
  assert.deepEqual(parseSentPart({ kind: 'builtin', id: 'app-builder', textHash: 'abcdef0123456789' }), {
    kind: 'builtin',
    id: 'app-builder',
    textHash: 'abcdef0123456789',
  });
  const bad = [
    { kind: 'file', path: 'a.md', truncated: false, excerpt: 'x'.repeat(AI_LIMITS.mentionPreviewCharsMax + 1) },
    { kind: 'file', path: '../a.md', truncated: false },
    { kind: 'file', path: 'a.md' },
    { kind: 'builtin', id: 'app-builder', textHash: 'not hex!' },
    { kind: 'builtin', id: 'app-builder', text: 'the whole instructions' },
    { kind: 'skill', name: 'x', source: 'user', path: '/abs' },
    { kind: 'voice' },
  ];
  for (const part of bad) {
    assert.throws(() => parseSentPart(part), Error, JSON.stringify(part).slice(0, 60));
  }
});

test('brands keep lookalike strings apart at compile time', () => {
  const section = toSectionId(sectionId);
  // @ts-expect-error A section id is not a chat id, though both are strings.
  const asChat: ReturnType<typeof toChatId> = section;
  assert.equal(String(asChat), sectionId);
});

test('an untracked-changes event names its turn and one known reason', () => {
  for (const reason of ['off', 'unavailable']) {
    assert.deepEqual(parseChatEvent({ kind: 'changes-untracked', turn, reason }), { kind: 'changes-untracked', turn, reason });
  }
  for (const reason of [undefined, '', 'Off', 'disabled', 1, {}]) {
    assert.throws(() => parseChatEvent({ kind: 'changes-untracked', turn, reason }), /reason/);
  }
  assert.throws(() => parseChatEvent({ kind: 'changes-untracked', turn: 'bad', reason: 'off' }));
  assert.throws(() => parseChatEvent({ kind: 'changes-untracked', reason: 'off' }));
});
