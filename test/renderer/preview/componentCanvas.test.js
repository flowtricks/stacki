// Goal: the component canvas renders what the frames say and nothing else. A Lumos-style button gets a frame per variant
// with props its variant forbids left out; required props and an element id get usable values; the canvas page imports
// each component once, writes every frame's props, size and background into a page the editor's own parser reads,
// escapes what it writes, falls back to the component's name for an empty default slot and keeps insertion defaults
// under the frame's own values; and only well-formed messages from the canvas page are heard.
// Method: build layouts from hand-written schemas and stored settings, generate pages from them, parse each page with the
// app's Astro parser, and feed the message reader known-good and known-bad shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const model = loadRenderer('src/features/preview/componentCanvas/canvasModel.ts');
const page = loadRenderer('src/features/preview/componentCanvas/canvasPage.ts');
const chrome = loadRenderer('src/features/preview/componentCanvas/canvasChrome.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BUTTON = 'src/components/Button.astro';
const unions = [
  {
    names: ['variant', 'direction', 'label'],
    branches: [
      { forbids: ['direction', 'label'], pins: { variant: ['main'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: [], pins: { variant: ['arrow'] }, defaults: {}, rules: {}, docs: {} },
    ],
  },
];
const button = {
  file: BUTTON,
  name: 'Button',
  schema: [
    { name: 'variant', type: 'enum', optional: true, options: ['main', 'arrow'], default: 'main', unions },
    { name: 'direction', type: 'enum', optional: true, options: ['forward', 'back'], unions },
    { name: 'label', type: 'string', optional: true, unions },
    { name: 'size', type: 'enum', optional: true, options: ['1', '2'], numeric: true, unions },
    { name: 'id', type: 'string', optional: true, unions },
    { name: 'heading', type: 'string', optional: false, unions },
    { name: 'onPress', type: 'code', optional: true, codeKind: 'function', unions },
  ],
};
const snapshot = {
  catalog: [{ file: BUTTON, name: 'Button', props: ['variant', 'label'], slots: ['default'], slotText: true }],
  config: { version: 1, components: {} },
};

function pageOf(layout, overrides = {}) {
  return page.canvasPageSource({
    id: ID,
    component: BUTTON,
    fallbackText: 'Button',
    theme: 'dark',
    snapshot,
    frames: layout.frames.map((frame) => ({
      key: frame.key,
      label: frame.key || 'Button',
      row: frame.row,
      props: frame.props,
      omitted: frame.omitted,
      width: frame.resolved.width,
      height: frame.resolved.height,
      background: frame.resolved.background,
    })),
    ...overrides,
  });
}

test('a button splits by variant; props a variant forbids are left out; required props and ids get values', () => {
  const layout = model.buildCanvasLayout(button, { frames: { '': { props: { label: 'Go', size: '2' } } } });
  assert.deepEqual(
    layout.frames.map((frame) => frame.key),
    ['variant=main', 'variant=arrow'],
  );
  const [main, arrow] = layout.frames;
  assert.equal(main.props.label, undefined, 'main forbids label');
  assert.ok(main.omitted.has('direction'));
  assert.equal(arrow.props.label, 'Go');
  assert.equal(arrow.props.size, 2, 'a numeric option is written as a number');
  assert.equal(main.props.heading, 'Heading', 'a required text prop shows its own name');
  assert.equal(main.props.id, 'stacki-canvas-1');
  assert.equal(arrow.props.id, 'stacki-canvas-2');
  assert.equal(model.frameTakes(button, main, 'direction'), false);
  assert.equal(model.frameTakes(button, arrow, 'direction'), true);
  assert.equal(model.fieldControl(button.schema[6]), undefined, 'an action has no preview control');
  assert.deepEqual(model.fieldControl(button.schema[0]), { kind: 'choice', options: ['main', 'arrow'] });
});

test('a stored value for a prop the component no longer has is ignored, not drawn', () => {
  const layout = model.buildCanvasLayout(button, { split: ['variant'], frames: { 'variant=arrow': { props: { gone: 'x' } } } });
  assert.equal(layout.frames[1].props.gone, undefined);
  assert.equal(layout.frames[1].resolved.props.gone, 'x', 'it stays in the settings');
});

test('the canvas page parses, imports the component once, and writes each frame', () => {
  const layout = model.buildCanvasLayout(button, {
    split: ['variant', 'direction'],
    frames: {
      '': { background: 'var(--swatch-light)' },
      'direction=back&variant=arrow': { width: 320, height: 200, props: { label: 'Back "<there>"' } },
    },
  });
  const source = pageOf(layout);
  const importLine = 'import ButtonCanvas0 from "../../' + BUTTON + '";';
  assert.equal(source.split(importLine).length - 1, 1, 'the component is imported once');
  assert.ok(source.includes('<stacki-frame data-frame={"direction=back&variant=arrow"}>'));
  assert.match(
    source,
    /data-fixed-width data-fixed-height style="width: 320px; height: 200px; contain-intrinsic-size: 320px 200px; background: var\(--swatch-light\)"/,
  );
  assert.match(source, /label="Back &quot;&lt;there&gt;&quot;"/, 'prop text is escaped');
  assert.match(source, /<ButtonCanvas0 variant="main"[^>]*>Button Text<\/ButtonCanvas0>/, 'without a project recipe, the starter defaults fill the slot');
  const chip = { ...snapshot, catalog: [{ ...snapshot.catalog[0], name: 'Chip', slotText: false }] };
  assert.match(pageOf(layout, { snapshot: chip, fallbackText: 'Chip' }), />Chip<\/ButtonCanvas0>/, 'an empty default slot shows the component name');
  assert.doesNotMatch(source, /variant="main" direction=/, 'main is never given a direction');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true, parsed.editable ? '' : parsed.reason);
  const root = JSON.stringify(parsed.model.nodes).includes('"name":"stacki-canvas"');
  assert.ok(root, 'the frames sit in one stacki-canvas element the editor can focus');
  assert.doesNotMatch(source, /<stacki-frame-body[^>]*data-transparent/, 'every frame has the all-frames background');
});

test('insertion defaults come first and the frame wins; an unset prop is not passed at all', () => {
  const withRecipe = { ...snapshot, config: { version: 1, components: { [BUTTON]: { props: { label: 'From defaults', variant: 'arrow' }, text: 'Click' } } } };
  const layout = model.buildCanvasLayout(button, { split: [], frames: { '': { unset: ['label'] } } });
  const source = pageOf(layout, { snapshot: withRecipe });
  assert.match(source, /<ButtonCanvas0 variant="arrow" id="stacki-canvas-1" heading="Heading">Click<\/ButtonCanvas0>/);
  assert.doesNotMatch(source, /From defaults/);
});

test('the chrome refuses what could break out of its elements, and the page name is a UUID', () => {
  assert.throws(() => chrome.chromeScript('not-a-uuid'), /UUID/);
  assert.doesNotMatch(chrome.chromeScript(ID), /<\/script/);
  assert.doesNotMatch(chrome.chromeStyles('dark'), /<\//);
  assert.throws(() => page.canvasPageSource({ id: ID, component: BUTTON, fallbackText: 'x', theme: 'dark', snapshot, frames: [] }), /at least one frame/);
});

test('only well-formed messages from this canvas are heard', () => {
  const type = chrome.CANVAS_MESSAGE;
  assert.deepEqual(chrome.canvasMessage({ type, canvas: ID, event: 'select', frame: 'variant=main', chrome: true }, ID), {
    event: 'select',
    frame: 'variant=main',
    chrome: true,
    scale: undefined,
  });
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: 0.5 }, ID).scale, 0.5);
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: -1 }, ID).scale, undefined);
  assert.equal(chrome.canvasMessage({ type, canvas: 'other', event: 'ready' }, ID), undefined, 'another canvas');
  assert.equal(chrome.canvasMessage({ type: 'avb:click-node', canvas: ID, event: 'ready' }, ID), undefined, 'another protocol');
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'delete' }, ID), undefined, 'an unknown event');
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'select', frame: 'x'.repeat(2000) }, ID).frame, undefined, 'an oversized key');
  assert.equal(chrome.canvasMessage(undefined, ID), undefined);
  assert.equal(chrome.canvasMessage('select', ID), undefined);
});
