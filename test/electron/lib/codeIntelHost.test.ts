// Goal: main's keeper of the intelligence process never hangs a question and never loops a broken process: it starts
// on demand, hands over one question at a time, bounds those waiting, times out and restarts a bounded number of times,
// ignores answers that do not parse or pair, and stops on project change, idleness and quit.
// Method: a stand-in child and a hand-driven clock; every question's answer is awaited.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createIntelHost, type IntelChild } from '#dist/electron/lib/codeIntel/host.js';
import { intelligenceProcess, type ForkedProcess } from '#dist/electron/lib/codeIntel/utilityChild.js';
import { parseServiceMessage } from '#dist/electron/lib/codeIntel/messages.js';
import { CODE_INTEL_LIMITS, parseCodeIntelRequest, type CodeIntelRequest } from '#dist/shared/ipc/codeIntel.js';
import { toExplorerPath } from '#dist/shared/ipc/fileExplorer.js';

// What `fork` hands back, as far as the wrapper uses it here.
const stoppedProcess: ForkedProcess = { kill: () => true, on: () => undefined, once: () => undefined, postMessage: () => {} };

interface FakeChild extends IntelChild {
  readonly sent: { readonly id: number; readonly request: CodeIntelRequest }[];
  readonly answer: (reply?: unknown, id?: number) => void;
  readonly die: () => void;
  killed: boolean;
}

function world() {
  const children: FakeChild[] = [];
  const timers: { action: () => void; delayMs: number; cancelled: boolean }[] = [];
  let now = 0;
  const host = createIntelHost({
    spawn: () => {
      let message: (value: unknown) => void = () => {};
      let exit: () => void = () => {};
      const sent: FakeChild['sent'] = [];
      const child: FakeChild = {
        sent,
        killed: false,
        post: (value) => {
          const message = parseServiceMessage(value);
          sent.push({ id: message.id, request: parseCodeIntelRequest(message.request) });
        },
        onMessage: (listener) => {
          message = listener;
        },
        onExit: (listener) => {
          exit = listener;
        },
        kill: () => {
          child.killed = true;
        },
        answer: (reply = { kind: 'diagnostics', diagnostics: [] }, id = sent.at(-1)?.id) => message({ id, reply }),
        die: () => exit(),
      };
      children.push(child);
      return child;
    },
    now: () => now,
    setTimer: (action, delayMs) => {
      const timer = { action, delayMs, cancelled: false };
      timers.push(timer);
      return { cancel: () => void (timer.cancelled = true) };
    },
    log: () => {},
  });
  const child = (): FakeChild => {
    const last = children.at(-1);
    assert.ok(last !== undefined, 'a process was started');
    return last;
  };
  const fire = (): number => {
    const timer = timers.filter((entry) => !entry.cancelled).at(-1);
    assert.ok(timer !== undefined, 'a timer is waiting');
    timer.cancelled = true;
    timer.action();
    return timer.delayMs;
  };
  return { host, children, child, fire, advance: (ms: number) => void (now += ms) };
}

function question(path: string, kind: 'diagnostics' | 'hover' | 'complete' = 'diagnostics', projectPath = '/site'): CodeIntelRequest {
  const query = kind === 'diagnostics' ? { kind } : kind === 'hover' ? { kind, position: 0 } : { kind, position: 0, explicit: false };
  return { projectPath, path: toExplorerPath(path), text: '', query };
}

test('nothing starts until asked; answers pair by number; urgent questions go first', async () => {
  const { host, children, child } = world();
  assert.equal(children.length, 0);
  const first = host.request(question('a.ts'));
  const checks = host.request(question('b.ts'));
  const hover = host.request(question('b.ts', 'hover'));
  assert.equal(children.length, 1);
  assert.equal(child().sent.length, 1);
  child().answer({ kind: 'unavailable' }, 999);
  child().answer();
  assert.equal((await first).kind, 'diagnostics');
  assert.equal(child().sent.at(-1)?.request.query.kind, 'hover');
  child().answer({ kind: 'hover' });
  assert.equal((await hover).kind, 'hover');
  child().answer();
  assert.equal((await checks).kind, 'diagnostics');
});

test('a newer question replaces a waiting one of its kind, and the waiting are bounded', async () => {
  const { host, child } = world();
  void host.request(question('a.ts'));
  const stale = host.request(question('a.ts', 'complete'));
  void host.request(question('a.ts', 'complete'));
  assert.equal((await stale).kind, 'unavailable');
  const many = Array.from({ length: CODE_INTEL_LIMITS.pendingMax + 2 }, (_, index) => host.request(question(`file${index}.ts`, 'hover')));
  assert.equal((await many[0])?.kind, 'unavailable');
  assert.equal(child().sent.length, 1);
});

test('the first answer is given longer; a late or dead process is replaced, a few times only', async () => {
  const { host, children, child, fire, advance } = world();
  const first = host.request(question('a.ts'));
  assert.equal(fire(), CODE_INTEL_LIMITS.firstRequestTimeoutMs);
  assert.equal((await first).kind, 'unavailable');
  assert.equal(child().killed, true);
  const warm = host.request(question('a.ts'));
  child().answer();
  await warm;
  const slow = host.request(question('a.ts'));
  assert.equal(fire(), CODE_INTEL_LIMITS.requestTimeoutMs);
  assert.equal((await slow).kind, 'unavailable');
  for (let crash = 2; crash <= CODE_INTEL_LIMITS.restartsMax; crash++) {
    const asked = host.request(question('a.ts'));
    child().die();
    assert.equal((await asked).kind, 'unavailable');
  }
  const started = children.length;
  assert.equal((await host.request(question('a.ts'))).kind, 'unavailable');
  assert.equal(children.length, started, 'it stays off');
  advance(1);
  // Another project starts afresh.
  void host.request(question('a.ts', 'diagnostics', '/other'));
  assert.equal(children.length, started + 1);
});

test('an answer that does not parse ends the process', async () => {
  const { host, child } = world();
  const asked = host.request(question('a.ts'));
  child().answer({ kind: 'run', code: '1' });
  assert.equal((await asked).kind, 'unavailable');
  assert.equal(child().killed, true);
});

test('the utility process is started with a heap limit V8 takes', () => {
  const started: { module: string; options: unknown }[] = [];
  const child = intelligenceProcess({
    fork: (module, _args, options) => {
      started.push({ module, options });
      return stoppedProcess;
    },
  });
  child.kill();
  assert.match(started[0]?.module ?? '', /serviceProcess\.js$/);
  // Bare, a utility process ignores the flag; only `--js-flags` reaches V8 (measured: 4 GB against 1 GB).
  assert.match(JSON.stringify(started[0]?.options), new RegExp(`"--js-flags=--max-old-space-size=${CODE_INTEL_LIMITS.heapMegabytesMax}"`));
});

test('stop, project change and idleness end the process', async () => {
  const { host, children, child, fire } = world();
  const open = host.request(question('a.ts'));
  host.stop();
  assert.equal((await open).kind, 'unavailable');
  assert.equal(children[0]?.killed, true);
  const second = host.request(question('a.ts'));
  child().answer();
  await second;
  const other = host.request(question('a.ts', 'diagnostics', '/other'));
  assert.equal(children[1]?.killed, true);
  assert.equal(children.length, 3);
  child().answer();
  await other;
  assert.equal(fire(), CODE_INTEL_LIMITS.idleStopMs);
  assert.equal(child().killed, true);
});
