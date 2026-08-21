// Picking a variable in the spacing popover puts it in the field it was picked in.
//
//   node test/spacing-pick.js
//
// The popover seeds its draft once, from the model, when it opens — and then
// stops following it, deliberately: it is a field being typed in, and a field
// that re-reads the model mid-edit takes the text out from under the caret.
//
// A pick is the one change that arrives from outside the typing and has to land
// inside it anyway. Without that, choosing a variable styled the element — the
// spacing box behind the popover showed it immediately — while the field it was
// chosen in stayed empty, and stayed empty until the popover was closed and
// opened again. Nothing was lost, which is what made it hard to read: it looked
// like the pick had failed, so the obvious response is to pick again.

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
  const bundlePath = path.join(buildDir, 'spacing-pick.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'style-panel', 'SpacingBox.tsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      {
        // The picker asks the project for its variables; there is no project here.
        name: 'stub-variables',
        setup(build) {
          build.onResolve({ filter: /lib\/webflow$/ }, () => ({ path: 'stub-webflow', namespace: 'stub' }));
          build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
            contents: `
              export async function streamProjectVariables(onAdd) {
                onAdd({ name: 'site-margin', collection: 'Sizes', group: '', value: '2rem', binding: 'var(--site-margin)', kind: 'Size' });
                return [];
              }
            `,
            loader: 'js',
          }));
        },
      },
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>', { url: 'http://localhost/', pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.Element = dom.window.Element;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.MutationObserver = dom.window.MutationObserver;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  dom.window.ResizeObserver = global.ResizeObserver;
  global.IS_REACT_ACT_ENVIRONMENT = true;

  // The picker focuses its search box from a lifecycle method, and React says so
  // at length. It is noise, and loud enough to bury the failures below it.
  const realError = console.error;
  console.error = (...args) => {
    if (typeof args[0] === 'string' && args[0].includes('flushSync was called from inside a lifecycle')) return;
    realError(...args);
  };

  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { act } = React;
  const { SpacingEditor } = require(bundlePath);

  const host = dom.window.document.getElementById('root');
  const root = createRoot(host);
  const committed = [];
  const cleared = [];
  // Nothing set on this side to begin with — the empty field is the case.
  const values = {};
  await act(async () => {
    root.render(
      React.createElement(SpacingEditor, {
        prop: 'padding-top',
        side: 'top',
        placeholder: '0',
        read: (prop) =>
          values[prop] != null
            ? { source: 'selected', selectedValue: { value: values[prop], important: false }, winner: { value: values[prop], important: false, selectorText: '.x' }, contributors: [], overridden: false }
            : undefined,
        setProp: (prop, value) => { committed.push([prop, value]); values[prop] = value },
        clearProp: (prop) => cleared.push(prop),
        liveSetProp: () => {},
        onSelectSelector: () => {},
        onClose: () => {},
        onSameLabelPress: () => {},
      })
    );
  });
  const settle = () => act(async () => { await new Promise((r) => dom.window.setTimeout(r, 30)) });
  await settle();

  const field = () => host.querySelector('input.embed-editor_spacing-editor');
  check('the popover has its field', !!field(), host.innerHTML.slice(0, 200));
  check('and it starts empty, with nothing set', field()?.value === '', JSON.stringify(field()?.value));

  // Open the variable picker the way the purple dot does.
  const dot = host.querySelector('.embed-editor_varconnect-dot');
  check('the field offers a variable picker', !!dot, host.innerHTML.slice(0, 300));
  await act(async () => {
    dot.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }));
    dot.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });
  await settle();

  const row = [...document.querySelectorAll('.embed-editor_varpicker-item')][0];
  check('the picker lists the variable', !!row, document.body.innerHTML.slice(-300));
  await act(async () => { row.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })) });
  await settle();

  // It reaches the element…
  check('picking it writes the property', committed.some(([p, v]) => p === 'padding-top' && v === 'var(--site-margin)'), JSON.stringify(committed));
  // …and it is IN THE FIELD, which is the whole bug.
  check(
    'and the field shows it',
    field()?.value === 'var(--site-margin)',
    `the field holds ${JSON.stringify(field()?.value)} — the pick landed on the element but not in the field`
  );
  // The rich editor is what is actually visible once a value has a variable in
  // it, so it has to be carrying the name too.
  const shown = host.querySelector('.embed-editor_varconnect-editor')?.textContent ?? '';
  check('and it is legible in the visible editor', shown.includes('site-margin'), JSON.stringify(shown));

  // Closing afterwards must not write it a second time: `close()` commits when
  // the draft differs from what the popover opened with, and the pick is
  // already written.
  const before = committed.length;
  await act(async () => {
    dom.window.document.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true }));
  });
  await settle();
  check('closing after a pick writes nothing further', committed.length === before, JSON.stringify(committed));
  check('and clears nothing', cleared.length === 0, JSON.stringify(cleared));

  await act(async () => { root.unmount() });

  if (failures.length) {
    console.error(`spacing-pick: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`spacing-pick: ${checked} passed  [the pick lands in the field]`);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
