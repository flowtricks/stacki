// Goal: the colour of an outline follows who owns what it is drawn around, and nothing a component renders itself can be blue
// (docs/canvas-closed-component-text.md). The rule: content is page-owned (blue, `element`) only when the page wrote it, as a
// node of the open file or as children passed into a slot of the enclosing instance; everything else inside a component instance
// (its root, its own markup, a wrapper it draws around the slot, text from a prop) is the component's (green, `component`).
// Words the page wrote as text nodes into a slot (a recorded run) are slot-owned runs; that case needs the preview's markers and is
// pinned in the real window (test/electron/preload/slotTextHoverCanvas.test.js, Heading). Method, three layers. (1) The pure rule `outlineKind` / `ownershipOf` is pinned with literal subjects and path lists, including
// the assertion that fires when something inside a component with no slot ancestor would be plain. (2) A JSDOM page tagged as
// the preview renders it (a Button whose own `<span class="label">` wraps the slot words, a Heading whose root holds them, a
// page-authored `<em>` inside a slot, a Button nested in a Card's slot, a Button in a loop) is hovered, picked and typed in
// with the real frame code, and the `owner` each `avb:text-marks` message carries is read. (3) The real overlays are rendered to
// static markup with those marks (hover, pick, edit) and the classes of every outline are read: green for the component's own,
// blue only for slot-authored content, for every producer (text marks, nodes, pseudo-elements).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const { outlineKind, ownershipOf } = loadRenderer('shared/properties/outlineOwnership.ts');

test("page paths only: the element is slot content; any component path makes it the component's", () => {
  assert.equal(ownershipOf(['0.0.1']), 'slot');
  assert.equal(ownershipOf(['0.0', '0.1']), 'slot');
  assert.equal(ownershipOf(['src/components/Button.astro|0.1']), 'component');
  assert.equal(ownershipOf(['src/components/Button.astro|0', '0.0']), 'component');
  assert.equal(ownershipOf([]), 'component');
});

test('inside a component, outside a slot, the kind is the component whatever the node says', () => {
  for (const nodeKind of ['element', 'component', 'map']) {
    assert.equal(outlineKind({ insideComponent: true, insideSlot: false, nodeKind }), 'component', nodeKind);
  }
});

test("slot content and the open file's own nodes keep their own kind", () => {
  assert.equal(outlineKind({ insideComponent: true, insideSlot: true, nodeKind: 'element' }), 'element');
  assert.equal(outlineKind({ insideComponent: true, insideSlot: true, nodeKind: 'component' }), 'component');
  assert.equal(outlineKind({ insideComponent: false, insideSlot: false, nodeKind: 'element' }), 'element');
  assert.equal(outlineKind({ insideComponent: false, insideSlot: false, nodeKind: 'map' }), 'map');
});

test('a slot ancestor with no component around it is a programmer error that crashes', () => {
  assert.throws(() => outlineKind({ insideComponent: false, insideSlot: true, nodeKind: 'element' }), /slot ancestor needs a component/);
});

