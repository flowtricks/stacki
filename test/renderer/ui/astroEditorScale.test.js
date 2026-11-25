// Goal: an Astro editor opens and stays coloured on a page of any length. Its
// first slice is coloured in the first frame, the rest is coloured slice by
// slice behind it, and an edit resumes the colouring from the slice before the
// edit instead of the top, so the event loop is never blocked for longer than one
// slice of grammar work.
//
// Method: a generated Astro page of several slices is opened in a real
// CodeMirror view under jsdom, with the grammar loaded first. The decoration set
// the extension provides is read back: the first window must be coloured at once,
// the last window must be coloured by the end of the pass, and an edit in the
// middle that opens a comment must recolour the lines after it (which the old
// colours, merely shifted, would not). Every wait runs under measureOperation,
// so the longest event-loop block is held to lagMsBound().

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { build } = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule.js');
const { lagMsBound, measureOperation, scaleMegabytes } = loadRenderer('test/helpers/scaleFixtures.ts');

const MEGABYTE = 1024 * 1024;
const WAIT_MS_MAX = 120_000;

const dom = new JSDOM('<!doctype html><div id="host"></div>', { pretendToBeVisual: true });
for (const name of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Window']) {
  Object.defineProperty(global, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true });
}
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });

let editor;
before(async () => {
  const output = repoPath('node_modules/.stacki-test/astro-editor-scale.cjs');
  await build({
    stdin: {
      contents: `export { astroCodeLines, astroHighlight, prefetchAstroHighlighter } from './src/ui/astroHighlight.ts';
        export { EditorView } from '@codemirror/view'; export { EditorState } from '@codemirror/state';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  editor = require(output);
  await editor.prefetchAstroHighlighter();
  // The grammar's first run is compiled lazily by the engine; that startup is
  // not the cost of a slice, so it is paid before anything is measured.
  await editor.astroCodeLines(astroPage(60_000));
});

function astroPage(characters) {
  const lines = ['---', 'const title = "Scale";', '---', '<main>'];
  let length = 0;
  for (let index = 0; length < characters; index++) {
    const line = index % 400 === 3 ? `still inside the comment ${index} -->` : `<p class="row-${index}" data-index={${index}}>{title} item ${index}</p>`;
    lines.push(line);
    length += line.length + 1;
  }
  lines.push('</main>');
  return lines.join('\n');
}

// The style strings of the colours that cover [from, to].
function stylesBetween(view, from, to) {
  const styles = [];
  for (const set of view.state.facet(editor.EditorView.decorations)) {
    if (typeof set !== 'function') {
      set.between(from, to, (_from, _to, value) => {
        styles.push(value.spec.attributes.style);
      });
    }
  }
  return styles;
}

async function waitUntil(condition, what) {
  const deadline = Date.now() + WAIT_MS_MAX;
  while (!condition()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('a long Astro page is coloured at once at the top, slice by slice below, and resumes after an edit', async () => {
  const text = astroPage((scaleMegabytes() * MEGABYTE) / 16);
  const parent = document.getElementById('host');
  // Building the view is one synchronous call however the colouring is done: CodeMirror lays out the whole
  // document in it (about half the block under jsdom, and over twice as long on a Windows runner as on a Mac).
  // Its grammar share is held to one slice by the two checks below, since a pass that coloured further would
  // already reach the last window; what is timed is the colouring that follows, which must yield slice by slice.
  const view = new editor.EditorView({ parent, state: editor.EditorState.create({ doc: text, extensions: [editor.astroHighlight] }) });
  assert.ok(stylesBetween(view, 0, 300).length > 0, 'the first window is coloured in the first frame');
  assert.equal(stylesBetween(view, text.length - 200, text.length).length, 0, 'the last window is not coloured yet');
  const opened = await measureOperation('astro-editor-open', `${text.length} chars`, async () => {
    await waitUntil(() => stylesBetween(view, text.length - 200, text.length).length > 0, 'the last window to be coloured');
  });
  assert.ok(opened.lagMsMax < lagMsBound(), `colouring after opening blocked the event loop ${opened.lagMsMax} ms`);

  const row = text.indexOf('<p class="row-1700"');
  const next = text.indexOf('\n', row) + 1;
  assert.ok(new Set(stylesBetween(view, next, next + 20)).size > 1, 'a markup line has several colours before the edit');
  const edited = await measureOperation('astro-editor-edit', `${text.length} chars`, async () => {
    view.dispatch({ changes: { from: row, insert: '<!-- ' } });
    // The comment now runs to the next `-->`, so the line after the edit is one colour.
    await waitUntil(() => new Set(stylesBetween(view, next + 5, next + 25)).size === 1, 'the lines after the edit to be recoloured');
  });
  assert.ok(edited.lagMsMax < lagMsBound(), `the edit blocked the event loop ${edited.lagMsMax} ms`);
  view.destroy();
});
