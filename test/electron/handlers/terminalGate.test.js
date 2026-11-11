// Goal: the real terminal module registers its invoke channels through main's role
// gate, so a role without code editing cannot start a shell by invoking the channel
// directly, and an allowed role still can.
// Method: load the built terminal module with Electron's ipcMain and node-pty replaced
// (as platformWindows.test.js does), pass a gate that refuses `terminal:start` the way
// handlers/roleAccess.ts does, and check that the refusal reaches the caller before
// node-pty spawns anything; then pass a gate that allows it and check the shell starts.

const assert = require('node:assert/strict');
const test = require('node:test');
const Module = require('node:module');

function loadTerminal() {
  const handlers = new Map();
  const spawned = [];
  const ipcMain = { handle: (channel, listener) => handlers.set(channel, listener), on: () => {} };
  const nativeTerminal = { process: 'zsh', onData: () => {}, onExit: () => {}, resize: () => {}, kill: () => {} };
  const originalLoad = Module._load;
  Module._load = function load(request, parent, isMain) {
    if (request === 'electron') {
      return { ipcMain };
    }
    if (request === 'node-pty') {
      return {
        spawn: (shell) => {
          spawned.push(shell);
          return nativeTerminal;
        },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const terminalPath = require.resolve('#dist/electron/terminal/terminal.js');
  delete require.cache[terminalPath];
  const terminal = require(terminalPath);
  const restore = () => {
    terminal.cleanupTerminals();
    Module._load = originalLoad;
    delete require.cache[terminalPath];
  };
  return { terminal, handlers, spawned, restore };
}

const start = { id: 'gated', cwd: process.cwd(), cols: 80, rows: 24 };

test('a refused role gate stops terminal:start before a shell spawns', async (context) => {
  const loaded = loadTerminal();
  context.after(loaded.restore);
  const gated = [];
  const gate = (channel) => {
    gated.push(channel);
    return channel === 'terminal:start' ? Promise.reject(new Error('Your role (Client) cannot do this in this project.')) : undefined;
  };
  loaded.terminal.registerTerminalHandlers({ send: () => {}, projectRoot: () => process.cwd(), gate: () => gate });
  await assert.rejects(loaded.handlers.get('terminal:start')({}, start), /Your role \(Client\) cannot do this/);
  assert.deepEqual(loaded.spawned, [], 'no shell starts for a refused role');
  assert.deepEqual(gated, ['terminal:start']);
});

test('an allowing role gate lets terminal:start spawn the shell', async (context) => {
  const loaded = loadTerminal();
  context.after(loaded.restore);
  loaded.terminal.registerTerminalHandlers({ send: () => {}, projectRoot: () => process.cwd(), gate: () => () => Promise.resolve() });
  assert.deepEqual(await loaded.handlers.get('terminal:start')({}, start), { ok: true, id: 'gated' });
  assert.equal(loaded.spawned.length, 1);
});
