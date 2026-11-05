// Goal: ⌘V with an SVG on the clipboard turns it into the clip-path, as the
// editor's shortcut help has always promised: straight-line outlines become an
// exact polygon(), and anything with curves or arcs becomes a shape() in the
// current Fit. The listener and its parser survived every refactor, but ⌘V never
// reached them outside a text field: Desktop's Paste is a menu item that pasted
// the copied element instead, and Studio's editor keys cancelled the key for the
// same reason. The editor now claims ⌘V while it is open (menuPasteClaim.ts).
// This file also holds the Shape preset to the user's SVG (a rounded square with a
// hole), converted the way a paste converts it, the hole's winding with it, and the Size / Offset X / Offset Y fields to the variable
// binding every other Style panel value has.
// Method: the parser is bundled from its modules and run in jsdom on SVGs that
// should convert, and on the negative space: no shape, too long, too many
// elements, broken markup, scripts and handlers, and transforms (the old parser
// refused those too, and still does). Then the real editor is mounted with the
// panel's writers as spies, and paste events (jsdom has no ClipboardEvent, so a
// plain event carries a `clipboardData` with getData) are dispatched where ⌘V
// lands: the canvas, the code field and a variable field. The Shape preset is
// chosen from the menu and compared with pasting the default SVG. The Desktop
// menu and key handlers are bundled with a stub bridge to show a claim routes
// ⌘V to the browser's paste. Last, three variables are stubbed in and each shape
// variable field is bound from its dot and by typing `--`.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');

// The project's variables: two sizes and a colour, so a filter by property shows.
const VARIABLES_STUB = {
  'src/features/style/model/webflow.ts': () => ({
    contents: `
      export async function streamProjectVariables(onAdd) {
        onAdd({ name: 'accent', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--accent)', type: 'Size' });
        onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--brand)', type: 'Size' });
        onAdd({ name: 'ink', collection: 'Sizes', group: '', value: '#000', binding: 'var(--ink)', type: 'Color' });
        return [];
      }
    `,
    loader: 'js',
  }),
};

async function bundle(name, contents) {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts' },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [stubSources('stub-variables', VARIABLES_STUB)],
  });
  delete require.cache[output];
  return require(output);
}

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
// The DOM here (jsdom) lays nothing out, so it cannot scroll; the preset menu scrolls its
// chosen option into view when it opens.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};
// Nor text boxes: CodeMirror measures its lines through ranges after an update.
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 });
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

let model;
let editor;
before(async () => {
  model = await bundle(
    'clip-path-paste-model',
    `
    export {
      parseSvgClipPathPolygon,
      parseSvgClipPathShape,
      parseSvgDocument,
    } from './src/features/style/clipPath/svgContours';
    export { formatClipPath } from './src/features/style/clipPath/clipPathFormat';
    export {
      DEFAULT_SHAPE_SVG,
      DEFAULT_SHAPE_VALUE,
      DEFAULT_SHAPE_PATH_DATA,
      SVG_PASTE_ELEMENTS_MAX,
      SVG_PASTE_TEXT_LENGTH_MAX,
    } from './src/features/style/clipPath/clipPathConstants';
    export {
      formatShapeVariableField,
      sanitizeShapeScaleVariableName,
      shapeVariableFieldText,
      shapeVariableReferenceName,
    } from './src/features/style/clipPath/clipPathMeasure';
    export { claimMenuPaste, menuPasteClaimed } from './src/ui/menuPasteClaim';
  `,
  );
  editor = await bundle(
    'clip-path-paste-editor',
    `
    export { default as ClipPath } from './src/features/style/clipPath/ClipPath';
    export { menuPasteClaimed } from './src/ui/menuPasteClaim';
    export { DEFAULT_SHAPE_SVG } from './src/features/style/clipPath/clipPathConstants';
  `,
  );
});

// ─────────────────────────── The parser ───────────────────────────

