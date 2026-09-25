const assert = require('node:assert/strict');
const path = require('node:path');

(async () => {
  const outfile = path.join(
    __dirname,
    '../node_modules/.stacki-test/code-editor-lifecycle.bundle.js'
  );
  await require('esbuild').build({
    stdin: {
      contents: `export { default as CodeEditor } from './src/ui/CodeEditor.jsx'; export { EditorView } from '@codemirror/view';`,
      resolveDir: path.join(__dirname, '..'),
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
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  for (const name of [
    'window',
    'Window',
    'document',
    'navigator',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
  ]) {
    Object.defineProperty(global, name, {
      value: name === 'window' ? dom.window : dom.window[name],
      configurable: true,
    });
  }
  global.getComputedStyle = dom.window.getComputedStyle;
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error));
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    width: 0,
    height: 0,
  });
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { CodeEditor, EditorView } = require(outfile);
  const root = createRoot(document.getElementById('root'));
  const changes = [];
  const positions = [];
  const components = [];
  const render = async (value, revealLine = 2, ranges = true, language = 'javascript') => {
    await React.act(async () =>
      root.render(
        React.createElement(CodeEditor, {
          value,
          revealLine,
          language,
          onChange: (text) => changes.push(text),
          activeRange: ranges ? { from: 4, to: 7 } : null,
          componentRanges: ranges ? [{ from: 0, to: 3, id: 'one', name: 'One' }] : [],
          onPositionChange: (position) => positions.push(position),
          onOpenComponent: (name, id) => components.push({ name, id }),
        })
      )
    );
  };
  try {
    await render('one\ntwo\nthree');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    assert.equal(view.state.selection.main.head, 4, 'initial reveal goes to the requested line');
    assert.ok(
      document.querySelector('.cm-code-muted'),
      'code outside the selected range is dimmed'
    );
    assert.ok(document.querySelector('.cm-component-link'), 'component names receive link marks');
    view.posAtCoords = () => 1;
    document
      .querySelector('.cm-content')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, metaKey: true }));
    assert.deepEqual(components, [{ name: 'One', id: 'one' }], 'Command-click opens a component');
    document
      .querySelector('.cm-content')
      .dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(positions, [1], 'ordinary code clicks report the source position');
    await React.act(async () =>
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        changes: { from: view.state.doc.length, insert: '!' },
      })
    );
    assert.deepEqual(changes, ['one\ntwo\nthree!'], 'user edits emit exactly once');
    const caret = view.state.selection.main.head;
    await render('one\ntwo\nthree!');
    assert.equal(
      view.state.selection.main.head,
      caret,
      'controlled typing does not jump back to the revealed line'
    );
    await render('external\nupdated\nsource');
    assert.equal(view.state.doc.toString(), 'external\nupdated\nsource');
    assert.equal(changes.length, 1, 'external reloads and app undo do not echo a new edit');
    await render('external\nupdated\nsource', 3);
    assert.equal(
      view.state.selection.main.head,
      view.state.doc.line(3).from,
      'a new reveal request still moves the caret'
    );
    const astroSource = '<Heading tag="h1" maxWidth={17}>Find hope.</Heading>';
    await render(astroSource, null, false, 'astro');
    await React.act(() => new Promise((resolve) => setTimeout(resolve, 500)));
    const astroTokens = [...document.querySelectorAll('.cm-astro-token')];
    const punctuation = astroTokens.find((token) => token.textContent === '<');
    const component = astroTokens.find((token) => token.textContent === 'Heading');
    const attribute = astroTokens.find((token) => token.textContent === 'maxWidth');
    const number = astroTokens.find((token) => token.textContent === '17');
    assert.ok(punctuation, 'the Astro grammar recognizes tag punctuation');
    assert.ok(component, 'the Astro grammar recognizes a component tag');
    assert.ok(attribute, 'the Astro grammar recognizes an attribute');
    assert.ok(number, 'the Astro grammar recognizes a number inside an expression');
    assert.match(
      component.getAttribute('style'),
      /rgb\(127, 166, 184\)/,
      'components use muted blue'
    );
    assert.match(
      attribute.getAttribute('style'),
      /rgb\(170, 148, 192\)/,
      'attributes use muted purple'
    );
    assert.match(
      number.getAttribute('style'),
      /rgb\(201, 148, 112\)/,
      'numbers use muted orange'
    );
    assert.match(
      punctuation.getAttribute('style'),
      /rgb\(174, 120, 159\)/,
      'tag punctuation uses muted pink'
    );
    assert.deepEqual(errors, [], 'the editor reports no asynchronous errors');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
  console.log('code-editor-lifecycle: passed [edits, reloads, caret, reveal, Astro grammar]');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
