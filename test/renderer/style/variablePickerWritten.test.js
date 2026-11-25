// A picker row shows the variable's value as WRITTEN for the selected element, never a computed value.
//
//   node test/renderer/style/variablePickerWritten.test.js
//
// Goal: each row's text is the declaration that wins for the selected element, in the form it was
// written (`var(--brand)`, a font stack with a var() chain, `color-mix(...)`, a literal hex), traced
// by the canvas up the element's parents. The computed value serves the swatch, the kind and the
// validity filter, and appears only in the tooltip ("Computes to ..."). Without a canvas, where the
// page cannot trace a name, or when a literal winner contradicts what the element computes to, the
// row shows the stylesheet's own :root text, still source text. The text swaps in place when the
// answer lands and an element asked before shows its last answer on the first frame.
// Method: the real VariablePicker in jsdom with the canvas bridge stubbed to play the page: for each
// element path it answers computed values and winning declarations. A source check pins that no row
// text is taken from a computed value. (The cascade itself, specificity, !important, layers, inline
// styles and ancestors, is held against real Chromium by test/electron/preload/winningDeclarations.test.js.)

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const DECLARED = {
  background: 'var(--light-300)',
  brand: '#c6fb50',
  'light-300': '#f3f3f3',
  'primary-family': 'var(--font-inter, system-ui, sans-serif)',
  'display-font-family': 'var(--primary-family)',
  mix: 'color-mix(in srgb, var(--brand) 20%, transparent)',
  literal: '#112233',
};
const FONT = 'Inter-a7104050ada94962, "Inter Fallback", sans-serif';
const win = (expression, selector, file = '/project/src/styles/tokens.css', depth = 0) => ({
  expression,
  selector,
  file,
  depth,
  ancestor: selector,
});
const BASE_COMPUTED = {
  '--brand': '#c6fb50',
  '--light-300': '#f3f3f3',
  '--primary-family': FONT,
  '--display-font-family': FONT,
  '--mix': 'color(srgb 0.776 0.984 0.314 / 0.2)',
  '--literal': '#112233',
};
const PAGE = {
  // Under a .theme-dark wrapper that sets --background: var(--brand).
  inside: {
    computed: { ...BASE_COMPUTED, '--background': '#c6fb50' },
    winning: {
      '--background': win('var(--brand)', '.theme-dark', '/project/src/styles/theme.css', 1),
      '--brand': win('#c6fb50', ':root'),
      '--light-300': win('#f3f3f3', ':root'),
      '--primary-family': win('var(--font-inter, system-ui, sans-serif)', ':root'),
      '--display-font-family': win('var(--primary-family)', ':root'),
      '--mix': win('color-mix(in srgb, var(--brand) 20%, transparent)', ':root'),
      '--literal': win('#112233', ':root'),
    },
  },
  // A sibling outside the wrapper.
  outside: {
    computed: { ...BASE_COMPUTED, '--background': '#f3f3f3' },
    winning: {
      '--background': win('var(--light-300)', ':root'),
      '--primary-family': win('var(--font-inter, system-ui, sans-serif)', ':root'),
    },
  },
  // Inside a component: its own `--_mw` on .card (nearest) and `--_gap` on .section (one parent up); a media-gated one that does not compute.
  card: {
    computed: { ...BASE_COMPUTED, '--background': '#f3f3f3', '--_mw': '40rem', '--_gap': '2rem' },
    winning: { '--_mw': win('40rem', '.card'), '--_gap': win('calc(1rem * 2)', '.section', '/project/src/components/Section.astro', 1) },
    scoped: {
      '--_gap': win('calc(1rem * 2)', '.section', '/project/src/components/Section.astro', 1),
      '--_mw': win('40rem', '.card'),
      '--_gated': win('1px', '.card @media'),
    },
  },
  // A sibling component: it sees none of the card's locals.
  sibling: {
    computed: { ...BASE_COMPUTED, '--background': '#f3f3f3', '--_other': '9px' },
    winning: {},
    scoped: { '--_other': win('9px', '.sibling') },
  },
  // A literal winner that disagrees with what the element computes to: a condition the page could not evaluate.
  conflict: {
    computed: { ...BASE_COMPUTED, '--background': '#f3f3f3' },
    winning: { '--literal': win('#999999', '@media'), '--background': win('var(--light-300)', ':root') },
  },
};