const css = (shape) => (shape ? model.formatClipPath(shape) : undefined);
const polygonOf = (svg) => css(model.parseSvgClipPathPolygon(svg));
const shapeOf = (svg, fit = 'stretch') => css(model.parseSvgClipPathShape(svg, fit));

test('straight-line SVG becomes an exact polygon(), normalised to the viewBox', () => {
  assert.equal(
    polygonOf('<svg viewBox="0 0 200 100"><polygon points="0,0 200,0 100,100"/></svg>'),
    'polygon(0% 0%, 100% 0%, 50% 100%)',
    'a <polygon> is scaled from its 200 × 100 viewBox',
  );
  assert.equal(
    polygonOf('<svg viewBox="0 0 10 10"><path d="M0 0H10V10H0Z"/></svg>'),
    'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    'a <path> of lines (H, V) is a polygon too',
  );
  assert.equal(
    polygonOf('<svg viewBox="10 20 100 50"><polyline points="10,20 110,20 110,70 10,70 10,20"/></svg>'),
    'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)',
    'an offset viewBox moves the origin to its corner',
  );
  // Text around the markup (a copied snippet, an HTML clipboard) is not the SVG.
  assert.equal(polygonOf('copied: <svg viewBox="0 0 4 4"><polygon points="0,0 4,0 0,4"/></svg> done'), 'polygon(0% 0%, 100% 0%, 0% 100%)');
});

