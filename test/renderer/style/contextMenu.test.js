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
// 4. Each query context is a PLACE: a query at the top level and the same query
//    nested inside `.developer_layout` are two rows, and the same query in two
//    stylesheets is two rows, each naming its stylesheet with a source chip. The
//    wrapper comes from where the block is written, never from whether the
//    selected element has styles there. A nested row is listed only where it can
//    reach the element: the element is the wrapper or sits inside it.
//
// Method: buildStyleContexts on plain and placed keys (no DOM); the shared Select
// mounted in jsdom and its rows read back; the placement model and the reach
// check run on rules parsed by the same postcss the module walks (bundled
// together, so the node classes are the module's own), the reach check against
// a hand-built page tree like the pigeon test project's.

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

  // ── 3a and 4. Where each query is written, from the parsed rules ─────────
  {
    const bundle = path.join(buildDirectory, 'query-wrapper.js');
    await esbuild.build({
      stdin: {
        contents: [
          `export * from './src/features/style/model/queryWrapper.ts';`,
          `export * from './src/features/style/model/queryReach.ts';`,
          `export { listAtRuleBlocks, parseRegion, createRuleInPlacedQuery } from './src/features/style/model/css.ts';`,
          `export { buildStyleContexts } from './src/features/style/model/nativeStyles.ts';`,
          `export { parse } from 'postcss';`,
        ].join('\n'),
        resolveDir: repoPath('.'),
        loader: 'ts',
      },
      outfile: bundle,
      bundle: true,
      format: 'cjs',
      platform: 'node',
      logLevel: 'silent',
    });
    const queryModel = require(bundle);
    const { parse, queryPlacementOf } = queryModel;
    const CSS = `
      @media (width < 42rem) { .top { color: red } }
      .developer_layout {
        @media (width < 42rem) { gap: 1rem; }
        .card { @media (width < 50rem) { color: blue } }
      }
      .other { @media (width < 60rem) { color: green } }
      .third { @media (width < 60rem) { color: teal } }
      @container (width > 40em) { .inner { @media print { color: black } } }
      .outer { @media (width > 10rem) { .mid { @media (width < 90rem) { color: navy } } } }
      .faq { &:hover { @media (hover: hover) { color: plum } } }
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
      rules.push({ node, atContext, declarations: [{}], embedKey: 'file:/p/a.css' });
    });
    const byText = (pattern) => rules.find((rule) => pattern.test(rule.node.toString()));
    assert.deepEqual(queryPlacementOf(byText(/\.top/)), { kind: 'top-level' }, 'a top-level query has no wrapper');
    assert.deepEqual(queryPlacementOf(byText(/gap: 1rem/)), { kind: 'nested', wrapper: '.developer_layout' }, 'bare declarations in a nested query');
    assert.deepEqual(queryPlacementOf(byText(/color: blue/)), { kind: 'nested', wrapper: '.developer_layout .card' }, 'two rules deep, outermost first');
    assert.deepEqual(queryPlacementOf(byText(/color: black/)), { kind: 'nested', wrapper: '.inner' }, 'a rule between two queries wraps the inner one');
    assert.deepEqual(
      queryPlacementOf(byText(/color: navy/)),
      { kind: 'nested', wrapper: '.outer .mid' },
      'every rule above the query wraps it, across queries',
    );
    assert.deepEqual(queryPlacementOf(byText(/color: plum/)), { kind: 'nested', wrapper: '.faq:hover' }, '`&` resolves through nesting');
    const unconditional = { node: parse('.plain { color: red }').first, atContext: [], declarations: [{}] };
    assert.deepEqual(queryPlacementOf(unconditional), { kind: 'none' }, 'a rule in no query has no placement');

    // Keys: a top-level query keeps its chain; a nested one names its wrapper; a
    // stylesheet's row names the stylesheet; each reads back into its parts.
    const nestedKey = queryModel.placedContextKey('@media (width < 42rem)', { kind: 'nested', wrapper: '.developer_layout' });
    assert.equal(queryModel.placedContextKey('@media (width < 42rem)', { kind: 'top-level' }), '@media (width < 42rem)', 'a top-level key is its chain');
    assert.notEqual(nestedKey, '@media (width < 42rem)', 'the nested place has a key of its own');
    assert.deepEqual(queryModel.nestedQueryOfKey(nestedKey), { wrapper: '.developer_layout', atContext: '@media (width < 42rem)' }, 'a nested key reads back');
    const sourced = queryModel.sourcedContextKey(nestedKey, 'astro:/p/src/pages/index.astro');
    assert.deepEqual(queryModel.splitSourcedKey(sourced), { placed: nestedKey, source: 'astro:/p/src/pages/index.astro' }, 'a sourced key reads back');
    assert.deepEqual(queryModel.nestedQueryOfKey(sourced), { wrapper: '.developer_layout', atContext: '@media (width < 42rem)' }, 'and stays nested');
    for (const plain of ['', 'bp:small', '@media (width < 42rem)', '@container card (width > 1px)']) {
      assert.equal(queryModel.nestedQueryOfKey(plain), undefined, `${JSON.stringify(plain)} is not nested`);
    }
    assert.equal(
      queryModel.renameQueryInContextKey(sourced, '@media (width < 42rem)', '@media (width < 40rem)'),
      queryModel.sourcedContextKey(
        queryModel.placedContextKey('@media (width < 40rem)', { kind: 'nested', wrapper: '.developer_layout' }),
        'astro:/p/src/pages/index.astro',
      ),
      'a rename keeps the wrapper and the stylesheet',
    );
    assert.deepEqual(
      queryModel.placementOfPath([
        { kind: 'selector', selector: '.hero' },
        { kind: 'atrule', name: 'media', params: 'print' },
      ]),
      {
        kind: 'nested',
        wrapper: '.hero',
      },
      'a typed path inside a rule is nested',
    );
    assert.deepEqual(
      queryModel.placementOfPath([
        { kind: 'atrule', name: 'media', params: 'print' },
        { kind: 'selector', selector: '.hero' },
      ]),
      { kind: 'top-level' },
      'a typed query around a rule is top-level',
    );
    assert.throws(() => queryModel.placedContextKey('width < 4px', { kind: 'top-level' }), /an at-context names a query/, 'a key is only made for a query');

    // The same query at the top level and nested: two rows, the nested one two-line.
    const topKey = queryModel.sourcedContextKey('@media (width < 42rem)', 'file:/p/a.css');
    const nestedRow = queryModel.sourcedContextKey(nestedKey, 'file:/p/a.css');
    const both = queryModel.buildStyleContexts(['', topKey, nestedRow], undefined, new Set([topKey, nestedRow]), new Set());
    assert.equal(both.length, 3, 'Base, the top-level query and the nested one');
    assert.deepEqual(
      both.map((context) => context.wrapper),
      [undefined, undefined, '.developer_layout'],
      'only the nested row has a wrapper',
    );
    assert.deepEqual(
      both.slice(1).map((context) => context.embedAtContext),
      ['@media (width < 42rem)', '@media (width < 42rem)'],
      'both write into the same query text',
    );
    // The same query in two stylesheets: two rows, each naming its stylesheet.
    const otherFile = queryModel.sourcedContextKey('@media (width < 42rem)', 'astro:/p/src/components/Button.astro');
    const twoSources = queryModel.buildStyleContexts(['', topKey, otherFile], undefined, new Set([topKey, otherFile]), new Set());
    assert.deepEqual(
      twoSources.slice(1).map((context) => context.source),
      ['file:/p/a.css', 'astro:/p/src/components/Button.astro'],
      'one row per stylesheet',
    );
    // Under two wrappers: two nested rows.
    const underOther = queryModel.sourcedContextKey(
      queryModel.placedContextKey('@media (width < 60rem)', { kind: 'nested', wrapper: '.other' }),
      'file:/p/a.css',
    );
    const underThird = queryModel.sourcedContextKey(
      queryModel.placedContextKey('@media (width < 60rem)', { kind: 'nested', wrapper: '.third' }),
      'file:/p/a.css',
    );
    const twoWrappers = queryModel.buildStyleContexts(['', underOther, underThird], undefined, new Set([underOther, underThird]), new Set());
    assert.deepEqual(
      twoWrappers.slice(1).map((context) => context.wrapper),
      ['.other', '.third'],
      'one nested row per wrapper',
    );

    // Each context sees only the rules written at its place.
    const model = (list) => ({ base: [], conditional: list.map((rule) => ({ rule, matchedSelectors: [] })), matchedRuleCount: list.length });
    const mixed = model([byText(/gap: 1rem/), byText(/\.top/)]);
    const nestedContext = both[2];
    const topContext = both[1];
    assert.deepEqual(
      queryModel.modelForContext(mixed, nestedContext).conditional.map((entry) => entry.rule),
      [byText(/gap: 1rem/)],
      'the nested context sees its block',
    );
    assert.deepEqual(
      queryModel.modelForContext(mixed, topContext).conditional.map((entry) => entry.rule),
      [byText(/\.top/)],
      'the top-level context sees its own',
    );
    assert.deepEqual([...queryModel.contextKeysWithStyles(mixed)].sort(), [nestedRow, topKey].sort(), 'styles are keyed by place and stylesheet');
    const infos = queryModel.indexPlacedContexts(mixed, both);
    assert.deepEqual(
      infos.map((info) => info.wrapper),
      [undefined, undefined, '.developer_layout'],
      'the wrapper line comes from the place',
    );

    // A nested block found by its place and written into, never the first block
    // spelling the query. The element IS the wrapper → a bare declaration.
    const regionOf = (css) => queryModel.parseRegion({ start: 0, end: css.length, css, root: undefined, openTag: '<style>' });
    const twoBlocks = regionOf(
      '@media (width < 42rem) {\n  .top {\n    color: red;\n  }\n}\n.developer_layout {\n  @media (width < 42rem) {\n    gap: 1rem;\n  }\n}\n',
    );
    const where = { atContextKey: '@media (width < 42rem)', wrapper: '.developer_layout' };
    assert.ok(queryModel.createRuleInPlacedQuery(twoBlocks, { ...where, selector: '.developer_layout' }, 'row-gap', { value: '2rem', important: false }));
    assert.ok(queryModel.createRuleInPlacedQuery(twoBlocks, { ...where, selector: '.developer_title' }, 'color', { value: 'teal', important: false }));
    assert.ok(queryModel.createRuleInPlacedQuery(twoBlocks, { ...where, selector: '.developer_layout .card' }, 'color', { value: 'navy', important: false }));
    assert.equal(
      twoBlocks.root.toString(),
      '@media (width < 42rem) {\n  .top {\n    color: red;\n  }\n}\n.developer_layout {\n  @media (width < 42rem) {\n    gap: 1rem;\n    row-gap: 2rem;\n    .developer_title {\n      color: teal;\n    }\n    .card {\n      color: navy;\n    }\n  }\n}\n',
      'the wrapper gets a bare declaration, a descendant a nested rule, and the top-level block is untouched',
    );
    const none = regionOf('.a {\n  color: red;\n}\n');
    assert.ok(
      queryModel.createRuleInPlacedQuery(none, { atContextKey: '@media (width < 42rem)', wrapper: '.developer_layout', selector: '.developer_layout' }, 'gap', {
        value: '1rem',
        important: false,
      }),
    );
    assert.match(
      none.root.toString(),
      /\.developer_layout \{\s*@media \(width < 42rem\) \{\s*gap: 1rem;?\s*\}\s*\}/,
      'a missing block is built inside its wrapper',
    );

    // ── Reach: the pigeon page's tree ──
    // developer_layout > developer_content > developer_title; hero_title elsewhere.
    const tree = {
      root: { tag: 'body', classes: [], parent: undefined },
      layout: { tag: 'div', classes: ['developer_layout'], parent: 'root' },
      content: { tag: 'div', classes: ['developer_content'], parent: 'layout' },
      title: { tag: 'h2', classes: ['developer_title', 'text-style-h1'], parent: 'content' },
      wrapper: { tag: 'div', classes: ['button-wrapper'], parent: 'content' },
      hero: { tag: 'h1', classes: ['hero_title'], parent: 'root' },
    };
    const view = (truncated) => ({
      truncated,
      parentKey: (key) => tree[key]?.parent,
      childKeys: (key) => Object.keys(tree).filter((child) => tree[child].parent === key),
      snapshot: async (key) =>
        tree[key] === undefined
          ? undefined
          : {
              tag: tree[key].tag,
              webflowType: '',
              id: undefined,
              classes: tree[key].classes,
              classList: tree[key].classes,
              attributes: { class: tree[key].classes.join(' ') },
            },
    });
    const target = (rootKey, options = {}) => ({
      rootKey,
      view: view(options.truncated ?? false),
      ...(options.domMatched ? { domMatched: options.domMatched } : {}),
    });
    const reach = async (wrapper, at) => (await queryModel.reachOfWrapper(wrapper, at)).kind;
    assert.equal(await reach('.developer_layout', target('title')), 'reaches', 'a descendant with no styles in the query is reached');
    assert.equal(await reach('.developer_layout', target('layout')), 'reaches', 'the wrapper itself is reached');
    assert.equal(await reach('.developer_layout', target('wrapper')), 'reaches', 'button-wrapper, deeper inside, is reached');
    assert.equal(await reach('.developer_layout', target('hero')), 'misses', 'an element outside is not');
    assert.equal(await reach('.developer_layout', target('hero', { truncated: true })), 'unknown', 'above a component edge a miss is undecided');
    assert.equal(await reach('.developer_layout:hover', target('hero')), 'unknown', 'a pseudo-class wrapper is undecided without the page');
    assert.equal(await reach('.developer_layout', undefined), 'unknown', 'no element: undecided');
    const page = new Map([
      ['.developer_layout', false],
      ['.developer_layout *', false],
    ]);
    assert.equal(await reach('.developer_layout', target('title', { domMatched: page })), 'misses', 'the rendered page answers over the source tree');
    assert.equal(
      await reach(
        '.developer_layout:hover',
        target('hero', {
          domMatched: new Map([
            ['.developer_layout:hover', false],
            ['.developer_layout:hover *', true],
          ]),
        }),
      ),
      'reaches',
      'and decides a pseudo-class wrapper too',
    );
    assert.deepEqual(queryModel.wrapperProbes('.a, .b'), ['.a', '.a *', '.b', '.b *'], 'each list member is probed as itself and as an ancestor');
    assert.deepEqual(
      queryModel.nestedWrappersOf([byText(/gap: 1rem/), byText(/\.top/), byText(/color: blue/)]).sort(),
      ['.developer_layout', '.developer_layout .card'],
      "the wrappers asked about are the nested rules' own",
    );
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

  // Source chips: every query row names its stylesheet; the same query in two
  // stylesheets is two rows told apart by their chips; the slots still line up.
  {
    const tagged = [
      { value: '', label: 'Base', marked: true },
      { value: 'a', label: '@media (width < 50rem)', overline: '.button', tag: { label: 'Button', tone: 'component', icon: 'C' }, marked: true },
      { value: 'b', label: '@media (width < 50rem)', tag: { label: 'index.astro', tone: 'embed', icon: 'E' } },
      {
        value: 'c',
        label: '@media (width < 50rem)',
        tag: { label: 'global.css', tone: 'embed', icon: 'E' },
        action: { icon: 'P', label: 'Edit', onSelect: () => {} },
      },
    ];
    const { host, root } = await mount('', tagged);
    const rows = [...host.querySelectorAll('.u-select-option')];
    const tagOf = (row) => row.querySelector('.u-select-tag .u-select-tag-label')?.textContent;
    assert.deepEqual(rows.map(tagOf), [undefined, 'Button', 'index.astro', 'global.css'], 'each query row carries its source chip');
    assert.equal(new Set(rows.slice(1).map(tagOf)).size, 3, 'one query in three stylesheets reads as three rows');
    for (const row of rows) {
      assert.deepEqual(trailing(row), ['u-select-dot-slot', 'u-select-check'], `${row.textContent}: the slots still end the row`);
    }
    const nestedRow = rows[1];
    assert.deepEqual(
      [...nestedRow.querySelector('.u-select-overline').children].map((child) => child.className),
      ['u-select-tag', 'u-select-overline-text'],
      'the chip leads the first line, the wrapper follows',
    );
    assert.equal(nestedRow.querySelector('.u-select-tag').dataset.tone, 'component', 'the chip carries its tone');
    assert.equal(nestedRow.querySelector('.u-select-label-line').textContent, '@media (width < 50rem)', 'the query stays the main line');
    assert.equal(rows[2].querySelector('.u-select-overline-text') ?? undefined, undefined, 'a top-level row has the chip alone on its first line');
    await act(async () => root.unmount());
    host.remove();
    const nestedTrigger = await mount('a', tagged);
    assert.equal(
      nestedTrigger.host.querySelector('.u-select-button .u-select-tag-label')?.textContent,
      'Button',
      'a two-line trigger shows the chip beside the wrapper',
    );
    await act(async () => nestedTrigger.root.unmount());
    nestedTrigger.host.remove();
    const topTrigger = await mount('b', tagged);
    assert.equal(
      topTrigger.host.querySelector('.u-select-button .u-select-overline') ?? undefined,
      undefined,
      'a one-line trigger does not grow a line for the chip',
    );
    await act(async () => topTrigger.root.unmount());
    topTrigger.host.remove();
    const css = fs.readFileSync(repoPath('src/features/style/utilities.css'), 'utf8');
    const chip = /\.u-select-tag \{([^}]*)\}/.exec(css);
    assert.ok(chip, 'the chip has its own rule');
    assert.doesNotMatch(chip[1], /border:/, 'a fill, never a border');
    assert.match(chip[1], /background:/, 'it is a filled chip');
    assert.match(css, /\.u-select-tag-label \{[^}]*text-overflow: ellipsis;/, 'a long stylesheet name truncates');
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
