// Goal: text a page hands to the selected component instance is marked dashed at rest, and
// reports itself to the app as hovered or picked, named for the component whose root renders
// it or else for its class — the way the app names an element under the pointer.
// Method: a JSDOM page tagged like a rendered slider and button, boxes stubbed per element,
// animation frames run at once, and the frame's messages to the app collected and checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const PAGE = [
  '<section data-avb-p="Slider.astro|0 0.3" data-box="0,0,800,400">',
  '<h2 data-avb-p="Heading.astro|0 Slider.astro|0.0" data-box="20,40,400,60">Here for you.</h2>',
  '<a data-avb-p="Button.astro|0 0.4" class="button" data-box="20,200,200,50">',
  '<span class="button_main_text" data-avb-p="Button.astro|0.0" data-box="30,210,150,30">',
  'Learn more</span></a>',
  '</section>',
  '<h3 data-avb-p="Heading.astro|0 0.5" data-box="20,600,300,40">Solo words</h3>',
].join('');

function setUp() {
  const dom = new JSDOM(`<body>${PAGE}</body>`);
  const { window } = dom;
  for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
    global[name] =
      name === 'document' ? window.document : name === 'window' ? window : window[name];
  }
  global.NodeFilter = window.NodeFilter;
  // Frames run at once; a zero handle reads as "none pending", as after a real frame.
  global.requestAnimationFrame = (run) => {
    run(0);
    return 0;
  };
  window.Element.prototype.getBoundingClientRect = function boxOf() {
    const box = (this.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number);
    const [left, top, width, height] = box;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
  };
  return dom;
}

const TARGETS = [
  { key: 'slot', path: '0.3.0', parent: '0.3', value: 'Here for you.', from: 'slot', scope: '0.3' },
  {
    key: 'prop',
    path: 'Button.astro|0.0#0',
    parent: 'Button.astro|0.0',
    value: 'Learn more',
    segment: 0,
  },
  {
    key: 'root',
    path: '0.5.0',
    parent: '0.5',
    value: 'Solo words',
    from: 'slot',
    scope: '0.5',
  },
].map((target) => ({
  kind: target.from === 'slot' ? 'component' : 'element',
  label: 'Edit text',
  nested: false,
  tag: target.from === 'slot' ? 'Slider' : 'span',
  siblings: [],
  from: 'prop',
  scope: '0.4',
  ...target,
}));

// One page for the file: the frame's tag index is module state, as it is in a frame.
const dom = setUp();
let focus = new Set(['0.3']);
let editing;
let editingElement;
const posted = [];
const { installTextMarks } = loadRenderer('electron/preload/frameTextMarks.ts');
const redraw = installTextMarks({
  catalog: () => ({
    type: 'avb:text-catalog',
    session: 's',
    file: 'f',
    checksum: 'c',
    targets: TARGETS,
  }),
  editing: () => editing,
  editingElement: () => editingElement,
  focus: () => focus,
  visible: () => true,
  post: (message) => posted.push(message),
});
const layer = () => document.querySelector('[data-avb-text-marks]');
const select = (...paths) => {
  focus = new Set(paths);
  redraw();
};
const move = (x, y) =>
  dom.window.dispatchEvent(new dom.window.MouseEvent('pointermove', { clientX: x, clientY: y }));
const click = (x, y) =>
  dom.window.dispatchEvent(new dom.window.MouseEvent('click', { clientX: x, clientY: y }));

test('only the selected instance marks its text, dashed at rest', () => {
  select('0.3');
  assert.equal(layer().children.length, 1, 'the slider marks its heading');
  assert.match(layer().children[0].style.border, /dashed/);
  select('0.3.0');
  assert.equal(layer().children.length, 0, 'a selected child marks nothing');
  select('0.5');
  assert.equal(layer().children.length, 0, "a component's own root is the selection, unmarked");
});

test('hovering and clicking report the text the way the app names elements', () => {
  select('0.3', '0.4');
  move(50, 60);
  const hovered = posted.at(-1);
  assert.deepEqual(
    [hovered.hover.label, hovered.hover.kind, hovered.hover.y, hovered.picked],
    ['Heading', 'component', 40, undefined],
    'a component root is named for its component',
  );
  assert.equal(layer().children.length, 1, 'the hovered text leaves its dash to the app');
  click(40, 220);
  const picked = posted.at(-1).picked;
  assert.deepEqual([picked.label, picked.kind], ['button_main_text', 'text'], 'a plain element');
  move(700, 380);
  assert.equal(posted.at(-1).hover, undefined, 'off the text, nothing is hovered');
  assert.equal(posted.at(-1).picked.label, 'button_main_text', 'the pick stays');
  click(700, 380);
  assert.equal(posted.at(-1).picked, undefined, 'a click elsewhere drops it');
});

test('the text being typed in stays picked while the editor is open', () => {
  select('0.3');
  editing = 'slot';
  editingElement = document.querySelector('h2');
  // Typing changes the words: the editor's element still says which text it is.
  editingElement.firstChild.data = 'Here for you, always.';
  move(50, 60);
  const typing = posted.at(-1);
  assert.equal(typing.picked.label, 'Heading', 'its parent keeps the picked look');
  assert.deepEqual(
    typing.hover,
    typing.picked,
    'the pointer over the editor is on the picked text, which the app neither tints nor outlines',
  );
  assert.equal(layer().children.length, 0, 'no dash under the editor');
  editing = undefined;
  editingElement.firstChild.data = 'Here for you.';
  editingElement = undefined;
  click(700, 380);
  assert.equal(posted.at(-1).picked, undefined);
});
