// Goal: pointing at the words inside a closed component draws the component's own hover (its
// green fill) and the words' outline and tag together, in the same render, whether or not
// anything is selected; the component's hover is not drawn twice for the selection itself.
// Method: render the real overlays to static markup with a hovered Button instance and a text
// hover inside it, with nothing selected and with another element selected, and read which
// outlines are drawn.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/text-hover-parent.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`,
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
const { PreviewOverlays } = require(output);

const BUTTON = { x: 100, y: 100, w: 180, h: 44 };
const WORDS = { x: 120, y: 110, w: 100, h: 20, kind: 'text', label: '.button_text', scope: '0.3' };
const INFO = {
  label: 'Button',
  kind: 'component',
  tag: undefined,
  astroAsset: false,
  dynamicTag: false,
  nodeKind: 'component',
  isLayout: false,
  bound: false,
};

function render(selected) {
  return renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.3: [BUTTON], 0.5: [{ x: 0, y: 400, w: 300, h: 40 }] },
      spacing: {},
      scale: 1,
      selPath: selected,
      selOcc: 0,
      hoverPath: '0.3',
      hoverOcc: 0,
      focusPath: undefined,
      focusWhole: false,
      textMarks: { hover: WORDS, picked: undefined },
      overlayInfo: () => INFO,
    }),
  );
}

const outlines = (markup) =>
  [...markup.matchAll(/class="(node-outline [^"]*)"/g)].map((match) => match[1]).filter((name) => !name.startsWith('node-outline-tag'));

test('with nothing selected, the closed component and its words are both drawn', () => {
  const drawn = outlines(render(undefined));
  assert.ok(
    drawn.some((name) => name.includes('hover component') && !name.includes('text-mark')),
    `the component hover is drawn: ${drawn}`,
  );
  assert.ok(
    drawn.some((name) => name.includes('hover component text-mark')),
    `the words hover is drawn: ${drawn}`,
  );
});

test('with another element selected, both are still drawn', () => {
  const drawn = outlines(render('0.5'));
  assert.ok(drawn.some((name) => name.includes('hover') && !name.includes('text-mark')));
  assert.ok(drawn.some((name) => name.includes('text-mark')));
});

test('hovering the selected component draws no second component outline over its own selection', () => {
  const drawn = outlines(render('0.3'));
  assert.equal(drawn.filter((name) => name.startsWith('node-outline hover') && !name.includes('text-mark')).length, 0);
  assert.ok(drawn.some((name) => name.includes('text-mark')));
});

test('the owning instance reads as the field around its words: thick faint outline, no name tag', () => {
  for (const selected of [undefined, '0.5']) {
    const markup = render(selected);
    const owners = [...markup.matchAll(/class="(node-outline (?:hover|sel)[^"]*text-owner[^"]*)"/g)];
    assert.equal(owners.length, 1, `exactly the instance is drawn as the owner with ${selected} selected`);
  }
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf('\n}', css.indexOf(`\n${selector} {`)));
  assert.match(
    rule('.node-outline.text-owner'),
    /outline-width:\s*4px;[\s\S]*outline-color:\s*color-mix/,
    'the thick faint outline of text being edited, faint in its colour',
  );
  assert.match(rule('.node-outline.text-owner .node-outline-tag'), /display:\s*none;/, 'its name tag goes');
});

test('an ancestor that is selected is not tinted or marked for words that belong to another instance', () => {
  // The layout (0.5) is selected and the pointer is on the Button's words (scope 0.3).
  const markup = render('0.5');
  const selected = [...markup.matchAll(/class="(node-outline sel[^"]*)"/g)].map((match) => match[1]);
  assert.equal(selected.length, 1);
  assert.doesNotMatch(selected[0], /tinted|text-owner/, selected[0]);
});

// The matrix of what the owning Card draws: the selection (nothing, the Card, its words, the layout) by the pointer
// (on the Card's body, on its words). Each cell is one deliberate look.
function cardLook(selected, picked, pointerOnWords, hoverPath = '0.3') {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { 0.3: [BUTTON], 0.5: [{ x: 0, y: 400, w: 300, h: 40 }] },
      spacing: {},
      scale: 1,
      selPath: selected,
      selOcc: 0,
      hoverPath,
      hoverOcc: 0,
      focusPath: undefined,
      focusWhole: false,
      textMarks: { hover: pointerOnWords ? WORDS : undefined, picked: picked ? WORDS : undefined },
      overlayInfo: () => INFO,
    }),
  );
  return [...markup.matchAll(/class="(node-outline (?:hover|sel)[^"]*)"/g)].map((match) => match[1]).filter((name) => !name.includes('text-mark'));
}

test('matrix: the Card selected, pointer on its words: the selected outline and tag stay, no fill, no second outline', () => {
  const drawn = cardLook('0.3', false, true);
  assert.equal(drawn.length, 1, drawn.join(' | '));
  assert.match(drawn[0], /^node-outline sel component$/);
});

test('matrix: pointer on the words, the Card is the field around them whatever is selected', () => {
  for (const [selected, picked] of [
    [undefined, false],
    ['0.3', true],
    ['0.5', false],
  ]) {
    const drawn = cardLook(selected, picked, true).filter((name) => name.includes('text-owner'));
    assert.equal(drawn.length, 1, `selected ${selected} picked ${picked}`);
  }
});

test('matrix: words selected, pointer on the Card body, the Card is a plain green hover, not the pale parent look', () => {
  const drawn = cardLook('0.3', true, false);
  assert.equal(drawn.length, 1);
  assert.match(drawn[0], /sel component parent tinted/);
  assert.doesNotMatch(drawn[0], /text-owner/);
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  assert.match(css, /\.node-outline\.sel\.parent\.tinted:not\(\.text-owner\) \{\s*outline-color: var\(--green\);\s*outline-width: 1px;/);
});

test('matrix: a selected layout and a hovered Card on its body draw the Card hover and nothing owns words', () => {
  const drawn = cardLook('0.5', false, false);
  assert.ok(drawn.some((name) => name.startsWith('node-outline hover component')));
  assert.ok(drawn.every((name) => !name.includes('text-owner') && !name.includes('tinted')));
});

test('matrix: words selected, pointer on neither the words nor the Card, the Card rests as the faint field', () => {
  const drawn = cardLook('0.3', true, false, 'none');
  assert.equal(drawn.length, 1);
  assert.match(drawn[0], /sel component text-owner owner-tag parent/);
});

test('matrix: words selected, pointer on the words, the Card is the field beside the words hover', () => {
  const drawn = cardLook('0.3', true, true);
  assert.equal(drawn.filter((name) => name.includes('text-owner')).length, 1);
});

test('matrix: nothing selected and the Card selected without words picked keep their ordinary outlines', () => {
  assert.ok(cardLook(undefined, false, false).every((name) => !name.includes('text-owner')));
  assert.ok(cardLook('0.3', false, false, 'none').every((name) => !name.includes('text-owner')));
});
