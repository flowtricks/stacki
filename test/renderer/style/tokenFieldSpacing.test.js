// The spaces in a value drawn as coloured code.
//
//   node test/renderer/style/tokenFieldSpacing.test.js
//
// Goal: a value in the Variables panel reads exactly as it is written.
// `rgb(255 255 255 / 0.09)` was drawn `rgb(255255255/0.09)` and
// `color-mix(in lab, currentcolor 8%, transparent)` as `color-mix(inlab,…`.
// The DOM still held the spaces; the layout dropped them. The single-line field
// is a flex row, so every bare text run between two coloured spans is an
// anonymous flex item, and a flex item trims the whitespace at its edges and
// drops a run that is only whitespace.
//
// Method: jsdom has no layout, so the test checks the shape that layout needs:
// no whitespace may sit in a text node that is a direct child of the field (an
// anonymous flex item); every space lives in an element. Then the value is read
// back the way the field reads it after an edit (repainted from its own text,
// then serialized), and it has to come back byte for byte. The CSS rule that
// gives the space element its width is checked last.

const fs = require('fs');
const path = require('path');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const entry = path.join(buildDirectory, 'token-field-spacing.entry.jsx');
  fs.writeFileSync(
    entry,
    [
      `export { buildTokenHtml, serializeTokens } from ${JSON.stringify(repoPath('src/features/style/VariableConnect.tsx'))};`,
      `export { chipsOf, fieldText, paint } from ${JSON.stringify(repoPath('src/features/style/TokenField.tsx'))};`,
      `export { highlightCss } from ${JSON.stringify(repoPath('src/features/style/model/cssCode.ts'))};`,
      '',
    ].join('\n'),
  );
  const out = path.join(buildDirectory, 'token-field-spacing.bundle.js');
  await esbuild.build({
    entryPoints: [entry],
    outfile: out,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.tsx': 'tsx', '.ts': 'ts', '.jsx': 'jsx', '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.MutationObserver = dom.window.MutationObserver;
  global.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  global.Node = dom.window.Node;
  global.HTMLElement = dom.window.HTMLElement;

  const { buildTokenHtml, serializeTokens, chipsOf, fieldText, paint, highlightCss } = require(out);
  const host = dom.window.document.getElementById('root');
  const chip = (name) => ({ text: `var(--${name})`, name, type: 'Size' });

  // Text nodes the flex row would trim or drop: direct children of the field
  // that hold whitespace. Zero-width caret slots are not whitespace to CSS.
  const exposedSpaces = () =>
    [...host.childNodes]
      .filter((node) => node.nodeType === dom.window.Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .filter((text) => /\s/.test(text.replace(/​/g, '')));

  const CASES = [
    { what: 'rgb() with spaces and a slash', value: 'rgb(255 255 255 / 0.09)', chips: [] },
    { what: 'color-mix(in lab, …)', value: 'color-mix(in lab, currentcolor 8%, transparent)', chips: [] },
    { what: 'clamp() with operators', value: 'clamp(1rem, 0.5rem + 2vw, 3rem * 1.5)', chips: [] },
    { what: 'color-mix() around a chip', value: 'color-mix(in lab, var(--text) 62%, transparent)', chips: [chip('text')] },
    {
      what: 'nested var() chips',
      value: 'clamp(var(--size-min), calc(var(--size-fluid) * 2 + 1vw), var(--size-max))',
      chips: [chip('size-min'), chip('size-fluid'), chip('size-max')],
    },
    { what: 'two chips and a gap', value: 'var(--a) var(--b)', chips: [chip('a'), chip('b')] },
    { what: 'a run of spaces', value: 'rgb(0   0 0)', chips: [] },
  ];

  for (const { what, value, chips } of CASES) {
    // Drawn as the field first draws it.
    host.innerHTML = buildTokenHtml(value, chips, true);
    check(`${what}: every space is in an element`, exposedSpaces().length === 0, JSON.stringify(exposedSpaces()) + '\n    ' + host.innerHTML);
    check(`${what}: reads back unchanged`, serializeTokens(host, value, value) === value, serializeTokens(host, value, value));

    // Repainted from its own text, as it is on every keystroke of an edit.
    paint(host, fieldText(host), undefined, chipsOf(host));
    check(`${what}: repainted, every space is in an element`, exposedSpaces().length === 0, JSON.stringify(exposedSpaces()) + '\n    ' + host.innerHTML);
    check(`${what}: repainted, reads back unchanged`, serializeTokens(host, value, value) === value, serializeTokens(host, value, value));
  }

  // Colouring alone, without a field: stripping the markup gives the value back.
  for (const { value } of CASES) {
    const text = highlightCss(value)
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
    check(`paint keeps "${value}"`, text === value, JSON.stringify(text));
  }
  // The negative space: a value with no whitespace gains no space elements.
  check('no space, no element', !highlightCss('rgb(0,0,0)').includes('cx-space'), highlightCss('rgb(0,0,0)'));
  // And the spaces are elements, not escaped or rewritten text.
  check('a space is wrapped as written', highlightCss('a  b').includes('<span class="cx-space">  </span>'), highlightCss('a  b'));

  // --- the rule that gives the space its width ------------------------------------
  const css = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
  const at = css.indexOf('.cx-space {');
  check('the space rule exists', at >= 0);
  const rule = css.slice(at, css.indexOf('}', at));
  check("the space keeps its width against the field's nowrap", /white-space:\s*pre;/.test(rule), rule);

  if (failures.length) {
    console.error(`\ntoken-field-spacing: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`token-field-spacing: ${checked} passed  [spaces in coloured values]`);
  process.exit(0);
})();
