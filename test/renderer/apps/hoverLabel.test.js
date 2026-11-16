// Goal: a hover label names the element under the pointer, as the Navigator names a row, never the
// component whose markup merely contains it.
// - Naming: a plain tag is its tag, a tag with classes its first authored class (`.card-body`), build
//   classes never name it, custom elements and namespaced tags keep their spelling, a Fragment-less
//   instance inside a component is that component's name.
// - Frame: a <p> in HomeHero's own template hovers as `p` "in HomeHero"; the Heading instance inside
//   it hovers as `Heading`; HomeHero's own root element keeps the instance (the page owns it); the
//   page's own markup is untouched.
// - Parity: the label equals the Navigator's elementLabel for the same tag and classes.
// Method: jsdom pages written as the marker serializer writes them, the frame modules, and the
// shared parsers; the hover message's `within` round trips through parseWithin.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const load = require('../../helpers/rendererModule');

const frame = load('test/fixtures/apps/frameLayersEntry.ts');
const { elementHoverNode, parseWithin } = load('shared/properties/deepOutline.ts');
const { elementLabel } = load('src/editor/classNames.ts');

const HERO = 'src/components/HomeHero.astro|';
const HEADING = 'src/components/Heading.astro|';
const PAGE =
  `<!doctype html><body><!--avb-s:0--><!--avb-s:${HERO}0--><section class="hero" id="root">` +
  `<!--avb-s:${HERO}0.0--><!--avb-s:${HEADING}0--><h2 id="heading">Hi</h2><!--avb-e:${HEADING}0--><!--avb-e:${HERO}0.0-->` +
  `<!--avb-s:${HERO}0.1--><p id="plain">Build</p><!--avb-e:${HERO}0.1-->` +
  `<!--avb-s:${HERO}0.2--><p class="astro-x1 card-body lead" id="classed">Rank</p><!--avb-e:${HERO}0.2-->` +
  `</section><!--avb-e:${HERO}0--><!--avb-e:0--><!--avb-s:1--><h1 id="own">Own</h1><!--avb-e:1--></body>`;

test('names: tag, first authored class, custom and namespaced tags', () => {
  assert.deepEqual(elementHoverNode('P', ''), { kind: 'element', label: 'p', tag: 'p' });
  assert.deepEqual(elementHoverNode('P', 'card-body'), { kind: 'element', label: '.card-body', tag: 'p' });
  assert.deepEqual(elementHoverNode('p', 'astro-abc card-body lead'), { kind: 'element', label: '.card-body', tag: 'p' });
  assert.deepEqual(elementHoverNode('p', 'astro-abc'), { kind: 'element', label: 'p', tag: 'p' });
  assert.deepEqual(elementHoverNode('MY-WIDGET', ''), { kind: 'element', label: 'my-widget', tag: 'my-widget' });
  assert.equal(elementHoverNode('svg:rect', '').label, 'svg:rect');
  assert.equal(parseWithin(''), undefined);
  assert.equal(parseWithin('x'.repeat(500)), undefined);
  assert.equal(parseWithin(7), undefined);
  assert.equal(parseWithin('HomeHero'), 'HomeHero');
});

test('parity: the label is the Navigator row name', () => {
  for (const [tag, classes] of [
    ['p', ''],
    ['p', 'card-body lead'],
    ['section', 'hero'],
    ['div', ''],
  ]) {
    const row = elementLabel({ name: tag, props: classes === '' ? {} : { class: { type: 'string', value: classes } } });
    assert.equal(elementHoverNode(tag, classes).label, row, `${tag}.${classes}`);
  }
});

test('frame: a p in HomeHero hovers as p in HomeHero; Heading stays Heading; the root stays the instance', () => {
  const dom = new JSDOM(PAGE);
  global.document = dom.window.document;
  global.Element = dom.window.Element;
  global.Node = dom.window.Node;
  try {
    frame.setTracking({ paths: [], scope: '', focus: '', occurrence: 0 });
    frame.resetFocusCache();
    frame.collectRegions();
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'normal' });
    const plain = frame.deepHoverAt(document.getElementById('plain'), '0');
    assert.deepEqual(plain.node, { kind: 'element', label: 'p', tag: 'p' });
    assert.equal(frame.hoverWithin(plain), 'HomeHero');
    assert.deepEqual(frame.deepHoverAt(document.getElementById('classed'), '0').node, { kind: 'element', label: '.card-body', tag: 'p' });
    const heading = frame.deepHoverAt(document.getElementById('heading'), '0');
    assert.deepEqual(heading.node, { kind: 'component', label: 'Heading', tag: undefined });
    assert.equal(frame.deepHoverAt(document.getElementById('root'), '0'), undefined, 'the instance root is the instance');
    assert.equal(frame.deepHoverAt(document.getElementById('own'), '1'), undefined, 'the page own element stays its own');
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'deep' });
    assert.equal(frame.hoverWithin(frame.deepHoverAt(document.getElementById('plain'), '0')), undefined, 'deep mode says no hint');
    frame.receiveOutlineMode({ type: 'avb:outline-mode', mode: 'normal' });
  } finally {
    dom.window.close();
  }
});
