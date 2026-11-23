// Goal (second part): the selected owner of words being edited is drawn green even when the Navigator calls its node a plain element
// (a dynamic tag, a fragment), because the frame names it as the instance that owns the words; a plain element with no words stays blue.
// Goal: a ::before or ::after outline reads as the component's (green, class `component`) when its host is a component
// instance or markup a component renders, and keeps the plain blue (`element`) on any other element; inside a
// component only a pseudo-element that renders text is offered at all (the pure rule `pseudoOffered`).
// Method: render the real overlays to static markup with a hovered pseudo-element for a component host, a host inside a
// component file (path with `|`) and a plain host, and read the classes drawn. The offer rule is pinned with literal
// `content` values: none, empty string, whitespace, text, an arrow, attr(), counter(), url(), on a component and a plain host.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/pseudo-outline-component.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents:
      `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';` +
      `export { pseudoPath } from './shared/page/pseudoPath';` +
      `export { pseudoOffered } from './electron/preload/pseudoHit';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
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
const { PreviewOverlays, pseudoPath, pseudoOffered } = require(output);

const info = (kind) => ({ label: 'X', kind, tag: 'a', astroAsset: false, dynamicTag: false, nodeKind: kind, isLayout: false, bound: false });

function drawn(hostPath, kind) {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { [pseudoPath(hostPath, 'after')]: [{ x: 10, y: 50, w: 20, h: 20 }] },
      spacing: {},
      scale: 1,
      selPath: undefined,
      selOcc: 0,
      hoverPath: hostPath,
      hoverOcc: 0,
      hoverPseudo: 'after',
      focusPath: undefined,
      focusWhole: false,
      overlayInfo: () => info(kind),
    }),
  );
  return [...markup.matchAll(/class="(node-outline [^"]*)"/g)].map((match) => match[1]);
}

test('a pseudo-element of a component instance is outlined as a component', () => {
  const classes = drawn('0.3', 'component');
  assert.equal(classes.length, 1);
  assert.match(classes[0], /\bcomponent\b/);
  assert.doesNotMatch(classes[0], /\belement\b/);
});

test('a pseudo-element of markup a component file renders is outlined as a component', () => {
  const classes = drawn('0.3|src/components/Button.astro|0.1', 'element');
  assert.match(classes[0], /\bcomponent\b/);
});

test('a pseudo-element of a plain element keeps the plain outline', () => {
  const classes = drawn('0.4', 'element');
  assert.match(classes[0], /\belement\b/);
  assert.doesNotMatch(classes[0], /\bcomponent\b/);
});

test('inside a component a pseudo-element with no text is not offered, with text it is', () => {
  for (const content of ['none', 'normal', '""', "''", '" "']) {
    assert.equal(pseudoOffered({ inComponent: true, content, pointerEvents: 'auto' }), false, `component, content ${content}`);
  }
  for (const content of ['"→"', '"Read"', 'attr(data-label)', 'counter(item)', 'counters(item, ".")', '"" "x"']) {
    assert.equal(pseudoOffered({ inComponent: true, content, pointerEvents: 'auto' }), true, `component, content ${content}`);
  }
  assert.equal(pseudoOffered({ inComponent: true, content: 'url("a.svg")', pointerEvents: 'auto' }), false);
});

test('on a plain element every drawn pseudo-element is offered, as before', () => {
  for (const content of ['""', 'none', '"→"', 'url("a.svg")']) {
    assert.equal(pseudoOffered({ inComponent: false, content, pointerEvents: 'auto' }), true, `plain, content ${content}`);
  }
});

function selected(hostKind, marks) {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.3: [{ x: 100, y: 100, w: 180, h: 44 }] },
      spacing: {},
      scale: 1,
      selPath: '0.3',
      selOcc: 0,
      hoverPath: undefined,
      hoverOcc: undefined,
      focusPath: undefined,
      focusWhole: false,
      textMarks: marks,
      overlayInfo: () => info(hostKind),
    }),
  );
  return [...markup.matchAll(/class="(node-outline [^"]*)"/g)].map((match) => match[1]).filter((name) => !name.includes('text-mark'));
}

const WORDS = { x: 120, y: 110, w: 100, h: 20, kind: 'component', label: 'Button', scope: '0.3' };

test('words picked in an instance the Navigator calls an element still draw that instance as a component', () => {
  const classes = selected('element', { hover: undefined, picked: WORDS });
  assert.equal(classes.length, 1);
  assert.match(classes[0], /\bcomponent\b/);
  assert.match(classes[0], /\bparent\b/);
});

test('an element with no words of its own keeps the plain outline', () => {
  const classes = selected('element', { hover: undefined, picked: { ...WORDS, scope: '0.9' } });
  assert.doesNotMatch(classes[0], /\bcomponent\b/);
  const none = selected('element', undefined);
  assert.doesNotMatch(none[0], /\bcomponent\b/);
});

test('pointer-events none is never offered: not hit, not hovered, with or without text, in a component or not', () => {
  for (const inComponent of [true, false]) {
    for (const content of ['""', '"→"', 'none']) {
      assert.equal(pseudoOffered({ inComponent, content, pointerEvents: 'none' }), false, `${inComponent} ${content}`);
    }
  }
});

test('pointer-events auto, or any other value that reaches the pointer, keeps the pseudo-element hit-testable', () => {
  for (const pointerEvents of ['auto', 'all', 'visiblePainted', 'fill']) {
    assert.equal(pseudoOffered({ inComponent: false, content: '""', pointerEvents }), true, pointerEvents);
  }
});

// Slot content belongs to the page: the outline of picked words follows who wrote them, not the instance around them.
function textMarkClasses(picked) {
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
      textMarks: { hover: undefined, picked },
      overlayInfo: () => undefined,
    }),
  );
  return [...markup.matchAll(/class="(node-outline [^"]*text-mark[^"]*)"/g)].map((match) => match[1]);
}

const MARK = { x: 10, y: 10, w: 80, h: 20, label: 'Heading', scope: '0.1' };

test('words the page passes into an instance (slot) are outlined blue, as a plain element', () => {
  const [classes] = textMarkClasses({ ...MARK, kind: 'text', from: 'slot' });
  assert.match(classes, /\belement\b/);
  assert.doesNotMatch(classes, /\bcomponent\b/);
});

test("slot words that fill the instance root are still the page's, so blue", () => {
  const [classes] = textMarkClasses({ ...MARK, kind: 'component', from: 'slot' });
  assert.match(classes, /\belement\b/);
});

test("a component's own text (a prop it renders) and its own root stay green", () => {
  assert.match(textMarkClasses({ ...MARK, kind: 'text', from: 'prop' })[0], /\bcomponent\b/);
  assert.match(textMarkClasses({ ...MARK, kind: 'component' })[0], /\bcomponent\b/);
});

test('a nested instance inside a slot is green on its own root, and its own slot words are blue', () => {
  assert.match(textMarkClasses({ ...MARK, kind: 'component', scope: '0.1.2' })[0], /\bcomponent\b/);
  assert.match(textMarkClasses({ ...MARK, kind: 'text', from: 'slot', scope: '0.1.2' })[0], /\belement\b/);
});
