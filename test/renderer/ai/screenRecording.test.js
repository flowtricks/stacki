// Goal: the recording's renderer side keeps its promises. The frame selection toggles, extends a range from
// the last frame toggled (either direction), picks every Nth frame, and never holds more than the draft's free
// attachment slots; a chosen frame becomes an ordinary image attachment named "Recording frame 3 (t=1.2s)"
// whose one-line note says when in the recording it was taken; the recording bar sits outside the region.
// The "Pick frames" sheet shows every frame at once while scrubbing (its thumbnail, then the full frame) in one
// frame of constant size, steps with the arrow keys (mirrored in right to left), scrubs on a plain click,
// extends on a shift-click, counts against the cap, keeps its labels on one line and adds the chosen frames in
// order. At rest the row is Send and the microphone; hovering or focusing the microphone grows a bar upward to
// reveal Screenshot and Record above it, with one sliding pill, without moving anything; Record starts the same region drag (nothing records until the drag is
// released) and stays red in every state while it records.
// Method: bundle the real modules with esbuild and run them in jsdom against a fake preload (window.avb) that
// answers `ai:record` frame requests. No window is opened and nothing is recorded.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/screenRecording.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { toggleFrame, extendTo, everyNth, EMPTY_SELECTION } from './src/features/ai/screenshot/frameSelection';",
      "export { screenshotNote, secondsText } from './src/features/ai/screenshot/screenshotNote';",
      "export { frameAttachment } from './src/features/ai/screenshot/useScreenshotCapture';",
      "export { barPlace } from './src/features/ai/screenshot/RecordingBar';",
      "export { FramePicker, frameAt, positionPercent, tileWidthFor, timelineTiles } from './src/features/ai/screenshot/FramePicker';",
      "export { ScreenshotButton } from './src/features/ai/screenshot/ScreenshotButton';",
      "export { useScreenshotCapture } from './src/features/ai/screenshot/useScreenshotCapture';",
      "export { AI_LIMITS } from './shared/properties/ai/aiLimits';",
      "export { appendAttachments } from './src/features/ai/screenshot/draftAttachments';",
      "export { lightboxSize } from './src/ui/ImageViewer';",
      "export { fitContain } from './src/ui/fitContain';",
      "export { aiState, resetAiStore } from './src/features/ai/aiStore';",
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
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.innerHeight = 800;
global.innerWidth = 1200;
// Thumbnails and frames fall back to data URLs where there are no object URLs, so the tests can read which frame shows.
URL.createObjectURL = undefined;
// The jsdom window has no pointer capture; the selector and the strip call it on press.
dom.window.HTMLElement.prototype.setPointerCapture = function () {};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const rec = require(output);
// Wait on what can be seen, never a fixed pause: each poll first lets React apply what has arrived, then reads.
const until = (what, read, holds = (value) => value) =>
  waitFor({
    what,
    read: async () => {
      await act(async () => undefined);
      return read();
    },
    until: holds,
    pollIntervalMs: 5,
    pollCountMax: 600,
  });
const translate = rec.ENGLISH_TRANSLATE;
const english = { formatNumber: (value, options) => new Intl.NumberFormat('en', options).format(value) };

test('a click toggles a frame, and the choice never passes the cap', () => {
  let change = rec.toggleFrame(rec.EMPTY_SELECTION, 4, 2);
  assert.deepEqual(change.selection.chosen, [4]);
  change = rec.toggleFrame(change.selection, 1, 2);
  assert.deepEqual(change.selection.chosen, [1, 4], 'kept in frame order');
  const full = rec.toggleFrame(change.selection, 7, 2);
  assert.equal(full.capped, true);
  assert.deepEqual(full.selection.chosen, [1, 4], 'at the cap nothing is added');
  const off = rec.toggleFrame(change.selection, 4, 2);
  assert.deepEqual(off.selection.chosen, [1]);
  assert.equal(rec.toggleFrame(rec.EMPTY_SELECTION, 0, 0).capped, true, 'a full draft takes no frame');
  assert.throws(() => rec.toggleFrame(rec.EMPTY_SELECTION, -1, 8), /index from zero/);
});

