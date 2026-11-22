// Goal: the composer's screenshots keep their promises. Every attachment (pasted, dropped or picked images,
// project files, screenshots) enters a draft through one append that holds the count bound and the total
// image bound whichever way it arrived; screenshot numbers never repeat after a removal; the one-line note
// says the kind and, for a region of the canvas, the breakpoint, and nothing else; the only capture is a
// dragged region (no element or whole-canvas mode): over the canvas it is a region and elsewhere a panel; a capture asks main for the shown rect, hides the
// canvas marks only for its frame, and keeps the bytes in memory (a data URL on the draft, nothing in
// browser storage); a failed or impossible capture is a message, a cancelled one is nothing; the chips
// enlarge in a lightbox and remove; the region selector cancels on Escape and takes a drag.
// Method: bundle the real modules with esbuild, run them in jsdom against a fake preload (window.avb) and a
// fake screenshot source, and drive the region selector with pointer events. No window is opened.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/screenshot.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { appendAttachments, nextScreenshotNumber, DRAFT_IMAGE_CHARS_MAX } from './src/features/ai/screenshot/draftAttachments';",
      "export { screenshotNote } from './src/features/ai/screenshot/screenshotNote';",
      "export { takeScreenshot, regionFacts, clampToWindow } from './src/features/ai/screenshot/takeScreenshot';",
      "export { AttachmentChips } from './src/features/ai/screenshot/AttachmentChips';",
      "export { RegionSelector } from './src/features/ai/screenshot/RegionSelector';",
      "export { setScreenshotSource } from './src/lib/screenshotSource';",
      "export { AI_LIMITS } from './shared/properties/ai/aiLimits';",
      "export { SCREENSHOT_NOTE_CHARS_MAX } from './shared/ipc/aiChat';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'localStorage',
  'DOMRect',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.innerWidth = 1200;
global.innerHeight = 800;
dom.window.HTMLElement.prototype.setPointerCapture = function () {};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const shot = require(output);
const translate = shot.ENGLISH_TRANSLATE;

const image = (id, chars, number) => ({
  id,
  preview: `data:image/png;base64,${'A'.repeat(4)}`,
  ...(number === undefined ? {} : { screenshotNumber: number }),
  attachment: { kind: 'image', name: id, mimeType: 'image/png', data: 'A'.repeat(chars) },
});
const file = (id) => ({ id, preview: undefined, attachment: { kind: 'file', path: `src/${id}.astro` } });

test('pasted images, files and screenshots share one append: the count bound holds across origins', () => {
  const pasted = image('pasted', 10, undefined);
  const screenshots = Array.from({ length: shot.AI_LIMITS.attachmentsMax }, (_, index) => image(`shot${index}`, 10, index + 1));
  const outcome = shot.appendAttachments([pasted, file('a')], screenshots);
  assert.equal(outcome.kind, 'limited');
  assert.equal(outcome.reason, 'count');
  assert.equal(outcome.attachments.length, shot.AI_LIMITS.attachmentsMax, 'filled to the bound, in order');
  assert.deepEqual(
    outcome.attachments.slice(0, 3).map((entry) => entry.id),
    ['pasted', 'a', 'shot0'],
  );
  const fits = shot.appendAttachments([], [pasted, file('b')]);
  assert.deepEqual(fits.kind, 'appended');
  assert.equal(fits.attachments.length, 2);
});

test('the total image bound refuses the image that would pass it, and files cost nothing', () => {
  const half = Math.floor(shot.DRAFT_IMAGE_CHARS_MAX / 2);
  const outcome = shot.appendAttachments([image('one', half, 1)], [image('two', half, 2), image('three', 1, 3)]);
  assert.equal(outcome.kind, 'limited');
  assert.equal(outcome.reason, 'size');
  assert.deepEqual(
    outcome.attachments.map((entry) => entry.id),
    ['one', 'two'],
  );
  const files = shot.appendAttachments(outcome.attachments, []);
  assert.equal(files.kind, 'appended');
  assert.throws(() => shot.appendAttachments([image('huge', shot.DRAFT_IMAGE_CHARS_MAX + 1, 1)], []), /already within the size bound/);
});

