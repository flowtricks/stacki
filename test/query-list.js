// The query dropdown: what it offers, and editing a query from it.
//
//   node test/query-list.js
//
// The dropdown above the style panel is how you get INTO a query to write a
// rule there. It used to list only the queries this element already had styles
// in — a door that opens from the far side: a component with a
// `prefers-reduced-motion` block offered it on the one element already inside
// it, and nowhere else in the same file. So it lists the queries the file being
// written into already uses, whoever is selected.
//
// And a breakpoint is one idea written in several places: a component with four
// `@media (width >= 64rem)` blocks has ONE breakpoint in it, spelled four times.
// Changing it by hand means finding every spelling, and missing one splits the
// breakpoint in two without saying so. The pencil on the row renames all of them
// at once, to anything you can type.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Two queries, neither of them used by `.plain` — and the reduced-motion one
// written twice, once at the top level and once nested inside a rule.
const SHEET = `.card {
  color: red;
}
@media (prefers-reduced-motion: reduce) {
  .card { transition: none }
}
@container (width > 40em) {
  .card { display: grid }
}
.plain {
  color: blue;
  @media (prefers-reduced-motion: reduce) {
    animation: none;
  }
}
`;

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });

  // ── The rewrite itself ────────────────────────────────────────────────────
  // No panel, no DOM: given a stylesheet, what does renaming a query do to it.
  {
    const cssBundle = path.join(buildDir, 'query-css.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'css.ts')],
      outfile: cssBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { parseRegion, renameAtRuleQuery, countAtRuleQuery, splitQuery } = require(cssBundle);
    const regionOf = (css) => {
      const region = { start: 0, end: css.length, css, root: null, openTag: '<style>' };
      parseRegion(region);
      return region;
    };

    const region = regionOf(SHEET);
    check(
      'a query written twice is counted twice',
      countAtRuleQuery(region, '@media (prefers-reduced-motion: reduce)') === 2,
      String(countAtRuleQuery(region, '@media (prefers-reduced-motion: reduce)'))
    );
    const n = renameAtRuleQuery(region, '@media (prefers-reduced-motion: reduce)', '@media (prefers-reduced-motion: no-preference)');
    const out = region.root.toString();
    check('both blocks are renamed in one pass', n === 2, `${n} renamed`);
    check(
      'including the one nested inside a rule',
      !/: reduce\)/.test(out),
      out
    );
    check('and the new condition is what got written', (out.match(/no-preference/g) || []).length === 2, out);
    check('the rules inside are untouched', /transition: none/.test(out) && /animation: none/.test(out), out);
    check('an unrelated query is left alone', /@container \(width > 40em\)/.test(out), out);
    check(
      "and so is everybody else's formatting",
      /\.card \{\n  color: red;\n\}/.test(out),
      JSON.stringify(out.slice(0, 40))
    );

    // Spelled differently in two places, meant the same in both.
    const spaced = regionOf('@media (width>=64rem){.a{color:red}}\n@MEDIA (width >= 64rem) { .b { color: blue } }\n');
    const m = renameAtRuleQuery(spaced, '@media (width >= 64rem)', '@media (width >= 48rem)');
    check('whitespace and case in the at-name do not hide a match', m === 2, `${m} renamed`);
    check('both come out with the new condition', (spaced.root.toString().match(/48rem/g) || []).length === 2, spaced.root.toString());

    // A query can become another KIND of query — the field takes anything.
    const kind = regionOf('@media (width > 30em) { .a { color: red } }');
    renameAtRuleQuery(kind, '@media (width > 30em)', '@container card (width > 30em)');
    check(
      'and can be changed into a container query',
      /@container card \(width > 30em\)/.test(kind.root.toString()),
      kind.root.toString()
    );

    // Renaming something the file doesn't have changes nothing, and says so.
    const miss = regionOf('@media (width > 30em) { .a { color: red } }');
    check('a query that is not there renames nothing', renameAtRuleQuery(miss, '@media print', '@media screen') === 0);
    check('and the file is left exactly as it was', miss.root.toString() === '@media (width > 30em) { .a { color: red } }', miss.root.toString());

    // Text that isn't an at-rule can't be written into the file.
    check('a query has to start with @', splitQuery('width < 40em') === null);
    check('and is split into the parts postcss holds', JSON.stringify(splitQuery('@media (width < 40em)')) === '{"name":"media","params":"(width < 40em)"}', JSON.stringify(splitQuery('@media (width < 40em)')));
  }

  // ── Where each query sits in the list ─────────────────────────────────────
  // The open component's own queries lead the custom-query group, whatever order
  // they reached the panel in: they're the ones being worked on, and a query
  // arriving from a project-wide stylesheet is further away in every sense.
  {
    const nsBundle = path.join(buildDir, 'query-contexts.bundle.js');
    await esbuild.build({
      entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'lib', 'native-styles.ts')],
      outfile: nsBundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { buildStyleContexts } = require(nsBundle);
    // The far-away query is listed FIRST — if order alone decided, it would stay
    // first.
    const keys = ['', '@media (prefers-contrast: more)', '@container (width > 40em)', '@media (width > 90em)'];
    const styled = new Set(keys.slice(1));
    const own = new Set(['@container (width > 40em)', '@media (width > 90em)']);
    const labels = buildStyleContexts(keys, null, null, styled, own).map((c) => c.label);
    const idx = (re) => labels.findIndex((l) => re.test(l));
    check('Base leads the list', labels[0] === 'Base', labels.join(' | '));
    check(
      "the component's own queries come first",
      idx(/width > 40em/) < idx(/prefers-contrast/) && idx(/width > 90em/) < idx(/prefers-contrast/),
      labels.join(' | ')
    );
    check(
      'and among its own, the order the file has them is kept',
      idx(/width > 40em/) < idx(/width > 90em/),
      labels.join(' | ')
    );
    // With nothing owned, the list is what it always was.
    const plain = buildStyleContexts(keys, null, null, styled, new Set()).map((c) => c.label);
    check('with no component queries at all, order is left alone', plain.join('|') === ['Base', '@media (prefers-contrast: more)', '@container (width > 40em)', '@media (width > 90em)'].join('|'), plain.join(' | '));
  }

  // ── The dropdown ──────────────────────────────────────────────────────────
  const bundlePath = path.join(buildDir, 'query-list.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { default as EmbedEditor } from './EmbedEditor'\nexport { setHost } from './lib/host'`,
      resolveDir: path.join(__dirname, '..', 'src', 'style-panel'),
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.MutationObserver = dom.window.MutationObserver;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  class RO { observe() {} unobserve() {} disconnect() {} }
  global.ResizeObserver = RO;
  dom.window.ResizeObserver = RO;
  dom.window.Element.prototype.scrollIntoView = function () {};

  const FILE = { rel: 'src/styles/main.css', name: 'main.css', path: '/p/src/styles/main.css', size: 10 };
  // A second stylesheet, further from the element than the one being written
  // into: it styles `.plain` inside a query of its own.
  const OTHER = { rel: 'src/styles/late.css', name: 'late.css', path: '/p/src/styles/late.css', size: 10 };
  const LATE = '@container (width > 90em) {\n  .plain { color: green }\n}\n';
  let onDisk = SHEET;
  const writes = [];
  dom.window.avb = {
    listStyleFiles: async () => ({ files: [FILE, OTHER] }),
    listAstroStyleFiles: async () => ({ files: [] }),
    listAssets: async () => ({ entries: [] }),
    readStyleFile: async (filePath) => ({ css: filePath === OTHER.path ? LATE : onDisk }),
    writeStyleFile: async ({ css }) => { writes.push(css); onDisk = css; return { ok: true } },
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { EmbedEditor, setHost } = require(bundlePath);

  // `.plain` has a rule in this sheet, but no styles in either query.
  setHost({
    projectPath: '/p',
    nodes: [{ id: 'n1', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'plain' } } }],
    selectedId: 'n1',
    files: [FILE, OTHER],
    astroFiles: [],
    renderedClasses: ['plain'],
    pathOf: () => '0.1',
  });
  global.IS_REACT_ACT_ENVIRONMENT = false;
  const host = dom.window.document.getElementById('root');
  createRoot(host).render(React.createElement(EmbedEditor));
  await wait(700);

  const doc = dom.window.document;
  const openList = async () => {
    const trigger = [...host.querySelectorAll('button')].find((b) => /Base/.test(b.textContent || ''));
    trigger?.click();
    await wait(120);
  };
  const rows = () => [...doc.querySelectorAll('.u-select-option')];
  const rowText = () => rows().map((o) => (o.textContent || '').trim());

  await openList();
  const options = rowText();
  const has = (re) => options.some((o) => re.test(o));
  check('the dropdown opens', options.length > 0, `${options.length} options`);
  check('Base is offered', has(/^Base/), options.join(' | '));
  check(
    "a query the file uses is offered, though this element has nothing in it",
    has(/prefers-reduced-motion/),
    options.join(' | ')
  );
  check('and so is a container query', has(/width > 40em|container/), options.join(' | '));
  check('adding a new one is still offered', has(/Add query/i), options.join(' | '));
  // A query from another stylesheet is reachable too, but it isn't what's being
  // worked on — the open file's own queries lead.
  check('a query from another stylesheet is offered as well', has(/width > 90em/), options.join(' | '));
  const rowAt = (re) => options.findIndex((o) => re.test(o));
  check(
    "this file's queries come before another file's",
    rowAt(/width > 40em/) < rowAt(/width > 90em/) && rowAt(/prefers-reduced-motion/) < rowAt(/width > 90em/),
    options.join(' | ')
  );
  check('and Base still leads', rowAt(/^Base/) === 0, options.join(' | '));

  // ── Editing one ───────────────────────────────────────────────────────────
  const rowFor = (re) => rows().find((o) => re.test(o.textContent || ''));
  const pencil = (row) => row?.querySelector('.u-select-action');
  check('Base has nothing to rename', !pencil(rowFor(/^\s*Base/)), 'Base offered an edit control');
  const motionRow = rowFor(/prefers-reduced-motion/);
  check('a query the file holds offers an edit control', !!pencil(motionRow), rowText().join(' | '));

  pencil(motionRow)?.click();
  await wait(80);
  check('pressing it closes the list', rows().length === 0, `${rows().length} options still shown`);
  check(
    'and does not switch the panel into that query',
    /Base/.test(host.querySelector('.embed-editor_context-select')?.textContent || ''),
    host.querySelector('.embed-editor_context-select')?.textContent || ''
  );

  const field = host.querySelector('[aria-label="Query"]');
  check('a field opens holding the query', field?.value === '@media (prefers-reduced-motion: reduce)', field?.value);
  // A field holding a whole query has nothing to narrow — the list is there to
  // show what else this block could be, so it shows everything.
  const suggested = () => [...host.querySelectorAll('.embed-editor_suggest-item')].map((b) => (b.textContent || '').trim());
  check(
    'with the whole query typed, the list still offers the others',
    suggested().length > 3,
    suggested().join(' | ')
  );
  check(
    'including the file\'s other query',
    suggested().some((s) => /width > 40em/.test(s)),
    suggested().join(' | ')
  );
  check(
    'and common ones it does not use yet',
    suggested().some((s) => /prefers-color-scheme/.test(s)),
    suggested().join(' | ')
  );
  // Size first: breakpoints are what this list is reached for, over and over,
  // while hover and the prefers-* queries are set once and left alone.
  const at = (re) => suggested().findIndex((s) => re.test(s));
  check(
    'a container query outranks a preference query',
    at(/width > 40em/) < at(/prefers-reduced-motion/),
    suggested().join(' | ')
  );
  check(
    'and a width query outranks hover',
    at(/min-width|width [<>]/) < at(/hover: hover/),
    suggested().join(' | ')
  );
  check(
    'the file\'s own queries still come before the suggested ones',
    at(/width > 40em/) < at(/width < 50em/),
    suggested().join(' | ')
  );
  check(
    'saying how much a rename touches',
    /2 blocks/.test(host.querySelector('.embed-editor_add-query-count')?.textContent || ''),
    host.querySelector('.embed-editor_add-query-count')?.textContent || ''
  );

  // Type something the suggestion list never offered — the list is a shortcut,
  // not the set of allowed answers.
  const setValue = (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  };
  setValue(field, '@media (prefers-reduced-motion: no-preference) and (width > 20em)');
  await wait(40);
  const rename = [...host.querySelectorAll('button')].find((b) => /^Rename$/.test((b.textContent || '').trim()));
  check('the rename button is there', !!rename, host.textContent?.slice(0, 200));
  rename?.click();
  await wait(400);

  check('the file is written once', writes.length === 1, `${writes.length} writes`);
  const written = writes[writes.length - 1] || '';
  check(
    'every block that spelled the old query now spells the new one',
    (written.match(/no-preference\) and \(width > 20em\)/g) || []).length === 2,
    written
  );
  check('and none of them still says the old one', !/: reduce\)/.test(written), written);
  check('the rules inside came through unchanged', /transition: none/.test(written) && /animation: none/.test(written), written);
  check('the other query is left alone', /@container \(width > 40em\)/.test(written), written);

  if (failures.length) {
    console.error(`\nquery-list: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`query-list: ${checked} passed  [offered, renamed]`);
  process.exit(0);
})();
