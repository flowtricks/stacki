// Goal: a recording holds its bounds and frees its memory. The frame buffer keeps frames in time order and
// refuses the frame that would pass the frame or byte bound (it is not a ring: the earliest frames stay); the
// rate is what a capture of the region measurably costs, with headroom, between the floor and the ceiling, chosen
// from the first frame, every ten frames and at once after an overrun; the first frame is taken at once and Stop
// keeps the tail; a recording pauses while the window is hidden (no frames, no time counted), stops by itself at
// the duration, frame and byte bounds and on a failed capture, and answers thumbnails on stop and one full frame
// on request; the recorder keeps one recording, frees it on
// discard, on a new start and when a stopped one is left alone, and refuses an unknown id as a value. The
// module imports nothing that writes files.
// Methodology: the modules from dist/ with a fake clock, a timer queue the test drains, and a stand-in
// NativeImage whose encoded sizes the test chooses; the compiled module's imports are scanned.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { test } from 'node:test';
import {
  FrameBuffer,
  RECORDING_LIMITS,
  Recording,
  ScreenRecorder,
  fpsForCost,
  encodeFrame,
  type RecorderDeps,
} from '#dist/electron/handlers/ai/screenRecorder.js';
import type { ScreenshotImage } from '#dist/electron/handlers/ai/screenshotCapture.js';

const RECT = { x: 0, y: 0, width: 400, height: 300 };

function encoded(width: number, height: number, bytes: number): Omit<ScreenshotImage, 'resize'> {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    toPNG: () => Buffer.alloc(bytes),
    toJPEG: () => Buffer.alloc(width <= RECORDING_LIMITS.thumbEdgePx && height <= RECORDING_LIMITS.thumbEdgePx ? 100 : bytes),
  };
}

// A frame is resized at most twice (to the screenshot edge, then to the thumbnail edge), so two levels are spelled out.
function image(width: number, height: number, bytes: number): ScreenshotImage {
  const leaf = (size: { readonly width: number; readonly height: number }): ScreenshotImage => ({
    ...encoded(size.width, size.height, bytes),
    resize: () => assert.fail('resized three times'),
  });
  const middle = (size: { readonly width: number; readonly height: number }): ScreenshotImage => ({ ...encoded(size.width, size.height, bytes), resize: leaf });
  return { ...encoded(width, height, bytes), resize: middle };
}

function frame(atMs: number, bytes: number) {
  return { atMs, width: 10, height: 10, frame: Buffer.alloc(bytes), thumb: Buffer.alloc(0) };
}

test('the frame buffer refuses past its frame bound and keeps the earliest frames', () => {
  const buffer = new FrameBuffer({ framesMax: 3, bytesMax: 1_000 });
  for (const at of [0, 200, 400]) {
    assert.equal(buffer.push(frame(at, 10)), undefined);
  }
  assert.equal(buffer.push(frame(600, 10)), 'frames');
  assert.equal(buffer.count, 3);
  assert.deepEqual(
    buffer.list().map((entry) => entry.atMs),
    [0, 200, 400],
    'not a ring: the first frames stay',
  );
  buffer.clear();
  assert.equal(buffer.count, 0);
  assert.equal(buffer.byteCount, 0);
});

test('the frame buffer refuses the frame that would pass its byte bound', () => {
  const buffer = new FrameBuffer({ framesMax: 10, bytesMax: 100 });
  assert.equal(buffer.push(frame(0, 60)), undefined);
  assert.equal(buffer.push(frame(1, 41)), 'bytes');
  assert.equal(buffer.byteCount, 60, 'a refused frame changes nothing');
  assert.equal(buffer.push(frame(2, 40)), undefined, 'one that fits exactly is kept');
  assert.equal(buffer.byteCount, 100);
  assert.throws(() => buffer.push(frame(1, 0)), /time order/);
});

test('the rate is what a capture of the region costs, with headroom, between the floor and the ceiling', () => {
  assert.equal(fpsForCost(0), RECORDING_LIMITS.fpsMax, 'free is the ceiling');
  assert.equal(fpsForCost(3), 15, 'a small region: 3 ms affords far more than the ceiling');
  assert.equal(fpsForCost(50), 13, '1000 / (50 × 1.5)');
  assert.equal(fpsForCost(100), 6, 'a large region');
  assert.equal(fpsForCost(133), 5);
  assert.equal(fpsForCost(2_000), RECORDING_LIMITS.fpsMin, 'never below the floor');
  assert.throws(() => fpsForCost(-1), /not negative/);
});

test('a frame is a JPEG within the screenshot edge with a small thumbnail', () => {
  const encoded = encodeFrame(image(3200, 1800, 5_000), 400);
  assert.ok(encoded !== undefined);
  assert.equal(encoded.width, 1600);
  assert.equal(encoded.height, 900);
  assert.equal(encoded.frame.length, 5_000);
  assert.equal(encoded.thumb.length, 100);
  assert.equal(encoded.atMs, 400);
});