// ---- the frame ----
const PAGE = [
  '<section data-avb-p="0" data-box="0,0,800,600">',
  // A Button whose own wrapper span draws the label around the slot words: the span is the component's.
  '<a class="button" data-avb-p="Button.astro|0 0.0" data-box="20,20,300,60" data-pad="14px"><span class="label" data-avb-p="Button.astro|0.1" data-box="48,36,244,24" data-words="48,36,244,24">ALL BLOGS</span></a>',
  // A Heading whose root holds the slot words itself.
  '<h2 data-avb-p="Heading.astro|0 0.1" data-box="20,100,300,40" data-words="20,100,200,40">Meet the</h2>',
  // A Button whose slot words sit in an element only the page tagged (the markers around a slot, an element the page wrote).
  '<a class="button" data-avb-p="Button.astro|0 0.2" data-box="20,200,300,60" data-pad="14px"><em data-avb-p="0.2.0" data-box="48,216,100,24" data-words="48,216,100,24">Authored</em></a>',
  // A Button inside a Card's slot, and one in a loop.
  '<div data-avb-p="Card.astro|0 0.3" data-box="20,300,400,100"><a class="button" data-avb-p="Button.astro|0 0.3.0" data-box="30,310,200,60" data-pad="14px"><span data-avb-p="Button.astro|0.1" data-box="40,320,100,24" data-words="40,320,100,24">Nested</span></a></div>',
  '<a class="button" data-avb-p="Button.astro|0 0.4" data-box="20,420,300,60" data-pad="14px"><span data-avb-p="Button.astro|0.1" data-box="48,436,100,24" data-words="48,436,100,24">Looped</span></a>',
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
window.Range.prototype.getBoundingClientRect = function wordsBox() {
  const holder = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
  return box(holder.getAttribute('data-words') ?? holder.getAttribute('data-box'));
};
window.getComputedStyle = (element) => ({
  getPropertyValue: (name) => (name.startsWith('padding-') ? (element.getAttribute('data-pad') ?? '0px') : name.startsWith('border-') ? '0px' : ''),
});
document.elementFromPoint = (x, y) => {
  const inside = [...document.querySelectorAll('[data-box]')].filter((element) => {
    const found = box(element.getAttribute('data-box'));
    return x >= found.left && x <= found.right && y >= found.top && y <= found.bottom;
  });
  return inside.at(-1) ?? undefined;
};

const slot = (instance, value, tag) => ({
  kind: 'component',
  key: `${instance}.k`,
  path: `${instance}.k`,
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
  targets: [
    slot('0.0', 'ALL BLOGS', 'Button'),
    slot('0.1', 'Meet the', 'Heading'),
    slot('0.2', 'Authored', 'Button'),
    slot('0.3.0', 'Nested', 'Button'),
    slot('0.4', 'Looped', 'Button'),
  ],
};
const posted = [];
const { installTextMarks } = loadRenderer('test/helpers/frameTextEntry.js');
installTextMarks({
  catalog: () => CATALOG,
  editing: () => undefined,
  editingElement: () => undefined,
  focus: () => new Set(),
  focusCopy: () => undefined,
  visible: () => true,
  post: (message) => posted.push(message),
});
// Hovering words draws no outline of their own (a component's own words are the instance's hover), so what the frame says about
// words is read from the pick a click makes; the hover is asserted to stay empty.
const hoverAt = (x, y) => {
  window.dispatchEvent(new window.MouseEvent('click', { clientX: 5000, clientY: 5000 }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: 5000, clientY: 5000 }));
  window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
  assert.equal(posted.at(-1)?.hover, undefined, 'no hover outline of its own over words');
  window.dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y }));
  return posted.at(-1)?.picked;
};
const pickAt = (x, y) => {
  hoverAt(x, y);
  window.dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y }));
  return posted.at(-1)?.picked;
};

test("slot words a Button prints from a string into its own span (set:html, no run the page wrote) are the component's", () => {
  const hover = hoverAt(100, 48);
  assert.equal(hover?.owner, 'component');
  assert.equal(hover?.w, 244);
  assert.equal(pickAt(100, 48)?.owner, 'component');
});

test('a Heading that is only its words, with no run the page wrote, draws no text outline: its own (green) hover is the hover', () => {
  assert.equal(hoverAt(60, 120), undefined);
});

test('an element only the page tagged, inside an instance, is slot content', () => {
  assert.equal(hoverAt(60, 228)?.owner, 'slot');
});

test("a Button nested in a Card's slot and a Button in a loop print their words themselves: the component's", () => {
  assert.equal(hoverAt(60, 332)?.owner, 'component');
  assert.equal(hoverAt(60, 448)?.owner, 'component');
});

test("text a component renders from a prop, in its own element, is the component's", () => {
  const prop = { ...slot('0.0', 'ALL BLOGS', 'Button'), from: 'prop' };
  CATALOG.targets.splice(0, 1, prop);
  try {
    assert.equal(hoverAt(100, 48)?.owner, 'component');
    assert.equal(pickAt(100, 48)?.owner, 'component');
  } finally {
    CATALOG.targets.splice(0, 1, slot('0.0', 'ALL BLOGS', 'Button'));
  }
});

