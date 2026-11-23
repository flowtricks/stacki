// Goal: the words a component prints from a prop draw no hover outline of their own (the pointer on them is the instance's hover:
// docs/canvas-closed-component-text.md), and a click picks them with nothing selected, not only after the component is selected. A prop bound to code
// the editor cannot follow shows a refused look instead. Words a component writes itself (no prop
// or slot of the instance reaches them) get nothing: they are the component's own hover.
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
// A range around words is the box they are drawn in: their element's `data-words`, else its own box (words fill it).
window.Range.prototype.getBoundingClientRect = function wordsBox() {
  const holder = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
  return boxOf({ getAttribute: (name) => (name === 'data-box' ? (holder.getAttribute('data-words') ?? holder.getAttribute('data-box')) : undefined) });
};
// The innermost element whose box holds the point, as the browser's hit test answers.
document.elementFromPoint = (x, y) => {
  const inside = [...document.querySelectorAll('[data-box]')].filter((element) => {
    const box = boxOf(element);
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });
  return inside.at(-1) ?? undefined;
};

const containsPoint = (element, x, y) => {
  const [left, top, width, height] = element.getAttribute('data-box').split(',').map(Number);
  return x >= left && x <= left + width && y >= top && y < top + height;
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
const { installTextMarks, regions, findTextHit } = loadRenderer('test/helpers/frameTextEntry.js');
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

// A component's own words draw no outline of their own on hover (the pointer on them is the instance's hover), but a click still
// picks them: the pick carries the box and the name.
const clickAt = (x, y) => {
  move(500, 250);
  window.dispatchEvent(new window.MouseEvent('click', { clientX: 500, clientY: 250 }));
  move(x, y);
  assert.equal(posted.at(-1).hover, undefined, "no hover outline over a component's own words");
  window.dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y }));
  return posted.at(-1).picked;
};

test('prop text under the pointer draws no hover of its own, and a click picks it with nothing selected', () => {
  const picked = clickAt(40, 40);
  assert.ok(picked, 'the heading is picked before its Card is selected');
  assert.deepEqual([picked.kind, picked.x, picked.y, picked.w, picked.h], ['component', 20, 20, 300, 40], 'the pick is the words box, named for the component');
  assert.equal(picked.label, 'Heading');
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
  assert.equal(posted.at(-1).hover, undefined, 'slot text draws no hover of its own');
  const picked = clickAt(40, 160);
  assert.ok(picked, 'a click picks slot text before selection');
  assert.equal(picked.y, 140);
  assert.equal(picked.scope, '0.1', 'and names the instance it belongs to');
});

test('words a component draws that no prop or slot reaches get no outline, no label and no double click', () => {
  move(40, 230);
  assert.equal(posted.at(-1).hover, undefined, "the pointer on them is the component's own hover");
  const words = document.querySelector('[data-avb-p="Input.astro|0.0.1"]');
  assert.equal(findTextHit(CATALOG, { target: words, clientX: 40, clientY: 230 }), undefined, 'a double click opens no editor on them');
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
    const picked = clickAt(40, 40);
    assert.ok(picked, `picked with ${[...selected]} selected`);
    assert.equal(picked.label, 'Heading');
  }
  focus = new Set();
});

test('nothing is hovered while a button is held down: a drag or a resize is in flight', () => {
  move(500, 250);
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 40, clientY: 40, buttons: 1 }));
  assert.equal(posted.at(-1).hover, undefined);
  move(40, 40);
  assert.equal(posted.at(-1).hover, undefined, 'and still no hover of its own once the button is up');
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

test('words under a link stretched over the whole component are still the ones hovered and double clicked', () => {
  // A card whose link covers it (`::after` over the card): the topmost element at every point is the link, never the words beneath.
  const link = document.createElement('a');
  link.setAttribute('data-avb-p', 'Button.astro|0 0.1.9');
  link.setAttribute('data-box', '0,0,600,300');
  const innermost = document.elementFromPoint;
  // The link lies inside the instance whose words it covers, as a stretched link does.
  (document.querySelector('[data-avb-p~="0.1"]') ?? document.body).append(link);
  // The hit test as it was before the link was added: the words are in the stack beneath it.
  const beneath = (x, y) =>
    [...document.body.querySelectorAll('[data-box]')]
      .filter((element) => element !== link && innermost.call(document, x, y) !== undefined && containsPoint(element, x, y))
      .reverse();
  const stack = (x, y) => [link, ...beneath(x, y)];
  document.elementsFromPoint = stack;
  window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 2000, bottom: 2000, width: 2000, height: 2000, x: 0, y: 0 });
  try {
    move(500, 250);
    move(40, 40);
    window.dispatchEvent(new window.MouseEvent('click', { clientX: 40, clientY: 40 }));
    assert.equal(posted.at(-1).picked?.label, 'Heading', 'the words beneath the link are picked');
    const hit = findTextHit(CATALOG, { target: link, clientX: 40, clientY: 40 });
    assert.ok(hit, 'a double click on the stretched link resolves a text');
    assert.equal(hit.target.key, CATALOG.targets[0].key, 'and it is the words under the pointer, not the link text or the nearest one');
  } finally {
    delete document.elementsFromPoint;
    link.remove();
  }
});
