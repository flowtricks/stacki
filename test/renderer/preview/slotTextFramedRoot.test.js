// Goal: slot words that a component renders straight into its own root are outlined on hover when that root frames them
// (padding or a border: a Button's `<a class="button"><slot /></a>`), and the outline is the words' own box, never the
// button's; a root that is only its words (a Heading's `<h2><slot /></h2>`, no padding, no border) stays the component's
// own hover (docs/canvas-closed-component-text.md). The pointer on the padding is the component, not its words.
// Method: a JSDOM page tagged as the preview renders a page of two Buttons and a Heading, with per-element boxes, a box
// for each run of words (the range the frame measures), computed padding read from a `data-pad` attribute, a stubbed
// `elementFromPoint`, animation frames run at once; the frame's `avb:text-marks` messages are collected and checked, with
// nothing selected and with the first Button selected. The planner's slot targets reach the frame as the editor sends them.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { isEditableThroughProps, textReach } = require('#dist/shared/properties/closedComponentReach.js');

const PAGE = [
  '<section data-avb-p="0" data-box="0,0,800,400">',
  '<a class="button" data-avb-p="Button.astro|0 0.0" data-box="20,20,300,60" data-words="48,36,244,24" data-pad="14px 28px">Start your free flight</a>',
  '<a class="button" data-avb-p="Button.astro|0 0.1" data-box="20,100,300,60" data-words="48,116,120,24" data-border="1px">Second</a>',
  '<h2 data-avb-p="Heading.astro|0 0.2" data-box="20,180,300,40" data-words="20,180,200,40">Plain heading</h2>',
  '</section>',
].join('');

const dom = new JSDOM(`<body>${PAGE}</body>`);
const { window } = dom;
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
  global[name] = name === 'document' ? window.document : name === 'window' ? window : window[name];
}
global.NodeFilter = window.NodeFilter;
global.location = window.location;
global.CSSStyleSheet = class {
  replaceSync() {}
};
window.document.adoptedStyleSheets = [];
global.requestAnimationFrame = (run) => {
  run(0);
  return 0;
};
const box = (text) => {
  const [left, top, width, height] = (text ?? '0,0,0,0').split(',').map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};
window.Element.prototype.getBoundingClientRect = function elementBox() {
  return box(this.getAttribute('data-box'));
};
// A range around an element's words is the box its words are drawn in.
window.Range.prototype.getBoundingClientRect = function wordsBox() {
  const owner = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
  return box(owner.getAttribute('data-words'));
};
// Padding and border as the page's stylesheet would compute them: `data-pad` for padding, `data-border` for a border.
window.getComputedStyle = (element) => ({
  getPropertyValue: (name) => {
    if (name.startsWith('padding-')) {
      return element.getAttribute('data-pad')?.split(' ')[0] ?? '0px';
    }
    if (name.startsWith('border-')) {
      return element.getAttribute('data-border') ?? '0px';
    }
    return '';
  },
});
document.elementFromPoint = (x, y) => {
  const inside = [...document.querySelectorAll('[data-box]')].filter((element) => {
    const found = box(element.getAttribute('data-box'));
    return x >= found.left && x <= found.right && y >= found.top && y <= found.bottom;
  });
  return inside.at(-1) ?? undefined;
};

// Slot targets as `canvasTextTarget` builds them for `<Button>Words</Button>`: the parent and the scope are the instance.
const slot = (instance, value, tag) => ({
  kind: 'component',
  key: `${instance}.0`,
  path: `${instance}.0`,
  parent: instance,
  value,
  label: 'Edit text',
  tag,
  siblings: [],
  nested: false,
  from: 'slot',
  scope: instance,
});
const CATALOG = {
  type: 'avb:text-catalog',
  session: 's',
  file: 'f',
  checksum: 'c',
  targets: [slot('0.0', 'Start your free flight', 'Button'), slot('0.1', 'Second', 'Button'), slot('0.2', 'Plain heading', 'Heading')],
};

let focus = new Set();
const posted = [];
const { installTextMarks } = loadRenderer('test/helpers/frameTextEntry.js');
installTextMarks({
  catalog: () => CATALOG,
  editing: () => undefined,
  editingElement: () => undefined,
  focus: () => focus,
  visible: () => true,
  post: (message) => posted.push(message),
});
const hoverAt = (x, y) => {
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 5000, clientY: 5000 }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
  return posted.at(-1)?.hover;
};

test('slot words reach the instance through its slot, so they are offered', () => {
  for (const target of CATALOG.targets) {
    assert.equal(textReach({ loaded: true, covering: target }), 'slot');
    assert.equal(isEditableThroughProps(textReach({ loaded: true, covering: target })), true);
  }
});

test('words a padded root frames are outlined on hover, the outline hugging the words', () => {
  focus = new Set();
  const hover = hoverAt(100, 48);
  assert.deepEqual({ x: hover?.x, y: hover?.y, w: hover?.w, h: hover?.h, scope: hover?.scope }, { x: 48, y: 36, w: 244, h: 24, scope: '0.0' });
});

test('a border alone frames the words too', () => {
  focus = new Set();
  const hover = hoverAt(60, 128);
  assert.deepEqual({ x: hover?.x, w: hover?.w, scope: hover?.scope }, { x: 48, w: 120, scope: '0.1' });
});

test('the pointer on the padding is the component, not its words', () => {
  focus = new Set();
  assert.equal(hoverAt(25, 25), undefined);
  assert.equal(hoverAt(310, 75), undefined);
});

test('a root with neither padding nor a border is its words: no outline of their own', () => {
  focus = new Set();
  assert.equal(hoverAt(60, 200), undefined);
});

test('with the Button selected its words are still hovered and marked at rest at their own size', () => {
  focus = new Set(['0.0']);
  const hover = hoverAt(100, 48);
  assert.deepEqual({ x: hover?.x, w: hover?.w, scope: hover?.scope }, { x: 48, w: 244, scope: '0.0' });
  hoverAt(5000, 5000);
  const mark = document.querySelector('[data-avb-text-marks]')?.children[0];
  assert.ok(mark, 'the selected Button marks its words');
  assert.equal(mark.style.left, '48px');
  assert.equal(mark.style.width, '244px');
});

test('a click on the framed words picks them with their own box', () => {
  focus = new Set();
  hoverAt(100, 48);
  window.dispatchEvent(new window.MouseEvent('click', { clientX: 100, clientY: 48 }));
  const picked = posted.at(-1)?.picked;
  assert.deepEqual({ x: picked?.x, w: picked?.w, scope: picked?.scope }, { x: 48, w: 244, scope: '0.0' });
});