test('screenshot numbers continue past the highest, so a removal never repeats one', () => {
  assert.equal(shot.nextScreenshotNumber([]), 1);
  assert.equal(shot.nextScreenshotNumber([image('a', 1, 1), image('b', 1, 2)]), 3);
  assert.equal(shot.nextScreenshotNumber([image('b', 1, 2)]), 3, 'Screenshot 1 removed: the next is still 3');
  assert.equal(shot.nextScreenshotNumber([image('pasted', 1, undefined)]), 1, 'a pasted image has no number');
});

test('the note is one short line: the kind, and for a region its breakpoint', () => {
  assert.equal(shot.screenshotNote({ kind: 'region', number: 3, breakpointPx: 768 }), 'Screenshot 3: region, 768px breakpoint');
  assert.equal(shot.screenshotNote({ kind: 'panel', number: 5 }), 'Screenshot 5: panel');
  assert.ok(shot.screenshotNote({ kind: 'region', number: 8, breakpointPx: 16384 }).length <= shot.SCREENSHOT_NOTE_CHARS_MAX, 'within the wire bound');
  assert.throws(() => shot.screenshotNote({ kind: 'panel', number: 0 }), /count from one/);
});

test('a region over the canvas is a canvas region; anywhere else, or with no canvas, a panel', () => {
  const canvas = { rect: { x: 300, y: 50, width: 800, height: 700 }, breakpointPx: 1280 };
  assert.deepEqual(shot.regionFacts({ x: 400, y: 100, width: 100, height: 100 }, canvas, 2), { kind: 'region', number: 2, breakpointPx: 1280 });
  assert.deepEqual(shot.regionFacts({ x: 0, y: 100, width: 200, height: 100 }, canvas, 2), { kind: 'panel', number: 2 });
  assert.deepEqual(shot.regionFacts({ x: 400, y: 100, width: 100, height: 100 }, undefined, 1), { kind: 'panel', number: 1 });
});

test('a rect is cut to the window and rounded outwards; one wholly outside is nothing', () => {
  const view = { width: 1000, height: 600 };
  assert.deepEqual(shot.clampToWindow({ x: 10.4, y: 20.6, width: 99.2, height: 50.1 }, view), { x: 10, y: 20, width: 100, height: 51 });
  assert.deepEqual(shot.clampToWindow({ x: -50, y: 500, width: 100, height: 300 }, view), { x: 0, y: 500, width: 50, height: 100 });
  assert.equal(shot.clampToWindow({ x: 1200, y: 0, width: 100, height: 100 }, view), undefined);
  assert.equal(shot.clampToWindow({ x: -5, y: 0, width: 4, height: 100 }, view), undefined, 'left of the window');
});

function fakeSource() {
  const calls = { hidden: 0, restored: 0 };
  const uninstall = shot.setScreenshotSource({
    canvas: () => ({ rect: { x: 300, y: 0, width: 800, height: 700 }, breakpointPx: 1280 }),
    hideMarks: () => {
      calls.hidden += 1;
      return () => {
        calls.restored += 1;
      };
    },
  });
  return { calls, uninstall };
}

test('a region capture asks main for its rect, hides the marks for that frame only, and keeps the bytes in memory', async () => {
  const { calls, uninstall } = fakeSource();
  const asked = [];
  window.avb = {
    aiScreenshot: async (payload) => {
      asked.push(payload);
      assert.equal(calls.hidden, 1, 'the marks are hidden while main photographs');
      assert.equal(calls.restored, 0);
      return { ok: true, value: { mimeType: 'image/png', data: 'iVBORw0KGgo=', width: 400, height: 200 } };
    },
  };
  const before = JSON.stringify({ ...localStorage });
  const outcome = await shot.takeScreenshot(
    { projectPath: '/site', number: 2, pickRegion: async () => ({ x: 320.5, y: 10, width: 200, height: 100 }) },
    translate,
  );
  uninstall();
  assert.equal(outcome.kind, 'captured');
  assert.deepEqual(asked, [{ projectPath: '/site', rect: { x: 320, y: 10, width: 201, height: 100 } }]);
  assert.equal(calls.restored, 1, 'and shown again afterwards');
  const { attachment } = outcome;
  assert.equal(attachment.screenshotNumber, 2);
  assert.equal(attachment.preview, 'data:image/png;base64,iVBORw0KGgo=');
  assert.deepEqual(attachment.attachment, {
    kind: 'image',
    name: 'Screenshot 2 (400×200)',
    mimeType: 'image/png',
    data: 'iVBORw0KGgo=',
    note: 'Screenshot 2: region, 1280px breakpoint',
  });
  assert.equal(JSON.stringify({ ...localStorage }), before, 'nothing went to browser storage');
});

