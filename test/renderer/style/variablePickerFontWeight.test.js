// The Weight field's variable picker offers only variables that compute to a
// valid font-weight.
//
//   node test/renderer/style/variablePickerFontWeight.test.js
//
// Goal: with prop `font-weight`, the picker lists only variables whose value is
// normal/bold/bolder/lighter or a number 1-1000; the applied variable stays
// listed even when it fails; the search runs on the filtered list; and the
// verdict follows the SELECTED ELEMENT's computed values, so a variable that is
// 400 at :root but 1rem on an ancestor is hidden for an element under that
// ancestor and shown for one outside it, and the reverse.
// Method: the real VariablePicker is bundled into jsdom with the canvas bridge
// and host stubbed. The stub plays the page: for each element "path" it answers
// with the computed custom properties a cascade would give it. Before the page
// answers (and when there is no canvas) the stylesheet values decide. No
// pointer, hover or layout is used, so it behaves the same on every platform.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

// Declared values, as the stylesheets give them.
const DECLARED = {
  w: '400',
  rev: '1rem',
  alias: 'var(--w)',
  bold: 'bold',
  border: '0.0625rem',
  display: 'clamp(2rem, 5vw, 4rem)',
  none: 'none',
  loop: 'var(--loop)',
  gone: 'var(--nowhere)',
  big: '1001',
  small: '23',
  floor: '99',
  odd: '274',
  viewport: '320',
  'font-main': '"Inter", sans-serif',
  'font-alias': 'var(--font-main)',
  'font-plain': 'Helvetica Neue',
  'text-transform': 'none',
  'text-wrap': 'balance',
  'lh-tight': '1.1',
  'lh-alias': 'var(--lh-tight)',
  'lh-body': '4',
  'lh-pct': '150%',
  'text-upper': 'uppercase',
  'hover-ease': 'ease',
  'ls-tight': '-0.04em',
  'ls-alias': 'var(--ls-tight)',
  'ls-wide': '1.5rem',
  'card-local': '0.5rem',
  'sibling-local': '0.25rem',
};
// The winning declarations the page traces for the element under the section (what the rows show).
const WINNING = {
  inside: {
    '--w': { expression: '1rem', selector: '.section', file: '/project/base.css', depth: 1, ancestor: '.section' },
    '--_mw': { expression: '40rem', selector: '.card', file: '/project/base.css', depth: 0, ancestor: '.card' },
  },
};
// What the cascade computes on each element: `inside` sits under a section that
// redefines --w and --rev; `outside` does not. A computed alias carries the
// substituted value, as getComputedStyle gives it.
const COMPUTED = {
  outside: {
    '--w': '400',
    '--rev': '1rem',
    '--alias': '400',
    '--bold': 'bold',
    '--border': '0.0625rem',
    '--display': 'clamp(2rem, 5vw, 4rem)',
    '--none': 'none',
    '--loop': '',
    '--gone': '',
    '--big': '1001',
    '--small': '23',
    '--floor': '99',
    '--odd': '274',
    '--viewport': '320',
    '--font-main': '"Inter", sans-serif',
    '--font-alias': '"Inter", sans-serif',
    '--font-plain': 'Helvetica Neue',
    '--text-transform': 'none',
    '--text-wrap': 'balance',
    '--lh-tight': '1.1',
    '--lh-alias': '1.1',
    '--lh-body': '4',
    '--lh-pct': '150%',
    '--text-upper': 'uppercase',
    '--hover-ease': 'ease',
    '--ls-tight': '-0.04em',
    '--ls-alias': '-0.04em',
    '--ls-wide': '1.5rem',
    '--sibling-local': '0.25rem',
    '--card-local': '',
  },
  inside: {
    '--w': '1rem',
    '--rev': '700',
    '--alias': '1rem',
    '--bold': 'bold',
    '--border': '0.0625rem',
    '--display': 'clamp(2rem, 5vw, 4rem)',
    '--none': 'none',
    '--loop': '',
    '--gone': '',
    '--big': '1001',
    '--small': '23',
    '--floor': '99',
    '--odd': '274',
    '--viewport': '320',
    '--font-main': '1rem',
    '--font-alias': '1rem',
    '--font-plain': 'Helvetica Neue',
    '--text-transform': 'none',
    '--text-wrap': 'balance',
    '--lh-tight': '4',
    '--lh-alias': '4',
    '--lh-body': '1.5',
    '--lh-pct': '150%',
    '--text-upper': 'balance',
    '--hover-ease': 'ease',
    '--ls-tight': '2em',
    '--ls-alias': '2em',
    '--ls-wide': '0.05rem',
    '--sibling-local': '',
    '--card-local': '0.5rem',
    '--_mw': '40rem',
  },
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-font-weight.bundle.js');
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
            export const hasCanvas = () => globalThis.__canvas !== undefined;
            export const queryCanvas = async (elementPath, _s, _c, props) => {
              const computed = globalThis.__canvas?.[elementPath];
              if (computed === undefined) return undefined;
              await globalThis.__canvasGate;
              return { computedProps: Object.fromEntries(props.map((name) => [name, computed[name] ?? ''])), winning: globalThis.__winning?.[elementPath] ?? {} };
            };
            const ready = new Set(); globalThis.__ready = () => ready.forEach((listener) => listener());
            export const onCanvasReady = (listener) => { ready.add(listener); return () => ready.delete(listener); };
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
            export const getHost = () => ({ selectedId: globalThis.__selected, pathOf: (id) => id });
            export const onHostChange = () => () => {};
            export const setHost = () => {};
            export const findNode = () => undefined;
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
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle;
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
  global.cancelAnimationFrame = clearTimeout;
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariablePicker, pickerVariables } = require(bundlePath);

  const variables = Object.entries(DECLARED).map(([name, value]) => ({
    name,
    value,
    collection: 'src/styles/base.css',
    group: ':root',
    binding: `var(--${name})`,
    type: /font/.test(name) ? 'FontFamily' : /^text-|ease/.test(name) ? 'String' : /^\d+$/.test(value) ? 'Number' : 'Size',
  }));
  const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

  const open = async ({ selected, selectedBinding, prop = 'font-weight' }) => {
    globalThis.__selected = selected;
    const anchor = document.createElement('button');
    document.body.appendChild(anchor);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(VariablePicker, {
          anchor,
          vars: variables,
          loading: false,
          prop,
          ...(selectedBinding === undefined ? {} : { selectedBinding }),
          onPick() {},
          onClose() {},
        }),
      );
    });
    await settle();
    const ordered = () => [...document.querySelectorAll('.embed-editor_varpicker-item')].map((row) => row.dataset.binding.slice(6, -1));
    // The set shown, order aside: rows are drawn in the panel's grouped order (variableGroups.ts).
    const names = () => ordered().sort();
    const close = async () => {
      await act(async () => root.unmount());
      host.remove();
      anchor.remove();
    };
    return { names, ordered, close };
  };
  const same = (label, actual, expected) =>
    check(label, JSON.stringify(actual) === JSON.stringify(expected), `${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);

  // --- No canvas (Studio, or nothing selected): the stylesheet values decide.
  {
    globalThis.__canvas = undefined;
    const { names, close } = await open({ selected: undefined });
    same('no canvas: stylesheet-resolved weights only (alias chain included)', names(), ['alias', 'bold', 'w']);
    await close();
  }

  // --- With a canvas: the selected element's computed values decide.
  globalThis.__canvas = COMPUTED;
  globalThis.__winning = WINNING;
  {
    const { names, close } = await open({ selected: 'outside' });
    same('outside the section: --w is 400, --rev is 1rem', names(), ['alias', 'bold', 'w']);
    await close();
  }
  {
    const { names, close } = await open({ selected: 'inside' });
    same('inside the section: --w is 1rem (hidden), --rev is 700 (shown)', names(), ['bold', 'rev']);
    await close();
  }

  // --- Before the page answers, the stylesheet list shows; the answer refines it.
  {
    let release;
    // A new page forgets what the last one answered, so the first frame is the stylesheet list.
    globalThis.__ready();
    globalThis.__canvasGate = new Promise((resolve) => {
      release = resolve;
    });
    const { names, close } = await open({ selected: 'inside' });
    same('before the page answers: the stylesheet-resolved list', names(), ['alias', 'bold', 'w']);
    await act(async () => release());
    await settle();
    same('after it answers: the element-computed list', names(), ['bold', 'rev']);
    await close();
    globalThis.__canvasGate = undefined;
  }

  // --- The applied variable stays listed, flagged, even when it fails.
  {
    const { names, close } = await open({ selected: 'outside', selectedBinding: 'var(--border)' });
    check('the applied failing variable stays in the list', names().includes('border'), names().join());
    const marked = document.querySelector('.embed-editor_varpicker-item.is-selected');
    check('and is the marked row', marked?.dataset.binding === 'var(--border)', marked?.dataset.binding);
    check('other failing variables stay hidden', !names().includes('display') && !names().includes('none'), names().join());
    await close();
  }

  // --- The search runs on the filtered list; an empty result shows the empty state.
  {
    const { names, close } = await open({ selected: 'outside' });
    const search = document.querySelector('.embed-editor_varpicker-search');
    const type = async (value) => {
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
        setter.call(search, value);
        search.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    await type('bo');
    same('search keeps working on the filtered list', names(), ['bold']);
    await type('border');
    same('a hidden variable is not found by search', names(), []);
    check('nothing matching shows the empty state', !!document.querySelector('.embed-editor_varpicker-empty'));
    await close();
  }

  // --- The Font (font-family) picker offers only family lists.
  {
    globalThis.__canvas = undefined;
    const { names, close } = await open({ selected: undefined, prop: 'font-family' });
    same('font-family, no canvas: families only, chain included', names(), ['font-alias', 'font-main', 'font-plain']);
    await close();
    globalThis.__canvas = COMPUTED;
  }
  {
    const { names, close } = await open({ selected: 'outside', prop: 'font-family' });
    same('font-family outside the section: none and balance are hidden', names(), ['font-alias', 'font-main', 'font-plain']);
    await close();
  }
  {
    const { names, close } = await open({ selected: 'inside', prop: 'font-family' });
    same('font-family inside the section: the overridden stacks (1rem) are hidden', names(), ['font-plain']);
    await close();
  }
  {
    const { names, close } = await open({ selected: 'inside', selectedBinding: 'var(--text-wrap)', prop: 'font-family' });
    same('font-family: the applied failing variable stays listed', names(), ['font-plain', 'text-wrap']);
    await close();
  }

  // --- The Line height picker offers only unitless numbers from 0 to 3.
  {
    globalThis.__canvas = undefined;
    const { names, close } = await open({ selected: undefined, prop: 'line-height' });
    same('line-height, no canvas: multipliers only, chain included', names(), ['lh-alias', 'lh-tight']);
    await close();
    globalThis.__canvas = COMPUTED;
    const outside = await open({ selected: 'outside', prop: 'line-height' });
    same('line-height outside the section', outside.names(), ['lh-alias', 'lh-tight']);
    await outside.close();
    const inside = await open({ selected: 'inside', prop: 'line-height' });
    same('line-height inside the section: the override makes lh-body valid', inside.names(), ['lh-body']);
    await inside.close();
  }

  // --- The Text transform picker offers its keywords, none included.
  {
    const outside = await open({ selected: 'outside', prop: 'text-transform' });
    same('text-transform outside: none and uppercase stay, balance and ease go', outside.names(), ['text-transform', 'text-upper']);
    await outside.close();
    const inside = await open({ selected: 'inside', prop: 'text-transform' });
    same('text-transform inside: the overridden uppercase is hidden', inside.names(), ['text-transform']);
    await inside.close();
  }

  // --- The Letter spacing picker offers 0 and em or rem lengths from -1 to 1.
  {
    const outside = await open({ selected: 'outside', prop: 'letter-spacing' });
    same('letter-spacing outside: small em/rem lengths, chain included', outside.names(), ['border', 'ls-alias', 'ls-tight', 'rev', 'sibling-local']);
    await outside.close();
    const inside = await open({ selected: 'inside', prop: 'letter-spacing' });
    same('letter-spacing inside: overrides swap which are valid', inside.names(), ['alias', 'border', 'card-local', 'ls-wide', 'w']);
    await inside.close();
  }

  // --- Locals: a variable defined only on the selected element's own scope.
  {
    const outside = await open({ selected: 'outside', prop: 'letter-spacing' });
    check(
      'a sibling scope local is listed for its own element',
      outside.names().includes('sibling-local') && !outside.names().includes('card-local'),
      outside.names().join(),
    );
    await outside.close();
    const inside = await open({ selected: 'inside', prop: 'letter-spacing' });
    check(
      'selecting another element swaps the locals: the card local in, the sibling local out',
      inside.names().includes('card-local') && !inside.names().includes('sibling-local'),
      inside.names().join(),
    );
    const widthRow = document.querySelector('[data-binding="var(--w)"] .embed-editor_varpicker-item-value');
    check(
      'a row shows the declaration that wins on this element, as written (400 at :root, 1rem here)',
      widthRow?.textContent === '1rem' && /Overridden on this element/.test(document.querySelector('[data-binding="var(--w)"]')?.title ?? ''),
      `${widthRow?.textContent} | ${document.querySelector('[data-binding="var(--w)"]')?.title}`,
    );
    await inside.close();
    // The applied local is declared nowhere the stylesheets list, and fails the filter: it still leads the list, marked.
    const applied = await open({ selected: 'inside', prop: 'font-weight', selectedBinding: 'var(--_mw)' });
    check('the applied local is first in the list', applied.ordered()[0] === '_mw', applied.ordered().join());
    const marked = document.querySelector('.embed-editor_varpicker-item.is-selected');
    check('and marked selected although 40rem is no font weight', marked?.dataset.binding === 'var(--_mw)', marked?.dataset.binding);
    check('with the declaration written for it', marked?.querySelector('.embed-editor_varpicker-item-value')?.textContent === '40rem');
    await applied.close();
  }

  // --- Other properties are not filtered.
  {
    const all = pickerVariables(variables, 'row-gap', '');
    check(
      'another property keeps every sizing variable',
      all.some((variable) => variable.name === 'border') && all.some((variable) => variable.name === 'display'),
    );
  }

  if (failures.length > 0) {
    console.error(`variablePickerFontWeight: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerFontWeight: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
