// Goal: the editor's poll of the start report is bounded, backs off, stops at ready, and stops quietly
// when there is no such route (an older Worker, the demo) instead of showing an error.
// Method: a scripted reader and a fake clock; the whole poll runs without waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pollStartup, STARTUP_POLL_LIMITS, type StartupReader } from '../src/features/startup/startupPoll';
import type { StartupView } from '../src/features/startup/startupStages';
import type { ReadinessClock } from '../src/features/startup/readiness';

const view = (stage: StartupView['stage']): StartupView => ({ stage, history: [] });
function fakeClock() {
  let nowMs = 0;
  const sleeps: number[] = [];
  const clock: ReadinessClock = {
    now: () => nowMs,
    sleep: async (delayMs) => {
      sleeps.push(delayMs);
      nowMs += delayMs;
    },
  };
  return { clock, sleeps };
}
function scripted(stages: readonly StartupView['stage'][]): { read: StartupReader; seen: () => number } {
  let index = 0;
  return {
    read: async () => {
      const stage = stages[Math.min(index, stages.length - 1)];
      index += 1;
      return stage === undefined ? undefined : { ok: true, value: view(stage) };
    },
    seen: () => index,
  };
}

test('the poll reports each view and stops at ready, with growing pauses between reads', async () => {
  const { clock, sleeps } = fakeClock();
  const { read } = scripted(['container', 'repository', 'drafts', 'ready']);
  const views: string[] = [];
  const end = await pollStartup({ read, onView: (next) => views.push(next.stage), clock, signal: new AbortController().signal, firstDelayMs: 0 });
  assert.equal(end, 'ready');
  assert.deepEqual(views, ['container', 'repository', 'drafts', 'ready']);
  assert.deepEqual(sleeps, [1_000, 2_000, 3_000]);
});

test('the first read waits for its first delay', async () => {
  const { clock, sleeps } = fakeClock();
  const { read } = scripted(['ready']);
  await pollStartup({ read, onView: () => {}, clock, signal: new AbortController().signal, firstDelayMs: 1_500 });
  assert.deepEqual(sleeps, [1_500]);
});

test('no route, an unreadable answer or a failing read ends the poll as unavailable, never as an error', async () => {
  for (const read of [
    async () => undefined,
    async () => ({ ok: false as const, error: 'bad' }),
    async (): Promise<undefined> => {
      throw new TypeError('offline');
    },
  ]) {
    const { clock } = fakeClock();
    const views: StartupView[] = [];
    const end = await pollStartup({ read, onView: (next) => views.push(next), clock, signal: new AbortController().signal, firstDelayMs: 0 });
    assert.equal(end, 'unavailable');
    assert.deepEqual(views, []);
  }
});

test('a start that never finishes ends at the attempt limit', async () => {
  const { clock } = fakeClock();
  const { read, seen } = scripted(['compile']);
  const end = await pollStartup({
    read,
    onView: () => {},
    clock,
    signal: new AbortController().signal,
    firstDelayMs: 0,
    limits: { attemptsMax: 5, delayMsMin: 1_000, delayMsMax: 3_000, deadlineMs: 900_000 },
  });
  assert.equal(end, 'limit');
  assert.equal(seen(), 5);
});

test('a start that never finishes ends at the deadline when that comes first', async () => {
  const { clock } = fakeClock();
  const { read } = scripted(['compile']);
  const end = await pollStartup({
    read,
    onView: () => {},
    clock,
    signal: new AbortController().signal,
    firstDelayMs: 0,
    limits: { attemptsMax: 1_000, delayMsMin: 1_000, delayMsMax: 3_000, deadlineMs: 10_000 },
  });
  assert.equal(end, 'limit');
});

test('an aborted poll reads nothing more and shows nothing more', async () => {
  const { clock } = fakeClock();
  const controller = new AbortController();
  let reads = 0;
  const views: string[] = [];
  const end = await pollStartup({
    read: async () => {
      reads += 1;
      controller.abort();
      return { ok: true, value: view('server') };
    },
    onView: (next) => views.push(next.stage),
    clock,
    signal: controller.signal,
    firstDelayMs: 0,
  });
  assert.equal(end, 'aborted');
  assert.equal(reads, 1);
  assert.deepEqual(views, []);
});

test('the shipped limits cost a bounded number of requests', () => {
  assert.ok(STARTUP_POLL_LIMITS.attemptsMax <= 600);
  assert.ok(STARTUP_POLL_LIMITS.delayMsMin >= 1_000, 'a poll never asks more than once a second');
  // The bound is stated in minutes, the unit a person reasons about, so no millisecond literal is compared.
  const deadlineMinutes = STARTUP_POLL_LIMITS.deadlineMs / (60 * 1000);
  assert.ok(deadlineMinutes <= 30, 'a poll gives up within half an hour');
});
