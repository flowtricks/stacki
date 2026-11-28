// Goal: stopping a server's process tree on Windows ends it even when `taskkill` fails, and never aims at a process id
// that is no longer ours. There the id of an ended process is soon someone else's, and `/T /F` ends its whole tree.
//
// Method: the real stopProcessTree with the platform and `taskkill` handed in, so the Windows path runs on any
// machine. The process is a record of the few fields it reads, and `taskkill` an emitter the test answers for.
// Nothing is spawned.
const assert = require('node:assert/strict');
const { ChildProcess } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const { stopProcessTree } = require('#dist/electron/lib/nodeTools.js');

// Past every system's largest process id, so no real process can be signalled even if the injection were ignored.
const NO_SUCH_PROCESS_ID = 2_000_000_000;

function windows() {
  const asked = [];
  const killer = new EventEmitter();
  const host = {
    platform: 'win32',
    taskkill: (processId) => {
      asked.push(processId);
      return killer;
    },
  };
  return { asked, killer, host };
}

// A real, never spawned ChildProcess: its exit code and signal read as a running one's do until an ending is given.
function processRecord(ending = {}) {
  const signals = [];
  const child = Object.assign(new ChildProcess(), { pid: NO_SUCH_PROCESS_ID, signals }, ending);
  child.kill = (signal) => signals.push(signal);
  return child;
}

test('on Windows the whole tree is ended by taskkill, and a success needs nothing more', () => {
  const { asked, killer, host } = windows();
  const child = processRecord();
  stopProcessTree(child, host);
  killer.emit('exit', 0);
  assert.deepEqual(asked, [NO_SUCH_PROCESS_ID]);
  assert.deepEqual(child.signals, []);
});

test('a taskkill that fails, or cannot run, still ends the process itself', () => {
  for (const answer of [
    ['exit', 1],
    ['exit', 128],
    ['error', new Error('spawn taskkill ENOENT')],
  ]) {
    const { killer, host } = windows();
    const child = processRecord();
    stopProcessTree(child, host);
    killer.emit(...answer);
    assert.deepEqual(child.signals, ['SIGTERM'], `after ${answer[0]} ${String(answer[1])}`);
  }
});

test('a process that has ended is not given to taskkill: its id may be another process by now', () => {
  for (const ending of [{ exitCode: 0 }, { exitCode: 1 }, { signalCode: 'SIGTERM' }]) {
    const { asked, host } = windows();
    stopProcessTree(processRecord(ending), host);
    assert.deepEqual(asked, [], JSON.stringify(ending));
  }
});

test('with no process there is nothing to stop', () => {
  const { asked, host } = windows();
  stopProcessTree(undefined, host);
  assert.deepEqual(asked, []);
});
