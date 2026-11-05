// Loaded into Electron's main process through NODE_OPTIONS by `npm run
// check:linux` (linuxPreflight.ts), it gives every window the conditions of
// the Linux release runner: a hidden window under xvfb gets its animation
// frames late, so a popup sits in its opening phase (scale 0.985) long after
// a macOS window has finished. Here each requestAnimationFrame callback waits
// `frameDelayMs` first, and CSS animations and transitions run at
// `animationRate` of their speed. A probe that measures after a fixed sleep
// instead of after the motion fails on a Mac the way it fails in CI.
//
// The frame delay is a session preload, so it is in place before any page
// script runs and needs nothing from the probe. The animation rate goes
// through the DevTools protocol once the document is ready.
//
// NODE_OPTIONS reaches every Node process the suites start, so the module does
// nothing outside an Electron main process. `require('electron')` cannot
// resolve while NODE_OPTIONS preloads run, so the work waits one turn.
import assert = require('node:assert/strict');
import fs = require('node:fs');
import os = require('node:os');
import path = require('node:path');
import type { Session, WebContents } from 'electron';

export const SLOW_MOTION_ENVIRONMENT = 'STACKI_SLOW_MOTION';
export const SLOW_MOTION_LOG_ENVIRONMENT = 'STACKI_SLOW_MOTION_LOG';

export interface SlowMotion {
  readonly frameDelayMs: number;
  readonly animationRate: number;
}

export const SLOW_MOTION_LIMITS = {
  frameDelayMsMax: 2_000,
  animationRateMin: 0.01,
} as const satisfies Record<string, number>;

/** Parse the profile the preflight passes in the environment. */
export function parseSlowMotion(raw: string): SlowMotion {
  const input: unknown = JSON.parse(raw);
  assert.ok(typeof input === 'object' && input !== null, 'SlowMotion: expected an object');
  const frameDelayMs: unknown = Reflect.get(input, 'frameDelayMs');
  const animationRate: unknown = Reflect.get(input, 'animationRate');
  assert.ok(typeof frameDelayMs === 'number' && Number.isSafeInteger(frameDelayMs), 'SlowMotion.frameDelayMs: expected an integer');
  assert.ok(frameDelayMs >= 0, 'SlowMotion.frameDelayMs: expected at least 0');
  assert.ok(frameDelayMs <= SLOW_MOTION_LIMITS.frameDelayMsMax, 'SlowMotion.frameDelayMs: exceeds limit');
  assert.ok(typeof animationRate === 'number' && Number.isFinite(animationRate), 'SlowMotion.animationRate: expected a number');
  assert.ok(animationRate >= SLOW_MOTION_LIMITS.animationRateMin, 'SlowMotion.animationRate: below limit');
  assert.ok(animationRate <= 1, 'SlowMotion.animationRate: a slowdown is at most 1');
  return { frameDelayMs, animationRate };
}

/** The preload that delays every animation frame in the page's own world.
 * With context isolation off, the preload already shares the page's world. */
export function frameDelayPreload(frameDelayMs: number): string {
  assert.ok(Number.isSafeInteger(frameDelayMs), 'frameDelayPreload: the delay is an integer');
  assert.ok(frameDelayMs >= 0, 'frameDelayPreload: the delay is not negative');
  return `const { contextBridge } = require('electron');
const slow = (delayMs) => {
  if (window.__stackiSlowMotion === true) { return; }
  window.__stackiSlowMotion = true;
  const requestFrame = window.requestAnimationFrame.bind(window);
  const cancelFrame = window.cancelAnimationFrame.bind(window);
  const pending = new Map();
  let next = 1;
  window.requestAnimationFrame = (callback) => {
    const id = next;
    next += 1;
    const entry = { timer: 0, frame: 0 };
    entry.timer = setTimeout(() => {
      entry.frame = requestFrame((time) => { pending.delete(id); callback(time); });
    }, delayMs);
    pending.set(id, entry);
    return id;
  };
  window.cancelAnimationFrame = (id) => {
    const entry = pending.get(id);
    if (entry === undefined) { return; }
    clearTimeout(entry.timer);
    if (entry.frame !== 0) { cancelFrame(entry.frame); }
    pending.delete(id);
  };
};
try {
  contextBridge.executeInMainWorld({ func: slow, args: [${frameDelayMs}] });
} catch {
  slow(${frameDelayMs});
}
`;
}

async function start(): Promise<void> {
  if (Reflect.get(process, 'type') !== 'browser') {
    return;
  }
  const raw = process.env[SLOW_MOTION_ENVIRONMENT];
  assert.ok(raw !== undefined, `slow motion: ${SLOW_MOTION_ENVIRONMENT} is set by the preflight that loads this module`);
  const motion = parseSlowMotion(raw);
  const logFile = process.env[SLOW_MOTION_LOG_ENVIRONMENT];
  const preloadDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-slow-motion-'));
  const preloadFile = path.join(preloadDirectory, 'preload.js');
  fs.writeFileSync(preloadFile, frameDelayPreload(motion.frameDelayMs));
  const { app, session } = await import('electron');
  const registered = new WeakSet<Session>();
  const register = (target: Session): void => {
    if (!registered.has(target)) {
      registered.add(target);
      target.registerPreloadScript({ type: 'frame', filePath: preloadFile });
    }
  };
  app.on('session-created', register);
  app.on('web-contents-created', (_event, contents) => {
    register(contents.session);
    contents.on('dom-ready', () => {
      void slowAnimations(contents, motion, logFile).catch((error: unknown) => console.error(`slow motion: ${String(error)}`));
    });
  });
  app.on('quit', () => fs.rmSync(preloadDirectory, { recursive: true, force: true }));
  await app.whenReady();
  register(session.defaultSession);
}

async function slowAnimations(contents: WebContents, motion: SlowMotion, logFile: string | undefined): Promise<void> {
  const protocol = contents.debugger;
  if (!protocol.isAttached()) {
    try {
      protocol.attach('1.3');
    } catch (error: unknown) {
      // A probe that drives the protocol itself keeps it; animations run at speed.
      console.error(`slow motion: could not attach to a window: ${String(error)}`);
    }
  }
  if (protocol.isAttached()) {
    await protocol.sendCommand('Animation.enable');
    await protocol.sendCommand('Animation.setPlaybackRate', { playbackRate: motion.animationRate });
  }
  // The preflight counts slowed documents to prove the profile reached the suite.
  const slowed: unknown = await contents.executeJavaScript('window.__stackiSlowMotion === true');
  if (logFile !== undefined) {
    fs.appendFileSync(logFile, `${slowed === true ? 'slowed' : 'unslowed'} ${contents.getURL()}\n`);
  }
}

if (process.versions.electron !== undefined) {
  if (process.env[SLOW_MOTION_ENVIRONMENT] !== undefined) {
    setImmediate(() => {
      void start().catch((error: unknown) => {
        console.error(`slow motion: ${String(error)}`);
        process.exit(1);
      });
    });
  }
}