test('failed, off-window and cancelled captures: a message, a message, and nothing', async () => {
  const { calls, uninstall } = fakeSource();
  window.avb = {
    aiScreenshot: async () => ({ ok: false, error: { code: 'invalid', message: 'Could not take the screenshot. Try again.' } }),
  };
  const failed = await shot.takeScreenshot({ projectPath: '/site', number: 1, pickRegion: async () => ({ x: 10, y: 10, width: 50, height: 50 }) }, translate);
  assert.deepEqual(failed, { kind: 'failed', message: 'Could not take the screenshot. Try again.' });
  assert.equal(calls.restored, calls.hidden, 'a failed capture still shows the marks again');
  const outside = await shot.takeScreenshot(
    { projectPath: '/site', number: 1, pickRegion: async () => ({ x: 5000, y: 10, width: 50, height: 50 }) },
    translate,
  );
  assert.deepEqual(outside, { kind: 'failed', message: 'Could not take the screenshot. Try again.' });
  const cancelled = await shot.takeScreenshot({ projectPath: '/site', number: 1, pickRegion: async () => undefined }, translate);
  assert.deepEqual(cancelled, { kind: 'cancelled' });
  uninstall();
});

test('a dragged region over a panel is a panel screenshot with no breakpoint', async () => {
  const { uninstall } = fakeSource();
  window.avb = { aiScreenshot: async () => ({ ok: true, value: { mimeType: 'image/jpeg', data: '/9j/', width: 10, height: 10 } }) };
  const outcome = await shot.takeScreenshot(
    { projectPath: '/site', number: 3, pickRegion: async () => ({ x: 10, y: 10, width: 100, height: 100 }) },
    translate,
  );
  uninstall();
  assert.equal(outcome.kind, 'captured');
  assert.equal(outcome.attachment.attachment.note, 'Screenshot 3: panel');
  assert.equal(outcome.attachment.attachment.mimeType, 'image/jpeg');
});

async function mount(element) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(element));
  return { container, root };
}

test('chips enlarge an image in the lightbox and remove an attachment', async () => {
  const removed = [];
  const attachments = [image('Screenshot 1 (4×4)', 4, 1), file('index')];
  const { container, root } = await mount(React.createElement(shot.AttachmentChips, { attachments, onRemove: (id) => removed.push(id) }));
  const open = container.querySelector('.ai-attachment-open');
  assert.ok(open !== null, 'an image chip opens');
  assert.equal(open.getAttribute('aria-label'), 'Enlarge Screenshot 1 (4×4)');
  assert.equal(container.querySelectorAll('.ai-attachment-open').length, 1, 'a file chip does not');
  await act(async () => open.click());
  const lightbox = document.querySelector('.ai-lightbox-image');
  assert.ok(lightbox !== null, 'the lightbox shows the image');
  assert.equal(lightbox.getAttribute('src'), attachments[0].preview);
  const removes = container.querySelectorAll('button[aria-label="Remove attachment"]');
  assert.equal(removes.length, 2);
  await act(async () => removes[1].click());
  assert.deepEqual(removed, ['index']);
  await act(async () => root.unmount());
});

test('the region selector cancels on Escape and takes a drag; a click is not a region', async () => {
  const picks = [];
  const { root } = await mount(React.createElement(shot.RegionSelector, { onDone: (region) => picks.push(region) }));
  const layer = document.querySelector('.ai-region-layer');
  assert.ok(layer !== null);
  assert.equal(layer.getAttribute('aria-label'), 'Screenshot region');
  const pointer = (type, x, y) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return act(async () => layer.dispatchEvent(event));
  };
  await pointer('pointerdown', 10, 10);
  await pointer('pointerup', 11, 11);
  assert.deepEqual(picks, [], 'a click picks nothing');
  await pointer('pointerdown', 200, 150);
  await pointer('pointermove', 50, 40);
  assert.ok(document.querySelector('.ai-region-box') !== null, 'the region is drawn while dragging');
  await pointer('pointerup', 50, 40);
  assert.deepEqual(picks, [{ x: 50, y: 40, width: 150, height: 110 }]);
  await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' })));
  assert.deepEqual(picks.at(-1), undefined);
  assert.equal(picks.length, 2, 'Escape answers no region');
  await act(async () => root.unmount());
});