test('curves and arcs become a shape(), in the Fit asked for', () => {
  const curved = '<svg viewBox="0 0 100 100"><path d="M0 50C0 0 100 0 100 50S100 100 0 50Z"/></svg>';
  assert.equal(polygonOf(curved), undefined, 'a curve is no polygon');
  const stretched = shapeOf(curved, 'stretch');
  assert.match(stretched, /^shape\(from 0% 50%, curve to 100% 50% with 0% 0% \/ 100% 0%, /, 'Stretch writes percentages');
  const scaled = shapeOf(curved, 'contain');
  assert.match(scaled, /^shape\(from calc\(0 \* 100cqw \+ 0\.5 \* \(100cqw - 1 \* 100cqw\)\) /, 'Scale writes the size and offset terms');
  const arc = '<svg viewBox="0 0 100 100"><path d="M0 50A50 50 0 0 1 100 50Z"/></svg>';
  assert.equal(polygonOf(arc), undefined, 'an arc is no polygon');
  assert.match(shapeOf(arc), /curve to 100% 50%/, 'an arc is drawn as curves');
  assert.match(shapeOf('<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="5"/></svg>'), /^shape\(from 100% 50%, curve to/, 'a circle element too');
});

test('transforms are refused, as the old parser refused them', () => {
  const moved = '<svg viewBox="0 0 10 10"><g transform="translate(1 1)"><polygon points="0,0 5,0 0,5"/></g></svg>';
  assert.equal(polygonOf(moved), undefined);
  assert.equal(shapeOf(moved), undefined);
});

test('a paste with no shape, too much text, too many elements, broken markup or script is refused', () => {
  const refused = (svg, why) => {
    assert.equal(polygonOf(svg), undefined, `${why}: no polygon`);
    assert.equal(shapeOf(svg), undefined, `${why}: no shape`);
    assert.equal(shapeOf(svg, 'contain'), undefined, `${why}: no scaled shape`);
  };
  refused('just text', 'not SVG');
  refused('<svg viewBox="0 0 10 10"></svg>', 'nothing drawn');
  refused('<svg viewBox="0 0 10 10"><polygon points="0,0 5,0 0,5" fill="none"/></svg>', 'nothing filled');
  refused('<svg viewBox="0 0 10 10"><defs><polygon points="0,0 5,0 0,5"/></defs></svg>', 'only definitions');
  refused('<svg viewBox="0 0 10 10"><polygon points="0,0 5,0 0,5"></svg>', 'broken markup');
  const triangle = '<polygon points="0,0 5,0 0,5"/>';
  refused(`<svg viewBox="0 0 10 10">${triangle}<script>alert(1)</script></svg>`, 'a script');
  refused(`<svg viewBox="0 0 10 10" onload="alert(1)">${triangle}</svg>`, 'a handler attribute');
  refused(`<svg viewBox="0 0 10 10">${triangle}<foreignObject><div/></foreignObject></svg>`, 'embedded HTML');
  // The bounds, and the valid side of each: one under the limit still converts.
  const padded = (length) => `<svg viewBox="0 0 10 10">${triangle}<!--${'x'.repeat(length)}--></svg>`;
  const fixedLength = padded(0).length;
  assert.equal(polygonOf(padded(model.SVG_PASTE_TEXT_LENGTH_MAX - fixedLength)), 'polygon(0% 0%, 50% 0%, 0% 50%)', 'text at the limit converts');
  refused(padded(model.SVG_PASTE_TEXT_LENGTH_MAX - fixedLength + 1), 'text over the limit');
  // The <svg> and the polygon are two of the elements counted.
  const grouped = (count) => `<svg viewBox="0 0 10 10">${triangle}${'<g/>'.repeat(count)}</svg>`;
  assert.equal(polygonOf(grouped(model.SVG_PASTE_ELEMENTS_MAX - 2)), 'polygon(0% 0%, 50% 0%, 0% 50%)', 'elements at the limit convert');
  refused(grouped(model.SVG_PASTE_ELEMENTS_MAX - 1), 'elements over the limit');
});

// The on-curve points of each subpath of a percent shape() value, for the winding:
// `from` and every `… to X Y`, control points left out.
function subpathPoints(value) {
  return value
    .split(/, move to /)
    .map((subpath) => [...subpath.matchAll(/(?:^from|to) (-?[\d.]+)% (-?[\d.]+)%/g)].map((match) => ({ x: Number(match[1]), y: Number(match[2]) })));
}
// Twice the signed area: positive for a loop clockwise on screen (y down), negative
// for one wound the other way.
function signedArea(points) {
  assert.ok(points.length >= 3, 'a loop has at least three points');
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    const next = points[(index + 1) % points.length];
    sum += point.x * next.y - next.x * point.y;
  }
  return sum;
}

test('the Shape preset is the default SVG converted, its hole kept, square under Scale', () => {
  const svg = model.DEFAULT_SHAPE_SVG;
  assert.match(svg, /viewBox="0 0 83 83"/, 'the user’s 83 × 83 SVG');
  const stretched = model.parseSvgClipPathShape(svg, 'stretch');
  assert.ok(stretched, 'the default SVG converts');
  assert.equal(stretched.value, model.DEFAULT_SHAPE_VALUE, 'the stored preset is the conversion, not hand-written');
  assert.equal(stretched.pathData, model.DEFAULT_SHAPE_PATH_DATA, 'and so is its path data');
  assert.equal((stretched.value.match(/(^|, )from /g) ?? []).length, 1, 'one start');
  assert.equal((stretched.value.match(/, move to /g) ?? []).length, 1, 'and the cut-out as a second subpath');
  assert.equal((stretched.value.match(/, close/g) ?? []).length, 2, 'each closed');
  assert.equal(polygonOf(svg), undefined, 'curves make it a shape, not a polygon');
  // The SVG names no fill rule, so it fills nonzero, which is shape()'s default:
  // the cut-out is a hole because it winds against the outline.
  assert.equal(stretched.fillRule, undefined, 'nonzero, the default, is not spelled out');
  const [outline, cutOut] = subpathPoints(stretched.value).map(signedArea);
  assert.ok(outline > 0, 'the outline winds clockwise');
  assert.ok(cutOut < 0, 'the cut-out winds the other way, so nonzero leaves it a hole');
  // Scale: a square viewBox spans the size both ways, centred by the 0.5 offsets.
  const scaled = shapeOf(svg, 'contain');
  assert.match(scaled, /\+ 0\.5 \* \(100cqw - 1 \* 100cqw\)\)/, 'x spans the size, centred');
  assert.match(scaled, /\+ 0\.5 \* \(100cqh - 1 \* 100cqw\)\)/, 'y spans the same size, centred: it stays square');
});

