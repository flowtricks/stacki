// Goal: the canvas never sits blank (src/features/preview/previewSupervisor.ts, docs/canvas-recovery.md). A dev
// server that stops answering is started again and a frame that stops answering is loaded again, each a bounded
// number of times; past the bound the state is `stopped` (the cover with Restart preview), and only the person
// asking gives the bound back. Nothing runs while the window is hidden, and coming back looks at once.
//
// Method: the real controller under a fake clock, with a scripted server and frames. Time moves only when the test
// advances it, and every action is counted, so a loop would show as a count that keeps growing over fake hours.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const loadRenderer = require('../../helpers/rendererModule.js');

const { createPreviewSupervisor, PREVIEW_SUPERVISOR_LIMITS: LIMITS } = loadRenderer('src/features/preview/previewSupervisor.ts');

function world() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  const state = { visible: true, active: true, up: true, frames: 'answered', restartWorks: true, restarts: 0, reloads: 0, probes: 0, changes: [] };
  const supervisor = createPreviewSupervisor({
    active: () => state.active,
    visible: () => state.visible,
    serverAnswers: async () => {
      state.probes += 1;
      return state.up;
    },
    frames: async () => state.frames,
    restartServer: async () => {
      state.restarts += 1;
      if (state.restartWorks) {
        state.up = true;
      }
      return state.restartWorks;
    },
    reload: () => {
      state.reloads += 1;
    },
    onChange: (next) => state.changes.push(next.kind === 'stopped' ? `stopped:${next.cause}` : next.kind),
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = nextId++;
        timers.set(id, { at: now + delayMs, callback });
        return id;
      },
      clearTimeout: (id) => timers.delete(id),
      now: () => now,
    },
  });
  const settle = async () => {
    for (let index = 0; index < 40; index++) {
      await Promise.resolve();
    }
  };
  const advance = async (ms) => {
    const end = now + ms;
    for (let guard = 0; guard < 20_000; guard++) {
      await settle();
      const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((left, right) => left[1].at - right[1].at)[0];
      if (due === undefined) {
        break;
      }
      timers.delete(due[0]);
      now = Math.max(now, due[1].at);
      due[1].callback();
    }
    now = end;
    await settle();
  };
  return { state, supervisor, advance, timers };
}

const HOUR = 3_600_000;

test('a healthy preview is only asked: nothing restarts or reloads', async () => {
  const { state, advance } = world();
  await advance(60_000);
  assert.ok(state.probes >= 10);
  assert.equal(state.restarts, 0);
  assert.equal(state.reloads, 0);
  assert.deepEqual(state.changes, []);
});

test('one slow answer is a busy server; a dead one is started again once and the pages loaded again', async () => {
  const { state, advance } = world();
  state.up = false;
  await advance(LIMITS.heartbeatMs);
  state.up = true;
  await advance(60_000);
  assert.equal(state.restarts, 0, 'one miss restarts nothing');

  state.up = false;
  await advance(LIMITS.heartbeatMs + LIMITS.confirmMs * LIMITS.serverMissesMax);
  assert.equal(state.restarts, 1);
  assert.equal(state.reloads, 1);
  assert.deepEqual(state.changes, ['restarting', 'ok']);
});

test('a server that cannot start is tried a bounded number of times, then stopped for as long as nobody asks', async () => {
  const { state, supervisor, advance } = world();
  state.up = false;
  state.restartWorks = false;
  await advance(HOUR);
  assert.equal(state.restarts, LIMITS.restartsMax);
  assert.deepEqual(supervisor.state(), { kind: 'stopped', cause: 'server' });
  assert.equal(state.reloads, 0);

  state.restartWorks = true;
  supervisor.restart();
  await advance(1_000);
  assert.equal(state.restarts, LIMITS.restartsMax + 1, 'the button tries at once');
  assert.deepEqual(supervisor.state(), { kind: 'ok' });
  assert.equal(state.reloads, 1);
});

test('a server that dies again right after every start does not loop', async () => {
  const { state, supervisor, advance } = world();
  for (let round = 0; round < 6; round++) {
    state.up = false;
    await advance(30_000);
  }
  assert.equal(state.restarts, LIMITS.restartsMax);
  assert.equal(supervisor.state().kind, 'stopped');
});

test('a server that comes back by itself is noticed, and the blank pages loaded again', async () => {
  const { state, supervisor, advance } = world();
  state.up = false;
  state.restartWorks = false;
  await advance(60_000);
  assert.equal(supervisor.state().kind, 'stopped');
  state.up = true;
  await advance(LIMITS.heartbeatMs * 2);
  assert.deepEqual(supervisor.state(), { kind: 'ok' });
  assert.equal(state.reloads, 1);
});

test('the person asking for a reload restarts a stopped preview, and looks sooner at a live one', async () => {
  const { state, supervisor, advance } = world();
  state.up = false;
  supervisor.asked();
  await advance(LIMITS.confirmMs);
  assert.equal(state.restarts, 1, 'two misses are enough when somebody is looking at the blank canvas');
});

test("the server's process ending restarts it at once; with the bound spent it stops", async () => {
  const { state, supervisor, advance } = world();
  state.up = false;
  supervisor.exited();
  await advance(10);
  assert.equal(state.restarts, 1);
  state.restartWorks = false;
  state.up = false;
  supervisor.exited();
  await advance(10);
  assert.equal(state.restarts, 2);
  assert.deepEqual(supervisor.state(), { kind: 'stopped', cause: 'server' });
});

test('hidden, nothing is asked; coming back looks at once', async () => {
  const { state, supervisor, advance } = world();
  state.visible = false;
  state.up = false;
  await advance(HOUR);
  assert.equal(state.probes, 0);
  assert.equal(state.restarts, 0);
  state.visible = true;
  supervisor.check('return');
  await advance(1);
  assert.equal(state.probes, 1);
  await advance(LIMITS.confirmMs * LIMITS.serverMissesMax);
  assert.equal(state.restarts, 1);
});

test('after a sleep the timers fire late: one answer is all a live server needs', async () => {
  const { state, advance } = world();
  state.up = false;
  await advance(LIMITS.heartbeatMs); // The network is not there yet on waking.
  state.up = true;
  await advance(HOUR);
  assert.equal(state.restarts, 0);
});

test('a frame that stops answering is loaded again, a bounded number of times', async () => {
  const { state, supervisor, advance } = world();
  state.frames = 'silent';
  await advance(HOUR / 12);
  assert.equal(state.restarts, 0, 'the server is fine');
  assert.equal(state.reloads, LIMITS.frameReloadsMax);
  assert.deepEqual(supervisor.state(), { kind: 'stopped', cause: 'frame' });
  state.frames = 'answered';
  await advance(LIMITS.heartbeatMs);
  assert.deepEqual(supervisor.state(), { kind: 'ok' }, 'a page that was only busy takes the cover down');
});

test('while there is no preview to watch, or main is restarting it, nothing happens', async () => {
  const { state, advance } = world();
  state.active = false;
  state.up = false;
  await advance(HOUR);
  assert.equal(state.probes, 0);
  assert.equal(state.restarts, 0);
});

test('stop leaves no timer behind', async () => {
  const { supervisor, timers, advance, state } = world();
  state.up = false;
  await advance(LIMITS.heartbeatMs);
  supervisor.stop();
  assert.equal(timers.size, 0);
});
