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
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { AgentHost, pinsEnvironment } from '#dist/electron/handlers/ai/agentHost.js';
import { ChatStore } from '#dist/electron/handlers/ai/chatStore.js';
import { PIN_PICTURE_LIMITS, PinPictures, readRuleFor } from '#dist/electron/handlers/ai/pinPictures.js';
import { toRecord } from '#dist/shared/core/record.js';
import { toChatId } from '#dist/shared/properties/ai/chatModel.js';
import type { ChatEvent } from '#dist/shared/properties/ai/chatModel.js';
import { parseAiEventsPush } from '#dist/shared/ipc/aiChat.js';
import { PIN_LIMITS, parsePinBrief } from '#dist/shared/properties/ai/commentPinBrief.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const FAKE_ADAPTER = path.resolve('test/fixtures/ai/fakeAdapter.mjs');

function temporary(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `stacki-pins-${name}-`));
}

type Request = { readonly method: string; readonly params: Record<string, unknown> };

interface FakeOptions {
  /** Told each request the host writes to the adapter, before the adapter gets it. */
  readonly heard?: (request: Request) => void;
  /** Switches for the stand-in adapter (fakeAdapter.mjs). */
  readonly environment?: Readonly<Record<string, string>>;
  readonly sessionSignal?: () => Promise<'continue' | 'stop'>;
  readonly permit?: () => Promise<'allowed'>;
}