test('a counter-wound inner subpath stays a hole, and an even-odd SVG says so', () => {
  const holed = model.parseSvgClipPathShape('<svg viewBox="0 0 10 10"><path d="M0 0H10V10H0Z M3 3V7H7Q7 3 3 3Z"/></svg>', 'stretch');
  assert.ok(holed, 'a path with a cut-out converts');
  assert.equal(holed.fillRule, undefined, 'nonzero');
  const [outline, hole] = subpathPoints(holed.value).map(signedArea);
  assert.ok(outline > 0, 'the outline keeps its direction');
  assert.ok(hole < 0, 'the inner subpath keeps the opposite one: a hole under nonzero');
  // Straight lines alone: two loops are no single polygon(), so it is a shape() too.
  const square = '<svg viewBox="0 0 10 10"><path d="M0 0H10V10H0Z M3 3V7H7V3Z"/></svg>';
  assert.equal(polygonOf(square), undefined, 'a polygon() could not hold the hole');
  assert.equal(
    shapeOf(square),
    'shape(from 0% 0%, line to 100% 0%, line to 100% 100%, line to 0% 100%, close, move to 30% 30%, line to 30% 70%, line to 70% 70%, line to 70% 30%, close)',
    'the hole is written as drawn',
  );
  const evenOdd = '<svg viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0H10V10H0Z M3 3H7Q7 7 3 7Z"/></svg>';
  assert.match(shapeOf(evenOdd), /^shape\(evenodd from 0% 0%, /, 'an even-odd SVG carries its rule');
  assert.match(shapeOf(evenOdd, 'contain'), /^shape\(evenodd from /, 'under Scale too');
});

test('a shape variable field reads a typed name or a var() reference as the same property', () => {
  assert.equal(model.sanitizeShapeScaleVariableName('var(--size)'), '--size', 'a reference is unwrapped');
  assert.equal(model.sanitizeShapeScaleVariableName(' var( --size , 2rem ) '), '--size', 'with a fallback and spaces');
  assert.equal(model.sanitizeShapeScaleVariableName('--size'), '--size', 'a typed name stays');
  assert.equal(model.shapeVariableReferenceName('calc(var(--a) * 2)'), undefined, 'an expression is not one reference');
  assert.equal(model.shapeVariableReferenceName('var(--a) var(--b)'), undefined, 'nor are two');
  assert.equal(model.formatShapeVariableField('Element Size'), 'var(--element-size)', 'a typed name becomes a reference on blur');
  assert.equal(model.formatShapeVariableField('var(--brand, 1)'), 'var(--brand)', 'a reference keeps its name');
  assert.equal(model.formatShapeVariableField('   '), '', 'an empty field stays empty');
  assert.equal(model.shapeVariableFieldText('--size'), 'var(--size)', 'a loaded name shows as a reference');
  assert.equal(model.shapeVariableFieldText(''), '');
});

test('a ⌘V claim lasts until its release, and a second release changes nothing', () => {
  assert.equal(model.menuPasteClaimed(), false, 'nothing claims ⌘V at first');
  const releaseFirst = model.claimMenuPaste();
  const releaseSecond = model.claimMenuPaste();
  assert.equal(model.menuPasteClaimed(), true);
  releaseFirst();
  releaseFirst();
  assert.equal(model.menuPasteClaimed(), true, 'a repeated release does not end the other claim');
  releaseSecond();
  assert.equal(model.menuPasteClaimed(), false, 'the last release ends it');
});

// ─────────────────────────── The mounted editor ───────────────────────────

const settle = (ms = 20) => act(async () => new Promise((resolve) => setTimeout(resolve, ms)));
// Past the editor's write throttle (60 ms) and its selection read.
const settleWrites = () => settle(300);
const press = (element) => {
  element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
  element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
};

// A paste as the browser fires it: a cancellable event whose clipboardData answers
// getData for plain text and HTML.
async function pasteOn(target, text, html = '') {
  const event = new dom.window.Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: { getData: (type) => (type === 'text/plain' ? text : type === 'text/html' ? html : '') },
  });
  await act(async () => target.dispatchEvent(event));
  await settleWrites();
  return event;
}

