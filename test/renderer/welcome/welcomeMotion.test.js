// Goal: start-screen decoration must not keep a constrained or inactive machine busy.
// Method: call the shared motion helpers (hardware eligibility, drawing budget, frame
// loop) with controlled hardware hints and a deterministic animation-frame queue.
// The shader component's own fallback and teardown are in welcomeShaderBackground.test.js.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources');
const { JSDOM } = require('jsdom');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
let visible = true;
let focused = true;
Object.defineProperty(document, 'hidden', { get: () => !visible });
document.hasFocus = () => focused;
const frames = new Map();
let frameIdentity = 0;
window.requestAnimationFrame = (callback) => {
  frameIdentity += 1;
  frames.set(frameIdentity, callback);
  return frameIdentity;
};
window.cancelAnimationFrame = (identity) => frames.delete(identity);
const tick = (now) => {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(now));
};

async function main() {
  const directory = repoPath('node_modules/.stacki-test/welcome-motion');
  await require('esbuild').build({
    entryPoints: [repoPath('src/features/welcome/welcomeMotion.ts')],
    outdir: directory,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { welcomeMotionAllowed, welcomeDrawingSize, welcomeFrames } = require(path.join(directory, 'welcomeMotion.js'));

  await test('hardware hints fail closed at invalid and low-resource boundaries', () => {
    for (const processors of [undefined, '8', 0, -1, 1, 2, 4, 4.5, NaN, Infinity, 1025]) {
      assert.equal(welcomeMotionAllowed(processors, 8), false, String(processors));
    }
    for (const memory of ['8', 0, -1, 0.25, 0.5, 1, 2, 4, NaN, Infinity, 1025]) {
      assert.equal(welcomeMotionAllowed(8, memory), false, String(memory));
    }
    assert.equal(welcomeMotionAllowed(5, 8), true);
    assert.equal(welcomeMotionAllowed(8, undefined), true);
    assert.equal(welcomeMotionAllowed(1024, 1024), true);
    assert.equal(welcomeMotionAllowed(4, undefined), false);
  });

  await test('drawing budget covers Retina, ultrawide, portrait and collapsed canvases', () => {
    for (const [width, height] of [
      [800, 600],
      [3840, 2160],
      [10000, 800],
      [800, 10000],
      [0, 0],
    ]) {
      const size = welcomeDrawingSize(width, height);
      assert.ok(size.width >= 1);
      assert.ok(size.height >= 1);
      assert.ok(size.width <= 1280);
      assert.ok(size.height <= 1280);
      assert.ok(size.width * size.height <= 1280 * 720);
      assert.ok(Number.isSafeInteger(size.width));
      assert.ok(Number.isSafeInteger(size.height));
    }
    assert.deepEqual(welcomeDrawingSize(800, 600), { width: 800, height: 600 });
    assert.throws(() => welcomeDrawingSize(NaN, 10), /width must be finite/);
    assert.throws(() => welcomeDrawingSize(10, Infinity), /height must be finite/);
  });

  await test('frame work is capped, suspended when inactive, and canceled on disposal', () => {
    let draws = 0;
    const stop = welcomeFrames(() => draws++);
    for (let time = 0; time < 1000; time += 5) {
      tick(time);
      assert.equal(frames.size, 1);
    }
    assert.ok(draws <= 30);
    assert.ok(draws >= 28);
    focused = false;
    window.dispatchEvent(new window.Event('blur'));
    assert.equal(frames.size, 0);
    focused = true;
    window.dispatchEvent(new window.Event('focus'));
    window.dispatchEvent(new window.Event('focus'));
    assert.equal(frames.size, 1);
    visible = false;
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(frames.size, 0);
    window.dispatchEvent(new window.Event('focus'));
    assert.equal(frames.size, 0);
    visible = true;
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(frames.size, 1);
    stop();
    window.dispatchEvent(new window.Event('focus'));
    document.dispatchEvent(new window.Event('visibilitychange'));
    assert.equal(frames.size, 0);
    focused = false;
    const stopInactive = welcomeFrames(() => draws++);
    assert.equal(frames.size, 0);
    stopInactive();
    focused = true;
  });

  dom.window.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
