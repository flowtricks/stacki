// Goal: the words a component prints from a prop show their hover outline and name under the
// pointer with nothing selected, not only after the component is selected. A prop bound to code
// the editor cannot follow shows a muted, refused look instead; the page's own slot text and
// words outside every component are left to the element hover as before.
// Method: a JSDOM page tagged like a rendered Card and Button with per-element boxes, a stubbed
// `elementFromPoint`, animation frames run at once, no focus at all, and the frame's
// `avb:text-marks` messages to the app collected and checked.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const PAGE = [
  '<div data-avb-p="Card.astro|0.0 0.1" data-box="0,0,600,300">',
  '<h3 data-avb-p="Heading.astro|0 Card.astro|0.0.1" data-box="20,20,300,40">Card heading</h3>',
  '<p data-avb-p="Paragraph.astro|0 Card.astro|0.0.2" data-box="20,80,300,40">Computed words</p>',
  '<span data-avb-p="Slot.astro|0 0.1.0" data-box="20,140,300,40">Slot words</span>',
  '<span data-avb-p="Input.astro|0.0.1" data-box="20,200,300,40">Computed label</span>',
  '<h2 data-avb-p="Heading.astro|0 0.1.7" data-box="20,260,300,40">Heading is the words</h2>',
  '</div>',
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
const boxOf = (element) => {
  const [left, top, width, height] = (element.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};
window.Element.prototype.getBoundingClientRect = function box() {
  return boxOf(this);
};
// The innermost element whose box holds the point, as the browser's hit test answers.
document.elementFromPoint = (x, y) => {
  const inside = [...document.querySelectorAll('[data-box]')].filter((element) => {
    const box = boxOf(element);
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });
  return inside.at(-1) ?? undefined;
};

const target = (extra) => ({ kind: 'component', label: 'Edit text', nested: false, siblings: [], from: 'prop', scope: '0.1', ...extra });
const CATALOG = {
  type: 'avb:text-catalog',
  session: 's',
  file: 'f',
  checksum: 'c',
  targets: [
    target({
      key: 'prop:0.1:heading:Card.astro|0.0.1#0',
      path: 'Card.astro|0.0.1#0',
      parent: 'Card.astro|0.0.1',
      value: 'Card heading',
      segment: 0,
      tag: 'Heading',
    }),
    target({ key: 'slot', path: '0.1.0', parent: '0.1.0', value: 'Slot words', from: 'slot', tag: 'Slot' }),
  ],
  blocked: [{ key: 'prop:0.1:text:Card.astro|0.0.2', path: 'Card.astro|0.0.2' }],
};

let focus = new Set();
const posted = [];
// The region map and the marks share one bundle, as they share module state in a frame.
const { installTextMarks, regions } = loadRenderer('test/helpers/frameTextEntry.js');
regions.set('Card.astro|0.0.2', [[document.querySelector('p').firstChild]]);
installTextMarks({
  catalog: () => CATALOG,
  editing: () => undefined,
  editingElement: () => undefined,
  focus: () => focus,
  visible: () => true,
  post: (message) => posted.push(message),
});
const move = (x, y) => window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));

test('prop text under the pointer is hovered with nothing selected', () => {
  move(40, 40);
  const hover = posted.at(-1).hover;
  assert.ok(hover, 'the heading is hovered before its Card is selected');
  assert.deepEqual(
    [hover.kind, hover.x, hover.y, hover.w, hover.h],
    ['component', 20, 20, 300, 40],
    'the outline is the words box, named for the component that draws it',
  );
  assert.equal(hover.label, 'Heading');
  assert.equal(posted.at(-1).picked, undefined, 'hover picks nothing: a click still selects the component');
});

test('off the words nothing is hovered', () => {
  move(500, 250);
  assert.equal(posted.at(-1).hover, undefined);
});

test('a prop bound to code the editor cannot follow shows the refused look', () => {
  move(40, 100);
  const hover = posted.at(-1).hover;
  assert.ok(hover, 'the refused words are named too');
  assert.equal(hover.kind, 'refused');
  assert.equal(hover.y, 80);
});

test('words the page writes inside an unselected instance hover too (a Button label as its child text)', () => {
  move(40, 160);
  const hover = posted.at(-1).hover;
  assert.ok(hover, 'slot text hovers before selection');
  assert.equal(hover.y, 140);
  assert.equal(hover.scope, '0.1', 'and names the instance it belongs to');
});

test('words a component draws that no target covers hover muted, as refused', () => {
  move(40, 230);
  const hover = posted.at(-1).hover;
  assert.ok(hover);
  assert.equal(hover.kind, 'refused');
});

test("a component's own root that is only its words stays the component's hover, not a second outline", () => {
  move(40, 270);
  assert.equal(posted.at(-1).hover, undefined);
});

test('the words are still hovered with their own component selected, or any other element, after a click moved on', () => {
  for (const selected of [new Set(['0.1']), new Set(['0.9'])]) {
    focus = selected;
    // A click, then the pointer travels on: the click's gesture must not read as a drag still in flight.
    window.dispatchEvent(new window.MouseEvent('pointerdown', { clientX: 400, clientY: 250, buttons: 1 }));
    window.dispatchEvent(new window.MouseEvent('pointerup', { clientX: 400, clientY: 250, buttons: 0 }));
    move(500, 250);
    move(40, 40);
    const hover = posted.at(-1).hover;
    assert.ok(hover, `hovered with ${[...selected]} selected`);
    assert.equal(hover.label, 'Heading');
  }
  focus = new Set();
});

test('nothing is hovered while a button is held down: a drag or a resize is in flight', () => {
  move(500, 250);
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 40, clientY: 40, buttons: 1 }));
  assert.equal(posted.at(-1).hover, undefined);
  move(40, 40);
  assert.ok(posted.at(-1).hover, 'hovered again once the button is up');
});

test('one click on hovered prop text picks it at once, whatever is selected, and keeps it when the selection arrives', () => {
  for (const before of [new Set(), new Set(['0.9'])]) {
    focus = before;
    move(500, 250);
    window.dispatchEvent(new window.MouseEvent('click', { clientX: 40, clientY: 40 }));
    const picked = posted.at(-1).picked;
    assert.ok(picked, 'the words are picked by the first click, before the app has selected their instance');
    assert.equal(picked.label, 'Heading');
    // The app's selection follows a message later: the pick stays.
    focus = new Set(['0.1']);
    move(41, 41);
    assert.ok(posted.at(-1).picked, 'the pick survives the selection');
    // A click elsewhere drops it.
    window.dispatchEvent(new window.MouseEvent('click', { clientX: 500, clientY: 250 }));
    assert.equal(posted.at(-1).picked, undefined);
  }
  focus = new Set();
});
