// Goal: a bound text says where editing it writes: the canvas cue under the text being typed in. The Settings panel shows no hint. The cue names the file and binding, says 'Used in N places' only when N is more than one, and gives up the START
// of a long path first. It sits under the element, left-aligned; directly above it only when there is no room below.
// Method: bundle the real components for the browser, mount them in jsdom with react-dom's act, set the live values the editor
// sets, and read the text drawn. The pure path helper is tested directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const { truncateStart, sourceCuePath, sourceCuePlace, SOURCE_CUE_CHARS_MAX, SOURCE_CUE_GAP_PX, SOURCE_CUE_MARGIN_PX } =
  loadRenderer('src/app/shell/sourceCueText.ts');

const ENTRY = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { CanvasTextSourceCue } from ${JSON.stringify(repoPath('src/app/shell/CanvasTextSourceCue.tsx'))};
import { canvasSourceCue } from ${JSON.stringify(repoPath('src/ui/canvasTextSourceCue.ts'))};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.stacki = { React, createRoot, act, CanvasTextSourceCue, canvasSourceCue };
`;

function mount() {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { runScripts: 'outside-only', pretendToBeVisual: true });
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
  dom.window.eval(outputFiles[0].text);
  return dom;
}

function cueState(overrides) {
  return { session: 's1', expression: 'aiCallout1.body', file: 'src/lib/homepage/content.ts', uses: 1, box: { x: 10, y: 100, w: 200, h: 30 }, ...overrides };
}

test('the cue names the source while a bound text is edited and goes when editing ends', () => {
  const dom = mount();
  const { stacki } = dom.window;
  const root = stacki.createRoot(dom.window.document.getElementById('root'));
  stacki.act(() => root.render(stacki.React.createElement(stacki.CanvasTextSourceCue)));
  assert.equal(dom.window.document.querySelector('.canvas-source-cue') ?? undefined, undefined);
  stacki.act(() => stacki.canvasSourceCue.set(cueState({})));
  const cue = dom.window.document.querySelector('.canvas-source-cue');
  assert.ok(cue, 'the cue is drawn');
  assert.match(cue.textContent, /Editing source/);
  assert.match(cue.textContent, /src\/lib\/homepage\/content\.ts › aiCallout1\.body/);
  assert.doesNotMatch(cue.textContent, /Used in/);
  stacki.act(() => stacki.canvasSourceCue.set(undefined));
  assert.equal(dom.window.document.querySelector('.canvas-source-cue') ?? undefined, undefined);
});

test('Used in N places shows only when the data feeds more than one place', () => {
  const dom = mount();
  const { stacki } = dom.window;
  const root = stacki.createRoot(dom.window.document.getElementById('root'));
  stacki.act(() => root.render(stacki.React.createElement(stacki.CanvasTextSourceCue)));
  stacki.act(() => stacki.canvasSourceCue.set(cueState({ uses: 3 })));
  assert.match(dom.window.document.querySelector('.canvas-source-cue').textContent, /Used in 3 places/);
  stacki.act(() => stacki.canvasSourceCue.set(cueState({ uses: 1 })));
  assert.doesNotMatch(dom.window.document.querySelector('.canvas-source-cue').textContent, /Used in/);
});

test('the page own data shows the binding and says this page', () => {
  const dom = mount();
  const { stacki } = dom.window;
  const root = stacki.createRoot(dom.window.document.getElementById('root'));
  stacki.act(() => root.render(stacki.React.createElement(stacki.CanvasTextSourceCue)));
  stacki.act(() => stacki.canvasSourceCue.set(cueState({ file: '' })));
  const text = dom.window.document.querySelector('.canvas-source-cue').textContent;
  assert.match(text, /aiCallout1\.body/);
  assert.match(text, /this page/);
  assert.doesNotMatch(text, /›/);
});

test('a long path gives up its start, keeping the file name and the binding', () => {
  assert.equal(truncateStart('short', 10), 'short');
  assert.equal(truncateStart('abcdefghij', 6), '…fghij');
  assert.equal(truncateStart('abcdefghij', 10), 'abcdefghij');
  assert.throws(() => truncateStart('abc', 1), /Assertion failed/);
  const long = `src/${'deep/'.repeat(30)}content.ts`;
  const shown = sourceCuePath(long, 'aiCallout1.body');
  assert.equal(shown.length, SOURCE_CUE_CHARS_MAX);
  assert.ok(shown.startsWith('…'));
  assert.ok(shown.endsWith('content.ts › aiCallout1.body'));
});

test('the Settings panel draws no source hint: the files that render its Content field do not import one', () => {
  const fs = require('node:fs');
  for (const file of ['src/features/props/ElementFields.tsx', 'src/features/props/TextConnectField.tsx']) {
    assert.doesNotMatch(fs.readFileSync(repoPath(file), 'utf8'), /SourceHint|source-hint|canvasTextSourceCue/, file);
  }
  assert.equal(fs.existsSync(repoPath('src/features/props/SourceHint.tsx')), false);
});

const CUE_SIZE = { width: 280, height: 22 };
const VIEW = { width: 1200, height: 800 };

test('the cue sits under the element, left-aligned with it', () => {
  const box = { x: 40, y: 120, w: 320, h: 48 };
  const place = sourceCuePlace(box, CUE_SIZE, VIEW);
  assert.equal(place.left, box.x);
  assert.equal(place.top, box.y + box.h + SOURCE_CUE_GAP_PX);
  assert.ok(place.top >= box.y + box.h, 'tag.top is at or under element.bottom');
});

test('with no room below, the cue sits directly above the element: the name tag is hidden while typing', () => {
  const box = { x: 40, y: 740, w: 320, h: 48 };
  const place = sourceCuePlace(box, CUE_SIZE, VIEW);
  assert.ok(place.top + CUE_SIZE.height <= box.y, 'the cue ends above the element');
  assert.equal(place.top, box.y - SOURCE_CUE_GAP_PX - CUE_SIZE.height);
});

test('the last pixel of room below still places the cue below; one less flips it', () => {
  const fits = { x: 40, y: 100, w: 320, h: VIEW.height - SOURCE_CUE_MARGIN_PX - CUE_SIZE.height - SOURCE_CUE_GAP_PX - 100 };
  assert.equal(sourceCuePlace(fits, CUE_SIZE, VIEW).top, fits.y + fits.h + SOURCE_CUE_GAP_PX);
  const short = { ...fits, h: fits.h + 1 };
  assert.ok(sourceCuePlace(short, CUE_SIZE, VIEW).top < short.y, 'flipped above');
});

test('with room for neither, the cue is pinned to the window bottom; it never leaves the window sideways', () => {
  const tall = { x: 40, y: 10, w: 320, h: 790 };
  assert.equal(sourceCuePlace(tall, CUE_SIZE, VIEW).top, VIEW.height - SOURCE_CUE_MARGIN_PX - CUE_SIZE.height);
  const right = sourceCuePlace({ x: 1150, y: 100, w: 40, h: 20 }, CUE_SIZE, VIEW);
  assert.equal(right.left, VIEW.width - CUE_SIZE.width - SOURCE_CUE_MARGIN_PX);
  const left = sourceCuePlace({ x: -30, y: 100, w: 40, h: 20 }, CUE_SIZE, VIEW);
  assert.equal(left.left, SOURCE_CUE_MARGIN_PX);
  assert.throws(() => sourceCuePlace(tall, { width: 280, height: -1 }, VIEW), /Assertion failed: sourceCuePlace: the cue has a height/);
});