test('a shift-click adds the range from the last frame toggled, either direction, up to the cap', () => {
  const anchored = rec.toggleFrame(rec.EMPTY_SELECTION, 5, 8).selection;
  assert.deepEqual(rec.extendTo(anchored, 8, 8).selection.chosen, [5, 6, 7, 8]);
  assert.deepEqual(rec.extendTo(anchored, 2, 8).selection.chosen, [2, 3, 4, 5]);
  const capped = rec.extendTo(anchored, 20, 4);
  assert.equal(capped.capped, true);
  assert.deepEqual(capped.selection.chosen, [5, 6, 7, 8], 'the frames nearest the anchor fit first');
  assert.deepEqual(rec.extendTo(rec.EMPTY_SELECTION, 3, 8).selection.chosen, [3], 'without an anchor it is a toggle');
});

test('pick evenly takes every Nth frame from the first, as far as the cap', () => {
  assert.deepEqual(rec.everyNth(10, 3, 8).selection.chosen, [0, 3, 6, 9]);
  const capped = rec.everyNth(60, 2, 8);
  assert.equal(capped.capped, true);
  assert.equal(capped.selection.chosen.length, 8);
  assert.deepEqual(rec.everyNth(0, 5, 8).selection.chosen, []);
  assert.throws(() => rec.everyNth(10, 0, 8), /step of at least one/);
});

test('an empty draft lets the chooser pick exactly 16 frames (twice the old 8): the 16th passes, the 17th is capped', () => {
  const cap = rec.AI_LIMITS.attachmentsMax;
  assert.equal(cap, 16);
  let selection = rec.EMPTY_SELECTION;
  for (let index = 0; index < cap; index += 1) {
    const change = rec.toggleFrame(selection, index * 3, cap);
    assert.equal(change.capped, false, `frame ${index + 1} of ${cap} fits`);
    selection = change.selection;
  }
  assert.equal(selection.chosen.length, cap);
  const over = rec.toggleFrame(selection, 200, cap);
  assert.equal(over.capped, true, 'one over the cap says so, which the sheet reports as a toast');
  assert.equal(over.selection.chosen.length, cap);
  const evenly = rec.everyNth(240, 1, cap);
  assert.equal(evenly.selection.chosen.length, cap, 'pick evenly never passes the cap either');
  assert.equal(evenly.capped, true);
});

test("a recording frame's note says when it was taken, then the region or panel as a screenshot does", () => {
  assert.equal(
    rec.screenshotNote({ kind: 'region', number: 4, breakpointPx: 1280 }, { atMs: 1200 }),
    'Screenshot 4: recording frame at 1.2s, region, 1280px breakpoint',
  );
  assert.equal(rec.screenshotNote({ kind: 'panel', number: 5 }, { atMs: 400 }), 'Screenshot 5: recording frame at 0.4s, panel');
  assert.equal(rec.screenshotNote({ kind: 'panel', number: 1 }), 'Screenshot 1: panel', 'a photograph is unchanged');
  assert.equal(rec.secondsText(0), '0.0');
  assert.equal(rec.secondsText(14_960), '15.0');
});

test('a chosen frame is an ordinary image attachment with its name and note, through the same append', () => {
  const attachment = rec.frameAttachment(
    {
      frame: { index: 2, atMs: 1200, width: 800, height: 600, thumb: 'AAAA' },
      image: { mimeType: 'image/jpeg', data: '/9j/' },
      facts: { kind: 'region', number: 3, breakpointPx: 768 },
    },
    translate,
    english,
  );
  assert.equal(attachment.attachment.name, 'Recording frame 3 (t=1.2s)');
  assert.equal(attachment.attachment.note, 'Screenshot 3: recording frame at 1.2s, region, 768px breakpoint');
  assert.equal(attachment.screenshotNumber, 3);
  assert.equal(attachment.preview, 'data:image/jpeg;base64,/9j/');
  const appended = rec.appendAttachments([], [attachment]);
  assert.equal(appended.kind, 'appended');
});

test('the recording bar sits below the region, else above it, else at the top', () => {
  assert.deepEqual(rec.barPlace({ x: 100, y: 100, width: 200, height: 100 }, { height: 800 }), { top: 208, left: 200 });
  assert.deepEqual(rec.barPlace({ x: 0, y: 600, width: 100, height: 190 }, { height: 800 }), { top: 560, left: 50 });
  assert.deepEqual(rec.barPlace({ x: 0, y: 0, width: 100, height: 800 }, { height: 800 }), { top: 8, left: 50 });
});

const thumbs = Array.from({ length: 6 }, (_, index) => ({ index, atMs: index * 200, width: 800, height: 600, thumb: `AAA${String.fromCharCode(65 + index)}` }));