(async () => {
  const source = fs.readFileSync(repoPath('src/features/style/VariablePicker.tsx'), 'utf8');
  check('no row text is taken from a computed value', !/\{\s*\.\.\.variable,\s*value:\s*computed/.test(source));
  check("a row's text is the traced declaration", /value:\s*written\.expression/.test(source));

  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-written.bundle.js');
  await esbuild.build({
    entryPoints: [repoPath('src/features/style/VariablePicker.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      stubSources('stub-canvas', {
        'src/editor/canvasQuery.ts': () => ({
          contents: `
            const listeners = new Set();
            export const hasCanvas = () => globalThis.__page !== undefined;
            export const queryCanvas = async (elementPath, _s, _c, props, context) => {
              const page = globalThis.__page?.[elementPath];
              if (page === undefined) return undefined;
              await globalThis.__gate;
              const winning = {};
              for (const name of context?.winning ?? []) if (page.winning[name] !== undefined) winning[name] = page.winning[name];
              const scoped = context?.scoped === true ? (page.scoped ?? {}) : {};
              const computedProps = Object.fromEntries([...props, ...Object.keys(scoped)].map((name) => [name, page.computed[name] ?? '']));
              return { computedProps, winning, scoped };
            };
            export const onCanvasReady = (listener) => { listeners.add(listener); return () => listeners.delete(listener); };
            export const noteCanvasReady = () => {};
            export const tellCanvas = () => false;
            export const requestCanvasReports = () => false;
            export const setCanvasFrame = () => {};
            export const receiveCanvasReply = () => {};
            export const CANVAS_LIMITS = { pendingMax: 1024 };
          `,
          loader: 'js',
        }),
        'src/features/style/model/host.ts': () => ({
          contents: `
            export const getHost = () => ({ selectedId: globalThis.__selected, pathOf: (id) => id, projectPath: undefined });
            export const onHostChange = () => () => {};
            export const setHost = () => {};
            export const findNode = () => undefined;
            export const walkNodes = () => {};
          `,
          loader: 'js',
        }),
        'src/features/style/model/webflow.ts': () => ({
          contents: 'export const streamProjectVariables = async () => []; export const __stub = true;',
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  Object.assign(global, {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    getComputedStyle: dom.window.getComputedStyle,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  Object.defineProperty(global, 'navigator', { value: dom.window.navigator, configurable: true });
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariablePicker } = require(bundlePath);
  const variables = Object.entries(DECLARED).map(([name, value]) => ({
    name,
    value,
    collection: 'src/styles/tokens.css',
    group: ':root',
    binding: `var(--${name})`,
    type: /family/.test(name) ? 'FontFamily' : /^(brand|light|literal|mix)/.test(name) ? 'Color' : 'String',
  }));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
  const open = async (selected, extra = {}) => {
    globalThis.__selected = selected;
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(VariablePicker, { anchor, vars: variables, loading: false, prop: '--x', ...extra, onPick() {}, onClose() {} }));
    });
    const row = (name) => document.querySelector(`.embed-editor_varpicker-item[data-binding="var(--${name})"]`);
    const text = (name) => row(name)?.querySelector('.embed-editor_varpicker-item-value')?.textContent;
    const close = async () => {
      await act(async () => root.unmount());
      host.remove();
      anchor.remove();
    };
    return { row, text, close };
  };
  const eq = (label, actual, expected) => check(label, actual === expected, `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

  // --- No canvas (Studio, the demo): the stylesheet's :root text.
  {
    globalThis.__page = undefined;
    const view = await open(undefined);
    await settle();
    eq('no canvas: the background row is the stylesheet text', view.text('background'), 'var(--light-300)');
    eq('no canvas: a font stack row is the stylesheet text', view.text('primary-family'), 'var(--font-inter, system-ui, sans-serif)');
    check('no canvas: no "Computes to" line', !(view.row('background')?.title ?? '').includes('Computes to'));
    await view.close();
  }

  globalThis.__page = PAGE;
  // --- Inside the .theme-dark wrapper: the written winner, with both facts in the tooltip.
  {
    const view = await open('inside');
    await settle();
    eq('inside: background is var(--brand), as written', view.text('background'), 'var(--brand)');
    eq('inside: the font stack is the written chain, not the hashed computed stack', view.text('primary-family'), 'var(--font-inter, system-ui, sans-serif)');
    eq('inside: a var() chain keeps its first level', view.text('display-font-family'), 'var(--primary-family)');
    eq('inside: color-mix is shown as written', view.text('mix'), 'color-mix(in srgb, var(--brand) 20%, transparent)');
    eq('inside: a literal hex is shown as written', view.text('literal'), '#112233');
    const title = view.row('background')?.title ?? '';
    check('the tooltip names the declaration and where it is', title.includes('--background: var(--brand) (declared in theme.css on .theme-dark)'), title);
    check('and what it computes to', title.includes('Computes to #c6fb50 on this element'), title);
    check('the overridden marker shows (base says var(--light-300))', view.row('background')?.classList.contains('is-overridden') === true);
    check('and names the winning selector and file', title.includes('.theme-dark'), title);
    check('a row whose winner is the base is not marked', view.row('brand')?.classList.contains('is-overridden') === false);
    check(
      'no row shows a computed value as its text',
      !/Inter-a71|color\(srgb/.test([...document.querySelectorAll('.embed-editor_varpicker-item-value')].map((node) => node.textContent).join('|')),
    );
    await view.close();
  }

  // --- The sibling outside the wrapper.
  {
    const view = await open('outside');
    await settle();
    eq('outside: background is var(--light-300)', view.text('background'), 'var(--light-300)');
    check('outside: not overridden', view.row('background')?.classList.contains('is-overridden') === false);
    check('outside: the tooltip computes to the light colour', (view.row('background')?.title ?? '').includes('Computes to #f3f3f3 on this element'));
    eq(
      'a name the page could not trace shows the stylesheet text, never the computed value',
      view.text('mix'),
      'color-mix(in srgb, var(--brand) 20%, transparent)',
    );
    await view.close();
  }

  // --- A literal winner that contradicts the computed value is not shown.
  {
    const view = await open('conflict');
    await settle();
    eq('a contradicting literal falls back to the stylesheet text', view.text('literal'), '#112233');
    await view.close();
  }

  // --- Stale-while-revalidate: asked before, the written text is there on the first frame.
  {
    const view = await open('inside');
    await settle();
    await view.close();
    let release;
    globalThis.__gate = new Promise((resolve) => {
      release = resolve;
    });
    const again = await open('inside');
    eq('re-opened on the same element: the written text on the first frame', again.text('background'), 'var(--brand)');
    eq('and the swatch order is unchanged', [...document.querySelectorAll('.embed-editor_varpicker-item')].length, Object.keys(DECLARED).length);
    await act(async () => release());
    await settle();
    eq('the fresh answer keeps it', again.text('background'), 'var(--brand)');
    await again.close();
    globalThis.__gate = undefined;
  }

  // --- Local scopes: the element's own and its parents' variables, grouped by selector, nearest first.
  {
    const view = await open('card');
    await settle();
    const rows = [...document.querySelectorAll('.embed-editor_varpicker-item')].map((row) => row.dataset.binding.slice(6, -1));
    check('a component local is listed', rows.includes('_mw'), rows.join());
    check('a parent scope local is listed', rows.includes('_gap'), rows.join());
    check('a local that does not compute here is not listed', !rows.includes('_gated'), rows.join());
    check('the nearest scope comes first', rows.indexOf('_mw') < rows.indexOf('_gap'), rows.join());
    check('locals come before the project variables', rows.indexOf('_gap') < rows.indexOf('background'), rows.join());
    const headings = [...document.querySelectorAll('.embed-editor_varpicker-group-name, .embed-editor_varpicker-family-name')].map((node) => node.textContent);
    check(
      'the scope selectors name the groups, nearest first',
      headings.indexOf('.card') >= 0 && headings.indexOf('.card') < headings.indexOf('.section'),
      headings.join(' | '),
    );
    eq('a local row shows its written text', view.text('_gap'), 'calc(1rem * 2)');
    await view.close();
  }
  {
    const view = await open('sibling');
    await settle();
    const rows = [...document.querySelectorAll('.embed-editor_varpicker-item')].map((row) => row.dataset.binding.slice(6, -1));
    check('a sibling sees its own local', rows.includes('_other'), rows.join());
    check("and not the card's", !rows.includes('_mw') && !rows.includes('_gap'), rows.join());
    await view.close();
  }
  {
    // The applied local stays listed and selected under a filter it fails, whichever scope declares it.
    const view = await open('card', { prop: 'font-weight', selectedBinding: 'var(--_gap)' });
    await settle();
    const marked = document.querySelector('.embed-editor_varpicker-item.is-selected');
    check('the applied local is listed and selected', marked?.dataset.binding === 'var(--_gap)', marked?.dataset.binding);
    await view.close();
  }

  if (failures.length > 0) {
    console.error(`variablePickerWritten: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerWritten: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
