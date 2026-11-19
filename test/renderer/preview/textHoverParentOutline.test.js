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
  for (const selected of [undefined, '0.5', '0.3']) {
    const markup = render(selected);
    const owners = [...markup.matchAll(/class="(node-outline (?:hover|sel)[^"]*text-owner[^"]*)"/g)];
    assert.equal(owners.length, 1, `exactly the instance is drawn as the owner with ${selected} selected`);
  }
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf('\n}', css.indexOf(`\n${selector} {`)));
  assert.match(rule('.node-outline.text-owner'), /outline-width:\s*4px;[\s\S]*opacity:\s*0\.2;/, 'the thick faint outline of text being edited');
  assert.match(rule('.node-outline.text-owner .node-outline-tag'), /display:\s*none;/, 'its name tag goes');
});

test('an ancestor that is selected is not tinted or marked for words that belong to another instance', () => {
  // The layout (0.5) is selected and the pointer is on the Button's words (scope 0.3).
  const markup = render('0.5');
  const selected = [...markup.matchAll(/class="(node-outline sel[^"]*)"/g)].map((match) => match[1]);
  assert.equal(selected.length, 1);
  assert.doesNotMatch(selected[0], /tinted|text-owner/, selected[0]);
});
