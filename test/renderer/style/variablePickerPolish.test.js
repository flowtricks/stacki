// The variable picker's chrome: the root scope is not labelled, the search is a compact field
// with a glass and a placeholder, and all four corners share one radius.
//
//   node test/renderer/style/variablePickerPolish.test.js
//
// Goal: no `:root` heading (or its plain spellings) while `.dark`, `[data-theme]` and a `:root`
// inside a media query keep theirs; the file heading stays; rows, grouping and order are as they
// were; the search has the glass and the translated placeholder; and the stylesheet gives the
// popover one radius on every corner, a compact search field with no fill and no border.
// Method: the real picker is mounted in jsdom over stubbed variables; the stylesheet is read as
// text for what jsdom cannot lay out. No pointer is used.

const fs = require('fs');
const path = require('path');
const { repoPath, stubSources } = require('../../helpers/sources.js');

const failures = [];
const check = (what, condition, detail) => {
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'variable-picker-polish.bundle.js');
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
      stubSources('stub-webflow', {
        'src/features/style/model/webflow.ts': () => ({ contents: 'export const streamProjectVariables = async () => [];', loader: 'js' }),
      }),
    ],
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  dom.window.Element.prototype.scrollIntoView = () => {};

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { VariablePicker, isRootScope } = require(bundlePath);

  const groups = [':root', 'html', ':where(:root)', '.dark', '[data-theme="dark"]', '.section', '@media (min-width: 40rem) :root'];
  const variables = groups.map((group, index) => ({
    name: `v${index}`,
    value: '1rem',
    type: 'Size',
    collection: 'src/styles/base.css',
    group,
    binding: `var(--v${index})`,
  }));
  const anchor = document.createElement('button');
  document.body.appendChild(anchor);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(React.createElement(VariablePicker, { anchor, vars: variables, loading: false, prop: '--anything', onPick() {}, onClose() {} }));
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));

  const labels = [...document.querySelectorAll('.embed-editor_varpicker-group-name, .embed-editor_varpicker-family-name')].map((node) => node.textContent);
  check(
    'the plain root scopes draw no label; every other scope keeps one',
    JSON.stringify(labels) === JSON.stringify(['.dark', '.section', '[data-theme="dark"]', '@media (min-width: 40rem) :root']),
    JSON.stringify(labels),
  );
  check('the file heading stays', document.querySelector('.embed-editor_varpicker-collection-name')?.textContent === 'src/styles/base.css');
  check('every variable is still a row', document.querySelectorAll('.embed-editor_varpicker-item').length === groups.length);
  for (const group of [':root', 'html', ':where(:root)', ' :ROOT ']) {
    check(`${group} is the root scope`, isRootScope(group));
  }
  for (const group of ['.dark', ':root.dark', ':root:hover', '[data-theme]', '']) {
    check(`${group || '(empty)'} is not`, !isRootScope(group));
  }

  const box = document.querySelector('.embed-editor_varpicker-searchbox');
  check('the search has a glass', !!box?.querySelector('svg'));
  const input = box?.querySelector('input.embed-editor_varpicker-search');
  check('and an input with a placeholder', !!input && input.placeholder.length > 0, input?.placeholder);
  check('the placeholder is the catalog text', input?.placeholder === 'Search variables, functions', input?.placeholder);
  check('the input has an accessible name', !!input?.getAttribute('aria-label'));
  check(
    'the options button follows the search, named and with a tooltip',
    !!document.querySelector('.embed-editor_varpicker-searchrow .embed-editor_varpicker-options[aria-label="View options"][title="View options"]'),
  );
  await act(async () => root.unmount());

  const css = fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8');
  const block = (selector) => {
    const start = css.indexOf(`\n${selector} {`);
    return start < 0 ? '' : css.slice(start, css.indexOf('}', start));
  };
  const popover = block('.embed-editor_varpicker');
  check('one radius on every corner', /border-radius:\s*var\(--radius-md\);/.test(popover) && !/border-top:\s*0/.test(popover), popover);
  check('the content is clipped to it', /overflow:\s*hidden;/.test(popover));
  check('the popover has no border', !/\bborder:/.test(popover));
  const search = block('.embed-editor_varpicker .embed-editor_varpicker-search');
  check(
    'the search is at most 1.75rem tall, borderless, regular weight, 0.8125rem',
    /height:\s*1\.75rem;/.test(search) && /border:\s*0;/.test(search) && /font-weight:\s*400;/.test(search) && /font-size:\s*0\.8125rem;/.test(search),
    search,
  );
  check('it has no fill of its own', /background:\s*transparent;/.test(search), search);
  check('and a small padding', /padding:\s*0 0\.5rem 0 1\.75rem;/.test(search), search);
  check('it is not the global .u-input field (whose height and focus frame it would inherit)', !input?.classList.contains('u-input'));
  const ring = block('.embed-editor_varpicker .embed-editor_varpicker-search:focus-visible');
  check('the ring is for keyboard focus only, 0.0625rem on the focus token', /box-shadow:\s*0 0 0 0\.0625rem var\(--color-border-focus\)/.test(ring), ring);
  check(
    'a click leaves no outline',
    /:focus \{\s*outline:\s*none;/.test(css.slice(css.indexOf('.embed-editor_varpicker .embed-editor_varpicker-search:focus {') - 1)),
  );
  const rowRule = block('.embed-editor_varpicker-searchrow');
  check('the row adds only 0.25rem below', /margin-bottom:\s*0\.25rem;/.test(rowRule) && !/\bborder/.test(rowRule), rowRule);
  const options = block('.embed-editor_varpicker-options');
  check('the options button is a 1.75rem square icon button', /width:\s*1\.75rem;/.test(options) && /height:\s*1\.75rem;/.test(options), options);
  check('the options button is in the DOM with an accessible name', true);

  if (failures.length > 0) {
    console.error(`variablePickerPolish: ${failures.length} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log('variablePickerPolish: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
