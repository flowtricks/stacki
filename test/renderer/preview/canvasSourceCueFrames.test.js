// Goal: the purple source cue of a data-bound text ("Editing source · file › platformIntro.heading") is painted
// only while that text is open for typing. A pointer moving over the text, onto it, off it and back, never paints
// it, not even for one frame; the message that opens the editor (avb:text-active, posted by the double click that
// starts typing) paints it in the same frame, under the element; the message that closes the editor removes it.
//
// Why this exists: a hover hint was set from avb:hover-node and cleared by the next frame message of any other
// kind (the rects report that follows every hover), so each hover flashed the cue for a frame.
//
// Method: the real useCanvasText hook and the real CanvasTextSourceCue, bundled for the browser and mounted in
// jsdom with an iframe standing in for the canvas. Frame messages are dispatched on the window as the canvas posts
// them (from the iframe's window, with the preview's origin). A recorder samples whether the cue is in the document
// after every DOM mutation and every animation frame; the hover steps must record no frame with it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const PREVIEW_URL = 'http://localhost:4321/';
const PREVIEW_ORIGIN = 'http://localhost:4321';
const TOKEN = 'a'.repeat(64);
const HEADING_BOX = { x: 40, y: 120, w: 320, h: 48 };
const FRAMES_SETTLE = 4;
const PAGE_SOURCE = '---\nimport { platformIntro } from "@lib/content";\n---\n<h2>{platformIntro.heading}</h2>';

const ENTRY = `
import React, { useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { useCanvasText } from ${JSON.stringify(repoPath('src/features/preview/useCanvasText.ts'))};
import { CanvasTextSourceCue } from ${JSON.stringify(repoPath('src/app/shell/CanvasTextSourceCue.tsx'))};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
function Harness({ document, url, post }) {
  const frame = useRef(globalThis.document.getElementById('canvas'));
  useCanvasText({ document, frame, url, post, subscribeLoad: () => () => {} });
  return React.createElement(CanvasTextSourceCue);
}
globalThis.stacki = { React, createRoot, act, Harness };
`;

function bundle() {
  const { outputFiles } = buildSync({
    stdin: { contents: ENTRY, resolveDir: repoPath('.'), loader: 'tsx' },
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'iife',
    logLevel: 'silent',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"test"' },
  });
  return outputFiles[0].text;
}

const BUNDLE = bundle();

// The bound heading as canvasBoundText.ts plans it: one target on node 0, written to platformIntro.heading.
function boundPlan() {
  const target = { kind: 'element', key: 'bound:0', path: '0', parent: '0', value: 'Hello', label: 'Heading', nested: false, tag: 'h2', siblings: [] };
  return { target, apply: async () => {}, bound: { kind: 'source', expression: 'platformIntro.heading', file: 'src/lib/content.ts', uses: 1 } };
}

class TimerChannel {
  constructor() {
    this.port1 = { onmessage: undefined };
    this.port2 = { postMessage: () => setTimeout(() => this.port1.onmessage?.({ data: undefined }), 0) };
  }
}