async function mountPicker(props) {
  const asked = [];
  window.avb = {
    aiRecord: async (payload) => {
      asked.push(payload.action);
      return { ok: true, value: { kind: 'frame', image: { mimeType: 'image/jpeg', data: `/9j/${payload.action.index}`, width: 800, height: 600 } } };
    },
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(rec.FramePicker, { projectPath: '/site', id: `r${'a'.repeat(16)}`, frames: thumbs, fps: 5, onGone: () => undefined, ...props }),
    ),
  );
  const sheet = document.querySelector('.ai-frame-sheet');
  const key = (name, extra = {}) => act(async () => sheet.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: name, bubbles: true, ...extra })));
  return { root, asked, sheet, key };
}

const stage = () => document.querySelector('.ai-frame-stage');
const shown = () => document.querySelector('.ai-frame-preview').getAttribute('src');
const button = (text) => [...document.querySelectorAll('.ai-frame-sheet button')].find((candidate) => candidate.textContent.trim() === text);

test('scrubbing shows each frame at once, in one frame of constant size, and the full frame once it rests', async () => {
  const { root, key, asked } = await mountPicker({ cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
  const preview = () => document.querySelector('.ai-frame-preview');
  const aspect = `${preview().style.width} × ${preview().style.height}`;
  assert.equal(aspect, '480px × 360px', "the preview's box is the recording's own aspect, fitted whole in the stage");
  await until('the full frame once the playhead rests', shown, (source) => source === 'data:image/jpeg;base64,/9j/0');
  await key('ArrowRight');
  assert.equal(stage().dataset.frame, '1', 'the step moves the displayed frame');
  assert.ok(['data:image/jpeg;base64,AAAB', 'data:image/jpeg;base64,/9j/1'].includes(shown()), 'at once: its thumbnail, or its prefetched full frame');
  await key('ArrowRight');
  await key('ArrowRight');
  assert.equal(stage().dataset.frame, '3');
  assert.match(shown(), /^data:image\/jpeg;base64,(\/9j\/\d|AAAD)$/, 'never blank: its own full frame, a sharp neighbour or its thumbnail');
  await until('its own full frame, sharp, once it rests', shown, (source) => source === 'data:image/jpeg;base64,/9j/3');
  assert.equal(`${preview().style.width} × ${preview().style.height}`, aspect, 'the frame never changes size');
  assert.ok(
    asked.some((action) => action.kind === 'frame' && action.index === 4),
    'the next frame is prefetched',
  );
  const css = fs.readFileSync(repoPath('src/features/ai/screenshot/screenshot.css'), 'utf8');
  assert.match(css, /\.ai-frame-preview \{[^}]*object-fit: contain/, 'the whole frame shows, letterboxed, never cropped');
  await act(async () => root.unmount());
});

test('labels stay on one line, the timeline never scrolls, and nothing in the sheet has a border', () => {
  const css = fs.readFileSync(repoPath('src/features/ai/screenshot/screenshot.css'), 'utf8');
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} has a rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  for (const selector of [
    '.ai-frame-time',
    '.ai-frame-sheet button.ai-frame-use',
    '.ai-frame-evenly',
    '.ai-frame-count',
    '.ai-frame-actions button',
    '.ai-frame-scale-tick',
  ]) {
    assert.match(rule(selector), /white-space: nowrap/, `${selector} never wraps`);
  }
  assert.match(rule('.ai-frame-time'), /tabular-nums/);
  const strip = rule('.ai-frame-strip');
  assert.match(strip, /overflow: hidden/, 'the whole recording fits: no scrolling');
  assert.ok(!/overflow-x: auto/.test(strip));
  assert.match(rule('.ai-frame-playhead'), /transform: translateX/, 'the playhead moves by transform');
  assert.match(rule('.ai-frame-tile'), /object-fit: contain/, 'tiles are never cropped');
  const frameRules = css.slice(css.indexOf('.modal.ai-frame-picker {'));
  assert.ok(!/\bborder:/.test(frameRules), 'backgrounds, not borders');
  const viewer = fs.readFileSync(repoPath('src/ui/imageViewer.css'), 'utf8');
  assert.match(viewer, /\.modal\.ai-lightbox \{[^}]*width: auto/, "the lightbox is its image's size, not the dialog's fixed width");
});

test('the microphone holds the capture bar: at rest the mic alone, hover or focus grows it up to Screenshot and Record', async () => {
  const starts = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let dictations = 0;
  const mic = React.createElement('button', { type: 'button', 'aria-label': 'Dictate', onClick: () => (dictations += 1) });
  const render = (active) =>
    act(async () =>
      root.render(
        React.createElement(rec.ScreenshotButton, { disabled: false, busy: active !== undefined, active, onCapture: (kind) => starts.push(kind) }, mic),
      ),
    );
  await render(undefined);
  const track = container.querySelector('.ai-capture-bar > .ai-capture-track');
  assert.ok(track !== null, 'one bar');
  assert.equal(track.querySelectorAll('.ai-capture-thumb').length, 1, 'one pill');
  const buttons = [...track.querySelectorAll('button')];
  assert.deepEqual(
    buttons.map((entry) => entry.getAttribute('aria-label')),
    ['Dictate', 'Screenshot', 'Record instead'],
    'the microphone first, then Screenshot and Record above it, in the tab order',
  );
  assert.equal(buttons[0].closest('[data-segment]').dataset.segment, 'mic', 'the microphone is the bottom segment, unchanged');
  assert.equal(
    buttons[1].getAttribute('aria-keyshortcuts'),
    navigator.platform.includes('Mac') ? 'Meta+Shift+S' : 'Control+Shift+S',
    'Screenshot keeps its shortcut',
  );
  await act(async () => buttons[0].click());
  assert.equal(dictations, 1, "the microphone's click is its own");
  await act(async () => buttons[1].click());
  await act(async () => buttons[2].click());
  assert.deepEqual(starts, ['photo', 'record'], 'each segment is its own one-click capture');
  await act(async () => buttons[0].focus());
  assert.ok(track.querySelector('.ai-capture-thumb').classList.contains('is-on-mic'), 'focusing the microphone opens the bar, the pill on it');
  await act(async () => track.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  assert.equal(document.activeElement, buttons[1], 'up reaches Screenshot');
  await act(async () => track.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })));
  assert.equal(document.activeElement, buttons[2], 'and Record');
  assert.ok(track.querySelector('.ai-capture-thumb').classList.contains('is-on-record'), 'the pill follows focus');
  await act(async () => track.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(document.activeElement, buttons[1]);
  await render('record');
  const record = track.querySelector('.ai-capture-mode');
  assert.ok(record.classList.contains('is-on'), 'Record is red while it records');
  assert.equal(record.disabled, false, 'never disabled while it records: disabled would turn it grey');
  assert.ok(container.querySelector('.ai-capture-bar').classList.contains('is-recording-mode'), 'and the bar stays open');
  await act(async () => root.unmount());
  const css = fs.readFileSync(repoPath('src/features/ai/screenshot/screenshot.css'), 'utf8');
  // A rule that starts its own line, so a selector that also ends a longer list is found as itself.
  const rule = (selector) => {
    const at = css.indexOf(`\n${selector} {`);
    assert.ok(at >= 0, `${selector} has a rule`);
    return css.slice(at, css.indexOf('}', at));
  };
  const closed = rule('.ai-capture-track');
  assert.match(closed, /position: absolute/, 'it overlays, so nothing in the composer moves');
  assert.match(closed, /bottom: 0/, "anchored at the microphone's bottom, so the microphone never moves");
  assert.match(closed, /height: 26px/, 'closed, it is the microphone alone');
  assert.match(closed, /background: transparent/, 'closed, no bar and no fill');
  assert.match(closed, /height 160ms ease-out 180ms/, 'it closes after the hover-intent delay');
  const open = rule('.ai-capture-bar:is(:hover, :focus-within, .is-recording-mode) .ai-capture-track');
  assert.match(open, /height: 82px/, 'open, it grows upward to three segments');
  assert.match(open, /color-mix\(in srgb, var\(--bg-panel-2\), var\(--text\) 14%\)/, 'a token-based step above the composer fill');
  assert.match(rule('.ai-capture-track .ai-capture-segment'), /visibility: hidden/, 'closed, Screenshot and Record are hidden and not tabbable');
  assert.match(rule('.ai-capture-thumb.is-on-photo'), /translateY\(-28px\)/);
  assert.match(rule('.ai-capture-thumb.is-on-record'), /translateY\(-56px\)/, 'the pill slides up');
  const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('.ai-capture-thumb'), 'reduced motion stops the slide');
  assert.match(reduced.slice(0, reduced.indexOf('}\n}')), /transition: none/);
  const red = css.indexOf('.ai-capture-track button.ai-capture-mode.is-on:is(:hover, :focus-visible, :active):not(:disabled)');
  assert.ok(red >= 0, 'Record keeps its red on hover, focus and press');
  assert.match(css.slice(red, css.indexOf('}', red)), /color: var\(--red\)/);
});

