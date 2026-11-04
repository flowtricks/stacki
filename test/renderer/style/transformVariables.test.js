// A variable in a transform field reads as a chip.
//
//   node test/renderer/style/transformVariables.test.js
//
// Goal: the transform popover's axis fields (Move / Scale / Rotate / Skew, X Y Z)
// and the perspective distance in its settings are single-value fields like any
// other in the panel, so a `var(--…)` in one has to show as the same purple chip,
// a calc() around one has to tokenise, and the slider has nothing to scrub while
// the value is a variable. The bug was an axis showing `var(--_offset)` as bare
// text because its input was never wrapped in VariableConnect.
//
// Method: bundle the real TransformEditor and TransformSettings with esbuild,
// stub only the project's variable list, mount them in jsdom, and look for the
// chip markup the varconnect tests already pin. Then press a field's connect dot,
// pick a variable, and check the patch the editor emits names the right axis.

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { repoPath, sourceSpecifier, stubSources } = require('../../helpers/sources.js');

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, 'transform-variables.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `
        export { TransformEditor } from ${sourceSpecifier('src/features/style/TransformsRow.tsx')};
        export { default as TransformSettings } from ${sourceSpecifier('src/features/style/TransformSettings.tsx')};
      `,
      resolveDir: repoPath('src/features/style'),
      loader: 'ts',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
    plugins: [
      // The picker asks the project for its variables; one is enough to pick.
      stubSources('stub-variables', {
        'src/features/style/model/webflow.ts': () => ({
          contents: `
            export async function streamProjectVariables(onAdd) {
              onAdd({ name: 'brand', collection: 'Sizes', group: '', value: '1rem', binding: 'var(--brand)', type: 'Size' });
              return [];
            }
            export const __stub = true;
          `,
          loader: 'js',
        }),
      }),
    ],
  });

  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  const { TransformEditor, TransformSettings } = require(bundlePath);

  const clickIt = (element) => {
    element.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    element.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true }));
    element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  };

  const mount = async (element) => {
    const host = document.createElement('div');
    host.className = 'embed-editor_root';
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(element));
    const done = async () => {
      await act(async () => root.unmount());
      host.remove();
    };
    return { host, done };
  };

  // The row of the axis whose input is labelled `label`.
  const axisRow = (host, label) => {
    const input = host.querySelector(`input[aria-label="${label}"]`);
    assert.ok(input, `the ${label} axis has its input`);
    const row = input.closest('.embed-editor_size-row');
    assert.ok(row, `the ${label} input sits in an axis row`);
    return row;
  };
  const chipNames = (row) => [...row.querySelectorAll('.embed-editor_varconnect-token-name')].map((chip) => chip.textContent);

  // --- A variable in a Move axis is a chip, and its slider stands still -------
  {
    const patches = [];
    const layer = { type: 'move', x: '0px', y: 'var(--_offset)', z: '0px' };
    const { host, done } = await mount(React.createElement(TransformEditor, { layer, busy: false, onChange: (patch, live) => patches.push({ patch, live }) }));
    const y = axisRow(host, 'Y');
    assert.ok(y.querySelector('.embed-editor_varconnect.is-token'), 'the Y field is drawn as a token field');
    assert.deepEqual(chipNames(y), ['_offset'], 'var(--_offset) reads as one chip named for the variable');
    const ySlider = y.querySelector('.u-drag-slider');
    assert.ok(ySlider);
    assert.equal(ySlider.getAttribute('aria-disabled'), 'true', 'the slider has no number to scrub while the axis is a variable');

    // An axis holding a variable still offers the dot: the field is code, so a
    // second variable can go in beside the first (the bug: hovering it showed none).
    assert.ok(y.querySelector('.embed-editor_varconnect-dot'), 'an axis holding a variable keeps the connect dot');

    // The negative space: a plain length is a plain field with a dot to connect it.
    const x = axisRow(host, 'X');
    assert.deepEqual(chipNames(x), [], 'a plain 0px has no chip');
    assert.equal(x.querySelector('.u-drag-slider').hasAttribute('aria-disabled'), false, 'and its slider scrubs');
    const dot = x.querySelector('.embed-editor_varconnect-dot');
    assert.ok(dot, 'a plain axis offers the connect dot');

    // Picking a variable from the dot writes var(--name) into X, and only X.
    await act(async () => clickIt(dot));
    const option = document.querySelector('.embed-editor_varpicker-item');
    assert.ok(option, 'the dot opens the variable picker');
    await act(async () => clickIt(option));
    const committed = patches.filter((entry) => entry.live === false);
    assert.deepEqual(committed.at(-1), { patch: { x: 'var(--brand)' }, live: false }, JSON.stringify(patches));
    await done();
  }

  // --- A calc() around a variable tokenises like the custom value editor ------
  {
    const layer = { type: 'rotate', x: '0deg', y: '0deg', z: 'calc(var(--a) * 2)' };
    const { host, done } = await mount(React.createElement(TransformEditor, { layer, busy: false, onChange: () => {} }));
    const z = axisRow(host, 'Z');
    assert.deepEqual(chipNames(z), ['a'], 'the variable inside the calc() is a chip');
    assert.match(z.querySelector('.embed-editor_varconnect-editor').textContent, /calc\(/, 'and the calc() around it stays as text');
    await done();
  }

  // --- Linked scale: a picked variable drives both X and Y --------------------
  {
    const patches = [];
    const layer = { type: 'scale', x: '1', y: '1', z: '1' };
    const { host, done } = await mount(React.createElement(TransformEditor, { layer, busy: false, onChange: (patch) => patches.push(patch) }));
    await act(async () => clickIt(axisRow(host, 'Y').querySelector('.embed-editor_varconnect-dot')));
    await act(async () => clickIt(document.querySelector('.embed-editor_varpicker-item')));
    assert.deepEqual(patches.at(-1), { x: 'var(--brand)', y: 'var(--brand)' }, 'the lock links a picked variable as it links a typed number');
    await done();
  }

  // --- The perspective distance in the settings is connected too --------------
  {
    const writes = [];
    const { host, done } = await mount(
      React.createElement(TransformSettings, {
        read: () => undefined,
        busy: false,
        setProp: () => {},
        clearProp: () => {},
        selfPerspective: 'var(--depth)',
        onSelfPerspective: (distance, live) => writes.push({ distance, live }),
      }),
    );
    const row = axisRow(host, 'Self perspective distance');
    assert.deepEqual(chipNames(row), ['depth'], 'a var() perspective reads as a chip');
    assert.equal(row.querySelector('.u-drag-slider').getAttribute('aria-disabled'), 'true', 'and its slider stands still');
    await done();
  }

  console.log('transform variables: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
