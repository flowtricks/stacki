// The state dropdown: one class, many states — the Webflow way.
//
//   node test/state-select.js
//
// "Hover" on `.card` is the selector `.card:hover`; None is `.card` again. Three
// things have to hold for that to feel like Webflow rather than like typing CSS:
//
//   1. the state arithmetic (split a selector into base + state, put it back) is
//      lossless, and never confuses `:focus-visible` with `:focus`;
//   2. the panel's matcher agrees on what a state IS — every dropdown state that
//      is dynamic reads as a view state of a still-simple selector, pseudo-elements
//      stay a separate target, and position pseudo-classes stay part of the rest view;
//   3. the dropdown itself offers every state, marks the ones that already carry
//      styles, and hands the recomposed selector to the panel when one is chosen.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);}
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'state-select.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export * from './lib/states'
        export { stateForSelector, selectorKey } from './lib/resolved'
        export { canonicalCompound } from './lib/selectors'
        export { default as StateSelect } from './StateSelect'
      `,
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
  global.IS_REACT_ACT_ENVIRONMENT = true;
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  global.ResizeObserver = dom.window.ResizeObserver;
  global.HTMLElement = dom.window.HTMLElement;

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = require('react');
  const m = require(bundlePath);

  // 1. Arithmetic.
  for (const def of m.STATE_DEFINITIONS) {
    const split = m.splitState(`.card${def.suffix}`);
    check(`splitState reads ${def.suffix}`, split.base === '.card' && split.suffix === def.suffix, JSON.stringify(split));
    check(`withState restores ${def.suffix}`, m.withState(split.base, split.suffix) === `.card${def.suffix}`);
  }
  check('rest selector has no suffix', m.splitState('.card').suffix === '');
  check('focus-visible is not focus', m.splitState('a.btn:focus-visible').suffix === ':focus-visible');
  check('a bare state is not split into nothing', m.splitState(':hover').base === ':hover');
  check('complex selector keeps its ancestors', m.splitState('.nav .link:hover').base === '.nav .link');
  check('None recomposes to the base', m.withState('.card', '') === '.card');

  // 2. The matcher agrees.
  for (const suffix of m.VIEW_STATE_PSEUDO_CLASSES) {
    const canon = m.canonicalCompound(`.card${suffix}`);
    check(`${suffix} keeps a class simple`, canon.simple, JSON.stringify(canon));
    check(`${suffix} is a view state`, m.stateForSelector(`.card${suffix}`) === suffix);
    check(`${suffix} is its own chip`, m.selectorKey(`.card${suffix}`) !== m.selectorKey('.card'));
  }
  check('pseudo-element is not a state', m.stateForSelector('.card::before') === '');
  check('pseudo-element is its own target', m.canonicalCompound('.card::before').pseudoElement === '::before');
  check('position pseudo stays in the rest view', m.stateForSelector('.card:first-child') === '');

  // 3. The dropdown.
  const chips = [{ text: '.card:hover' }, { text: '.card::before' }, { text: '.other:focus' }];
  const chosen = [];
  const host = document.getElementById('root');
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(m.StateSelect, {
      selectors: chips, activeSelector: '.card', busy: false, onSelect: (s) => chosen.push(s),
    }));
  });
  const trigger = host.querySelector('button');
  check('dropdown renders a trigger', !!trigger);
  check('rest shows None', /None/.test(trigger?.textContent ?? ''), trigger?.textContent);
  await act(async () => { trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  const text = document.body.textContent;
  for (const def of m.STATE_DEFINITIONS) {
    check(`list offers ${def.label}`, text.includes(def.label));
  }
  const option = [...document.querySelectorAll('[role="option"]')].find((el) => /^Hover/.test(el.textContent));
  check('Hover option exists', !!option);
  if (option) {
    await act(async () => { option.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  }
  check('choosing Hover selects .card:hover', chosen[0] === '.card:hover', JSON.stringify(chosen));
  await act(async () => { root.unmount(); });

  if (failures.length) {
    console.error(`state-select: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`state-select: ${checked} checks passed`);
})();
