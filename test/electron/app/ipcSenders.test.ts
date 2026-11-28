// Goal: main answers its IPC channels only to the app window's own top frame,
// and no module can register a channel around that rule.
// Method: the guard runs over a recording `ipcMain` with events from the
// window's top frame, a frame inside it, another window and no window; then the
// Desktop sources are read for any other way to Electron's `ipcMain`.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { guardIpcSenders, isAppWindowSender } from '#dist/electron/lib/ipcSenders.js';

type Guarded = Parameters<typeof guardIpcSenders>[0];

const windowContents = { mainFrame: { processId: 7, routingId: 1 } };
const otherContents = { mainFrame: { processId: 9, routingId: 1 } };

const FROM_WINDOW = { sender: windowContents, processId: 7, frameId: 1 };
const REFUSED = [
  ['a frame inside the window', { sender: windowContents, processId: 7, frameId: 4 }],
  ['a frame in another process', { sender: windowContents, processId: 8, frameId: 1 }],
  ['another window', { sender: otherContents, processId: 9, frameId: 1 }],
] as const;

// Electron's objects, as far as the guard reads them.
function check(event: unknown, contents: unknown): boolean {
  const answer: unknown = Reflect.apply(isAppWindowSender, undefined, [event, contents]);
  assert.ok(typeof answer === 'boolean');
  return answer;
}

function guarded() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const record = (channel: string, listener: (...args: never[]) => unknown): void => {
    handlers.set(channel, (...args) => {
      const answer: unknown = Reflect.apply(listener, undefined, args);
      return answer;
    });
  };
  const native: Guarded = {
    handle: record,
    on: function (this: Electron.IpcMain, channel: string, listener: (...args: never[]) => unknown) {
      record(channel, listener);
      return this;
    },
  };
  return { handlers, ipc: guardIpcSenders(native, (event) => check(event, windowContents)) };
}

test('only the app window’s top frame is the app window', () => {
  assert.equal(check(FROM_WINDOW, windowContents), true);
  assert.equal(check(FROM_WINDOW, undefined), false, 'no window');
  for (const [what, event] of REFUSED) {
    assert.equal(check(event, windowContents), false, what);
  }
});

test('an invoke from any other sender is rejected before the handler runs', () => {
  const { handlers, ipc } = guarded();
  const ran: unknown[] = [];
  ipc.handle('src:writeText', (_event, payload: unknown) => {
    ran.push(payload);
    return 'written';
  });
  const handler = handlers.get('src:writeText');
  assert.ok(handler);
  assert.equal(handler(FROM_WINDOW, 'mine'), 'written');
  for (const [what, event] of REFUSED) {
    assert.throws(() => handler(event, what), /Refused: src:writeText/, what);
  }
  assert.deepEqual(ran, ['mine']);
});

test('a one-way message from any other sender is dropped', (context) => {
  context.mock.method(console, 'warn', () => undefined);
  const { handlers, ipc } = guarded();
  const ran: unknown[] = [];
  ipc.on('terminal:input', (_event, payload) => ran.push(payload));
  const listener = handlers.get('terminal:input');
  assert.ok(listener);
  listener(FROM_WINDOW, 'mine');
  for (const [what, event] of REFUSED) {
    listener(event, what);
  }
  assert.deepEqual(ran, ['mine']);
});

test('main.ts alone takes Electron’s ipcMain, and hands it on only behind the guard', () => {
  const root = path.resolve('electron');
  const takers = fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((file) => file.endsWith('.ts') && !file.endsWith('.d.ts'))
    .filter((file) => /import \{[^}]*\bipcMain\b[^}]*\} from 'electron'/.test(fs.readFileSync(path.join(root, file), 'utf8')));
  assert.deepEqual(takers, ['main.ts']);
  const main = fs.readFileSync(path.join(root, 'main.ts'), 'utf8');
  const uses = [...main.matchAll(/\bnativeIpcMain\b/g)].length;
  // The import, the guard, and the boot channels, which ask `fromAppWindow` themselves.
  assert.equal(uses, 3, 'a new use of the unguarded ipcMain: register it on appIpc');
  assert.match(main, /registerBootChannels\(\{\s*ipcMain: nativeIpcMain,[\s\S]*?isMainFrame: fromAppWindow,/);
});
