// Goal: the full copy of a sent image survives a restart, so it can be opened later, and stays inside its stated
// bounds and inside the app's own folder: a chat's delete takes its copies, a fork has its own, the oldest go
// first past a bound, and nothing but a regular file named by a parsed id is ever read.
// Methodology: a real ChatStore over a temporary folder; a second store over the same folder stands for the app
// after a restart. Bounds are tested on the pruning rule with small numbers; links and bad names are planted.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type TestContext } from 'node:test';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { pruneImages } from '#dist/electron/handlers/ai/chatImageStore.js';
import { parseChatEvent, toChatImageId, toTurnId } from '#dist/shared/properties/ai/chatModel.js';

const PIXELS = Buffer.from('the whole picture').toString('base64');
const IMAGE = { mimeType: 'image/png', data: PIXELS } as const;

function world(context: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-chat-images-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const project = path.join(root, 'site');
  fs.mkdirSync(project);
  const store = new ChatStore(path.join(root, 'ai'));
  const chat = store.create(project, 'claude', 'Pictures', 1);
  assert.ok(chat !== undefined);
  return { root, project, store, chat: chat.id };
}

test('a kept image is read back whole after a restart, and the same bytes are one file', (context) => {
  const { root, project, store, chat } = world(context);
  const image = store.saveImage(project, chat, IMAGE);
  assert.ok(image !== undefined);
  assert.equal(store.saveImage(project, chat, IMAGE), image);
  const folder = path.join(store.projectDirectory(project), 'images', chat);
  assert.deepEqual(fs.readdirSync(folder), [image], 'one file and no temporary left behind');
  assert.deepEqual(fs.readdirSync(project), [], 'nothing is written in the project');
  const turn = toTurnId(`t${'1'.repeat(16)}`);
  const attachments = [{ kind: 'image', name: 'a.png', thumbnail: 'data:image/jpeg;base64,/9j/', original: image }] as const;
  assert.ok(store.append(project, chat, [{ kind: 'user', turn, text: 'Look', attachments, at: 2, parts: undefined, mode: undefined }]));
  const restarted = new ChatStore(path.join(root, 'ai'));
  const stored = restarted.read(project, chat).events[0];
  assert.ok(stored?.kind === 'user');
  assert.equal(stored.attachments[0]?.original, image, 'the reloaded message still names its copy');
  assert.deepEqual(restarted.readImage(project, chat, image), IMAGE);
});

test('a fork keeps its own copies, and deleting a chat removes only that chat’s', (context) => {
  const { project, store, chat } = world(context);
  const image = store.saveImage(project, chat, IMAGE);
  assert.ok(image !== undefined);
  const fork = store.fork(project, chat, 3);
  assert.ok(fork.ok);
  store.delete(project, chat);
  assert.equal(store.readImage(project, chat, image), undefined);
  assert.ok(!fs.existsSync(path.join(store.projectDirectory(project), 'images', chat)));
  assert.deepEqual(store.readImage(project, fork.value.id, image), IMAGE);
});

test('past a bound the oldest copies go first, never the one just written', (context) => {
  const { root } = world(context);
  const images = [3, 1, 2].map((age) => {
    const file = path.join(root, `${age}.png`);
    fs.writeFileSync(file, 'x'.repeat(10));
    return { file, bytes: 10, modifiedMs: age };
  });
  pruneImages(images, { filesMax: 3, bytesMax: 30 }, undefined);
  assert.equal(images.filter((image) => fs.existsSync(image.file)).length, 3, 'at the bound nothing goes');
  pruneImages(images, { filesMax: 3, bytesMax: 20 }, path.join(root, '1.png'));
  assert.deepEqual(
    images.map((image) => fs.existsSync(image.file)),
    [true, true, false],
    'the oldest that is not the new one',
  );
  pruneImages(
    images.filter((image) => fs.existsSync(image.file)),
    { filesMax: 1, bytesMax: 100 },
    undefined,
  );
  assert.deepEqual(
    images.map((image) => fs.existsSync(image.file)),
    [true, false, false],
  );
});

test('only a regular file named by an image id is read', (context) => {
  const { root, project, store, chat } = world(context);
  const outside = path.join(root, 'secret.txt');
  fs.writeFileSync(outside, 'secret');
  const planted = toChatImageId(`${'b'.repeat(32)}.png`);
  const folder = path.join(store.projectDirectory(project), 'images', chat);
  fs.mkdirSync(folder, { recursive: true });
  fs.symlinkSync(outside, path.join(folder, planted));
  assert.equal(store.readImage(project, chat, planted), undefined, 'a link is not followed');
  assert.equal(store.readImage(project, chat, toChatImageId(`${'c'.repeat(32)}.jpg`)), undefined, 'a missing copy is undefined');
  for (const bad of ['../index.json', `${'a'.repeat(32)}.svg`, `${'a'.repeat(31)}.png`, `x/${'a'.repeat(32)}.png`, '']) {
    assert.throws(() => toChatImageId(bad), /ChatImageId/, bad);
  }
});

test('a stored message names a copy only by an image id, and only for an image', () => {
  const event = (attachment: unknown) => ({ kind: 'user', turn: `t${'1'.repeat(16)}`, text: '', attachments: [attachment], at: 1 });
  const original = `${'a'.repeat(32)}.jpg`;
  const parsed = parseChatEvent(event({ kind: 'image', name: 'a', original }));
  assert.ok(parsed.kind === 'user');
  assert.equal(parsed.attachments[0]?.original, original);
  assert.throws(() => parseChatEvent(event({ kind: 'image', name: 'a', original: '/etc/passwd' })), /ChatImageId/);
  assert.throws(() => parseChatEvent(event({ kind: 'file', name: 'a', original })), /only an image/);
});
