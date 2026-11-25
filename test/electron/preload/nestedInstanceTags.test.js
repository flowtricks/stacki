// Goal: a component used inside itself is outlined at its own bounds, at any depth. The frame moves an instance's
// page path up to its component's root when `{...rest}` landed on an inner element (a form field's control); that
// climb once took an outer Section for the inner one's root, so every nested Section answered to the outer
// `<section>`, and its outline, clicks and drops used the outer bounds.
// Method: the frame's own collector (collectRegions, electron/preload/frameRegions.ts) over a jsdom page shaped as a
// Lumos page renders: slot content with its comment markers stripped, so nested instances are addressed by their
// tags, with the component's own markers around its slot. Each page path must be on its own element alone. The
// positive case (the promotion a form field needs, nested in itself too) and a use through another template branch
// are pinned beside it.

const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule.js');

const ROOT = 'src/components/Section.astro|';
const mark = (path, html) => `<!--avb-s:${path}-->${html}<!--avb-e:${path}-->`;

// One rendered Section: its root, written with its own path and the name that rode in, holding a container whose
// slot outlet the component's markers surround.
const section = (id, pagePath, slot) =>
  `<section id="${id}" data-avb-p="${ROOT}0.0 ${pagePath}"><div data-avb-p="${ROOT}0.0.1">${mark(`${ROOT}0.0.1.0`, slot)}</div></section>`;
const component = (html) => mark(`${ROOT}0`, html);

function collect(body) {
  const dom = new JSDOM(`<!doctype html><html><body>${body}</body></html>`);
  const previous = { window: global.window, document: global.document, Node: global.Node };
  Object.assign(global, { window: dom.window, document: dom.window.document, Node: dom.window.Node });
  try {
    const frame = loadRenderer('electron/preload/frameRegions.ts');
    frame.collectRegions();
    const idsOf = (path) =>
      [...dom.window.document.querySelectorAll('[data-avb-p]')].filter((element) => frame.pathsOf(element).includes(path)).map((element) => element.id);
    return { idsOf };
  } finally {
    Object.assign(global, previous);
  }
}

test('a Section in a Section in a Section, and its sibling, each keep their own name', () => {
  const deep = section('deep', '0.0.1.1', '<h2 id="three" data-avb-p="0.0.1.1.0">three</h2>');
  const inner = section('inner', '0.0.1', deep);
  const sibling = section('sibling', '0.0.2', '<p id="four" data-avb-p="0.0.2.0">four</p>');
  const page = collect(mark('0.0', component(section('outer', '0.0', inner + sibling))));
  assert.deepEqual(page.idsOf('0.0.1'), ['inner']);
  assert.deepEqual(page.idsOf('0.0.1.1'), ['deep']);
  assert.deepEqual(page.idsOf('0.0.2'), ['sibling']);
});

test('under an outer use the page never named (a layout’s own Section), the inner one keeps its name', () => {
  const inner = section('inner', '0.0', 'words');
  const outer = `<section id="outer" data-avb-p="${ROOT}0.0"><div data-avb-p="${ROOT}0.0.1">${mark(`${ROOT}0.0.1.0`, inner)}</div></section>`;
  assert.deepEqual(collect(component(outer)).idsOf('0.0'), ['inner']);
});

test('copies a loop renders of nested Sections stay on their own elements', () => {
  const copy = (key) => section(`loop-${key}`, '0.1.0', section(`in-${key}`, '0.1.0.0', 'x'));
  const page = collect(component(copy('a')) + component(copy('b')));
  assert.deepEqual(page.idsOf('0.1.0'), ['loop-a', 'loop-b']);
  assert.deepEqual(page.idsOf('0.1.0.0'), ['in-a', 'in-b']);
});

test('a use nested through another branch of the template is never moved onto the named outer one', () => {
  const inner = `<article id="inner" data-avb-p="${ROOT}0.1.0 0.0.0">words</article>`;
  const outer = `<section id="outer" data-avb-p="${ROOT}0.0 0.0"><div data-avb-p="${ROOT}0.0.1">${mark(`${ROOT}0.0.1.0`, inner)}</div></section>`;
  assert.deepEqual(collect(component(outer)).idsOf('0.0.0'), ['inner']);
});

test('a field that forwards `...rest` to its control is still named on its own label, nested in itself too', () => {
  const FIELD = 'src/components/Field.astro|';
  const field = (id, pagePath, extra) =>
    mark(`${FIELD}0`, `<label id="${id}" data-avb-p="${FIELD}0"><select id="${id}-control" data-avb-p="${FIELD}0.0 ${pagePath}"></select>${extra}</label>`);
  const page = collect(field('outer', '0.0', field('inner', '0.1', '')));
  assert.deepEqual(page.idsOf('0.0'), ['outer', 'outer-control']);
  assert.deepEqual(page.idsOf('0.1'), ['inner', 'inner-control']);
});