async function mount(initialValue) {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const writes = [];
  await act(async () => {
    root.render(
      React.createElement(editor.ClipPath, {
        onApply: (value) => writes.push(value),
        onClear: () => writes.push('clear'),
        hideClassPicker: true,
        initialValue,
      }),
    );
  });
  await settleWrites();
  const done = async () => {
    await act(async () => root.unmount());
    host.remove();
  };
  return { host, writes, done };
}

async function chooseShapePreset(host) {
  const button = host.querySelector('.clip-path_preset-button');
  assert.ok(button, 'the shape menu button is mounted');
  await act(async () => press(button));
  await settle();
  const option = [...host.querySelectorAll('.clip-path_preset-option')].find((item) => item.textContent.trim() === 'Shape');
  assert.ok(option, 'the menu offers Shape');
  await act(async () => press(option));
  await settleWrites();
}

const STRAIGHT_SVG = '<svg viewBox="0 0 200 100"><polygon points="0,0 200,0 100,100"/></svg>';
const CURVED_SVG = '<svg viewBox="0 0 100 100"><path d="M0 50C0 0 100 0 100 50S100 100 0 50Z"/></svg>';

test('the open editor claims ⌘V, and pasting a straight-line SVG on it writes the polygon()', async () => {
  assert.equal(editor.menuPasteClaimed(), false, 'nothing claims ⌘V before the editor opens');
  const { host, writes, done } = await mount('none');
  assert.equal(editor.menuPasteClaimed(), true, 'the open editor claims ⌘V');
  const canvas = host.querySelector('.clip-path_component');
  assert.ok(canvas, 'the editor is mounted');
  const event = await pasteOn(canvas, STRAIGHT_SVG);
  assert.ok(event.defaultPrevented, 'the editor takes the paste');
  assert.equal(writes.at(-1), 'polygon(0% 0%, 100% 0%, 50% 100%)', 'the clip-path is the SVG’s outline');
  // The same SVG offered only as HTML (a copy from a page) converts too.
  await pasteOn(document.body, '', `<meta charset="utf-8">${CURVED_SVG}`);
  assert.match(writes.at(-1), /^shape\(/, 'the HTML flavour is read when the text has no SVG');
  await done();
  assert.equal(editor.menuPasteClaimed(), false, 'closing the editor releases ⌘V');
  // Detached: with the editor closed, a paste writes nothing.
  const before = writes.length;
  await pasteOn(document.body, STRAIGHT_SVG);
  assert.equal(writes.length, before, 'no listener outlives the editor');
});

test('pasting a curved SVG writes a shape() in the current Fit, and plain text is left alone', async () => {
  const { host, writes, done } = await mount('none');
  const canvas = host.querySelector('.clip-path_component');
  const ignored = await pasteOn(canvas, 'hello');
  assert.equal(ignored.defaultPrevented, false, 'text that is no SVG pastes as usual');
  assert.equal(writes.length, 0, 'and writes nothing');
  await pasteOn(canvas, CURVED_SVG);
  const written = writes.at(-1);
  assert.equal(written, `shape(${model.parseSvgClipPathShape(CURVED_SVG, 'contain').value})`, 'Scale, the default Fit, writes the scaled shape()');
  assert.match(written, /calc\(0 \* 100cqw \+ 0\.5 \* \(100cqw - 1 \* 100cqw\)\)/);
  await done();
});

test('an SVG pasted into the code field becomes the shape; one pasted into another field stays text', async () => {
  const { host, writes, done } = await mount('none');
  await chooseShapePreset(host);
  const chosen = writes.length;
  const sizeField = host.querySelector('#clip-path_shape-variable-input');
  assert.ok(sizeField, 'the Size field shows for a scaled shape');
  const intoField = await pasteOn(sizeField, STRAIGHT_SVG);
  assert.equal(intoField.defaultPrevented, false, 'a variable field takes the text itself');
  assert.equal(writes.length, chosen, 'and the shape is untouched');
  const code = host.querySelector('#clip-path_css-output .cm-content');
  assert.ok(code, 'the code field is mounted');
  const intoCode = await pasteOn(code, STRAIGHT_SVG);
  assert.ok(intoCode.defaultPrevented, 'the code field’s paste is the shape’s, as its shortcut help says');
  assert.equal(writes.at(-1), 'polygon(0% 0%, 100% 0%, 50% 100%)');
  await done();
});

test('choosing Shape writes the default SVG, exactly as pasting that SVG does', async () => {
  const chose = await mount('none');
  await chooseShapePreset(chose.host);
  const chosen = chose.writes.at(-1);
  await chose.done();
  assert.ok(chosen, 'choosing Shape writes');
  assert.equal(chosen, `shape(${model.parseSvgClipPathShape(model.DEFAULT_SHAPE_SVG, 'contain').value})`, 'the default SVG under Scale');
  assert.equal((chosen.match(/, move to /g) ?? []).length, 1, 'with both of its paths');
  assert.doesNotMatch(chosen, /0\.568 \* 100cqw/, 'not the old four-point shape');
  const pasted = await mount('none');
  await pasteOn(pasted.host.querySelector('.clip-path_component'), editor.DEFAULT_SHAPE_SVG);
  assert.equal(pasted.writes.at(-1), chosen, 'pasting the same SVG writes the same clip-path');
  await pasted.done();
});

// ─────────────────────────── The Desktop paste route ───────────────────────────

test('Desktop’s Paste runs the browser’s paste while a tool claims it, and the copied element otherwise', async () => {
  const keys = await bundle(
    'clip-path-paste-keys',
    `
    export { menuPaste, handleSelectionKey } from './src/app/model/appKeys';
    export { claimMenuPaste } from './src/ui/menuPasteClaim';
  `,
  );
  const calls = [];
  window.avb = { nativePaste: () => (calls.push('native'), Promise.resolve({ ok: true })) };
  const menu = {
    selectedIdRef: { current: 'n1' },
    pageStateRef: { current: { pageState: { editable: true } } },
    cmsOpenRef: { current: false },
    nodeClipboardRef: { current: { markup: '<div/>' } },
    copyNode: () => calls.push('copy'),
    pasteNode: () => (calls.push('node'), Promise.resolve()),
    reportFailure: (error) => calls.push(String(error)),
  };
  document.body.focus();
  keys.menuPaste(menu);
  assert.deepEqual(calls, ['node'], 'unclaimed, Paste pastes the copied element');
  const release = keys.claimMenuPaste();
  keys.menuPaste(menu);
  assert.deepEqual(calls, ['node', 'native'], 'claimed, Paste fires the browser’s paste for the tool');
  const key = new dom.window.KeyboardEvent('keydown', { key: 'v', metaKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(key, 'target', { value: document.body });
  keys.handleSelectionKey(key, { ...menu, pageStateRef: menu.pageStateRef, selectedIdRef: menu.selectedIdRef });
  assert.equal(key.defaultPrevented, false, 'claimed, the ⌘V key is left to the browser');
  assert.deepEqual(calls, ['node', 'native'], 'and pastes no element');
  release();
  delete window.avb;
});

test('Studio’s editor keys leave ⌘V alone while a tool claims it', () => {
  const source = fs.readFileSync(repoPath('studio/src/features/navigator/useEditorKeys.ts'), 'utf8');
  const claim = source.indexOf('menuPasteClaimed()');
  const cancel = source.indexOf("['c', 'd', 'v'].includes(value)");
  assert.ok(claim > 0, 'the editor keys ask whether ⌘V is claimed');
  assert.ok(claim < cancel, 'before they cancel the key for an element paste');
  const shared = JSON.parse(fs.readFileSync(repoPath('studio/scripts/shared-source.json'), 'utf8'));
  assert.ok(shared.files.includes('src/ui/menuPasteClaim.ts'), 'Studio carries the claim');
});

// ─────────────────────────── Shape variables ───────────────────────────

const pickerNames = () => [...document.querySelectorAll('.embed-editor_varpicker-item-name')].map((name) => name.textContent);
const FIELDS = [
  { id: 'clip-path_shape-variable-input', label: 'Size', written: /var\(--accent, 100cqw\)/ },
  { id: 'clip-path_shape-offset-left-input', label: 'Offset X', written: /\+ var\(--accent, 0\.5\) \* \(100cqw - / },
  { id: 'clip-path_shape-offset-top-input', label: 'Offset Y', written: /\+ var\(--accent, 0\.5\) \* \(100cqh - / },
];

for (const field of FIELDS) {
  test(`${field.label} has the bind dot, and binding it writes the shape() with the variable`, async () => {
    const { host, writes, done } = await mount('none');
    await chooseShapePreset(host);
    const input = host.querySelector(`#${field.id}`);
    assert.ok(input, `${field.label} is mounted`);
    const wrap = input.closest('.embed-editor_varconnect');
    assert.ok(wrap, `${field.label} sits in VariableConnect`);
    const dot = wrap.querySelector(':scope > .embed-editor_varconnect-dot');
    assert.ok(dot, `${field.label} has the hover dot`);
    assert.equal(dot.getAttribute('aria-label'), `Connect ${field.label} to a variable`);
    await act(async () => press(dot));
    await settle();
    assert.deepEqual(pickerNames(), ['accent', 'brand'], 'the chooser offers numbers and lengths, not the colour');
    const accent = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((item) => item.textContent.includes('accent'));
    await act(async () => press(accent));
    await settleWrites();
    assert.match(writes.at(-1), field.written, `the shape() reads ${field.label} from the variable`);
    assert.ok(wrap.classList.contains('is-token'), 'the bound field shows the variable as a chip');
    await done();
  });
}

test('typing -- in a shape variable field suggests variables, and the pick binds it', async () => {
  const { host, writes, done } = await mount('none');
  await chooseShapePreset(host);
  const input = host.querySelector('#clip-path_shape-variable-input');
  const setValue = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    input.focus();
    setValue.call(input, '--');
    input.setSelectionRange(2, 2);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
  assert.deepEqual(pickerNames(), ['accent', 'brand'], 'typing -- opens the chooser');
  const brand = [...document.querySelectorAll('.embed-editor_varpicker-item')].find((item) => item.textContent.includes('brand'));
  await act(async () => press(brand));
  await settleWrites();
  assert.match(writes.at(-1), /var\(--brand, 100cqw\)/, 'the pick is the size variable');
  await done();
});

test('the Size field of a loaded shape shows its variable as a chip', async () => {
  const sized = model.parseSvgClipPathShape(CURVED_SVG, 'contain', {
    useVariable: true,
    variableName: '--size',
    offsetLeftVariableName: '',
    offsetTopVariableName: '',
  });
  const loaded = model.formatClipPath(sized);
  assert.match(loaded, /var\(--size, 100cqw\)/, 'the loaded shape reads --size');
  const { host, writes, done } = await mount(loaded);
  const input = host.querySelector('#clip-path_shape-variable-input');
  assert.ok(input, 'the loaded shape is scaled, so Size shows');
  assert.ok(input.closest('.embed-editor_varconnect')?.classList.contains('is-token'), 'its variable is a chip');
  assert.deepEqual(writes, [], 'opening writes nothing');
  await done();
});
