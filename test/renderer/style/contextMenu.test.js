// The style-context dropdown: which rows it lists, how each row's trailing
// markers line up, and the two-line form of a query nested inside a rule.
//
//   node test/renderer/style/contextMenu.test.js
//
// Goal, in three parts.
//
// 1. The list names only queries that are authored. A phone-width canvas used to
//    add "Mobile (L)", and a tablet one "Tablet", though no stylesheet held either
//    query. An authored query that equals a preset's is listed once, never beside
//    a second spelling of itself.
// 2. Every row of a list ends with the same fixed slots in the same order: the
//    dot slot, then the end slot that holds the check or the row's pencil. A row
//    without a dot or a check keeps its slot empty, so the dots stand in one
//    column and the check and the pencil in the one after it.
// 3. A query nested inside a rule reads as two lines, the wrapping selector over
//    the query, in the list and the closed trigger alike; Base and a top-level
//    query stay one line.
//
// Method: buildStyleContexts on plain keys (no DOM); the shared Select mounted in
// jsdom and its rows read back; queryPlacementOf and contextWrappers on rules
// parsed by the same postcss the module walks (bundled together, so the node
// classes are the module's own).

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const settle = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// ── 1. Which rows are listed ────────────────────────────────────────────────
{
  const { buildStyleContexts } = load('src/features/style/model/nativeStyles.ts');
  const labelsOf = (contexts) => contexts.map((context) => context.label);
  const PRESET_LABELS = ['Tablet', 'Mobile (L)', 'Mobile', 'Desktop ≥1920', 'Desktop ≥1440', 'Desktop ≥1280'];

  // Only authored, styled custom queries: no preset row appears.
  const keys = ['', '@media (width < 42rem)', '@media (width < 50rem)'];
  const styled = new Set(keys.slice(1));
  const plain = buildStyleContexts(keys, undefined, styled, new Set());
  assert.deepEqual(labelsOf(plain), ['Base', '@media (width < 42rem)', '@media (width < 50rem)'], 'Base and the authored queries, nothing else');
  for (const preset of PRESET_LABELS) {
    assert.ok(!labelsOf(plain).includes(preset), `no unauthored ${preset} row`);
  }
  assert.equal(buildStyleContexts.length, 2, 'there is no device argument: the canvas width cannot add a row');

  // Nothing authored at all: Base alone.
  assert.deepEqual(labelsOf(buildStyleContexts([''], undefined, new Set(), new Set())), ['Base'], 'an empty project lists only Base');

  // A preset's query that IS authored is listed, once, though spelled twice.
  const presetKeys = ['', '@media (max-width: 767px)', '@media (max-width:767px)', '@media (width < 42rem)'];
  const presetStyled = new Set(presetKeys.slice(1));
  const withPreset = buildStyleContexts(presetKeys, undefined, presetStyled, new Set());
  const mobileRows = withPreset.filter((context) => context.breakpoint === 'small');
  assert.equal(mobileRows.length, 1, 'an authored preset query is one row');
  assert.equal(mobileRows[0].embedAtContext, '@media (max-width: 767px)', 'the row writes into the authored block');
  assert.equal(new Set(withPreset.map((context) => context.key)).size, withPreset.length, 'no key is listed twice');

  // The same query with native values too is still one row.
  const native = { read: true, styles: [{ propsByContext: new Map([['small|', new Map([['color', { value: 'red', isVariable: false }]])]]) }] };
  const both = buildStyleContexts(presetKeys, native, presetStyled, new Set());
  assert.equal(both.filter((context) => context.breakpoint === 'small').length, 1, 'native values and an authored query share one row');

  // A preset query in the file but not styled for the element, and not the
  // file's own, is not listed (the same terms as any custom query).
  const unstyled = buildStyleContexts(['', '@media (max-width: 991px)'], undefined, new Set(), new Set());
  assert.deepEqual(labelsOf(unstyled), ['Base'], 'an unstyled preset query is not listed');
}

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/context-menu');
  fs.mkdirSync(buildDirectory, { recursive: true });

  // ── 3a. The wrapping selector, from the parsed rules ──────────────────────
  {
    const bundle = path.join(buildDirectory, 'query-wrapper.js');
    await esbuild.build({
      stdin: {
        contents: `export * from './src/features/style/model/queryWrapper.ts'; export { parse } from 'postcss';`,
        resolveDir: repoPath('.'),
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const { parse, queryPlacementOf, contextWrappers } = require(bundle);
    const CSS = `
      @media (width < 42rem) { .top { color: red } }
      .developer_layout {
        @media (width < 42rem) { gap: 1rem; }
        .card { @media (width < 50rem) { color: blue } }
      }
      .other { @media (width < 60rem) { color: green } }
      .third { @media (width < 60rem) { color: teal } }
      @container (width > 40em) { .inner { @media print { color: black } } }
    `;
    const root = parse(CSS);
    // Rules shaped like the parser's: the innermost rule (or the query itself for
    // a nested query's bare declarations), its at-context, its declarations.
    const rules = [];
    root.walk((node) => {
      if (node.type !== 'rule' && !(node.type === 'atrule' && node.nodes?.some((child) => child.type === 'decl'))) {
        return;
      }
      if (node.type === 'rule' && !node.nodes.some((child) => child.type === 'decl')) {
        return;
      }
      const atContext = [];
      for (let parent = node.type === 'atrule' ? node : node.parent; parent && parent.type !== 'root'; parent = parent.parent) {
        if (parent.type === 'atrule') {
          atContext.unshift(`@${parent.name} ${parent.params}`);
        }
      }
      rules.push({ node, atContext, declarations: [{}] });
    });
    const byText = (pattern) => rules.find((rule) => pattern.test(rule.node.toString()));
    assert.deepEqual(queryPlacementOf(byText(/\.top/)), { kind: 'top-level' }, 'a top-level query has no wrapper');
    assert.deepEqual(queryPlacementOf(byText(/gap: 1rem/)), { kind: 'nested', wrapper: '.developer_layout' }, 'bare declarations in a nested query');
    assert.deepEqual(queryPlacementOf(byText(/color: blue/)), { kind: 'nested', wrapper: '.developer_layout .card' }, 'two rules deep, outermost first');
    assert.deepEqual(queryPlacementOf(byText(/color: black/)), { kind: 'nested', wrapper: '.inner' }, 'stops at the next query up');
    const unconditional = { node: parse('.plain { color: red }').first, atContext: [], declarations: [{}] };
    assert.deepEqual(queryPlacementOf(unconditional), { kind: 'none' }, 'a rule in no query has no placement');

    const model = (list) => ({ base: [], conditional: list.map((rule) => ({ rule })), matchedRuleCount: list.length });
    const nestedOnly = contextWrappers(model([byText(/gap: 1rem/)]), ['@media (width < 42rem)']);
    assert.equal(nestedOnly.get('@media (width < 42rem)'), '.developer_layout', 'one nested placement: its wrapper');
    const mixed = contextWrappers(model([byText(/gap: 1rem/), byText(/\.top/)]), ['@media (width < 42rem)']);
    assert.equal(mixed.has('@media (width < 42rem)'), false, 'nested and top-level together: one line');
    const twoWrappers = contextWrappers(model([byText(/color: green/), byText(/color: teal/)]), ['@media (width < 60rem)']);
    assert.equal(twoWrappers.has('@media (width < 60rem)'), false, 'two different wrappers: one line');
    const unasked = contextWrappers(model([byText(/gap: 1rem/)]), []);
    assert.equal(unasked.size, 0, 'a context not asked about is not answered');
  }

  // ── 2 and 3b. The rows, in the real Select ────────────────────────────────
  const bundlePath = path.join(buildDirectory, 'select.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/components/Select.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const Select = require(bundlePath).default;

  const mount = async (value, options) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Select, { value, options, onChange: () => {} }));
      await settle();
    });
    await act(async () => {
      host.querySelector('.u-select-button').click();
      await settle();
    });
    return { host, root };
  };
  const trailing = (row) => [...row.children].slice(-2).map((child) => child.className);

  // A context list: Base selected and styled, a nested styled query with a pencil,
  // a top-level query with neither a dot nor a pencil.
  const contextOptions = [
    { value: '', label: 'Base', marked: true },
    {
      value: '@media (width < 42rem)',
      label: '@media (width < 42rem)',
      overline: '.developer_layout',
      marked: true,
      action: { icon: 'P', label: 'Edit', onSelect: () => {} },
    },
    { value: '@media (width < 50rem)', label: '@media (width < 50rem)' },
  ];
  {
    const { host, root } = await mount('', contextOptions);
    const rows = [...host.querySelectorAll('.u-select-option')];
    assert.equal(rows.length, 3, 'every option is a row');
    for (const row of rows) {
      assert.deepEqual(trailing(row), ['u-select-dot-slot', 'u-select-check'], `${row.textContent}: the dot slot, then the end slot, ending the row`);
    }
    const [base, nested, plain] = rows;
    assert.ok(base.querySelector('.u-select-dot-slot > .u-select-dot'), 'Base has its dot in the slot');
    assert.ok(base.querySelector('.u-select-check > svg'), 'Base, selected, has its check in the end slot');
    assert.ok(nested.querySelector('.u-select-dot-slot > .u-select-dot'), 'the styled query has its dot in the same slot');
    assert.ok(nested.querySelector('.u-select-check > .u-select-action'), 'its pencil sits in the end slot, the check column');
    assert.equal(nested.querySelector('.u-select-check > svg') ?? undefined, undefined, 'an unselected row draws no check');
    assert.equal(plain.querySelector('.u-select-dot-slot').children.length, 0, 'a row with no dot keeps its slot, empty');
    assert.equal(plain.querySelector('.u-select-check').children.length, 0, 'a row with no check or pencil keeps its slot, empty');
    assert.ok(nested.classList.contains('has-action'), 'a row with an action says so, so its check can give way to it');

    // Two lines for the nested query, in order; one for Base and the top-level query.
    const lines = (row) => [...row.querySelector('.u-select-label').children].map((child) => [child.className, child.textContent]);
    assert.deepEqual(
      lines(nested),
      [
        ['u-select-overline', '.developer_layout'],
        ['u-select-label-line', '@media (width < 42rem)'],
      ],
      'nested: the wrapping selector, then the query',
    );
    assert.equal(base.querySelector('.u-select-overline') ?? undefined, undefined, 'Base is one line');
    assert.equal(plain.querySelector('.u-select-overline') ?? undefined, undefined, 'a top-level query is one line');
    assert.equal(plain.querySelector('.u-select-label').textContent, '@media (width < 50rem)', 'its one line is the query');
    await act(async () => root.unmount());
    host.remove();
  }
  {
    // The closed trigger agrees with its row.
    const { host, root } = await mount('@media (width < 42rem)', contextOptions);
    const label = host.querySelector('.u-select-button .u-select-label');
    assert.deepEqual(
      [...label.children].map((child) => child.textContent),
      ['.developer_layout', '@media (width < 42rem)'],
      'the trigger shows the same two lines',
    );
    await act(async () => root.unmount());
    host.remove();
  }
  {
    const { host, root } = await mount('@media (width < 50rem)', contextOptions);
    assert.equal(host.querySelector('.u-select-button .u-select-overline') ?? undefined, undefined, 'a top-level query in the trigger is one line');
    await act(async () => root.unmount());
    host.remove();
  }
  {
    // A list with no dots anywhere holds no dot column, so its rows carry no gap.
    const { host, root } = await mount('a', [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' },
    ]);
    for (const row of host.querySelectorAll('.u-select-option')) {
      assert.equal(row.querySelector('.u-select-dot-slot') ?? undefined, undefined, 'no dot slot in a list without dots');
      assert.ok(row.lastElementChild.classList.contains('u-select-check'), 'the end slot still ends the row');
    }
    await act(async () => root.unmount());
    host.remove();
  }

  // Both lines start at one left edge. jsdom lays nothing out, so this reads the
  // rule itself: the two-line column stretches its lines and aligns their text to
  // the start, overriding the centred text a <button> trigger inherits.
  {
    const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
    const block = /\.u-select-label\.has-overline \{([^}]*)\}/.exec(css);
    assert.ok(block, 'the two-line label has its own rule');
    assert.match(block[1], /flex-direction: column;/, 'the lines stack in one column');
    assert.match(block[1], /align-items: stretch;/, 'each line spans the column');
    assert.match(block[1], /text-align: start;/, 'and starts at its left edge, not centred');
    assert.doesNotMatch(block[1], /align-items: center/, 'no line is centred in the column');
  }

  dom.window.close();
  console.log('context-menu: passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
