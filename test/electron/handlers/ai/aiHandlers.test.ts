// Goal: the AI panel's channels, registered in the real main process, work in
// the open project and nowhere else, and keep chats under userData, never in
// the project: creating a chat succeeds and writes only the store's files.
// Methodology: load main.js in the windowless harness, open a temporary
// project with project:scan, then invoke the AI channels as the renderer does.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { mainHarness } from '../../../helpers/mainHarness.ts';
import {
  parseAiAgentsReply,
  parseAiResult,
  parseChatList,
  parseDiffReply,
  parseMentionReply,
  parseCompactStarted,
  parseSteerReply,
} from '#dist/shared/ipc/aiChat.js';
import { parseChatSummary } from '#dist/shared/properties/ai/chatModel.js';

test('a new chat in the open project is stored under userData and listed', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ai-handlers-'));
  const userData = path.join(root, 'user');
  const project = path.join(root, 'site');
  fs.mkdirSync(path.join(project, 'src/pages'), { recursive: true });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(project, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const harness = mainHarness(userData);
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await harness.invoke('project:scan', project);
  const before = fs.readdirSync(project).sort();
  const created = parseAiResult(await harness.invoke('ai:chatCreate', { projectPath: project, agent: 'codex' }), parseChatSummary);
  assert.ok(created.ok, created.ok ? '' : created.error.message);
  assert.equal(created.value.title, 'New chat');
  assert.deepEqual(fs.readdirSync(project).sort(), before, 'nothing is written in the project');
  const stores = fs.readdirSync(path.join(userData, 'ai', 'projects'));
  assert.equal(stores.length, 1);
  assert.ok(fs.existsSync(path.join(userData, 'ai', 'projects', stores[0] ?? '', 'index.json')));
  const listed = parseChatList(await harness.invoke('ai:chats', { projectPath: `${project}/` }));
  assert.deepEqual(
    listed.chats.map((chat) => chat.id),
    [created.value.id],
    'a trailing slash names the same project',
  );
  const agents = parseAiAgentsReply(await harness.invoke('ai:agents', { projectPath: project }));
  assert.equal(agents.trusted, true, 'opening the panel allows agents here (Settings can ask instead)');
  assert.equal(agents.agents.length, 2);
  await assert.rejects(harness.invoke('ai:chats', { projectPath: path.join(project, 'src') }), /open project only/);
  await assert.rejects(harness.invoke('ai:chats', { projectPath: root }), /open project only/);
});

