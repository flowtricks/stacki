// Goal: the label of text inside the selected (closed) component follows one rule, as in 1.4.5 plus
// the tag fallback: a component's own root is named for that component (cube, green), any other
// element by its first authored class (`.home-hero_cta-support`), and an element with no usable
// class (build `astro-*` classes ignored) by its TAG (`p`), never by the enclosing component.
// Method: a JSDOM page tagged like a rendered HomeHero (its own template's elements carry
// `HomeHero.astro|0.N` paths, a nested Heading instance carries its root path too), boxes
// stubbed, the frame's hover messages collected and their labels read.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const PAGE = [
  '<section data-avb-p="HomeHero.astro|0 0.1" data-box="0,0,800,600">',
  '<h2 data-avb-p="Heading.astro|0 HomeHero.astro|0.0" data-box="20,20,400,40">Title</h2>',
  '<p data-avb-p="HomeHero.astro|0.1" data-box="20,100,400,40">Build your brand</p>',
  '<p data-avb-p="HomeHero.astro|0.2 Wrap.astro|0.3" data-box="20,200,400,40">Two files</p>',
  '<p class="astro-x1y2" data-avb-p="HomeHero.astro|0.3" data-box="20,300,400,40">Build class only</p>',
  '<p class="astro-x1y2 home-hero_cta-support" data-avb-p="HomeHero.astro|0.4" data-box="20,400,400,40">Start building</p>',
  '</section>',
].join('');

const dom = new JSDOM(`<body>${PAGE}</body>`);
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
  global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
global.NodeFilter = dom.window.NodeFilter;
global.requestAnimationFrame = (run) => {
  run(0);
  return 0;
};
dom.window.Element.prototype.getBoundingClientRect = function boxOf() {
  const [left, top, width, height] = (this.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};

// jsdom's Range has no layout. The marks measure the words themselves with a Range, so a Range reports the box of the
// element holding the words it starts in: the same boxes the elements above report, which is what a bare word fills.
dom.window.Range.prototype.getBoundingClientRect = function boxOfWords() {
  const holder = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
  return holder.getBoundingClientRect();
};

const targets = ['Title', 'Build your brand', 'Two files', 'Build class only', 'Start building'].map((value, index) => ({
  kind: 'component',
  label: 'Edit text',
  nested: false,
  tag: 'HomeHero',
  siblings: [],
  from: 'slot',
  key: `t${index}`,
  path: `0.1.${index}`,
  parent: '0.1',
  value,
  scope: '0.1',
}));
const posted = [];
const { installTextMarks } = loadRenderer('electron/preload/frameTextMarks.ts');
const redraw = installTextMarks({
  catalog: () => ({ type: 'avb:text-catalog', session: 's', file: 'f', checksum: 'c', targets }),
  editing: () => undefined,
  editingElement: () => undefined,
  focus: () => new Set(['0.1']),
  visible: () => true,
  post: (message) => posted.push(message),
});
redraw();
// Hovering words draws no outline of their own (a component's own words are the instance's hover), so the name the app gives an
// element is read from the pick a click makes.
const hoverAt = (y) => {
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: 50, clientY: y }));
  assert.equal(posted.at(-1).hover, undefined, 'no hover outline of its own over words');
  dom.window.dispatchEvent(new dom.window.MouseEvent('click', { clientX: 50, clientY: y }));
  return posted.at(-1).picked;
};

test('closed HomeHero selected: a nested component root is named for its component', () => {
  assert.deepEqual([hoverAt(30).label, hoverAt(30).kind], ['Heading', 'component']);
});

test('a classless p is its tag, not the enclosing component', () => {
  const hover = hoverAt(110);
  assert.deepEqual([hover.label, hover.kind], ['p', 'text']);
});

test('a p tagged by a second file but not that file root is still its tag', () => {
  assert.equal(hoverAt(210).label, 'p');
});

test('build classes never name an element', () => {
  assert.equal(hoverAt(310).label, 'p');
});

test('a classed element is its first authored class', () => {
  const hover = hoverAt(410);
  assert.deepEqual([hover.label, hover.kind], ['.home-hero_cta-support', 'text']);
});