// A fake world: a clock that moves only when the test says, timers the test drains in order.
function world(options: {
  readonly captureMs: number | ((frame: number) => number);
  readonly bytes: number;
  readonly visible?: () => boolean;
  readonly fail?: () => boolean;
}) {
  let now = 0;
  let captures = 0;
  let timers: { at: number; run: () => void; live: boolean }[] = [];
  const deps: RecorderDeps = {
    now: () => now,
    visible: options.visible ?? (() => true),
    setTimer: (run, delayMs) => {
      const timer = { at: now + delayMs, run, live: true };
      timers.push(timer);
      return {
        cancel: () => {
          timer.live = false;
        },
      };
    },
    capture: async () => {
      captures += 1;
      now += typeof options.captureMs === 'number' ? options.captureMs : options.captureMs(captures);
      if (options.fail?.() === true) {
        throw new Error('window closed');
      }
      return image(800, 600, options.bytes);
    },
  };
  const drain = async (untilMs: number): Promise<void> => {
    // Each pass runs the earliest live timer; the bound keeps a broken loop from spinning forever.
    for (let pass = 0; pass < 10_000; pass += 1) {
      timers = timers.filter((timer) => timer.live);
      timers.sort((left, right) => left.at - right.at);
      const next = timers[0];
      if (next === undefined || next.at > untilMs) {
        return;
      }
      timers.shift();
      now = Math.max(now, next.at);
      next.run();
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.fail('the timer queue did not drain');
  };
  return { deps, drain, clock: () => now };
}

test('a recording stops by itself at the duration bound, at the rate its cost affords', async () => {
  // A capture of 100 ms affords 6 fps (fpsForCost), so 15 s hold about 90 frames.
  const { deps, drain } = world({ captureMs: 100, bytes: 1_000 });
  let finished = 0;
  const recording = new Recording(RECT, deps, () => {
    finished += 1;
  });
  await drain(RECORDING_LIMITS.durationMsMax + 1_000);
  const status = recording.status();
  assert.ok(status.kind === 'status');
  assert.equal(status.state, 'stopped');
  assert.equal(status.stopReason, 'duration');
  assert.equal(finished, 1);
  assert.ok(status.frames <= RECORDING_LIMITS.framesMax);
  assert.ok(status.frames >= Math.floor((RECORDING_LIMITS.durationMsMax / 1000) * fpsForCost(100)) - 2, `about 6 fps over 15 s: ${status.frames}`);
  const stopped = await recording.stop();
  assert.ok(stopped.kind === 'stopped');
  assert.equal(stopped.frames.length, status.frames);
  assert.equal(stopped.stopReason, 'duration');
  assert.ok(stopped.fps >= RECORDING_LIMITS.fpsMin && stopped.fps <= RECORDING_LIMITS.fpsMax);
  const full = recording.frame(0);
  assert.ok(full?.kind === 'frame');
  assert.equal(full.image.mimeType, 'image/jpeg');
  assert.equal(recording.frame(stopped.frames.length), undefined);
});

test('a recording stops at the frame bound and at the byte bound', async () => {
  const quick = world({ captureMs: 1, bytes: 10 });
  const byFrames = new Recording(RECT, quick.deps, () => undefined);
  await quick.drain(60_000);
  const frames = byFrames.status();
  assert.ok(frames.kind === 'status');
  assert.ok(frames.stopReason === 'frames' || frames.stopReason === 'duration');
  assert.ok(frames.frames <= RECORDING_LIMITS.framesMax);
  const heavy = world({ captureMs: 10, bytes: 8 * 1024 * 1024 });
  const byBytes = new Recording(RECT, heavy.deps, () => undefined);
  await heavy.drain(60_000);
  const bytes = byBytes.status();
  assert.ok(bytes.kind === 'status');
  assert.equal(bytes.stopReason, 'bytes');
  assert.ok(bytes.bytes <= RECORDING_LIMITS.bytesMax);
  assert.equal(bytes.frames, 4, 'four 8 MiB frames fit in 40 MiB, a fifth does not');
});

test('a hidden window pauses capture without counting the time, and a failed capture stops', async () => {
  let shown = false;
  const paused = world({ captureMs: 10, bytes: 100, visible: () => shown });
  const recording = new Recording(RECT, paused.deps, () => undefined);
  await paused.drain(5_000);
  const waiting = recording.status();
  assert.ok(waiting.kind === 'status');
  assert.equal(waiting.state, 'paused');
  assert.equal(waiting.frames, 0);
  assert.equal(waiting.elapsedMs, 0, 'hidden time does not count');
  shown = true;
  const shownAt = paused.clock();
  await paused.drain(6_000);
  const running = recording.status();
  assert.ok(running.kind === 'status');
  assert.equal(running.state, 'recording');
  assert.ok(running.frames > 0);
  // The fake clock's own reading: only the time since the window was shown counts.
  assert.ok(running.elapsedMs <= paused.clock() - shownAt, `only the shown time counts: ${running.elapsedMs}`);
  recording.discard();
  let calls = 0;
  const failing = world({ captureMs: 10, bytes: 100, fail: () => ++calls > 2 });
  const broken = new Recording(RECT, failing.deps, () => undefined);
  await failing.drain(5_000);
  const ended = broken.status();
  assert.ok(ended.kind === 'status');
  assert.equal(ended.stopReason, 'failed');
  assert.equal(ended.frames, 2, 'the frames before the failure are kept');
});

test('the recorder keeps one recording, frees it on discard, on a new start and when left alone', async () => {
  const { deps, drain } = world({ captureMs: 10, bytes: 1_000 });
  const recorder = new ScreenRecorder(deps);
  const sender = { capture: deps.capture, visible: deps.visible };
  const first = await recorder.act({ kind: 'start', rect: RECT }, sender);
  assert.ok(first.ok && first.value.kind === 'started');
  await drain(1_000);
  const second = await recorder.act({ kind: 'start', rect: RECT }, sender);
  assert.ok(second.ok && second.value.kind === 'started');
  const old = await recorder.act({ kind: 'status', id: first.value.id }, sender);
  assert.ok(!old.ok, 'a new start frees the old recording');
  assert.equal(old.error.code, 'invalid');
  await drain(2_000);
  const stopped = await recorder.act({ kind: 'stop', id: second.value.id }, sender);
  assert.ok(stopped.ok && stopped.value.kind === 'stopped');
  assert.ok(stopped.value.frames.length > 0);
  const discarded = await recorder.act({ kind: 'discard', id: second.value.id }, sender);
  assert.ok(discarded.ok);
  assert.ok(!(await recorder.act({ kind: 'frame', id: second.value.id, index: 0 }, sender)).ok, 'nothing is left after discard');
  const third = await recorder.act({ kind: 'start', rect: RECT }, sender);
  assert.ok(third.ok && third.value.kind === 'started');
  await drain(3_000);
  await recorder.act({ kind: 'stop', id: third.value.id }, sender);
  await drain(3_000 + RECORDING_LIMITS.stoppedKeepMs + 1);
  assert.ok(!(await recorder.act({ kind: 'status', id: third.value.id }, sender)).ok, 'a stopped recording left alone is freed');
  assert.ok(!(await recorder.act({ kind: 'status', id: 'r0000000000000000' }, sender)).ok, 'an unknown id is a value, not a throw');
});

test('the first frame is taken at once, the rate is chosen from measured costs, and Stop keeps the tail', async () => {
  // Cheap captures for 20 frames (a small region), then expensive ones (the page got busy).
  const { deps, drain } = world({ captureMs: (frame) => (frame <= 20 ? 3 : 120), bytes: 1_000 });
  const recording = new Recording(RECT, deps, () => undefined);
  await drain(0);
  const opening = recording.status();
  assert.ok(opening.kind === 'status');
  assert.equal(opening.frames, 1, 'the first frame at once');
  assert.equal(recording.currentFps, RECORDING_LIMITS.fpsMax, 'the first measured cost sets the rate: 3 ms is the ceiling');
  await drain(1_000);
  const fast = recording.status();
  assert.ok(fast.kind === 'status');
  assert.ok(fast.frames >= 14, `about 15 fps for a small region: ${fast.frames} in the first second`);
  await drain(4_000);
  assert.ok(recording.currentFps <= 6, `an overrun re-chooses at once: ${recording.currentFps} fps`);
  const before = recording.status();
  assert.ok(before.kind === 'status');
  const stopped = await recording.stop();
  assert.ok(stopped.kind === 'stopped');
  assert.equal(stopped.stopReason, 'person');
  const tail = stopped.frames.at(-1);
  assert.ok(tail !== undefined);
  assert.ok(stopped.frames.length >= before.frames, 'no frame is lost at Stop');
  assert.ok(stopped.frames.length > before.frames, 'Stop took one more frame');
  assert.ok(tail.atMs >= before.elapsedMs, 'the last frame is from the moment of Stop, after everything counted before it');
  assert.deepEqual(
    stopped.frames.map((frame) => frame.index),
    stopped.frames.map((_, index) => index),
    'every frame is kept, none deduplicated',
  );
});

test('the recorder module touches no file: no fs, os or temp-directory import', () => {
  const compiled = fs.readFileSync(new URL(import.meta.resolve('#dist/electron/handlers/ai/screenRecorder.js')), 'utf8');
  for (const forbidden of ['node:fs', 'node:os', "'fs'", "'os'", 'mkdtemp', 'tmpdir', 'writeFile']) {
    assert.ok(!compiled.includes(forbidden), `screenRecorder imports nothing like ${forbidden}`);
  }
});
