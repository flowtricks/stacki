// Goal: code paints highlighted in its first frame, never as grey text that
// recolours a moment later. Astro source is coloured by Shiki's grammar, which
// loads on demand; the first Code panel of a session used to paint grey until
// it arrived. Now the app fetches the grammar when a project opens
// (panelPrefetch.ts), a loaded grammar colours a new editor or block as it is
// created, and an editor that opens while the grammar is still loading stays
// hidden for at most 150 ms rather than painting grey.
//
// Method: the real CodeEditor and CodeBlock are bundled and mounted in jsdom.
// Renders commit synchronously (a non-async act), so the DOM afterwards is the
// first frame. In order, because the grammar is module state: a cold Astro
// editor is held back and then revealed coloured; after the prefetch, a new
// editor and a new block carry token colours in their first frame; a Markdown
// fence is coloured in its first frame too.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
for (const name of ['window', 'Window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver']) {
  Object.defineProperty(global, name, { value: name === 'window' ? dom.window : dom.window[name], configurable: true });
}
global.getComputedStyle = dom.window.getComputedStyle;
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const create = React.createElement;

const ASTRO = '---\nconst title = "x";\n---\n<h1 class="a">{title}</h1>\n';

let code;
test.before(async () => {
  const outfile = repoPath('node_modules/.stacki-test/code-first-paint.cjs');
  fs.mkdirSync(path.dirname(outfile), { recursive: true });
  await esbuild.build({
    stdin: {
      contents: `export { default as CodeEditor } from './src/ui/CodeEditor'; export { CodeBlock } from './src/ui/CodeBlock'; export { prefetchAstroHighlighter } from './src/ui/astroHighlight';`,
      resolveDir: ROOT,
      loader: 'ts',
    },
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  code = require(outfile);
});

function mount(element) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // Synchronous: the DOM afterwards is the first committed frame.
  act(() => root.render(element));
  return { host, unmount: () => act(() => root.unmount()) };
}

const waitFor = async (ready, label) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) {
      return;
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  }
  assert.fail(`Timed out waiting for ${label}`);
};

test('a cold Astro editor is held back, not painted grey, then revealed coloured', async () => {
  const editor = mount(create(code.CodeEditor, { value: ASTRO, language: 'astro' }));
  const shell = editor.host.querySelector('.cm-editor');
  assert.ok(shell.classList.contains('cm-astro-pending'), 'The first frame hides the uncoloured text');
  assert.equal(editor.host.querySelectorAll('.cm-astro-token').length, 0);
  await waitFor(() => !shell.classList.contains('cm-astro-pending'), 'the reveal');
  await waitFor(() => editor.host.querySelector('.cm-astro-token'), 'the colours');
  editor.unmount();
});

test('after the prefetch, a new Astro editor is coloured in its first frame', async () => {
  await code.prefetchAstroHighlighter();
  const editor = mount(create(code.CodeEditor, { value: ASTRO, language: 'astro' }));
  assert.ok(!editor.host.querySelector('.cm-editor').classList.contains('cm-astro-pending'), 'Nothing is held back');
  const tokens = [...editor.host.querySelectorAll('.cm-astro-token')];
  assert.ok(tokens.length > 0, 'The first frame carries the grammar colours');
  assert.ok(new Set(tokens.map((token) => token.style.color)).size >= 3, 'Frontmatter and markup take several colours');
  editor.unmount();
});

test('after the prefetch, an Astro block is coloured in its first frame', async () => {
  await code.prefetchAstroHighlighter();
  const block = mount(create(code.CodeBlock, { text: ASTRO, language: 'astro' }));
  assert.ok(block.host.querySelectorAll('.code-token').length > 0, 'No plain first frame');
  assert.equal(block.host.textContent, ASTRO);
  block.unmount();
});

test('a Markdown fence is coloured in its first frame', () => {
  const editor = mount(create(code.CodeEditor, { value: '# Title\n\n```ts\nconst a = 1;\n```\n', language: 'markdown' }));
  const fence = [...editor.host.querySelectorAll('.cm-line')].find((line) => line.textContent === 'const a = 1;');
  assert.ok(fence, 'The fence line is drawn');
  assert.ok(fence.querySelector('span'), 'Its code is tokenised as the editor opens, not a tick later');
  editor.unmount();
});
