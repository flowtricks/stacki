// Goal: a "Send all" of comment pins reaches the agent as one turn whose instructions, images and notes are all
// there, the agent's one-subagent-per-pin work comes back as Agent calls the panel matches to each pin, pins that
// share a file run in separate waves, and the chat keeps only the person's pins: the stored message has the pins'
// words and names, never the instructions, a path or a locator.
// Method: the real host from dist/ against the stand-in adapter (test/fixtures/ai/fakeAdapter.mjs), which acts as
// Claude's coordinator for a prompt carrying `<comment-pins>`: it reads the waves the instructions give and reports
// an Agent call per pin, with a child call each, wave after wave. Nothing reaches a real provider.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { AgentHost } from '#dist/electron/handlers/ai/agentHost.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import type { ChatEvent } from '#dist/shared/properties/ai/chatModel.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';
import { parsePinBrief } from '#dist/shared/properties/ai/commentPinBrief.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-pins-${name}-`));
}

function fakeHost() {
  const root = fs.realpathSync(temporary('project'));
  const userData = temporary('user');
  const bin = temporary('bin');
  for (const name of ['claude', 'codex']) {
    fs.writeFileSync(path.join(bin, process.platform === 'win32' ? `${name}.cmd` : name), '#!/bin/sh\n', { mode: 0o755 });
  }
  const store = new ChatStore(path.join(userData, 'ai'));
  const pushes: ChatEvent[] = [];
  // Woken by every push, so a wait is on the events themselves, never on a clock.
  const waiters = new Set<() => void>();
  const host = new AgentHost({
    userData,
    store,
    send: (channel: string, payload: unknown) => {
      if (channel === 'ai:events') {
        const push = parseAiEventsPush(payload);
        pushes.push(...push.events);
        host.acknowledge(push.chars);
        for (const wake of [...waiters]) {
          wake();
        }
      }
    },
    files: {
      read: (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined),
      write: (file: string, text: string) => fs.writeFileSync(file, text),
      create: (file: string, text: string) => fs.writeFileSync(file, text, { flag: 'wx' }),
      trash: async (file: string) => fs.rmSync(file),
    },
    snapshots: { snapshot: async () => undefined, changes: async () => [], blob: async () => undefined },
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir() }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) =>
      spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] }),
  });
  // Resolves once `condition` holds, checked after each push; the test runner's own timeout bounds a wait that never ends.
  const until = (condition: () => boolean): Promise<void> =>
    new Promise((resolve) => {
      const check = (): void => {
        if (condition()) {
          waiters.delete(check);
          resolve();
        }
      };
      waiters.add(check);
      check();
    });
  return { root, store, host, until, events: (): readonly ChatEvent[] => pushes };
}

const entry = (number: number, file: string, images: readonly number[]) => ({
  number,
  comment: `Pin words ${number}`,
  pageLabel: 'Home',
  page: 'src/pages/index.astro',
  elementLabel: `Heading ${number}`,
  file,
  locator: `0.${number}`,
  tag: 'h1',
  images,
});

test('one turn of pins: the agent gets every instruction and image, each pin its own subagent, shared files in waves', async (context) => {
  const { root, store, host, events, until } = fakeHost();
  context.after(() => host.stopAll());
  store.trust(root);
  const chat = store.create(root, 'claude', 'New chat', 1);
  assert.ok(chat !== undefined);
  const brief = parsePinBrief({
    mode: 'subagents',
    pins: [entry(1, 'src/pages/index.astro', [0]), entry(2, 'src/pages/about.astro', [1]), entry(3, 'src/pages/index.astro', [])],
  });
  const image = (note: string) => ({ kind: 'image' as const, name: 'Pinned area', mimeType: 'image/png' as const, data: 'aGVsbG8=', note });
  const started = await host.prompt(root, chat.id, 'Comments on 3 pins', [image('Pin 1, image 1: the pinned area'), image('Pin 2, image 1: the pinned area')], {
    pins: brief,
  });
  assert.ok(started.ok, JSON.stringify(started));
  await until(() => events().some((event) => event.kind === 'turn-end'));
  const all = events();
  const said = all.flatMap((event) => (event.kind === 'text' ? [event.text] : [])).join('');
  assert.match(said, /Got 2 images and 2 notes/, 'the images and their notes reached the agent');
  const starts = all.flatMap((event) => (event.kind === 'tool' && event.toolName === 'Agent' && event.status === 'in_progress' ? [event.title] : []));
  assert.deepEqual(starts, ['Pin 1: Make the change', 'Pin 2: Make the change', 'Pin 3: Make the change']);
  // Pin 3 shares index.astro with pin 1: it starts only after pin 1 finished.
  // A call's later updates carry its id, not its tool name: the order is read by call id.
  const pin1Done = all.findIndex((event) => event.kind === 'tool' && event.call === 'agent1' && event.status === 'completed');
  const pin3Start = all.findIndex((event) => event.kind === 'tool' && event.call === 'agent3');
  assert.ok(pin1Done >= 0, 'pin 1 finished');
  assert.ok(pin3Start > pin1Done, 'a pin on a file another pin edits waits for the wave before');
  const children = all.filter((event) => event.kind === 'tool' && event.parent !== undefined);
  assert.equal(children.length, 3, 'each subagent’s own work names it as parent');
  const user = all.find((event) => event.kind === 'user');
  assert.ok(user !== undefined && user.kind === 'user');
  assert.equal(user.text, 'Comments on 3 pins');
  const stored = JSON.stringify(store.read(root, chat.id).events.filter((event) => event.kind === 'user'));
  assert.match(stored, /"kind":"pins"/);
  for (const hidden of ['comment-pins', 'src/pages', 'Wave', 'child path']) {
    assert.ok(!stored.includes(hidden), `the stored message keeps no ${hidden}`);
  }
});

test('a pin naming an image the message lacks is refused before anything runs', async (context) => {
  const { root, store, host, events } = fakeHost();
  context.after(() => host.stopAll());
  store.trust(root);
  const chat = store.create(root, 'claude', 'New chat', 1);
  assert.ok(chat !== undefined);
  const brief = parsePinBrief({ mode: 'subagents', pins: [entry(1, 'src/pages/index.astro', [0])] });
  const refused = await host.prompt(root, chat.id, 'Comments on 1 pin', [], { pins: brief });
  assert.ok(!refused.ok);
  assert.equal(refused.error.code, 'invalid');
  assert.equal(events().filter((event) => event.kind === 'user').length, 0);
});
