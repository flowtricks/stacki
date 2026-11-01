// Goal: start-screen decoration must not keep a constrained or inactive machine busy.
// Method: mount the real component with controlled hardware, motion and WebGL APIs;
// advance a deterministic frame queue to check budgets, fallback and teardown.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources');
const { JSDOM } = require('jsdom');
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.IS_REACT_ACT_ENVIRONMENT = true;
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

function hardware(processors, memoryGB) {
  Object.defineProperty(navigator, 'hardwareConcurrency', {
    configurable: true,
    value: processors,
  });
  Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: memoryGB });
}

function motionPreference() {
  const listeners = new Set();
  const motion = {
    matches: false,
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  };
  window.matchMedia = () => motion;
  return {
    listeners,
    change(matches) {
      motion.matches = matches;
      listeners.forEach((listener) => listener());
    },
  };
}

function graphics() {
  const calls = { draws: 0, texturesDeleted: 0, buffersDeleted: 0, programsDeleted: 0 };
  const context = {
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    deleteShader() {},
    createProgram: () => ({}),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    createBuffer: () => ({}),
    createTexture: () => ({}),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    useProgram() {},
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    bindTexture() {},
    texParameteri() {},
    viewport() {},
    texImage2D() {},
    activeTexture() {},
    uniform1i() {},
    uniform1f() {},
    uniform2f() {},
    drawArrays() {
      calls.draws += 1;
    },
    deleteTexture() {
      calls.texturesDeleted += 1;
    },
    deleteBuffer() {
      calls.buffersDeleted += 1;
    },
    deleteProgram() {
      calls.programsDeleted += 1;
    },
  };
  return { calls, context };
}

async function main() {
  const directory = repoPath('node_modules/.stacki-test/welcome-background');
  await require('esbuild').build({
    entryPoints: [repoPath('src/features/welcome/WelcomeBackground.tsx'), repoPath('src/features/welcome/welcomeMotion.ts')],
    outdir: directory,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const WelcomeBackground = require(path.join(directory, 'WelcomeBackground.js')).default;
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

  const container = document.getElementById('root');
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WelcomeBackground)));
    return root;
  };
  await test('constrained devices and reduced motion never request a WebGL context', async () => {
    let requests = 0;
    window.HTMLCanvasElement.prototype.getContext = () => {
      requests++;
      return undefined;
    };
    const motion = motionPreference();
    for (const [processors, memory] of [
      [4, 8],
      [8, 4],
      [undefined, 8],
      [8, 8],
    ]) {
      hardware(processors, memory);
      motion.change(processors === 8 && memory === 8);
      const root = await mount();
      assert.equal(requests, 0);
      assert.equal(frames.size, 0);
      assert.equal(container.querySelector('canvas').style.visibility, 'hidden');
      await act(async () => root.unmount());
    }
    assert.equal(motion.listeners.size, 0);
  });

  await test('WebGL rejection keeps the static fallback without scheduling work', async () => {
    hardware(8, 8);
    motionPreference();
    let attributes;
    window.HTMLCanvasElement.prototype.getContext = (_type, options) => {
      attributes = options;
      return undefined;
    };
    const root = await mount();
    assert.equal(attributes.powerPreference, 'low-power');
    assert.equal(attributes.failIfMajorPerformanceCaveat, true);
    assert.equal(frames.size, 0);
    assert.equal(container.querySelector('canvas').style.visibility, 'hidden');
    await act(async () => root.unmount());
  });

  await test('motion changes, context loss and unmount dispose animation resources', async () => {
    hardware(8, 8);
    const motion = motionPreference();
    const { calls, context } = graphics();
    window.HTMLCanvasElement.prototype.getContext = () => context;
    const root = await mount();
    const canvas = container.querySelector('canvas');
    Object.defineProperty(canvas, 'clientWidth', { value: 3840 });
    Object.defineProperty(canvas, 'clientHeight', { value: 2160 });
    tick(10000);
    assert.equal(calls.draws, 1);
    assert.equal(canvas.style.visibility, 'visible');
    assert.equal(canvas.width, 1280);
    assert.equal(canvas.height, 720);
    await act(async () => motion.change(true));
    assert.equal(frames.size, 0);
    assert.equal(canvas.style.visibility, 'hidden');
    assert.equal(calls.texturesDeleted, 1);
    assert.equal(calls.buffersDeleted, 1);
    assert.equal(calls.programsDeleted, 1);
    await act(async () => motion.change(false));
    assert.equal(frames.size, 1);
    canvas.dispatchEvent(new window.Event('webglcontextlost'));
    assert.equal(frames.size, 0);
    assert.equal(canvas.style.visibility, 'hidden');
    assert.equal(calls.programsDeleted, 2);
    await act(async () => root.unmount());
    assert.equal(motion.listeners.size, 0);
    const nextRoot = await mount();
    assert.equal(frames.size, 1);
    await act(async () => nextRoot.unmount());
    assert.equal(calls.programsDeleted, 3);
    assert.equal(frames.size, 0);
    window.dispatchEvent(new window.Event('focus'));
    assert.equal(frames.size, 0);
  });
  dom.window.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
