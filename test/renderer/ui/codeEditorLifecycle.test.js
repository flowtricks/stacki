// Goal: the shared CodeEditor reveals the requested line, marks component
// links, positions selected code on opening, reports clicks, and emits each
// user edit exactly once — never echoing an external reload or an app undo.
// Method: the component is bundled with esbuild, mounted into jsdom through
// React, and driven through its CodeMirror view; assertions read the editor
// state and the callbacks it fired.
// Inspect the structural highlighter before waiting for Shiki to catch fallback-color flashes.

const assert = require('node:assert/strict');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');

(async () => {
  const outfile = repoPath('node_modules/.stacki-test/code-editor-lifecycle.bundle.js');
  await require('esbuild').build({
    stdin: {
      contents:
        `export { default as CodeEditor, selectedCodeScrollTop } ` +
        `from './src/ui/CodeEditor.tsx'; export { EditorView } from '@codemirror/view';` +
        `export { highlightingFor } from '@codemirror/language';` +
        `export { tags } from '@lezer/highlight';`,
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
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    pretendToBeVisual: true,
  });
  for (const name of ['window', 'Window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
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
  const { CodeEditor, EditorView, selectedCodeScrollTop, highlightingFor, tags } = require(outfile);
  assert.equal(selectedCodeScrollTop(600, 820, 500), 350, 'short blocks center their start');
  assert.equal(selectedCodeScrollTop(600, 850, 500), 350, 'a block fitting exactly stays centered');
  assert.equal(selectedCodeScrollTop(600, 851, 500), 600, 'overflowing blocks start at the top');
  assert.equal(selectedCodeScrollTop(100, 120, 500), 0, 'the first lines do not scroll above zero');
  assert.equal(selectedCodeScrollTop(600, 820, 0), undefined, 'an unmeasured editor waits');
  assert.throws(() => selectedCodeScrollTop(600, 599, 500), /Selected code range keeps its order/);
  const root = createRoot(document.getElementById('root'));
  const changes = [];
  const positions = [];
  const components = [];
  // Options spread over the defaults, so a render can ask for no reveal line at all.
  const render = async (value, options = {}) => {
    const { revealLine, ranges, language } = {
      revealLine: 2,
      ranges: true,
      language: 'javascript',
      ...options,
    };
    await React.act(async () =>
      root.render(
        React.createElement(CodeEditor, {
          value,
          revealLine,
          language,
          onChange: (text) => changes.push(text),
          activeRange: ranges ? { from: 4, to: 7 } : undefined,
          componentRanges: ranges ? [{ from: 0, to: 3, id: 'one', name: 'One' }] : [],
          onPositionChange: (position) => positions.push(position),
          onOpenComponent: (name, id) => components.push({ name, id }),
        }),
      ),
    );
  };
  try {
    await render('one\ntwo\nthree');
    const view = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    assert.ok(highlightingFor(view.state, [tags.keyword]), 'JavaScript keeps its syntax colors');
    assert.equal(view.state.selection.main.head, 4, 'initial reveal goes to the requested line');
    assert.ok(document.querySelector('.cm-code-muted'), 'code outside the selected range is dimmed');
    assert.ok(document.querySelector('.cm-component-link'), 'component names receive link marks');
    view.posAtCoords = () => 1;
    document.querySelector('.cm-content').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, metaKey: true }));
    assert.deepEqual(components, [{ name: 'One', id: 'one' }], 'Command-click opens a component');
    document.querySelector('.cm-content').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.deepEqual(positions, [1], 'ordinary code clicks report the source position');
    await React.act(async () =>
      view.dispatch({
        selection: { anchor: view.state.doc.length },
        changes: { from: view.state.doc.length, insert: '!' },
      }),
    );
    assert.deepEqual(changes, ['one\ntwo\nthree!'], 'user edits emit exactly once');
    const caret = view.state.selection.main.head;
    await render('one\ntwo\nthree!');
    assert.equal(view.state.selection.main.head, caret, 'controlled typing does not jump back to the revealed line');
    await render('external\nupdated\nsource');
    assert.equal(view.state.doc.toString(), 'external\nupdated\nsource');
    assert.equal(changes.length, 1, 'external reloads and app undo do not echo a new edit');
    // A saved text that came back with an outside edit merged into it (step 8)
    // replaces only what differs: the caret stays where the user put it, and
    // moves with text inserted before it.
    await React.act(async () => view.dispatch({ selection: { anchor: 2 } }));
    await render('external\nupdated\nsource, merged');
    assert.equal(view.state.selection.main.head, 2, 'a change after the caret leaves it');
    await render('an external\nupdated\nsource, merged');
    assert.equal(view.state.selection.main.head, 5, 'a change before the caret carries it');
    assert.equal(changes.length, 1, 'neither echoes as an edit');
    await render('external\nupdated\nsource');
    await render('external\nupdated\nsource', { revealLine: 3 });
    assert.equal(view.state.selection.main.head, view.state.doc.line(3).from, 'a new reveal request still moves the caret');
    const astroSource = '<Heading tag="h1" maxWidth={17}>Find hope.</Heading>';
    const astroOptions = { revealLine: undefined, ranges: false, language: 'astro' };
    // Highlighting runs in the background and is bounded per line (Shiki's
    // tokenize time limit). The first pass in a process also compiles the
    // grammar, and under a loaded gate it can run out of time partway along
    // the line. So: wait for the grammar to be ready, then change the document
    // so a warm pass highlights it again, and wait for that pass's last token.
    // Each wait is bounded at five seconds.
    const HIGHLIGHT_WAIT_MS_MAX = 5_000;
    const tokenTexts = () => [...document.querySelectorAll('.cm-astro-token')].map((token) => token.textContent);
    const waitFor = async (ready) => {
      for (let waitedMs = 0; waitedMs < HIGHLIGHT_WAIT_MS_MAX && !ready(); waitedMs += 100) {
        await React.act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      }
    };
    await render(astroSource, astroOptions);
    const astroView = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    assert.ok(
      highlightingFor(astroView.state, [tags.keyword, tags.string, tags.tagName]) === null,
      'Astro never shows fallback syntax colors while its grammar loads',
    );
    await waitFor(() => tokenTexts().length > 0);
    // A pass that still runs out of time (a starved machine) is followed by
    // another, at most three.
    const WARM_PASSES_MAX = 3;
    for (let pass = 0; pass < WARM_PASSES_MAX && !tokenTexts().includes('17'); pass += 1) {
      await render(`${astroSource}\n`, astroOptions);
      await render(astroSource, astroOptions);
      await waitFor(() => tokenTexts().includes('17'));
    }
    const astroTokens = [...document.querySelectorAll('.cm-astro-token')];
    const punctuation = astroTokens.find((token) => token.textContent === '<');
    const component = astroTokens.find((token) => token.textContent === 'Heading');
    const attribute = astroTokens.find((token) => token.textContent === 'maxWidth');
    const number = astroTokens.find((token) => token.textContent === '17');
    assert.ok(punctuation, 'the Astro grammar recognizes tag punctuation');
    assert.ok(component, 'the Astro grammar recognizes a component tag');
    assert.ok(attribute, 'the Astro grammar recognizes an attribute');
    assert.ok(number, 'the Astro grammar recognizes a number inside an expression');
    assert.match(component.getAttribute('style'), /rgb\(127, 166, 184\)/, 'components use muted blue');
    assert.match(attribute.getAttribute('style'), /rgb\(170, 148, 192\)/, 'attributes use muted purple');
    assert.match(number.getAttribute('style'), /rgb\(201, 148, 112\)/, 'numbers use muted orange');
    assert.match(punctuation.getAttribute('style'), /rgb\(174, 120, 159\)/, 'tag punctuation uses muted pink');
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