// ---- the overlays ----
const output = repoPath('node_modules/.stacki-test/outline-ownership.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: { contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`, resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PreviewOverlays } = require(output);

const mark = (owner) => ({ x: 48, y: 36, w: 244, h: 24, label: 'span', kind: 'text', scope: '0.0', owner });
function textMarkClasses(marks) {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: {},
      spacing: {},
      scale: 1,
      selPath: undefined,
      selOcc: 0,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      textMarks: marks,
      overlayInfo: () => undefined,
    }),
  );
  return [...markup.matchAll(/class="(node-outline [^"]*text-mark[^"]*)"/g)].map((match) => match[1]);
}

test("hover, pick and edit outlines of a component's own words are all green, never blue", () => {
  for (const marks of [
    { hover: mark('component'), picked: undefined },
    { hover: undefined, picked: mark('component') },
    { hover: mark('component'), picked: mark('component') },
  ]) {
    for (const classes of textMarkClasses(marks)) {
      assert.match(classes, /\bcomponent\b/);
      assert.doesNotMatch(classes, /\belement\b/);
    }
  }
});

test('an element the page wrote into a slot is the one blue text outline', () => {
  const [classes] = textMarkClasses({ hover: undefined, picked: mark('slot') });
  assert.match(classes, /\belement\b/);
  assert.doesNotMatch(classes, /\bcomponent\b/);
});

test("a text outline reported with no owner is the component's: blue cannot come from an absent field", () => {
  const [classes] = textMarkClasses({ hover: undefined, picked: { ...mark('component'), owner: undefined } });
  assert.match(classes, /\bcomponent\b/);
});

function allClasses({ selected, hovered, marks, kinds }) {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.1: [{ x: 20, y: 100, w: 300, h: 40 }], '0.1.0': [{ x: 30, y: 105, w: 60, h: 20 }] },
      spacing: {},
      scale: 1,
      selPath: selected,
      selOcc: 0,
      hoverPath: hovered,
      hoverOcc: hovered === undefined ? undefined : 0,
      focusPath: undefined,
      focusWhole: false,
      textMarks: marks,
      overlayInfo: (nodePath) => ({
        label: 'X',
        kind: kinds[nodePath],
        tag: 'a',
        astroAsset: false,
        dynamicTag: false,
        nodeKind: kinds[nodePath],
        isLayout: false,
        bound: false,
      }),
    }),
  );
  return [...markup.matchAll(/class="(node-outline [^"]*)"/g)].map((match) => match[1]).filter((name) => !name.startsWith('node-outline-tag'));
}

test('a selected Heading instance is green and the slot words picked inside it are a blue run, in the same render', () => {
  const classes = allClasses({ selected: '0.1', marks: { hover: undefined, picked: mark('slot') }, kinds: { 0.1: 'component' } });
  assert.ok(
    classes.some((name) => /\bsel\b/.test(name) && /\bcomponent\b/.test(name) && !name.includes('text-mark')),
    classes.join(' | '),
  );
  assert.ok(
    classes.some((name) => name.includes('text-mark') && /\belement\b/.test(name)),
    classes.join(' | '),
  );
});

test("a page's own span inside a Button's slot is a plain (blue) node, the Button around it green", () => {
  const classes = allClasses({ hovered: '0.1.0', selected: '0.1', marks: undefined, kinds: { 0.1: 'component', '0.1.0': 'element' } });
  assert.ok(
    classes.some((name) => /\bcomponent\b/.test(name)),
    classes.join(' | '),
  );
  assert.ok(
    classes.some((name) => /\bhover\b/.test(name) && /\belement\b/.test(name)),
    classes.join(' | '),
  );
});

test("while editing, the component's own words stay green and a slot run stays blue (the editor adds no colour of its own)", () => {
  assert.match(textMarkClasses({ hover: undefined, picked: mark('component') })[0], /\bcomponent\b/);
  assert.match(textMarkClasses({ hover: mark('slot'), picked: mark('slot') })[0], /\belement\b/);
});
