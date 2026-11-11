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
import { parseAiAgentsReply, parseAiResult, parseChatSummaries } from '#dist/shared/ipc/aiChat.js';
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
  const listed = parseChatSummaries(await harness.invoke('ai:chats', { projectPath: `${project}/` }));
  assert.deepEqual(
    listed.map((chat) => chat.id),
    [created.value.id],
    'a trailing slash names the same project',
  );
  const agents = parseAiAgentsReply(await harness.invoke('ai:agents', { projectPath: project }));
  assert.equal(agents.trusted, true, 'opening the panel allows agents here (Settings can ask instead)');
  assert.equal(agents.agents.length, 2);
  await assert.rejects(harness.invoke('ai:chats', { projectPath: path.join(project, 'src') }), /open project only/);
  await assert.rejects(harness.invoke('ai:chats', { projectPath: root }), /open project only/);
});
