// Goal: the floating code window (the `<style>` CSS editor) is a tool window that outlives everything
// around it. Collapsing or expanding the Navigator or the right panel, picking another element, a click
// on the canvas (a message from the frame), a window resize, a scroll of the page under it and the window
// losing focus leave it open: the same DOM node, the same text, the same caret, the same undo history.
// Only what the person asks for closes it: Escape, the X, and the host dropping it when the node it edits
// is deleted or the project changes.
//
// Method: the real CodeWindow (so the real Popup and its dismissal, the real CodeMirror editor and the
// real window geometry) is mounted in jsdom inside a small shell that stands in for AppShell: two side
// panels with collapse buttons, a list of elements to select, a canvas area, and the host rule of
// CodeWindowHost (the window shows while its node exists). Each action is dispatched the way the browser
// does (pointerdown/mousedown/click on the control, a `message` event from the frame, a resize event) and
// the window is then read back. The same window is never found by a fresh query alone: the DOM node
// captured at the start must still be the one in the document. Layout in Chromium is test
// test/renderer/code/codeWindowStaysChromium.test.js. Waits poll state (test/helpers/waitFor.js).
//
// Run it with `node test/renderer/code/codeWindowStays.test.js`.
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

(async () => {
  const outfile = repoPath('node_modules/.stacki-test/code-window-stays.bundle.js');
  await require('esbuild').build({
    stdin: {
      contents:
        `export { default as CodeWindow } from './src/features/code/CodeWindow.tsx'; export { EditorView } from '@codemirror/view';` +
        `export { undo, undoDepth } from '@codemirror/commands';`,
      resolveDir: ROOT,
      loader: 'jsx',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const name of ['window', 'Window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
    Object.defineProperty(global, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true });
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  installPopupDOM(dom.window);
  dom.window.avb = { onCssChanged: () => () => undefined };
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const emptyRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { CodeWindow, EditorView, undoDepth } = require(outfile);
  const create = React.createElement;

  // The shell: what AppShell holds around the code window.
  let shell;
  function Shell() {
    const [navigatorOpen, setNavigatorOpen] = React.useState(true);
    const [rightOpen, setRightOpen] = React.useState(true);
    const [selectedId, setSelectedId] = React.useState('div1');
    const [nodes, setNodes] = React.useState(['s1', 'div1', 'div2']);
    const [open, setOpen] = React.useState(true);
    const [text, setText] = React.useState('a {\n  color: red;\n}\n');
    shell = { setNodes, setOpen, selectedId };
    return create(
      'div',
      { id: 'shell' },
      navigatorOpen &&
        create(
          'div',
          { id: 'navigator' },
          nodes.map((id) => create('button', { key: id, className: 'row', 'data-id': id, onClick: () => setSelectedId(id) }, id)),
        ),
      create('button', { id: 'toggle-navigator', onClick: () => setNavigatorOpen((current) => !current) }, 'navigator'),
      create('div', { id: 'canvas' }, 'canvas'),
      rightOpen && create('div', { id: 'right' }, 'properties'),
      create('button', { id: 'toggle-right', onClick: () => setRightOpen((current) => !current) }, 'right'),
      // CodeWindowHost's rule: the window shows while the node it edits exists.
      open &&
        nodes.includes('s1') &&
        create(CodeWindow, {
          title: '<style>',
          language: 'css',
          indentation: 'block',
          value: text,
          editorKey: 's1',
          onChange: setText,
          onClose: () => setOpen(false),
        }),
    );
  }

  const container = document.getElementById('root');
  const root = createRoot(container);
  const settle = () => React.act(() => new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0))));
  const act = async (action) => {
    await React.act(async () => action());
    await settle();
  };
  const press = (element) => {
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click']) {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
      element.dispatchEvent(event);
    }
  };
  const windowNode = () => document.querySelector('.code-window');
  const viewOf = () => EditorView.findFromDOM(document.querySelector('.cm-editor'));
  const shown = () => Boolean(windowNode());

  await act(() => root.render(create(Shell)));
  const first = await waitFor({ what: 'the code window to draw', read: () => windowNode() ?? undefined, until: (node) => node !== undefined });
  const editorNode = document.querySelector('.cm-editor');
  const view = viewOf();
  // The person types a line and puts the caret in the middle of it.
  await act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: '/* unsaved */\n' }, userEvent: 'input.type' }));
  await act(() => view.dispatch({ selection: { anchor: 6, head: 11 } }));
  const before = {
    text: view.state.doc.toString(),
    selection: [view.state.selection.main.anchor, view.state.selection.main.head],
    depth: undoDepth(view.state),
  };
  assert.ok(before.depth > 0, 'the typing is on the undo history');
  assert.ok(before.text.includes('unsaved'), 'the edit reached the document');

  const stays = async (what) => {
    await settle();
    await waitFor({ what: `${what}: the window still drawn`, read: () => shown(), until: (value) => value === true });
    assert.equal(windowNode(), first, `${what}: the window is the same DOM node`);
    assert.equal(document.querySelector('.cm-editor'), editorNode, `${what}: the editor is the same DOM node`);
    assert.ok(document.contains(first), `${what}: the window is in the document`);
    const current = viewOf();
    assert.equal(current, view, `${what}: the same editor view`);
    assert.equal(current.state.doc.toString(), before.text, `${what}: the text is unchanged`);
    assert.deepEqual([current.state.selection.main.anchor, current.state.selection.main.head], before.selection, `${what}: the selection is unchanged`);
    assert.equal(undoDepth(current.state), before.depth, `${what}: the undo history is unchanged`);
    assert.equal(first.getAttribute('data-popup-phase'), 'open', `${what}: the window is open, not closing`);
  };

  // Collapse and expand the Navigator and the right panel.
  await act(() => press(document.getElementById('toggle-navigator')));
  assert.equal(document.getElementById('navigator') ?? undefined, undefined, 'the Navigator collapsed');
  await stays('Navigator collapsed');
  await act(() => press(document.getElementById('toggle-navigator')));
  assert.notEqual(document.getElementById('navigator') ?? undefined, undefined, 'the Navigator expanded');
  await stays('Navigator expanded');
  await act(() => press(document.getElementById('toggle-right')));
  await stays('right panel collapsed');
  await act(() => press(document.getElementById('toggle-right')));
  await stays('right panel expanded');

  // Selecting another element, from the Navigator and from the canvas, leaves the window on its own node.
  await act(() => press(document.querySelector('.row[data-id="div2"]')));
  assert.equal(shell.selectedId, 'div2', 'another element is selected');
  await stays('another element selected in the Navigator');
  await act(() => press(document.getElementById('canvas')));
  await stays('a press on the canvas area');
  for (const type of ['avb:click-node', 'avb:open-node', 'avb:context-node', 'studio:select', 'studio:open']) {
    await act(() =>
      dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type, pressedAtMs: performance.timeOrigin + performance.now() + 1000 } })),
    );
    await stays(`a ${type} message from the canvas`);
  }

  // The window resizing, the page scrolling under it, the app losing focus.
  await act(() => dom.window.dispatchEvent(new dom.window.Event('resize')));
  await stays('a window resize');
  await act(() => document.getElementById('canvas').dispatchEvent(new dom.window.Event('scroll', { bubbles: false })));
  await stays('a scroll of the canvas');
  await act(() => dom.window.dispatchEvent(new dom.window.Event('blur')));
  await stays('the window losing focus');

  // Still editable afterwards: typing goes to the same document.
  await act(() => view.dispatch({ changes: { from: 0, insert: '/* more */\n' }, userEvent: 'input.type' }));
  assert.ok(shown(), 'still open after more typing');
  before.text = view.state.doc.toString();
  before.selection = [view.state.selection.main.anchor, view.state.selection.main.head];
  before.depth = undoDepth(view.state);

  // Negative space: Escape closes it.
  await act(() =>
    document.querySelector('.cm-content').dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })),
  );
  await waitFor({ what: 'Escape to close the window', read: () => shown(), until: (value) => value === false });

  // The X closes it.
  await act(() => shell.setOpen(true));
  await waitFor({ what: 'the window to draw again', read: () => shown(), until: (value) => value === true });
  const close = document.querySelector('.code-window-header button');
  assert.ok(close, 'the X is drawn');
  await act(() => close.click());
  await waitFor({ what: 'the X to close the window', read: () => shown(), until: (value) => value === false });

  // The host drops it when the node it edits is deleted.
  await act(() => shell.setOpen(true));
  await waitFor({ what: 'the window to draw once more', read: () => shown(), until: (value) => value === true });
  await act(() => shell.setNodes(['div1', 'div2']));
  await waitFor({ what: 'the delete of the node to close the window', read: () => shown(), until: (value) => value === false });

  await act(() => root.unmount());
  console.log('code-window-stays: all checks passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
