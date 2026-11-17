// Goal: the gate exits only after what it printed has left the process, so a CI log ends with
// the failing check's output instead of losing it (Studio verify's error vanished that way), and
// a pipe that never drains cannot hold the exit forever.
// Methodology: drainStreams runs on fake streams whose write callbacks fire when the test says;
// the timer is a fake that records its bound and fires on demand; a child process proves the real
// thing: it writes 2 MB to a pipe, calls flushAndExit, and the parent counts every byte.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { drainStreams, FLUSH_LIMITS, type FlushStream } from '#dist/scripts/gate/flushExit.js';

function heldStream(): { readonly stream: FlushStream; readonly release: () => void } {
  const callbacks: (() => void)[] = [];
  return {
    stream: {
      write: (_chunk, callback) => {
        callbacks.push(callback);
        return false;
      },
    },
    release: () => {
      for (const callback of callbacks.splice(0)) {
        callback();
      }
    },
  };
}

test('it resolves only when every stream has drained', async () => {
  const output = heldStream();
  const errors = heldStream();
  let state = 'pending';
  const done = drainStreams([output.stream, errors.stream], () => undefined).then((result) => {
    state = result;
  });
  output.release();
  await Promise.resolve();
  assert.equal(state, 'pending', 'one stream drained is not enough');
  errors.release();
  await done;
  assert.equal(state, 'drained');
});

test('a stream that never drains times out at the bound', async () => {
  const stuck = heldStream();
  let fire: (() => void) | undefined;
  let boundMs = 0;
  const result = drainStreams([stuck.stream], (callback, delayMs) => {
    fire = callback;
    boundMs = delayMs;
  });
  assert.equal(boundMs, FLUSH_LIMITS.drainMsMax);
  fire?.();
  assert.equal(await result, 'timed-out');
  assert.throws(() => drainStreams([], () => undefined), /at least one stream/);
});

test('a real exit after a large write to a pipe loses nothing', () => {
  const module = path.join(process.cwd(), 'dist', 'scripts', 'gate', 'flushExit.js');
  const program = `const { flushAndExit } = require(${JSON.stringify(module)}); process.stdout.write('x'.repeat(2 * 1024 * 1024)); process.stdout.write('END'); void flushAndExit(3);`;
  const child = spawnSync(process.execPath, ['-e', program], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 30_000 });
  assert.equal(child.status, 3);
  assert.equal(child.stdout.length, 2 * 1024 * 1024 + 3);
  assert.ok(child.stdout.endsWith('END'));
});