test('Send sits left of the microphone: a plain return-arrow icon button, drawn only when there is something to send', () => {
  const composer = fs.readFileSync(repoPath('src/features/ai/composer/ChatComposer.tsx'), 'utf8');
  const sendAt = composer.indexOf('className="ai-send"');
  const barAt = composer.indexOf('<ScreenshotButton');
  assert.ok(sendAt > 0 && barAt > sendAt, 'Send comes before the microphone and its bar');
  assert.match(composer.slice(composer.lastIndexOf('{', sendAt), sendAt), /!running && hasContent && \(/, 'not rendered at all when the box is empty');
  assert.match(composer.slice(sendAt, barAt), /<ReturnGlyph size=\{14\} \/>/, 'the return arrow');
  assert.match(composer, /const ReturnGlyph = centralIcon\(centralReturn\)/);
  assert.match(composer, /arrowCornerDownLeft as centralReturn/, "Central's arrow-corner-down-left");
  const css = fs.readFileSync(repoPath('src/features/ai/composer/composer.css'), 'utf8');
  const send = css.slice(css.indexOf('\n.ai-send {'), css.indexOf('}', css.indexOf('\n.ai-send {')));
  assert.match(send, /background: transparent/, 'no blue background');
  assert.ok(!/--accent/.test(send), 'no accent colour');
  assert.match(send, /width: 26px/, "the microphone's size");
  assert.match(css, /animation: ai-send-in 140ms ease-out/, 'it fades and slides in');
  assert.match(css, /\.ai-stop-square \{[^}]*background: #fff/, 'Stop is a plain white square');
});

test('Record opens the region selector first, and nothing records until the drag is released', async () => {
  const calls = [];
  window.avb = {
    aiRecord: async (payload) => {
      calls.push(payload.action.kind);
      return payload.action.kind === 'start' ? { ok: true, value: { kind: 'started', id: `r${'b'.repeat(16)}` } } : { ok: true, value: { kind: 'discarded' } };
    },
  };
  let capture;
  function Host() {
    capture = rec.useScreenshotCapture({
      projectPath: '/site',
      enabled: true,
      nextNumber: () => 1,
      slotsLeft: () => 8,
      onCaptured: () => undefined,
      onProblem: () => undefined,
    });
    return capture.overlay ?? React.createElement('span');
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Host)));
  await act(async () => capture.start('record'));
  const layer = document.querySelector('.ai-region-layer');
  assert.ok(layer !== null, 'the region selector is open');
  assert.equal(capture.active, 'record');
  assert.deepEqual(calls, [], 'nothing records while the region is being chosen');
  const pointer = (type, x, y) => {
    const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    return act(async () => layer.dispatchEvent(event));
  };
  await pointer('pointerdown', 20, 20);
  await pointer('pointermove', 220, 120);
  assert.equal(document.querySelector('.ai-region-size').textContent, '200 × 100', 'the size shows while dragging');
  assert.deepEqual(calls, [], 'still nothing before release');
  await pointer('pointerup', 220, 120);
  await until('the recording to start', () => calls.includes('start'));
  assert.deepEqual(calls.slice(0, 1), ['start'], 'the release starts the recording of that region');
  assert.ok(document.querySelector('.ai-record-bar') !== null, 'and the recording bar shows');
  await act(async () => root.unmount());
});