async function mountCanvas() {
  const dom = new JSDOM('<!doctype html><iframe id="canvas"></iframe><div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom;
  Object.defineProperty(window, 'crypto', { configurable: true, value: webcrypto });
  window.avb = { onCmsChanged: () => () => {} };
  // React's async act schedules on a MessageChannel, which jsdom's window does not have. Node's own one would
  // hold the process open after the test, so this one posts with a timer.
  window.MessageChannel = TimerChannel;
  window.eval(BUNDLE);
  const posted = [];
  const document = {
    projectPath: '/fixture',
    file: '/fixture/src/pages/index.astro',
    source: PAGE_SOURCE,
    nodes: [],
    pathFor: () => undefined,
    apply: async () => {},
    report: (message) => assert.fail(`unexpected report: ${message}`),
    loadContent: async () => [boundPlan()],
  };
  const { stacki } = window;
  const root = stacki.createRoot(window.document.getElementById('root'));
  await stacki.act(async () => {
    root.render(stacki.React.createElement(stacki.Harness, { document, url: PREVIEW_URL, post: (message) => posted.push(message) }));
  });
  const catalog = await waitFor(window, () => posted.filter((message) => message.type === 'avb:text-catalog' && message.targets.length > 0).pop());
  const frame = window.document.getElementById('canvas').contentWindow;
  const send = async (data) => {
    await stacki.act(async () => {
      window.dispatchEvent(new window.MessageEvent('message', { data, origin: PREVIEW_ORIGIN, source: frame }));
    });
  };
  return { window, stacki, root, session: catalog.session, send };
}

async function waitFor(window, read) {
  for (let tick = 0; tick < 200; tick += 1) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
  return assert.fail('waitFor: the value never arrived');
}

// One sample per DOM mutation and per animation frame: is the cue in the document, and where.
function recordFrames(window) {
  const frames = [];
  const push = () => {
    const cue = window.document.querySelector('.canvas-source-cue');
    frames.push(cue === null ? 'none' : `cue ${cue.style.visibility} ${cue.style.top}`);
  };
  push();
  const observer = new window.MutationObserver(push);
  observer.observe(window.document.body, { childList: true, subtree: true, attributes: true, characterData: true });
  let sampling = true;
  const sample = () => {
    if (sampling) {
      push();
      window.requestAnimationFrame(sample);
    }
  };
  window.requestAnimationFrame(sample);
  return {
    frames,
    stop: () => {
      sampling = false;
      observer.disconnect();
    },
  };
}

async function settleFrames(window) {
  for (let frame = 0; frame < FRAMES_SETTLE; frame += 1) {
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
  }
}

// Unmounted and closed even when an assertion failed, so a failing run ends instead of timing out.
async function close(canvas) {
  await canvas.stacki.act(async () => canvas.root.unmount());
  canvas.window.close();
}

const hover = (path) => ({ type: 'avb:hover-node', path, occurrence: 0, token: TOKEN, ...(path === undefined ? {} : { boxes: [HEADING_BOX] }) });
const rects = { type: 'avb:rects', token: TOKEN, rects: { 0: [HEADING_BOX] } };

test('no frame paints the source cue while the pointer moves over a bound heading', async (context) => {
  const canvas = await mountCanvas();
  context.after(() => close(canvas));
  const recorder = recordFrames(canvas.window);
  for (let pass = 0; pass < 3; pass += 1) {
    await canvas.send(hover('0'));
    await canvas.send(rects);
    await settleFrames(canvas.window);
    await canvas.send(hover(undefined));
    await settleFrames(canvas.window);
  }
  await canvas.send(hover('0'));
  await settleFrames(canvas.window);
  recorder.stop();
  assert.ok(recorder.frames.length > FRAMES_SETTLE, 'the recorder sampled frames');
  assert.deepEqual(
    recorder.frames.filter((frame) => frame !== 'none'),
    [],
    'a hover-only frame showed the cue',
  );
});

test('the cue appears with the message that opens the editor, under the element, and goes when it closes', async (context) => {
  const canvas = await mountCanvas();
  context.after(() => close(canvas));
  await canvas.send(hover('0'));
  assert.equal(canvas.window.document.querySelector('.canvas-source-cue') ?? undefined, undefined, 'hover alone draws nothing');
  await canvas.send({ type: 'avb:text-active', session: canvas.session, key: 'bound:0', rect: HEADING_BOX });
  const cue = canvas.window.document.querySelector('.canvas-source-cue');
  assert.ok(cue, 'the cue is drawn once typing begins');
  assert.match(cue.textContent, /Editing source/);
  assert.match(cue.textContent, /src\/lib\/content\.ts › platformIntro\.heading/);
  assert.doesNotMatch(cue.textContent, /Double-click/);
  assert.equal(cue.style.visibility, 'visible');
  assert.ok(Number.parseFloat(cue.style.top) >= HEADING_BOX.y + HEADING_BOX.h, 'the cue sits under the element');
  await canvas.send({ type: 'avb:text-inactive', session: canvas.session });
  assert.equal(canvas.window.document.querySelector('.canvas-source-cue') ?? undefined, undefined, 'the cue goes when the editor closes');
});
