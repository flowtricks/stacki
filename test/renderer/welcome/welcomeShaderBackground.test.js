// Goal: the reel-shader backdrop runs at its scaled reel pace, bounds its pixel and clock
// inputs, shows a still frame under reduced motion, and falls back to the
// static CSS gradient whenever WebGL refuses or loses its context.
// Method: bundle the welcome modules with esbuild, test the pure surface and timing
// helpers at and beyond their bounds, then mount WelcomeShaderBackground in jsdom against a
// fake WebGL context and a deterministic animation-frame queue.
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
document.hasFocus = () => true;
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
Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 8 });
Object.defineProperty(navigator, 'deviceMemory', { configurable: true, value: 8 });

function motionPreference(matches) {
  const listeners = new Set();
  const motion = {
    matches,
    addEventListener: (_event, listener) => listeners.add(listener),
    removeEventListener: (_event, listener) => listeners.delete(listener),
  };
  window.matchMedia = () => motion;
  return listeners;
}

function graphics() {
  const calls = { draws: 0, times: [], programsDeleted: 0, buffersDeleted: 0 };
  const context = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
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
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    useProgram() {},
    bindBuffer() {},
    bufferData() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    viewport() {},
    uniform2f() {},
    uniform1f(_location, value) {
      calls.times.push(value);
    },
    drawArrays() {
      calls.draws += 1;
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
  const directory = repoPath('node_modules/.stacki-test/welcome-shader-background');
  await require('esbuild').build({
    entryPoints: [repoPath('src/features/welcome/WelcomeShaderBackground.tsx'), repoPath('src/features/welcome/welcomeShader.ts')],
    outdir: directory,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const WelcomeShaderBackground = require(path.join(directory, 'WelcomeShaderBackground.js')).default;
  const shader = require(path.join(directory, 'welcomeShader.js'));

  await test('only a drawn frame shows the canvas; otherwise the CSS gradient shows', () => {
    assert.equal(shader.welcomeShaderSurface('drawn'), 'canvas');
    for (const context of ['pending', 'refused', 'lost']) {
      assert.equal(shader.welcomeShaderSurface(context), 'gradient', context);
    }
  });

  await test('motion is still under reduced motion or modest hardware', () => {
    assert.equal(shader.welcomeShaderMotion({ reducedMotion: false, hardwareAllowed: true }), 'animated');
    assert.equal(shader.welcomeShaderMotion({ reducedMotion: true, hardwareAllowed: true }), 'still');
    assert.equal(shader.welcomeShaderMotion({ reducedMotion: false, hardwareAllowed: false }), 'still');
    assert.equal(shader.welcomeShaderMotion({ reducedMotion: true, hardwareAllowed: false }), 'still');
  });

  await test('shader time runs at the scaled reel pace, clamped at zero and wrapped at its period', () => {
    // The reel fed frame / fps; the app runs that clock at timeScale, slower than the reel.
    const scale = shader.SHADER_LIMITS.timeScale;
    assert.ok(scale > 0.25, `still visibly moving: ${scale}`);
    assert.ok(scale < 1);
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);
    assert.equal(shader.welcomeShaderSeconds(0), 0);
    near(shader.welcomeShaderSeconds(1000), scale);
    near(shader.welcomeShaderSeconds(4000), 4 * scale);
    assert.equal(shader.welcomeShaderSeconds(-16), 0);
    const periodMs = (shader.SHADER_LIMITS.secondsPeriod / scale) * 1000;
    near(shader.welcomeShaderSeconds(periodMs + 2000), 2 * scale);
    assert.ok(shader.welcomeShaderSeconds(periodMs - 1) < shader.SHADER_LIMITS.secondsPeriod);
    assert.ok(shader.welcomeShaderSeconds(periodMs * 50) < shader.SHADER_LIMITS.secondsPeriod);
    assert.throws(() => shader.welcomeShaderSeconds(NaN), /elapsed time must be finite/);
    assert.throws(() => shader.welcomeShaderSeconds(Infinity), /elapsed time must be finite/);
  });

  await test('device pixel ratio is capped and malformed ratios read as one', () => {
    assert.equal(shader.welcomeShaderPixelRatio(1), 1);
    assert.equal(shader.welcomeShaderPixelRatio(1.25), 1.25);
    assert.equal(shader.welcomeShaderPixelRatio(2), shader.SHADER_LIMITS.pixelRatioMax);
    assert.equal(shader.welcomeShaderPixelRatio(3), shader.SHADER_LIMITS.pixelRatioMax);
    for (const ratio of [0, 0.5, -2, NaN, Infinity, '2', undefined]) {
      assert.equal(shader.welcomeShaderPixelRatio(ratio), 1, String(ratio));
    }
  });

  // The clock wraps at secondsPeriod. A wrap is seamless only if every motion
  // ends the loop where it began: the sways complete whole cycles, and the
  // noise drifts (circles in noise space) close. A straight drift, or a sway
  // at 0.7 rad/s, did not — the picture jumped once per loop.
  await test('every motion repeats exactly over one loop, so the wrap is seamless', () => {
    const period = shader.SHADER_LIMITS.secondsPeriod;
    for (const reel of [0.7, 1.3]) {
      const frequency = shader.loopFrequency(reel);
      const cycles = (frequency * period) / (2 * Math.PI);
      assert.ok(Math.abs(cycles - Math.round(cycles)) < 1e-9, `${reel} rad/s snaps to whole cycles per loop: ${cycles}`);
      assert.ok(Math.abs(frequency - reel) / reel < 0.01, `and stays within 1% of the reel's pace: ${frequency}`);
      assert.match(shader.SHADER_FRAGMENT_SOURCE, new RegExp(`t \\* ${frequency.toFixed(9).replace('.', '\\.')}`), 'the shader uses the snapped frequency');
    }
    // The drift, as the shader computes it: start at rest, end at rest.
    const omega = (2 * Math.PI) / period;
    const drift = (velocity, seconds) => {
      const radius = shader.loopDriftRadius(velocity);
      const length = Math.hypot(velocity[0], velocity[1]);
      const direction = [velocity[0] / length, velocity[1] / length];
      const side = [-direction[1], direction[0]];
      return [0, 1].map((axis) => radius * (direction[axis] * Math.sin(omega * seconds) + side[axis] * (1 - Math.cos(omega * seconds))));
    };
    for (const velocity of [
      [0.28, -0.2],
      [-0.4, 0.32],
    ]) {
      const end = drift(velocity, period);
      assert.ok(Math.hypot(end[0], end[1]) < 1e-9, `the drift ${velocity} closes over one loop: ${end}`);
      // Same speed as the reel's straight drift at the start.
      const early = drift(velocity, 0.01);
      const speed = Math.hypot(early[0], early[1]) / 0.01;
      assert.ok(Math.abs(speed - Math.hypot(velocity[0], velocity[1])) < 1e-3, `at the reel's speed: ${speed}`);
    }
    assert.doesNotMatch(shader.SHADER_FRAGMENT_SOURCE, /t \* 0\.28|t \* 0\.7\)/, 'no straight drift or unsnapped sway is left');
    assert.throws(() => shader.loopFrequency(0), /loopFrequency: a frequency is positive/);
    assert.throws(() => shader.loopDriftRadius([0, 0]), /loopDriftRadius: a drift moves/);
  });

  await test('the fragment shader carries the reel ramp and no beat pulse', () => {
    assert.match(shader.SHADER_FRAGMENT_SOURCE, /float snoise\(vec2 v\)/);
    assert.match(shader.SHADER_FRAGMENT_SOURCE, /vec3\(0\.38, 0\.0, 1\.0\)/);
    assert.doesNotMatch(shader.SHADER_FRAGMENT_SOURCE, /uPulse|u_pulse/);
  });

  const container = document.getElementById('root');
  const mount = async () => {
    const root = createRoot(container);
    await act(async () => root.render(React.createElement(WelcomeShaderBackground)));
    return root;
  };
  // The backdrop element always stays; its CSS gradient shows wherever the canvas is hidden.
  const canvasShown = () => {
    assert.ok(container.querySelector('.welcome-bg'), 'the backdrop element is always rendered');
    return container.querySelector('canvas').style.visibility === 'visible';
  };

  await test('a refused WebGL context leaves the static gradient', async () => {
    motionPreference(false);
    const types = [];
    window.HTMLCanvasElement.prototype.getContext = (type) => {
      types.push(type);
      return undefined;
    };
    const root = await mount();
    assert.equal(canvasShown(), false);
    assert.equal(types.length, 1);
    assert.equal(types[0], 'webgl');
    assert.equal(frames.size, 0);
    await act(async () => root.unmount());
  });

  await test('reduced motion draws one still frame and schedules no animation', async () => {
    const listeners = motionPreference(true);
    const { calls, context } = graphics();
    window.HTMLCanvasElement.prototype.getContext = () => context;
    const root = await mount();
    assert.equal(canvasShown(), true);
    assert.equal(calls.draws, 1);
    assert.deepEqual(calls.times, [shader.SHADER_LIMITS.secondsStill]);
    assert.equal(frames.size, 0);
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(calls.draws, 2);
    await act(async () => root.unmount());
    window.dispatchEvent(new window.Event('resize'));
    assert.equal(calls.draws, 2);
    assert.equal(calls.programsDeleted, 1);
    assert.equal(calls.buffersDeleted, 1);
    assert.equal(listeners.size, 0);
  });

  await test('animation caps pixels, advances with time, and stops on unmount', async () => {
    motionPreference(false);
    const { calls, context } = graphics();
    window.HTMLCanvasElement.prototype.getContext = () => context;
    Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 3 });
    const root = await mount();
    const canvas = container.querySelector('canvas');
    Object.defineProperty(canvas, 'clientWidth', { configurable: true, value: 600 });
    Object.defineProperty(canvas, 'clientHeight', { configurable: true, value: 400 });
    assert.equal(frames.size, 1);
    const start = performance.now();
    tick(start + 1000);
    tick(start + 2000);
    assert.equal(calls.draws, 2);
    assert.equal(canvas.width, 900);
    assert.equal(canvas.height, 600);
    const [first, second] = calls.times;
    assert.ok(Math.abs(second - first - shader.SHADER_LIMITS.timeScale) < 0.05, `one scaled second apart: ${first}, ${second}`);
    await act(async () => root.unmount());
    assert.equal(frames.size, 0);
    assert.equal(calls.programsDeleted, 1);
  });

  await test('a lost context hides the canvas over the static gradient and stops drawing', async () => {
    motionPreference(false);
    const { calls, context } = graphics();
    window.HTMLCanvasElement.prototype.getContext = () => context;
    const root = await mount();
    assert.equal(canvasShown(), false, 'hidden until the first frame is drawn');
    tick(performance.now() + 100);
    assert.equal(canvasShown(), true);
    await act(async () => container.querySelector('canvas').dispatchEvent(new window.Event('webglcontextlost')));
    assert.equal(canvasShown(), false);
    assert.equal(frames.size, 0);
    const draws = calls.draws;
    window.dispatchEvent(new window.Event('focus'));
    tick(performance.now() + 200);
    assert.equal(calls.draws, draws);
    await act(async () => root.unmount());
    assert.equal(calls.programsDeleted, 1);
  });
  dom.window.close();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
