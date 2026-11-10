// Goal: a raw declaration row (Other properties) is the same code field as every
// other CSS value: coloured, stepped by arrows, and committing what was typed.
// Method: the real ValueField, bundled as the panel loads it and rendered in jsdom,
// driven through its rich editor. The only stand-in is the preload's change listener.
// The negative space: a value that did not change writes nothing, and a property
// that refuses negatives stops at 0.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const directory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(directory, { recursive: true });
  const bundlePath = path.join(directory, 'value-field.bundle.js');
  await esbuild.build({
    stdin: { contents: "export { ValueField } from './src/features/style/embed/AddProperty.tsx';\n", resolveDir: ROOT, loader: 'ts' },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });

  const win = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true }).window;
  require('../../helpers/popupDom').installPopupDOM(win);
  win.avb = { onCssChanged: () => () => {} };
  Object.assign(global, {
    window: win,
    document: win.document,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLTextAreaElement: win.HTMLTextAreaElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
  Object.defineProperty(global, 'navigator', { value: win.navigator, configurable: true });

  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const { ValueField } = require(bundlePath);

  const mount = async (prop, value) => {
    const commits = [];
    const host = win.document.createElement('div');
    win.document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        React.createElement(ValueField, {
          prop,
          value,
          important: false,
          busy: false,
          onCommit: (next, important) => commits.push({ next, important }),
          onLiveCommit: () => undefined,
          onPick: () => undefined,
        }),
      );
    });
    return { host, commits, editor: host.querySelector('.embed-editor_varconnect-editor'), unmount: () => act(async () => root.unmount()) };
  };

  const placeCaret = (editor, offset) => {
    const walker = win.document.createTreeWalker(editor, win.NodeFilter.SHOW_TEXT);
    let left = offset;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (left <= node.textContent.length) {
        win.getSelection().collapse(node, left);
        return;
      }
      left -= node.textContent.length;
    }
    throw new Error('placeCaret: offset is past the text');
  };
  const press = (editor, key) => act(async () => editor.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })));

  {
    const { host, editor, commits, unmount } = await mount('--_offset', 'calc(1lh - 0.2em)');
    assert.ok(editor, 'the row draws the rich editor');
    assert.equal(editor.textContent, 'calc(1lh - 0.2em)');
    assert.ok(editor.querySelector('span'), 'the value is syntax highlighted');
    assert.equal(host.querySelector('textarea[data-prop="--_offset"]')?.value, 'calc(1lh - 0.2em)', 'the field behind it can still be found');

    await act(async () => editor.focus());
    await act(async () => editor.blur());
    assert.deepEqual(commits, [], 'an unchanged value writes nothing');

    await act(async () => editor.focus());
    placeCaret(editor, 8);
    await press(editor, 'ArrowUp');
    assert.equal(editor.textContent, 'calc(2lh - 0.2em)', 'an arrow steps the number with the caret after its unit');
    await act(async () => editor.blur());
    assert.deepEqual(commits, [{ next: 'calc(2lh - 0.2em)', important: false }], 'blur commits the step');
    await unmount();
  }
  {
    const { editor, unmount } = await mount('padding', '0rem');
    await act(async () => editor.focus());
    placeCaret(editor, 4);
    await press(editor, 'ArrowDown');
    assert.equal(editor.textContent, '0rem', 'padding stops at 0');
    await unmount();
  }
  console.log('value field: ok');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