test('the preview shows the whole frame: its own aspect fitted inside the stage, for tall, square and wide regions', async () => {
  const stageBox = { width: 640, height: 360 };
  for (const [name, frame] of Object.entries({ tall: { width: 360, height: 1200 }, square: { width: 500, height: 500 }, wide: { width: 1600, height: 400 } })) {
    const fitted = rec.fitContain(frame, stageBox);
    assert.ok(fitted.width <= stageBox.width && fitted.height <= stageBox.height, `${name}: inside the stage`);
    assert.ok(Math.abs(fitted.width / fitted.height - frame.width / frame.height) < 0.02, `${name}: the frame's own aspect`);
    assert.ok(Math.max(fitted.width / stageBox.width, fitted.height / stageBox.height) > 0.99, `${name}: as large as fits`);
  }
  assert.deepEqual(
    rec.fitContain({ width: 360, height: 1200 }, stageBox),
    { width: 108, height: 360 },
    'a phone column is letterboxed left and right, not cropped',
  );
  assert.equal(rec.tileWidthFor({ width: 360, height: 1200 }), 14, 'a tall tile keeps its aspect too, within reason');
  // The stage is measured from the DOM; jsdom lays nothing out, so it is given a width here.
  const width = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientWidth');
  const height = Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientHeight');
  Object.defineProperty(dom.window.Element.prototype, 'clientWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(dom.window.Element.prototype, 'clientHeight', { configurable: true, get: () => 360 });
  try {
    const tall = Array.from({ length: 3 }, (_, index) => ({ index, atMs: index * 66, width: 360, height: 1200, thumb: 'AAAA' }));
    const { root, key } = await mountPicker({ frames: tall, cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
    const image = () => document.querySelector('.ai-frame-preview');
    const box = () => [parseFloat(image().style.width), parseFloat(image().style.height)];
    assert.deepEqual(box(), [108, 360], "the preview's box is the tall frame's own aspect, inside the stage");
    await key('ArrowRight');
    assert.deepEqual(box(), [108, 360], 'the same box for every frame');
    await act(async () => root.unmount());
  } finally {
    Object.defineProperty(dom.window.Element.prototype, 'clientWidth', width);
    Object.defineProperty(dom.window.Element.prototype, 'clientHeight', height);
  }
  const css = fs.readFileSync(repoPath('src/features/ai/screenshot/screenshot.css'), 'utf8');
  const picker = css.slice(css.indexOf('.modal.ai-frame-picker {'));
  assert.ok(!/object-fit: cover/.test(picker), 'nothing in the sheet crops: never cover');
  assert.match(picker, /\.ai-frame-preview \{[^}]*object-fit: contain/);
  assert.match(picker, /\.ai-frame-tile \{[^}]*object-fit: contain/);
  assert.ok(!/\.ai-frame-preview \{[^}]*transform/.test(picker), 'no scaling transform on the preview');
});

// The timeline's box for the tests: jsdom lays nothing out, so the strip is given a width here.
function stubLayout({ width, height }) {
  const saved = {
    clientWidth: Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientWidth'),
    clientHeight: Object.getOwnPropertyDescriptor(dom.window.Element.prototype, 'clientHeight'),
    rect: dom.window.Element.prototype.getBoundingClientRect,
  };
  Object.defineProperty(dom.window.Element.prototype, 'clientWidth', { configurable: true, get: () => width });
  Object.defineProperty(dom.window.Element.prototype, 'clientHeight', { configurable: true, get: () => height });
  dom.window.Element.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height, x: 0, y: 0 });
  return () => {
    Object.defineProperty(dom.window.Element.prototype, 'clientWidth', saved.clientWidth);
    Object.defineProperty(dom.window.Element.prototype, 'clientHeight', saved.clientHeight);
    dom.window.Element.prototype.getBoundingClientRect = saved.rect;
  };
}

const pointerAt = (target, type, x, extra = {}) => {
  const event = new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10, button: 0, buttons: 1, ...extra });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  target.dispatchEvent(event);
};

