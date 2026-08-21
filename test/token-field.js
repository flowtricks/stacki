// The field that draws a value's variables as chips.
//
//   node test/token-field.js
//
// `padding: var(--space-1) var(--space-2)` is two chips with a space between
// them. In the big editor that space was there; in the single-line field the two
// chips sat welded together and the caret could not be put between them.
//
// The cause is the layout: that field is a flex container (it centres a chip in a
// 26px row), and a flex container drops any run of text between two elements that
// is only whitespace — it never becomes a flex item, so the space had no width
// and no caret position. Inside an element it is an item like any other.
//
// The value must not change either way: what is drawn is a rendering of the
// declaration, and the declaration is what gets written back.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const entry = path.join(buildDir, 'token-field.entry.jsx');
  fs.writeFileSync(
    entry,
    `export { buildTokenHtml, serializeTokens } from ${JSON.stringify(
      path.join(__dirname, '..', 'src', 'style-panel', 'VariableConnect.tsx')
    )};\n`
  );
  const out = path.join(buildDir, 'token-field.bundle.js');
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
  global.ResizeObserver = class { observe() {} disconnect() {} };
  global.Node = dom.window.Node;
  global.HTMLElement = dom.window.HTMLElement;

  const { buildTokenHtml, serializeTokens } = require(out);

  const chip = (text, name) => ({ text, name, type: 'size' });
  const PADDING = 'var(--space-1) var(--space-2)';
  const chips = [chip('var(--space-1)', 'space-1'), chip('var(--space-2)', 'space-2')];

  const draw = (value, list, code) => {
    const host = dom.window.document.getElementById('root');
    host.innerHTML = buildTokenHtml(value, list, code);
    return host;
  };

  // --- the space between two chips ----------------------------------------------
  let host = draw(PADDING, chips);
  const spaces = () => [...host.querySelectorAll('.embed-editor_varconnect-space')];
  check('the space between two chips is an element', spaces().length === 1, host.innerHTML);
  check('holding exactly the space', spaces()[0]?.textContent === ' ', JSON.stringify(spaces()[0]?.textContent));
  check(
    'and sitting between them',
    spaces()[0]?.previousElementSibling?.dataset.chip === '1' &&
      spaces()[0]?.nextElementSibling?.dataset.chip === '1'
  );
  // What the caret needs: a text node of its own to land in.
  check(
    'with a text node to put a caret in',
    spaces()[0]?.firstChild?.nodeType === dom.window.Node.TEXT_NODE
  );

  // --- and the value it round-trips to -------------------------------------------
  const back = (root) => serializeTokens(root, PADDING, PADDING);
  check('the value comes back as it went in', back(host) === PADDING, back(host));

  host = draw(PADDING, chips, true);
  check('the same with syntax colouring on', host.querySelectorAll('.embed-editor_varconnect-space').length === 1, host.innerHTML);
  check('and it still round-trips', back(host) === PADDING, back(host));

  // --- runs that are NOT only whitespace are left alone --------------------------
  //
  // Text with anything else in it is already a flex item, and wrapping it would be
  // markup for its own sake.
  const border = '1px solid var(--line)';
  host = draw(border, [chip('var(--line)', 'line')]);
  check('a run with words in it is not wrapped', host.querySelectorAll('.embed-editor_varconnect-space').length === 0, host.innerHTML);
  check(
    'and that value round-trips too',
    serializeTokens(host, border, border) === border,
    serializeTokens(host, border, border)
  );

  // Three chips, two gaps — `inset` and `border-radius` are written this way.
  const inset = 'var(--a) var(--b) var(--c)';
  host = draw(inset, [chip('var(--a)', 'a'), chip('var(--b)', 'b'), chip('var(--c)', 'c')]);
  check('every gap gets one', host.querySelectorAll('.embed-editor_varconnect-space').length === 2, host.innerHTML);
  check('and three chips still round-trip', serializeTokens(host, inset, inset) === inset, serializeTokens(host, inset, inset));

  // A value that is one chip and nothing else keeps its zero-width caret slots,
  // which are what let you type in front of a variable that IS the whole value.
  host = draw('var(--only)', [chip('var(--only)', 'only')]);
  check('a lone chip is not given a space', host.querySelectorAll('.embed-editor_varconnect-space').length === 0);
  check(
    'but keeps its caret slots either side',
    (host.textContent.match(/​/g) || []).length === 2,
    JSON.stringify(host.textContent)
  );

  // --- the rule that makes it visible --------------------------------------------
  const css = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'style-panel', 'embed-editor.css'),
    'utf8'
  );
  const rule = css.slice(css.indexOf('.embed-editor_varconnect-space'));
  check(
    'the space keeps its width against the field\'s nowrap',
    /white-space:\s*pre/.test(rule.slice(0, rule.indexOf('}'))),
    rule.slice(0, rule.indexOf('}'))
  );

  if (failures.length) {
    console.error(`\ntoken-field: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`token-field: ${checked} passed  [chips, and the space between them]`);
  process.exit(0);
})();
