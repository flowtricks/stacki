// Mount the real CMS controls and exercise nested dialogs, focus preservation,
// and imported-image selection. Rendering assertions also pin collection, text,
// and recursion limits before a malformed model can grow the editor without bound,
// and that text past a prop attribute's limit (a sermon transcript) still renders.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { BOUNDARY_LIMITS } = require('#dist/shared/core/boundary.js');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const output = repoPath('node_modules/.stacki-test/cms-field.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export {default as Field} from './src/features/cms/CmsField';
      export {getPendingAsset} from './src/ui/assetPick';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
]) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
window.avb = { listAssets: async () => ({ entries: [] }), onAssetsChanged: () => () => {} };
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { renderToStaticMarkup } = require('react-dom/server');
const { Field, getPendingAsset } = require(output);
const context = { label: 'Field', projectPath: '/project', baseDir: 'src/data', onChange() {} };
const click = (element) => act(async () => element.click());

test('a focused CMS field retains its input until blur', async () => {
  const root = createRoot(document.getElementById('root'));
  const show = (type) =>
    act(async () => root.render(React.createElement(Field, { ...context, type, value: 'text' })));
  try {
    await show('text');
    const input = document.querySelector('input');
    await act(async () => input.focus());
    await show('longtext');
    assert.equal(document.querySelector('input'), input);
    assert.ok(document.querySelector('textarea') === null);
    await act(async () => input.blur());
    assert.ok(document.querySelector('textarea'));
  } finally {
    await act(async () => root.unmount());
  }
});

test(
  'nested repeaters keep image imports and ' + 'Escape closes only the innermost dialog',
  async () => {
    const root = createRoot(document.getElementById('root'));
    let value = [{ title: 'Outer', nested: [{ title: 'Inner', image: 'old.png' }] }];
    const imports = [];
    const pickAsset = async (picked) => {
      imports.push(picked);
      return { ok: true, value: { __expr: 'newImage', __asset: picked.rel } };
    };
    // eslint-disable-next-line stacki/bounded-recursion -- Event re-entry: onChange re-renders.
    const render = () =>
      root.render(
        React.createElement(Field, {
          ...context,
          type: 'objects',
          value,
          pickAsset,
          onChange(next) {
            value = next;
            render();
          },
        }),
      );
    try {
      await act(async () => render());
      await click(document.querySelector('.cms-repeat-row'));
      assert.match(
        document.querySelector('.cms-delete-action').textContent,
        /Delete/,
        'the item dialog uses the quieter destructive action',
      );
      await click(document.querySelector('.cms-modal .cms-repeat-row'));
      assert.equal(document.querySelectorAll('dialog.popup-dialog').length, 2);
      await click(document.querySelectorAll('.cms-modal .af-choose')[0]);
      const request = getPendingAsset();
      assert.ok(request);
      await act(async () => request.onPick('src/assets/new.png'));
      assert.deepEqual(imports, [{ rel: 'src/assets/new.png', root: 'src' }]);
      assert.deepEqual(value[0].nested[0].image, {
        __expr: 'newImage',
        __asset: 'src/assets/new.png',
      });
      await act(async () =>
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })),
      );
      assert.equal(document.querySelectorAll('dialog.popup-dialog').length, 1);
      assert.match(document.querySelector('.cms-modal-header').textContent, /Outer/);
      await act(async () =>
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })),
      );
      assert.equal(document.querySelectorAll('dialog.popup-dialog').length, 0);
    } finally {
      await act(async () => root.unmount());
    }
  },
);

test('reordering a repeater preserves the entry shown by its open dialog', async () => {
  const root = createRoot(document.getElementById('root'));
  let value = [{ title: 'First' }, { title: 'Second' }, { title: 'Third' }];
  // eslint-disable-next-line stacki/bounded-recursion -- Event re-entry: onChange re-renders.
  const render = () =>
    root.render(
      React.createElement(Field, {
        ...context,
        type: 'objects',
        value,
        onChange(next) {
          value = next;
          render();
        },
      }),
    );
  const pointer = (target, type, y) =>
    act(async () =>
      target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, button: 0, clientY: y })),
    );
  try {
    await act(async () => render());
    await click(document.querySelectorAll('.cms-repeat-row')[1]);
    const rows = [...document.querySelectorAll('.cms-repeat-row')];
    rows.forEach((row, index) => {
      row.getBoundingClientRect = () => ({ top: index * 30, height: 30 });
    });
    await pointer(rows[0], 'pointerdown', 5);
    await pointer(window, 'pointermove', 100);
    await pointer(window, 'pointerup', 100);
    assert.deepEqual(
      value.map((entry) => entry.title),
      ['Second', 'Third', 'First'],
    );
    assert.match(document.querySelector('.cms-modal-header').textContent, /Second/);
  } finally {
    await act(async () => root.unmount());
  }
});

test('CMS editor bounds reject invalid depth, text, and list size', () => {
  const render = (props) =>
    renderToStaticMarkup(
      React.createElement(Field, {
        ...context,
        type: 'text',
        value: '',
        ...props,
      }),
    );
  assert.throws(() => render({ depth: -1 }), /CMS field: depth must be nonnegative/);
  assert.throws(() => render({ depth: 0.5 }), /CMS field: depth must be an integer/);
  assert.throws(() => render({ depth: 129 }), /CMS field: nesting limit exceeded/);
  assert.throws(
    () => render({ value: 'a'.repeat(BOUNDARY_LIMITS.textLengthMax + 1) }),
    /CMS field: text limit exceeded/,
  );
  assert.throws(
    () => render({ type: 'list', value: Array(100001).fill('') }),
    /CMS list: item limit exceeded/,
  );
  assert.match(render({ depth: 128, value: 'ok' }), /ok/);
});

test('CMS text longer than a prop attribute keeps a text box instead of failing', async () => {
  const { LIMITS } = require('#dist/shared/core/limits.js');
  const root = createRoot(document.getElementById('root'));
  const changes = [];
  const long = 'Sermon transcript. '.repeat(Math.ceil((LIMITS.attrCharsMax + 1) / 19));
  assert.ok(long.length > LIMITS.attrCharsMax);
  const show = (type, value) =>
    act(async () =>
      root.render(
        React.createElement(Field, {
          ...context,
          type,
          value,
          onChange: (next) => changes.push(next),
        }),
      ),
    );
  try {
    for (const type of ['text', 'longtext']) {
      await show(type, long);
      const box = document.querySelector('textarea');
      assert.ok(box, type);
      assert.equal(box.value, long);
    }
    // Switching to a short item returns to the ordinary prop field.
    await show('text', 'Short title');
    assert.equal(document.querySelector('input').value, 'Short title');
  } finally {
    await act(async () => root.unmount());
  }
});

test.after(() => dom.window.close());