function fakeHost(options: FakeOptions = {}) {
  const heard = options.heard ?? (() => undefined);
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
    environment: () => ({ PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}`, HOME: os.homedir(), ...options.environment }),
    ...(options.sessionSignal === undefined ? {} : { sessionSignal: options.sessionSignal }),
    ...(options.permit === undefined ? {} : { permit: options.permit }),
    now: () => 1_000,
    version: 'test',
    askBeforeTrust: () => true,
    entryOf: () => FAKE_ADAPTER,
    spawnAdapter: (entry: string, cwd: string, environment: Record<string, string | undefined>) => {
      const child = spawn(process.execPath, [entry], { cwd, env: { ...environment }, stdio: ['pipe', 'pipe', 'pipe'] });
      const tap = new PassThrough();
      tap.on('data', (chunk: Buffer) => {
        for (const line of chunk
          .toString('utf8')
          .split('\n')
          .filter((text) => text.trim() !== '')) {
          const message = toRecord(JSON.parse(line));
          const method = message?.['method'];
          if (typeof method === 'string') {
            heard({ method, params: toRecord(message?.['params']) ?? {} });
          }
        }
      });
      tap.pipe(child.stdin);
      Object.defineProperty(child, 'stdin', { value: tap });
      return child;
    },
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
  return { root, userData, store, host, until, events: (): readonly ChatEvent[] => pushes };
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

test('one turn of pins: the agent gets every instruction and image, each pin its own subagent, all at once', async (context) => {
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
  assert.match(said, /Got 0 images and 0 notes/, 'the pictures travel as files, never as blocks of the one message');
  const starts = all.flatMap((event) => (event.kind === 'tool' && event.toolName === 'Agent' && event.status === 'in_progress' ? [event.title] : []));
  assert.deepEqual(starts, ['Pin 1: Make the change', 'Pin 2: Make the change', 'Pin 3: Make the change']);
  // Pins 1 and 3 share index.astro and still run together: every call starts before any finishes.
  // A call's later updates carry its id, not its tool name: the order is read by call id.
  const firstDone = all.findIndex((event) => event.kind === 'tool' && /^agent/.test(event.call) && event.status === 'completed');
  const lastStart = all.findIndex((event) => event.kind === 'tool' && event.call === 'agent3');
  assert.ok(firstDone >= 0, 'a pin finished');
  assert.ok(lastStart < firstDone, 'all three subagents are at work before the first one finishes');
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

test('four pins on one file run at the same time and every edit is kept; each subagent is asked for its own model', async (context) => {
  const { root, store, host, events, until } = fakeHost();
  context.after(() => host.stopAll());
  store.trust(root);
  const file = path.join(root, 'src', 'pages', 'index.astro');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'slot 1\nslot 2\nslot 3\nslot 4\n');
  const chat = store.create(root, 'claude', 'New chat', 1);
  assert.ok(chat !== undefined);
  // The stand-in subagents are told the file by the brief, relative to their working folder, the project.
  const pins = [1, 2, 3, 4].map((number) => ({
    ...entry(number, 'src/pages/index.astro', []),
    ...(number === 2 ? { model: 'haiku', modelName: 'Haiku' } : {}),
  }));
  const started = await host.prompt(root, chat.id, 'Comments on 4 pins', [], { pins: parsePinBrief({ mode: 'subagents', pins }) });
  assert.ok(started.ok, JSON.stringify(started));
  await until(() => events().some((event) => event.kind === 'turn-end'));
  assert.equal(fs.readFileSync(file, 'utf8'), 'done 1\ndone 2\ndone 3\ndone 4\n', 'no edit overwrote another');
  const all = events();
  const stale = all.filter((event) => event.kind === 'tool' && /^stale/.test(event.call));
  assert.equal(stale.length, 3, 'the reads overlapped: three edits found the file changed and were redone');
  const asked = all.flatMap((event) => (event.kind === 'tool' && event.agentModel !== undefined ? [[event.call, event.agentModel]] : []));
  assert.deepEqual(asked, [['agent2', 'haiku']], 'the chosen model reached that pin’s subagent, and no other');
  const user = all.find((event) => event.kind === 'user');
  assert.ok(user !== undefined && user.kind === 'user');
  const part = user.parts?.find((candidate) => candidate.kind === 'pins');
  assert.ok(part !== undefined && part.kind === 'pins');
  assert.deepEqual(
    part.pins.map((pin) => pin.modelName),
    [undefined, 'Haiku', undefined, undefined],
    'the sent message keeps the chosen model’s name',
  );
});

test('a subagent send refuses a model its subagents cannot take', () => {
  const bad = { ...entry(1, 'src/pages/index.astro', []), model: 'claude-opus-4-8', modelName: 'Opus 4.8' };
  assert.throws(() => parsePinBrief({ mode: 'subagents', pins: [bad] }), /cannot run that model/);
  assert.equal(parsePinBrief({ mode: 'single', pins: [bad] }).pins[0]?.model, 'claude-opus-4-8');
  assert.throws(() => parsePinBrief({ mode: 'single', pins: [{ ...bad, modelName: '' }] }), /modelName/);
});

const picture = (words: string) => Buffer.from(words).toString('base64');
const pinned = (number: number) => ({
  kind: 'image' as const,
  name: 'Pinned area',
  mimeType: 'image/png' as const,
  data: picture(`the area pin ${number} points at`),
  note: `Pin ${number}, image 1: the pinned area`,
});

/** The instructions block of a prompt, and what each pin's own lines in it name as picture files. */
function pictureFilesOf(prompt: unknown): ReadonlyMap<number, readonly string[]> {
  const first: unknown = Array.isArray(prompt) ? prompt[0] : undefined;
  const text = toRecord(first)?.['text'];
  assert.ok(typeof text === 'string' && text.startsWith('<comment-pins>'));
  assert.match(text, /A subagent gets only the words you give it: tell it to open every picture file/);
  const files = new Map<number, string[]>();
  let pin = 0;
  for (const line of text.split('\n')) {
    pin = Number(/^Pin (\d+)$/.exec(line)?.[1] ?? pin);
    const file = /^ {4}(.+\.(?:png|jpg|webp|gif)) \(Pin /.exec(line)?.[1];
    if (file !== undefined) {
      files.set(pin, [...(files.get(pin) ?? []), file]);
    }
  }
  return files;
}

test('parallel pins: each subagent’s words name its own pictures, readable without asking, and they go with the turn', async (context) => {
  // What each pin's subagent would open, read at the moment the main agent receives the message.
  const opened = new Map<number, string[]>();
  const paths: string[] = [];
  const allowed: unknown[] = [];
  const { root, userData, store, host, events, until } = fakeHost({
    heard: (request) => {
      if (request.method === 'session/new') {
        const meta = toRecord(toRecord(toRecord(request.params['_meta'])?.['claudeCode'])?.['options']);
        allowed.push(toRecord(toRecord(meta?.['settings'])?.['permissions'])?.['allow']);
      }
      if (request.method === 'session/prompt') {
        for (const [pin, files] of pictureFilesOf(request.params['prompt'])) {
          paths.push(...files);
          opened.set(
            pin,
            files.map((file) => fs.readFileSync(file).toString('base64')),
          );
          if (process.platform !== 'win32') {
            assert.equal(fs.statSync(files[0] ?? '').mode & 0o077, 0, 'the person’s alone');
          }
        }
      }
    },
  });
  context.after(() => host.stopAll());
  store.trust(root);
  const chat = store.create(root, 'claude', 'New chat', 1);
  assert.ok(chat !== undefined);
  const added = { ...pinned(2), data: picture('an image added to pin 2'), note: 'Pin 2, image 2: an image the person added' };
  const brief = parsePinBrief({
    mode: 'subagents',
    pins: [entry(1, 'src/pages/index.astro', [0]), entry(2, 'src/pages/about.astro', [1, 2]), entry(3, 'src/pages/index.astro', [])],
  });
  const started = await host.prompt(root, chat.id, 'Comments on 3 pins', [pinned(1), pinned(2), added], { pins: brief });
  assert.ok(started.ok, JSON.stringify(started));
  await until(() => events().some((event) => event.kind === 'turn-end'));
  assert.deepEqual(
    [...opened],
    [
      [1, [pinned(1).data]],
      [2, [pinned(2).data, added.data]],
    ],
    'each pin’s own pictures and no one else’s; a pin without pictures names none',
  );
  const rule = new PinPictures(userData).readRule(root);
  assert.deepEqual(allowed[0], [rule], 'the session may read that folder, and nothing more is allowed');
  const folder = rule.slice('Read('.length + 1, -'/**)'.length);
  for (const file of paths) {
    assert.ok(file.startsWith(`${folder}${path.sep}`), 'under the folder the rule names');
    assert.ok(path.relative(root, file).startsWith('..'), 'never in the project');
    assert.equal(fs.existsSync(file), false, 'removed once the turn ended');
  }
});

test('pictures are kept while a pin has asked a question, and go with the chat or the agents', async (context) => {
  const paths: string[] = [];
  const { root, store, host, events, until } = fakeHost({
    heard: (request) => {
      if (request.method === 'session/prompt') {
        paths.push(...[...pictureFilesOf(request.params['prompt']).values()].flat());
      }
    },
  });
  context.after(() => host.stopAll());
  store.trust(root);
  const asking = { ...entry(1, 'src/pages/index.astro', [0]), comment: 'ask which blue' };
  const send = async () => {
    const chat = store.create(root, 'claude', 'New chat', 1);
    assert.ok(chat !== undefined);
    const ended = events().filter((event) => event.kind === 'turn-end').length;
    const started = await host.prompt(root, chat.id, 'Comments on 1 pin', [pinned(1)], { pins: parsePinBrief({ mode: 'subagents', pins: [asking] }) });
    assert.ok(started.ok, JSON.stringify(started));
    await until(() => events().filter((event) => event.kind === 'turn-end').length > ended);
    return chat.id;
  };
  const first = await send();
  const [kept] = paths;
  assert.ok(kept !== undefined && fs.existsSync(kept), 'the answer may start the pin again');
  host.forget(root, first);
  assert.equal(fs.existsSync(kept), false, 'gone with its chat');
  await send();
  const second = paths.at(-1) ?? '';
  assert.ok(fs.existsSync(second));
  host.stopAll();
  assert.equal(fs.existsSync(second), false, 'gone when the agents stop');
});

test('what a crash left is swept once it is a day old; the read rule is an absolute path rule on every system', () => {
  const userData = temporary('sweep');
  const pictures = new PinPictures(userData);
  const brief = parsePinBrief({ mode: 'subagents', pins: [entry(1, 'src/pages/index.astro', [0])] });
  const written = pictures.keep('/site', toChatId(`c${'a'.repeat(24)}`), brief, [pinned(1)]);
  assert.ok(written.ok);
  const file = written.value.get(1)?.[0]?.path ?? '';
  const another = new PinPictures(userData);
  another.sweep(Date.now());
  assert.ok(fs.existsSync(file), 'a young folder may be another running Stacki’s');
  another.sweep(Date.now() + PIN_PICTURE_LIMITS.staleMsMin + 1_000);
  assert.equal(fs.existsSync(file), false);
  assert.equal(readRuleFor('/Users/a/Library/Application Support/Stacki/x'), 'Read(//Users/a/Library/Application Support/Stacki/x/**)');
  assert.equal(readRuleFor('C:\\Users\\a\\x'), 'Read(//c/Users/a/x/**)');
});

const TURN_ENDS = (events: readonly ChatEvent[]): number => events.filter((event) => event.kind === 'turn-end').length;
const AGENT_STARTS = (events: readonly ChatEvent[]): number =>
  events.filter((event) => event.kind === 'tool' && event.toolName === 'Agent' && event.status === 'in_progress').length;
const sendOfPins = (count: number) =>
  parsePinBrief({ mode: 'subagents', pins: Array.from({ length: count }, (_, index) => entry(index + 1, 'src/pages/index.astro', [index])) });

test('a full board in one send: forty subagents at work at once, and the chat keeps a picture of each pin', async (context) => {
  const gate = temporary('gate');
  const { root, store, host, events, until } = fakeHost({ environment: { FAKE_PIN_GATE: gate } });
  context.after(() => host.stopAll());
  store.trust(root);
  const chat = store.create(root, 'claude', 'New chat', 1);
  assert.ok(chat !== undefined);
  const count = PIN_LIMITS.pinsMax;
  const pictures = Array.from({ length: count }, (_, index) => pinned(index + 1));
  const payload = { projectPath: root, chat: chat.id, text: 'Pins', attachments: pictures, pins: sendOfPins(count) };
  assert.equal(parseIpcPayload('ai:prompt', payload).attachments.length, count, 'the main process takes the whole send');
  assert.throws(() => parseIpcPayload('ai:prompt', { ...payload, pins: undefined }), /exceeds limit/, 'an ordinary message keeps its own bound');
  const started = await host.prompt(root, chat.id, 'Comments on 40 pins', pictures, { pins: sendOfPins(count) });
  assert.ok(started.ok, JSON.stringify(started));
  await until(() => AGENT_STARTS(events()) === count);
  assert.equal(TURN_ENDS(events()), 0, 'all forty are at work and none was waited for');
  fs.writeFileSync(path.join(gate, 'pins'), '');
  await until(() => TURN_ENDS(events()) === 1);
  const done = events().filter((event) => event.kind === 'tool' && /^agent\d+$/.test(event.call) && event.status === 'completed');
  assert.equal(done.length, count, 'every pin ran to its end');
  const stored = store.read(root, chat.id).events.find((event) => event.kind === 'user');
  assert.ok(stored !== undefined && stored.kind === 'user', 'the stored message reads back');
  const part = stored.parts?.find((candidate) => candidate.kind === 'pins');
  assert.ok(part !== undefined && part.kind === 'pins');
  assert.equal(stored.attachments.length, count);
  assert.deepEqual(
    part.pins.map((pin) => pin.image),
    Array.from({ length: count }, (_, index) => index),
  );
});

test('pins run beside a chat reply: stopping one reply leaves the others working, and each hears its own end', async (context) => {
  const gate = temporary('gate');
  let permits = 0;
  const { root, store, host, until, events } = fakeHost({
    environment: { FAKE_PIN_GATE: gate },
    permit: async () => {
      permits += 1;
      return 'allowed';
    },
  });
  context.after(() => host.stopAll());
  store.trust(root);
  const make = () => {
    const record = store.create(root, 'claude', 'New chat', 1);
    assert.ok(record !== undefined);
    return record.id;
  };
  const [reply, first, second] = [make(), make(), make()];
  const brief = () => parsePinBrief({ mode: 'subagents', pins: [entry(1, 'src/pages/index.astro', [])] });
  const sent = await Promise.all([
    host.prompt(root, reply, 'hold this reply', []),
    host.prompt(root, first, 'Pins', [], { pins: brief() }),
    host.prompt(root, second, 'Pins', [], { pins: brief() }),
  ]);
  assert.ok(
    sent.every((outcome) => outcome.ok),
    JSON.stringify(sent),
  );
  await until(() => AGENT_STARTS(events()) === 2 && events().some((event) => event.kind === 'text' && event.text === 'Working'));
  assert.ok(permits >= 3, 'the sign-in was asked about for every message');
  host.cancel(root, first);
  await until(() => TURN_ENDS(events()) === 1);
  assert.notEqual(host.runningTurn(root, reply), undefined, 'the chat reply goes on');
  assert.notEqual(host.runningTurn(root, second), undefined, 'the other send goes on');
  assert.equal(host.runningTurn(root, first), undefined);
  fs.writeFileSync(path.join(gate, 'pins'), '');
  fs.writeFileSync(path.join(gate, 'chat'), '');
  await until(() => TURN_ENDS(events()) === 3);
  const stops = events().flatMap((event) => (event.kind === 'turn-end' ? [event.stop] : []));
  assert.deepEqual(stops.sort(), ['cancelled', 'end_turn', 'end_turn']);
  const words = store.read(root, reply).events.flatMap((event) => (event.kind === 'text' ? [event.text] : []));
  assert.ok(!words.join('').includes('pins'), 'nothing of the pins reached the chat’s own transcript');
});

test('every reply running at once is stopped when its own session reports billing per use', async (context) => {
  const { root, store, host, until, events } = fakeHost({ sessionSignal: async () => 'stop' });
  context.after(() => host.stopAll());
  store.trust(root);
  const chats = [1, 2, 3].map(() => {
    const record = store.create(root, 'claude', 'New chat', 1);
    assert.ok(record !== undefined);
    return record.id;
  });
  const sent = await Promise.all(chats.map((chat) => host.prompt(root, chat, 'report billing', [])));
  assert.ok(
    sent.every((outcome) => outcome.ok),
    JSON.stringify(sent),
  );
  await until(() => TURN_ENDS(events()) === 3);
  assert.deepEqual(
    events().flatMap((event) => (event.kind === 'turn-end' ? [event.stop] : [])),
    ['cancelled', 'cancelled', 'cancelled'],
  );
});

test('a chat made for pins lets its session go when the reply ends, and a later message resumes it', async (context) => {
  const asked: string[] = [];
  let closed: () => void = () => undefined;
  const closing = new Promise<void>((resolve) => (closed = resolve));
  const { root, store, host, until, events } = fakeHost({
    heard: (request) => {
      asked.push(request.method);
      if (request.method === 'session/close') {
        closed();
      }
    },
    environment: { FAKE_CLOSE: '1' },
  });
  context.after(() => host.stopAll());
  store.trust(root);
  const forPins = store.create(root, 'claude', 'New chat', 1);
  const ordinary = store.create(root, 'claude', 'New chat', 1);
  assert.ok(forPins !== undefined && ordinary !== undefined);
  const plain = await host.prompt(root, ordinary.id, 'hello', []);
  assert.ok(plain.ok);
  await until(() => TURN_ENDS(events()) === 1);
  const brief = parsePinBrief({ mode: 'subagents', pins: [entry(1, 'src/pages/index.astro', [])] });
  assert.ok((await host.prompt(root, forPins.id, 'Pins', [], { pins: brief })).ok);
  await until(() => TURN_ENDS(events()) === 2);
  await closing;
  assert.equal(asked.filter((method) => method === 'session/close').length, 1, 'only the pins’ chat lets its session go');
  assert.ok((await host.prompt(root, forPins.id, 'and one more thing', [])).ok);
  await until(() => TURN_ENDS(events()) === 3);
  assert.equal(asked.filter((method) => method === 'session/resume').length, 1, 'the conversation is resumed, not started again');
  assert.equal(asked.filter((method) => method === 'session/close').length, 1, 'the chat is the person’s now: it stays open');
});

test('Claude is told it may run a full board of subagents; a value the person set is kept, and Codex is told nothing', () => {
  const variable = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS';
  assert.equal(pinsEnvironment('claude', {})[variable], String(PIN_LIMITS.subagentsAtOnceMax));
  assert.equal(pinsEnvironment('claude', { [variable]: '5' })[variable], '5');
  assert.equal(pinsEnvironment('codex', {})[variable], undefined);
});
