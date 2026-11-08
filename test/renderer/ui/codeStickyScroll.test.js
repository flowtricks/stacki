// Goal: a CodeEditor that asks for sticky headers draws pinned lines with their numbers
// and colours, a click scrolls to the line without touching the caret or focus, and
// the caret keeps clear of the stack. Sticky headers are opt-in: the Code panel, the
// Style panel's CSS Code box and any editor that does not ask have no stack, and a code window asks only for CSS and scripts.
// Method: the real CodeEditor is bundled and mounted in jsdom, which has no layout,
// so the scroller's height is stubbed and CodeMirror's estimated line heights stand
// in for measured ones. Scrolling sets scrollTop and fires the scroll event the
// browser would. The geometry on screen was checked by hand in Chromium.
const assert = require('node:assert/strict');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const lines = (...items) => items.join('\n');
const STYLE = lines(
  '',
  '    .hero_wrap {',
  '      .container {',
  '        & > :first-child {',
  ...Array.from({ length: 60 }, () => '          color: red;'),
  '        }',
  '      }',
  '    }',
  '  ',
);

(async () => {
  const outfile = repoPath('node_modules/.stacki-test/code-sticky-scroll.bundle.js');
  await require('esbuild').build({
    stdin: {
      contents:
        `export { default as CodeEditor } from './src/ui/CodeEditor.tsx'; export { EditorView } from '@codemirror/view';` +
        `export { CodeEditor as CssCodeEditor } from './src/features/style/components/CssCodeEditor.tsx';` +
        `export { default as CodePanel } from './src/features/code/CodePanel.tsx'; export { codeWindowPinsHeaders } from './src/features/code/CodeWindow.tsx';`,
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
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const errors = [];
  dom.window.addEventListener('error', (event) => errors.push(event.error));
  const emptyRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const { CodeEditor, CodePanel, CssCodeEditor, EditorView, codeWindowPinsHeaders } = require(outfile);
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 400 });
  const settle = () => React.act(() => new Promise((resolve) => dom.window.requestAnimationFrame(() => setTimeout(resolve, 0))));
  const root = createRoot(document.getElementById('root'));
  const mount = async (props) => {
    await React.act(async () => root.render(React.createElement(CodeEditor, { key: props.language, stickyHeaders: true, ...props })));
    await settle();
    return EditorView.findFromDOM(document.querySelector('.cm-editor'));
  };
  const scrollTo = async (view, line) => {
    view.scrollDOM.scrollTop = view.lineBlockAt(view.state.doc.line(line).from).top + view.documentPadding.top;
    view.scrollDOM.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
  };
  const rows = () => [...document.querySelectorAll('.cm-sticky-row')];
  const rowNumbers = () => rows().map((row) => row.querySelector('.cm-gutterElement').textContent);
  const rowTexts = () => rows().map((row) => row.querySelector('.cm-sticky-code').textContent);
  const rootShown = () => document.querySelector('.cm-sticky-scroll').style.display !== 'none';

  try {
    const view = await mount({ language: 'css', indentation: 'block', value: STYLE });
    assert.equal(view.state.doc.line(1).text, '.hero_wrap {', 'the editor shows the dedented view');
    assert.equal(rootShown(), false, 'nothing pins at rest');

    await scrollTo(view, 30);
    assert.deepEqual(rowNumbers(), ['1', '2', '3'], 'pinned lines carry the gutter numbers of the dedented view');
    assert.deepEqual(rowTexts(), ['.hero_wrap {', '\t.container {', '\t\t& > :first-child {'], 'and the indentation of the lines they copy');
    assert.ok(rows()[0].querySelector('.cm-sticky-code span[class]'), 'a pinned line keeps its syntax colours');
    const [firstRow, secondRow] = rows();
    assert.ok(Number(firstRow.style.zIndex) > Number(secondRow.style.zIndex), 'an outer line covers an inner one as it leaves');
    assert.equal(document.querySelector('.cm-scroller').firstElementChild.className, 'cm-sticky-scroll', 'the stack rides inside the scroller');

    await React.act(async () => view.dispatch({ selection: { anchor: view.state.doc.line(30).from } }));
    await settle();
    const marginTop = (editor) => Math.max(0, ...editor.state.facet(EditorView.scrollMargins).map((margin) => margin(editor)?.top ?? 0));
    assert.equal(marginTop(view), 3 * view.defaultLineHeight, 'the caret is kept below the lines that pin above it');

    // Click-to-jump: the line lands below what stays pinned, and the caret stays put.
    const caret = view.state.selection.main.head;
    const line = view.state.doc.line(2);
    const pressed = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    rows()[1].dispatchEvent(pressed);
    assert.equal(pressed.defaultPrevented, true, 'pressing a pinned line takes no focus from the editor');
    rows()[1].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(
      view.scrollDOM.scrollTop,
      view.lineBlockAt(line.from).top + view.documentPadding.top - view.defaultLineHeight,
      'a click scrolls to the line, one row down for the line pinned above it',
    );
    view.scrollDOM.dispatchEvent(new dom.window.Event('scroll'));
    await settle();
    assert.equal(view.state.selection.main.head, caret, 'and leaves the caret where it was');
    assert.deepEqual(rowNumbers(), [], 'the line is its real self again, and so are the headers above it');

    // An edit to a pinned line shows at once, without waiting for a scroll.
    await scrollTo(view, 30);
    const header = view.state.doc.line(2);
    await React.act(async () => view.dispatch({ changes: { from: header.from + 2, insert: 'x' } }));
    await settle();
    assert.equal(rowTexts()[1], '\t.xcontainer {');

    // A selector list pins as one row, with the first line's number, and jumps to it.
    const list = await mount({
      language: 'javascript',
      value: lines('// One.', 'function long(', '  first,', '  second,', ') {', ...Array.from({ length: 60 }, () => '  go();'), '}'),
    });
    await scrollTo(list, 30);
    assert.deepEqual(rowNumbers(), ['2']);
    assert.deepEqual(rowTexts(), ['function long(first, second,) {'], 'the whole opening shows on one row');
    assert.equal(document.querySelector('.cm-sticky-tail').textContent, '{', 'what opens the block sits apart, so truncation keeps it');
    assert.ok(document.querySelector('.cm-sticky-head span[class]'), 'a joined header keeps its syntax colours');
    rows()[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
    assert.equal(list.scrollDOM.scrollTop, list.lineBlockAt(list.state.doc.line(2).from).top + list.documentPadding.top, 'a click goes to its first line');

    // Opt-in: an editor that does not ask has neither a stack nor a scroll margin for one.
    const plain = await mount({ language: 'css', stickyHeaders: undefined, value: STYLE });
    await scrollTo(plain, 30);
    assert.ok(!document.querySelector('.cm-sticky-scroll'), 'an editor that does not ask pins nothing');
    assert.equal(marginTop(plain), 0, 'and keeps no margin');

    // The Code panel: a whole page, scrolled deep into nested markup and a nested <style>.
    const source = lines(
      '<main>',
      '  <section>',
      '    <style>',
      '      .a {',
      ...Array.from({ length: 60 }, () => '        color: red;'),
      '      }',
      '    </style>',
      '  </section>',
      '</main>',
    );
    await React.act(async () =>
      root.render(
        React.createElement(CodePanel, {
          source,
          relativePath: 'src/pages/index.astro',
          model: undefined,
          selectedId: undefined,
          onChange: () => undefined,
          onSelect: () => undefined,
          onOpenComponent: () => undefined,
        }),
      ),
    );
    await settle();
    const panel = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    await scrollTo(panel, 30);
    assert.equal(rows().length, 0, 'the Code panel has no pinned rows');
    assert.ok(!document.querySelector('.cm-sticky-scroll'), 'nor a stack to hold them');

    // The Style panel's CSS Code box, as EditableCssRule mounts it, scrolled inside a nested rule.
    await React.act(async () =>
      root.render(
        React.createElement(CssCodeEditor, {
          value: STYLE,
          language: 'css',
          ariaLabel: 'CSS',
          variables: { kind: 'declarations' },
          lineOverflow: 'scroll',
          onChange: () => undefined,
        }),
      ),
    );
    await settle();
    const box = EditorView.findFromDOM(document.querySelector('.cm-editor'));
    await scrollTo(box, 30);
    assert.equal(rows().length, 0, 'the CSS Code box has no pinned rows');
    assert.ok(!document.querySelector('.cm-sticky-scroll'), 'nor a stack to hold them');

    assert.equal(codeWindowPinsHeaders('css'), true, 'a <style> window pins');
    assert.equal(codeWindowPinsHeaders('javascript'), true, 'a <script> or frontmatter window pins');
    assert.equal(codeWindowPinsHeaders('typescript'), true);
    assert.equal(codeWindowPinsHeaders('astro'), false, 'a window of markup does not');
    assert.equal(codeWindowPinsHeaders('html'), false);
    assert.equal(codeWindowPinsHeaders('markdown'), false);
    assert.equal(codeWindowPinsHeaders(undefined), false);

    assert.deepEqual(errors, [], 'the editor reports no asynchronous errors');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
  }
  assert.ok(!document.querySelector('.cm-sticky-scroll'), 'unmounting takes the stack with it');
  console.log('code-sticky-scroll: passed [rows, colours, margin, click-to-jump, edits, opt-in, Code panel]');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
