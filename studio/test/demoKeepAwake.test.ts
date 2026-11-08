// Goal: the demo never shows Studio's idle pause ("Studio paused to save hosting
// costs"), because it has no server to stop, while normal Studio still pauses after
// five idle minutes.
// Method: run Studio's own idle rule (`mayPause`) the way `useIdleSession` does, with
// its 10-second check, its activity listener and Node's fake timers, over half an hour
// of a visitor doing nothing, with and without the demo's keep-awake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mayPause } from '../src/features/session/activity';
import { installKeepAwake, KEEP_AWAKE_MS, STUDIO_IDLE_MS } from '../demo/keepAwake';

const CHECK_MS = 10_000;
const IDLE_MS = 30 * 60_000;

/** True when Studio's idle check would have paused at some point in `IDLE_MS`. */
function pausesWhileIdle(keepAwake: boolean): boolean {
  mock.timers.enable({ apis: ['setInterval', 'Date'], now: 0 });
  const page = new EventTarget();
  let lastActivity = Date.now();
  // The listener `useIdleSession` adds for `studio:interaction`.
  page.addEventListener('studio:interaction', () => {
    lastActivity = Date.now();
  });
  const stop = keepAwake ? installKeepAwake(page) : () => undefined;
  let paused = false;
  const check = setInterval(() => {
    paused ||= mayPause(lastActivity, Date.now(), false);
  }, CHECK_MS);
  try {
    for (let elapsed = 0; elapsed < IDLE_MS; elapsed += CHECK_MS) {
      mock.timers.tick(CHECK_MS);
    }
    return paused;
  } finally {
    clearInterval(check);
    stop();
    mock.timers.reset();
  }
}

test('the keep-awake reports activity well inside Studio’s idle window', () => {
  assert.ok(KEEP_AWAKE_MS * 2 <= STUDIO_IDLE_MS, 'Even a throttled background tab stays inside the window');
  assert.equal(mayPause(0, STUDIO_IDLE_MS, false), true, 'The constant is Studio’s own idle window');
  assert.equal(mayPause(0, STUDIO_IDLE_MS - 1, false), false);
});

test('normal Studio still pauses after five idle minutes', () => {
  assert.equal(pausesWhileIdle(false), true);
});

test('the demo stays editable through half an hour of idleness', () => {
  assert.equal(pausesWhileIdle(true), false);
});