test('the timeline holds the whole recording: evenly sampled tiles, every frame addressable across the width, no scroll', async () => {
  assert.deepEqual(rec.timelineTiles(240, 5), [0, 60, 120, 179, 239], 'first and last included, evenly between');
  assert.deepEqual(rec.timelineTiles(3, 10), [0, 1, 2], 'never more tiles than frames');
  assert.equal(rec.frameAt(0, 600, 240), 0);
  assert.equal(rec.frameAt(599.9, 600, 240), 239, 'the far end is the last frame');
  assert.equal(rec.frameAt(300, 600, 240), 120);
  const reached = new Set(Array.from({ length: 600 }, (_, x) => rec.frameAt(x + 0.5, 600, 240)));
  assert.equal(reached.size, 240, 'every one of the 240 frames is under some point of the width');
  assert.equal(rec.positionPercent(0, 4), 12.5);
  assert.equal(rec.tileWidthFor({ width: 360, height: 1200 }), 14, 'a tall tile keeps its aspect, within reason');
  const restore = stubLayout({ width: 600, height: 360 });
  try {
    const many = Array.from({ length: 240 }, (_, index) => ({ index, atMs: index * 66, width: 800, height: 600, thumb: 'AAAA' }));
    const { root } = await mountPicker({ frames: many, cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
    const tiles = document.querySelectorAll('.ai-frame-tile');
    assert.ok(tiles.length > 5 && tiles.length <= Math.ceil(600 / rec.tileWidthFor({ width: 800, height: 600 })), `tiles fit the width: ${tiles.length}`);
    assert.equal(tiles[0].dataset.index, '0');
    assert.equal(tiles[tiles.length - 1].dataset.index, '239', 'the last tile is the last frame');
    const strip = document.querySelector('.ai-frame-strip');
    assert.equal(strip.getAttribute('aria-valuemax'), '240');
    await act(async () => pointerAt(strip, 'pointerdown', 599));
    await act(async () => pointerAt(strip, 'pointerup', 599));
    assert.equal(strip.getAttribute('aria-valuenow'), '240', 'a click at the far end jumps to the last frame');
    await act(async () => root.unmount());
  } finally {
    restore();
  }
});

test('dragging across 200 frames costs little per move, renders no tile again and shows the frame under the pointer', async () => {
  const restore = stubLayout({ width: 600, height: 360 });
  try {
    const many = Array.from({ length: 200 }, (_, index) => ({
      index,
      atMs: index * 66,
      width: 800,
      height: 600,
      thumb: `AA${String(index).padStart(2, '0')}`,
    }));
    const { root } = await mountPicker({ frames: many, cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
    const strip = document.querySelector('.ai-frame-strip');
    const tilesBefore = [...document.querySelectorAll('.ai-frame-tile')];
    await act(async () => pointerAt(strip, 'pointerdown', 0));
    const moves = 200;
    const started = performance.now();
    for (let move = 1; move <= moves; move += 1) {
      pointerAt(strip, 'pointermove', (move * 600) / moves - 0.5);
    }
    const perMove = (performance.now() - started) / moves;
    // Reported, not held to a number: a loaded runner is slower; what is held is that nothing renders per move.
    console.log(`frame-picker drag: ${perMove.toFixed(3)} ms per move over ${moves} moves, 200 frames`);
    const preview = document.querySelector('.ai-frame-preview');
    await until(
      'the frame under the pointer, painted on the next frame',
      () => preview.getAttribute('src'),
      (source) => /^data:image\/jpeg;base64,(AA199|\/9j\/19\d)$/.test(source ?? ''),
    );
    assert.match(document.querySelector('.ai-frame-playhead').style.getPropertyValue('--ai-playhead'), /^99\.75%$/, 'the playhead moved by its transform');
    const tilesAfter = [...document.querySelectorAll('.ai-frame-tile')];
    assert.ok(
      tilesAfter.every((tile, index) => tile === tilesBefore[index]),
      'the tiles were not rendered again',
    );
    await act(async () => pointerAt(strip, 'pointerup', 599.5));
    assert.equal(strip.getAttribute('aria-valuenow'), '200', 'the drag ends committed on the last frame');
    await act(async () => root.unmount());
  } finally {
    restore();
  }
});

test('the arrow keys step one frame and ten with Shift (mirrored in right to left); Enter toggles; marks show the chosen frames', async () => {
  const { root, key } = await mountPicker({ cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
  const now = () => Number(document.querySelector('.ai-frame-strip').getAttribute('aria-valuenow'));
  assert.equal(document.querySelector('[aria-label="Previous frame"]').disabled, true, 'nothing before the first frame');
  await key('ArrowRight');
  await key('ArrowRight');
  assert.equal(now(), 3);
  await key('Enter');
  assert.equal(document.querySelectorAll('.ai-frame-mark').length, 1, 'a chosen frame is marked above the timeline');
  assert.equal(document.querySelector('.ai-frame-use').textContent, 'Selected');
  await key('ArrowRight', { shiftKey: true });
  assert.equal(now(), 6, 'Shift moves ten, up to the end');
  assert.equal(document.querySelector('[aria-label="Next frame"]').disabled, true);
  await key('Home');
  assert.equal(now(), 1);
  document.querySelector('.ai-frame-strip').style.direction = 'rtl';
  await key('ArrowLeft');
  assert.equal(now(), 2, 'in right to left, the left arrow goes forward');
  await act(async () => root.unmount());
});

test('the lightbox shows the whole image at its own aspect, as large as the window allows', () => {
  assert.deepEqual(rec.lightboxSize({ width: 360, height: 1200 }, { width: 1400, height: 900 }), { width: 243, height: 812 }, 'a tall frame fits the height');
  assert.deepEqual(rec.lightboxSize({ width: 1600, height: 400 }, { width: 1000, height: 900 }), { width: 904, height: 226 }, 'a wide one fits the width');
  assert.deepEqual(rec.lightboxSize({ width: 300, height: 100 }, { width: 1400, height: 900 }), { width: 300, height: 100 }, 'never larger than its pixels');
});

test('after frames are added the composer takes the keyboard again', async () => {
  rec.resetAiStore();
  const before = rec.aiState().composerFocusRequests;
  window.avb = {
    aiRecord: async (payload) => {
      switch (payload.action.kind) {
        case 'start':
          return { ok: true, value: { kind: 'started', id: `r${'c'.repeat(16)}` } };
        case 'status':
          return { ok: true, value: { kind: 'status', state: 'recording', elapsedMs: 100, frames: 2, bytes: 10, stopReason: undefined } };
        case 'stop':
          return { ok: true, value: { kind: 'stopped', frames: thumbs.slice(0, 2), fps: 10, stopReason: 'person' } };
        case 'frame':
          return { ok: true, value: { kind: 'frame', image: { mimeType: 'image/jpeg', data: '/9j/', width: 800, height: 600 } } };
        default:
          return { ok: true, value: { kind: 'discarded' } };
      }
    },
  };
  const added = [];
  let capture;
  function Host() {
    capture = rec.useScreenshotCapture({
      projectPath: '/site',
      enabled: true,
      nextNumber: () => 1,
      slotsLeft: () => 8,
      onCaptured: (items) => added.push(...items),
      onProblem: () => undefined,
    });
    return capture.overlay ?? React.createElement('span');
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(Host)));
  await act(async () => capture.start('record'));
  const layer = document.querySelector('.ai-region-layer');
  await act(async () => pointerAt(layer, 'pointerdown', 20));
  await act(async () => pointerAt(layer, 'pointermove', 220));
  await act(async () => pointerAt(layer, 'pointerup', 220, { clientY: 120 }));
  const stop = await until('the recording bar', () => document.querySelector('.ai-record-stop'));
  await act(async () => stop.click());
  const use = await until('the Pick frames sheet', () => document.querySelector('.ai-frame-use'));
  await act(async () => use.click());
  const add = [...document.querySelectorAll('.ai-frame-actions button')].find((button) => button.textContent.startsWith('Add'));
  await act(async () => add.click());
  await until('the frame to be added', () => added.length === 1);
  await until('the composer to be asked for the keyboard', () => rec.aiState().composerFocusRequests > before);
  assert.equal(added[0].attachment.data, '/9j/', 'the full frame main holds, not the thumbnail');
  assert.ok(document.querySelector('.ai-frame-sheet') === null, 'the sheet closed');
  assert.ok(rec.aiState().composerFocusRequests >= before + 1, 'the composer is asked to take the keyboard, caret at the end');
  await act(async () => root.unmount());
});

test('a click on the timeline jumps there and toggles that frame; a drag only scrubs; the playhead has its handle', async () => {
  const restore = stubLayout({ width: 600, height: 360 });
  try {
    const many = Array.from({ length: 6 }, (_, index) => ({ index, atMs: index * 100, width: 800, height: 600, thumb: 'AAAA' }));
    const { root } = await mountPicker({ frames: many, cap: 8, onAdd: () => undefined, onDiscard: () => undefined });
    const strip = document.querySelector('.ai-frame-strip');
    const marks = () => document.querySelectorAll('.ai-frame-mark').length;
    await act(async () => pointerAt(strip, 'pointerdown', 250));
    await act(async () => pointerAt(strip, 'pointerup', 251));
    assert.equal(strip.getAttribute('aria-valuenow'), '3', 'the click jumped to the frame under it');
    assert.equal(marks(), 1, 'and chose it');
    await act(async () => pointerAt(strip, 'pointerdown', 250));
    await act(async () => pointerAt(strip, 'pointerup', 250));
    assert.equal(marks(), 0, 'a second click on it lets it go');
    await act(async () => pointerAt(strip, 'pointerdown', 10));
    await act(async () => pointerAt(strip, 'pointermove', 400));
    await act(async () => pointerAt(strip, 'pointerup', 400));
    assert.equal(marks(), 0, 'a drag scrubs and chooses nothing');
    assert.equal(strip.getAttribute('aria-valuenow'), '5');
    await act(async () => root.unmount());
  } finally {
    restore();
  }
  const css = fs.readFileSync(repoPath('src/features/ai/screenshot/screenshot.css'), 'utf8');
  const cap = css.slice(css.indexOf('.ai-frame-playhead::after {'));
  assert.match(cap.slice(0, cap.indexOf('}')), /clip-path: polygon\(0 0, 100% 0, 50% 100%\)/, 'a white downward triangle on the line');
});