test('the list channels: move, sections, pin, archive, unread, fork, diff, mentions, and honest refusals', async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-ai-list-'));
  const userData = path.join(root, 'user');
  const project = path.join(root, 'site');
  fs.mkdirSync(path.join(project, 'src/pages'), { recursive: true });
  fs.mkdirSync(userData);
  fs.writeFileSync(path.join(project, 'package.json'), '{"dependencies":{"astro":"*"}}');
  fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Notes');
  const harness = mainHarness(userData);
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  await harness.invoke('project:scan', project);
  const make = async () => {
    const created = parseAiResult(await harness.invoke('ai:chatCreate', { projectPath: project, agent: 'claude' }), parseChatSummary);
    assert.ok(created.ok);
    return created.value.id;
  };
  const first = await make();
  const second = await make();
  const third = await make();
  const list = async () => parseChatList(await harness.invoke('ai:chats', { projectPath: project }));
  assert.deepEqual(
    (await list()).chats.map((chat) => chat.id),
    [third, second, first],
    'new chats go to the top',
  );

  const created = parseAiResult(await harness.invoke('ai:sections', { projectPath: project, action: { kind: 'create', name: 'Launch' } }), parseChatList);
  assert.ok(created.ok);
  const section = created.value.sections[0]?.id;
  assert.ok(section !== undefined);
  const twin = parseAiResult(await harness.invoke('ai:sections', { projectPath: project, action: { kind: 'create', name: ' launch ' } }), parseChatList);
  assert.ok(!twin.ok && twin.error.code === 'invalid', 'a repeated name is refused');

  const moved = parseAiResult(await harness.invoke('ai:chatMove', { projectPath: project, chat: first, section }), parseChatList);
  assert.ok(moved.ok);
  assert.equal(moved.value.chats.find((chat) => chat.id === first)?.section, section);
  const missing = parseAiResult(await harness.invoke('ai:chatMove', { projectPath: project, chat: first, section: `s${'f'.repeat(16)}` }), parseChatList);
  assert.ok(!missing.ok && missing.error.code === 'section-missing');

  const pinned = parseAiResult(await harness.invoke('ai:chatUpdate', { projectPath: project, chat: second, pinned: true, unread: true }), parseChatSummary);
  assert.ok(pinned.ok);
  assert.deepEqual([pinned.value.pinned, pinned.value.unread, pinned.value.rank], [true, true, 0]);
  const archived = parseAiResult(await harness.invoke('ai:chatUpdate', { projectPath: project, chat: third, archived: true }), parseChatSummary);
  assert.ok(archived.ok && archived.value.archivedAt !== undefined);
  const restored = parseAiResult(await harness.invoke('ai:chatUpdate', { projectPath: project, chat: third, archived: false }), parseChatSummary);
  assert.ok(restored.ok && restored.value.archivedAt === undefined);
  const gone = parseAiResult(await harness.invoke('ai:chatUpdate', { projectPath: project, chat: `c${'0'.repeat(24)}`, pinned: true }), parseChatSummary);
  assert.ok(!gone.ok && gone.error.code === 'chat-missing');

  const forked = parseAiResult(await harness.invoke('ai:chatFork', { projectPath: project, chat: first }), parseChatSummary);
  assert.ok(forked.ok);
  assert.equal(forked.value.forkOf, first);
  assert.equal(forked.value.section, section, 'a fork lands in its original’s section');

  const deleted = parseAiResult(await harness.invoke('ai:sections', { projectPath: project, action: { kind: 'delete', section } }), parseChatList);
  assert.ok(deleted.ok);
  assert.equal(deleted.value.sections.length, 0);
  assert.equal(deleted.value.chats.length, 4, 'deleting a section deletes no chat');
  assert.ok(deleted.value.chats.every((chat) => chat.section === undefined));

  // Steering and compaction reach the host. No adapter is installed in this harness, so a steer that would start
  // a turn fails before anything runs, and a compaction has no conversation to compact; both are values, not throws.
  const notRunnable = ['missing-cli', 'not-installed'];
  const steer = parseAiResult(await harness.invoke('ai:steer', { projectPath: project, chat: first, text: 'x', attachments: [] }), parseSteerReply);
  assert.ok(!steer.ok && notRunnable.includes(steer.error.code), 'an idle steer is a prompt, and no agent is installed here');
  const compact = parseAiResult(await harness.invoke('ai:compact', { projectPath: project, chat: first }), parseCompactStarted);
  assert.ok(!compact.ok && compact.error.code === 'invalid', 'a chat without a session has nothing to compact');
  const steered = parseAiResult(
    await harness.invoke('ai:prompt', { projectPath: project, chat: first, text: 'x', attachments: [], mode: 'steer' }),
    parseSteerReply,
  );
  assert.ok(!steered.ok && notRunnable.includes(steered.error.code), 'a steering prompt takes the same path as ai:steer');
  const missingChat = parseAiResult(await harness.invoke('ai:compact', { projectPath: project, chat: `c${'0'.repeat(24)}` }), parseCompactStarted);
  assert.ok(!missingChat.ok && missingChat.error.code === 'chat-missing');

  // A change is readable while pending; nothing is pending here, so the diff is not available.
  const diff = parseAiResult(
    await harness.invoke('ai:diff', { projectPath: project, chat: first, turn: `t${'1'.repeat(16)}`, path: 'AGENTS.md' }),
    parseDiffReply,
  );
  assert.ok(!diff.ok && diff.error.code === 'invalid');
  const escaped = parseAiResult(
    await harness.invoke('ai:diff', { projectPath: project, chat: first, turn: `t${'1'.repeat(16)}`, path: '../AGENTS.md' }),
    parseDiffReply,
  );
  assert.ok(!escaped.ok && escaped.error.code === 'invalid');
  const noChat = parseAiResult(
    await harness.invoke('ai:diff', { projectPath: project, chat: `c${'0'.repeat(24)}`, turn: `t${'1'.repeat(16)}`, path: 'AGENTS.md' }),
    parseDiffReply,
  );
  assert.ok(!noChat.ok && noChat.error.code === 'chat-missing');

  const mentions = parseAiResult(await harness.invoke('ai:mentions', { projectPath: project, query: 'agents', kinds: ['file'] }), parseMentionReply);
  assert.ok(mentions.ok);
  assert.deepEqual(
    mentions.value.map((candidate) => (candidate.kind === 'file' ? candidate.path : candidate.name)),
    ['AGENTS.md'],
  );
  await assert.rejects(harness.invoke('ai:mentions', { projectPath: root, query: '', kinds: [] }), /open project only/);
  await assert.rejects(harness.invoke('ai:chatMove', { projectPath: root, chat: first }), /open project only/);
});
