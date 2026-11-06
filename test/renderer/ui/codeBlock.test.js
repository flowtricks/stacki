// Goal: code shown rather than edited is coloured, in every language the app
// shows and at every site that shows it, without losing a character of the text.
// Method: the tokenisers run on one sample per language, and the colours are
// compared with the rule table CodeEditor builds its highlight style from, so a
// token is known to match the editor rather than merely to have a colour. Invalid
// input follows: unknown languages, text over the limit and unterminated quotes
// must still give the text back. Then the real components are bundled and mounted
// in jsdom, each site with the smallest props it needs and its IPC modules stubbed,
// and each must show `.code-token` spans, or CodeMirror's for the editable fields.

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { build } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath, stubSources } = require('../../helpers/sources.js');

const KEYWORD = '#c792ea';
const TAG = '#ffcb6b';
const STRING = '#c3e88d';
const NUMBER = '#f78c6c';
const FUNCTION = '#82aaff';
const ATTRIBUTE = '#80cbc4';

const STUBS = {
  'src/features/git/MergeResultEditor.tsx': () => ({ contents: 'export default function MergeResultEditor() { return null; }', loader: 'js' }),
  'src/features/history/historyDiffBridge.ts': () => ({
    contents: `export async function readHistoryDiff() { return { ok: true, value: '@@ -1 +1 @@\\n-const before = 1;\\n+const after = "two";\\n' }; }`,
    loader: 'js',
  }),
  'studio/src/features/ai/chatActions.ts': () => ({ contents: 'export function applyProposal() {} export function discardProposal() {}', loader: 'js' }),
  'studio/src/features/collections/content.ts': () => ({ contents: `export function collectionContent() { throw new Error('Unparsed'); }`, loader: 'js' }),
};

// Studio reaches the editor through a generated copy (studio/vendor is built by
// `npm --prefix studio run assemble`); here it is the source that copy is made of.
const vendorSources = {
  name: 'vendor-sources',
  setup(context) {
    context.onResolve({ filter: /\/vendor\/stacki\// }, async (args) => {
      const relative = args.path.slice(args.path.indexOf('/vendor/stacki/') + '/vendor/stacki/'.length);
      return context.resolve(`./${relative}`, { resolveDir: ROOT, kind: args.kind });
    });
  },
};

async function bundle(name, contents) {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await build({
    stdin: { contents, resolveDir: ROOT, loader: 'ts' },
    outfile: output,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'text', '.png': 'empty' },
    logLevel: 'silent',
    plugins: [vendorSources, stubSources('stub-code-sites', STUBS)],
  });
  delete require.cache[output];
  return require(output);
}

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
global.document = dom.window.document;
Object.defineProperty(global, 'navigator', { configurable: true, value: dom.window.navigator });
for (const name of [
  'Element',
  'HTMLElement',
  'Node',
  'Text',
  'Range',
  'MutationObserver',
  'getComputedStyle',
  'KeyboardEvent',
  'MouseEvent',
  'DOMParser',
  'Window',
]) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = (callback) => setTimeout(callback, 0);
global.cancelAnimationFrame = clearTimeout;
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.ResizeObserver = global.ResizeObserver;
// The chat scrolls to its end, and CodeMirror measures text through ranges;
// jsdom lays nothing out, so neither has anything to do.
dom.window.HTMLElement.prototype.scrollTo = () => {};
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
global.IS_REACT_ACT_ENVIRONMENT = true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');

let code;
before(async () => {
  code = await bundle(
    'code-block',
    `
    export * from './src/ui/CodeBlock';
    export * from './src/ui/codeHighlight';
    export { astroCodeLines } from './src/ui/astroHighlight';
    export { default as InstallCommand } from './src/features/studioSetup/InstallCommand';
    export { default as LocalStep } from './src/features/studioSetup/LocalStep';
    export { ConnectionHelp } from './src/features/publishing/PublishConnections';
    export { CodeControl } from './src/features/props/PropControls';
    export { default as PropertyReadOnlyFields } from './src/features/componentProperties/PropertyReadOnlyFields';
    export { RawLinePanel } from './src/features/props/SourcePanels';
    export { default as HistoryFileDiff } from './src/features/history/HistoryFileDiff';
    export { MergeConflictDetail } from './src/features/git/MergeConflictDetail';
    export { ChatText } from './studio/src/features/ai/ChatText';
    export { ChatMessages } from './studio/src/features/ai/ChatMessages';
    export { CollectionEditor } from './studio/src/features/collections/CollectionEditor';
    export { EditorView } from '@codemirror/view';
  `,
  );
});

const roots = [];
async function mount(element) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  roots.push({ root, host });
  await act(async () => {
    root.render(element);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return host;
}
after(async () => {
  for (const { root, host } of roots) {
    await act(async () => root.unmount());
    host.remove();
  }
});

const create = React.createElement;
const sourceOf = (lines) => lines.map((line) => line.map((token) => token.text).join('')).join('\n');
const colorOf = (lines, text) => lines.flat().find((token) => token.text === text)?.style?.color;
const tokenCount = (host) => host.querySelectorAll('.code-token').length;
const tokenColors = (host) => new Set([...host.querySelectorAll('.code-token')].map((token) => token.style.color));
const waitFor = async (ready, label) => {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (ready()) {
      return;
    }
    await act(async () => new Promise((resolve) => setTimeout(resolve, 25)));
  }
  assert.fail(`Timed out waiting for ${label}`);
};

test('each language colours its tokens with the editor rule for that kind', () => {
  const { codeTokenLines } = code;
  assert.equal(colorOf(codeTokenLines('const name = "x";', 'typescript'), 'const'), KEYWORD);
  assert.equal(colorOf(codeTokenLines('const name = "x";', 'typescript'), '"x"'), STRING);
  assert.equal(colorOf(codeTokenLines('function run() { return 1; }', 'javascript'), 'return'), KEYWORD);
  assert.equal(colorOf(codeTokenLines('function run() { return 1; }', 'javascript'), '1'), NUMBER);
  assert.equal(colorOf(codeTokenLines('<main class="a">x</main>', 'html'), 'main'), TAG);
  assert.equal(colorOf(codeTokenLines('<main class="a">x</main>', 'html'), 'class'), ATTRIBUTE);
  assert.equal(colorOf(codeTokenLines('.a { color: red; margin: 2px; }', 'css'), 'color'), ATTRIBUTE);
  assert.equal(colorOf(codeTokenLines('{ "name": "x", "size": 2, "on": true }', 'json'), '"name"'), STRING);
  assert.equal(colorOf(codeTokenLines('{ "name": "x", "size": 2, "on": true }', 'json'), '2'), NUMBER);
  assert.equal(colorOf(codeTokenLines('{ "name": "x", "size": 2, "on": true }', 'json'), 'true'), NUMBER);
  assert.equal(codeTokenLines('# Title', 'markdown')[0].at(-1).style.color, '#f5f5f5', 'A heading is coloured');
  assert.equal(colorOf(codeTokenLines('<!doctype html>', 'html'), '<!doctype html>'), '#8a8a8a');
});

test('shell colours the command, its flags and its strings, and a second command after a separator', () => {
  const { codeTokenLines } = code;
  const lines = codeTokenLines('FOO=1 npm run dev --config "a b" | grep x # note\ngit status', 'shell');
  assert.equal(colorOf(lines, 'npm'), FUNCTION);
  assert.equal(colorOf(lines, 'grep'), FUNCTION);
  assert.equal(colorOf(lines, 'git'), FUNCTION);
  assert.equal(colorOf(lines, '--config'), ATTRIBUTE);
  assert.equal(colorOf(lines, '"a b"'), STRING);
  assert.equal(colorOf(lines, 'run'), undefined, 'An argument stays plain');
  assert.equal(colorOf(lines, '# note'), '#8a8a8a');
  assert.equal(lines.length, 2);
});

test('a # inside a word is not a comment', () => {
  const lines = code.codeTokenLines('echo a#b', 'shell');
  assert.equal(
    lines.flat().some((token) => token.text.startsWith('#')),
    false,
  );
});

test('astro uses the editor grammar, frontmatter and markup alike', async () => {
  const source = '---\nconst title = "x";\n---\n<h1 class="a">{title}</h1>\n';
  const lines = await code.astroCodeLines(source);
  assert.equal(sourceOf(lines), source);
  assert.ok(new Set(lines.flat().map((token) => token.style.color)).size >= 3, 'Frontmatter and markup take several colours');
});

test('the text survives colouring, whatever it is', () => {
  const samples = {
    css: ['', '\n', 'a{', '/* open', '.a {\n  color: red;\n}\n'],
    html: ['', '<', '<div', '<a href="', '\n\n<p>\n'],
    json: ['', '{', '}', '{"a":', '[1,\n2]\n', ')('],
    markdown: ['', '```', '# a\n\n- b\n'],
    shell: ['', '"', "'", '$', '${', '#', ' ', '\n', 'a\\', 'x=', 'a;b', '-', '\n\n  git  add\t.\n'],
    typescript: ['', '`', '/*', 'const', 'a\n\nb\n', '(x: string) => void', '<T,>() => 1'],
  };
  for (const [language, texts] of Object.entries(samples)) {
    for (const text of texts) {
      assert.equal(sourceOf(code.codeTokenLines(text, language)), text, `${language}: ${JSON.stringify(text)}`);
    }
  }
});

test('text in no known language, or past the limit, shows plain', () => {
  const { codeTokenLines, languageFor, languageNamed } = code;
  assert.deepEqual(codeTokenLines('a: 1\nb: 2', undefined), [[{ text: 'a: 1' }], [{ text: 'b: 2' }]]);
  const long = 'x'.repeat(1_000_001);
  assert.deepEqual(codeTokenLines(long, 'typescript'), [[{ text: long }]]);
  assert.equal(languageFor('src/data/site.yaml'), undefined);
  assert.equal(languageFor(undefined), undefined);
  assert.equal(languageFor('Makefile'), undefined);
  assert.equal(languageNamed(''), undefined);
  assert.equal(languageNamed('constructor'), undefined, 'A fence name is not a key of the object prototype');
});

test('a path or a fence name picks the language', () => {
  const { languageFor, languageNamed } = code;
  const expected = {
    'a.astro': 'astro',
    'a.html': 'html',
    'a.svg': 'html',
    'a.ts': 'typescript',
    'a.TSX': 'typescript',
    'a.js': 'javascript',
    'a.mjs': 'javascript',
    'a.css': 'css',
    'a.scss': 'css',
    'a.json': 'json',
    'a.md': 'markdown',
    'a.mdx': 'markdown',
    'a.sh': 'shell',
  };
  for (const [file, language] of Object.entries(expected)) {
    assert.equal(languageFor(file), language, file);
  }
  assert.equal(languageNamed('bash'), 'shell');
  assert.equal(languageNamed('TS'), 'typescript');
});

test('CodeBlock draws a pre with coloured spans, and a label makes it a tab stop', async () => {
  const host = await mount(create(code.CodeBlock, { text: 'const a = 1;\nconst b = 2;', filename: 'a.ts', className: 'site', label: 'Sample' }));
  const block = host.querySelector('pre.code-block.site');
  assert.equal(block.textContent, 'const a = 1;\nconst b = 2;');
  assert.equal(block.getAttribute('aria-label'), 'Sample');
  assert.equal(block.tabIndex, 0);
  assert.ok(tokenColors(host).size >= 2);
  const plain = await mount(create(code.CodeBlock, { text: 'plain words' }));
  assert.equal(tokenCount(plain), 0);
  assert.equal(plain.querySelector('pre').hasAttribute('tabindex'), false);
});

test('CodeBlock shows astro plain, then coloured once the grammar arrives, and follows new text', async () => {
  const shown = (text) => create(code.CodeBlock, { text, language: 'astro' });
  const host = await mount(shown('<h1 class="a">one</h1>'));
  assert.equal(host.textContent, '<h1 class="a">one</h1>');
  await waitFor(() => tokenCount(host) > 0, 'astro tokens');
  assert.equal(host.textContent, '<h1 class="a">one</h1>');
  await act(async () => roots.at(-1).root.render(shown('<h2>two</h2>')));
  assert.equal(host.textContent, '<h2>two</h2>', 'New text shows at once, before its colours');
  await waitFor(() => tokenCount(host) > 0, 'the new tokens');
  assert.equal(host.textContent, '<h2>two</h2>');
});

test('CodeInline keeps the host class on a code element', async () => {
  const host = await mount(create(code.CodeInline, { text: 'git status', language: 'shell', className: 'note' }));
  assert.ok(host.querySelector('code.code-inline.note .code-token'));
  assert.equal(host.textContent, 'git status');
});

test('the install and launch commands are highlighted shell', async () => {
  const install = await mount(create(code.InstallCommand));
  assert.equal(install.querySelector('.studio-install-command-box code').textContent, 'npm create stacki@latest');
  assert.ok(tokenCount(install) > 0);
  const launch = await mount(create(code.LocalStep, { installed: true, previewURL: undefined }));
  assert.ok(launch.querySelector('pre.studio-launch-code[aria-label="Launch command"] .code-token'));
  assert.ok(!launch.querySelector('textarea'));
});

test('connection help highlights the sign-in command', async () => {
  const host = await mount(create(code.ConnectionHelp, { provider: 'cloudflare' }));
  assert.equal(host.querySelector('code').textContent, 'wrangler login');
  assert.ok(tokenCount(host) > 0);
});

test('a prop set in code shows its type and value highlighted', async () => {
  const field = { codeKind: 'function', typeText: '(value: string) => void' };
  const host = await mount(create(code.CodeControl, { state: { field, value: { type: 'string', value: 'x' }, label: 'Handler' } }));
  assert.equal(host.querySelector('.props-code-row-type').textContent, '(value: string) => void');
  assert.equal(host.querySelector('.props-code-row-value').textContent, '"x"');
  assert.ok(host.querySelector('.props-code-row-type .code-token'));
  assert.equal(host.querySelector('.props-code-row-value .code-token').style.color, 'rgb(195, 232, 141)');
});

test('a read-only prop shows its type and default as code, and says when one is absent', async () => {
  const property = { name: 'size', type: "'small' | 'large'", required: false, readonly: false, defaultValue: '', description: '' };
  const host = await mount(create(code.PropertyReadOnlyFields, { property }));
  const type = host.querySelector('pre[aria-label="Code type"]');
  assert.equal(type.textContent, "'small' | 'large'");
  assert.ok(type.querySelector('.code-token'));
  const empty = host.querySelector('pre[aria-label="Default value"]');
  assert.equal(empty.textContent, 'Not specified');
  assert.ok(!empty.querySelector('.code-token'), 'The placeholder is not code');
});

test('a source line edits as highlighted markup, and only an edit writes', async () => {
  const written = [];
  const node = { id: 'n', kind: 'raw-line', value: '<!doctype html>' };
  const host = await mount(create(code.RawLinePanel, { node, onSetText: (text) => written.push(text) }));
  const content = host.querySelector('.cm-content[aria-label="Doctype"]');
  assert.ok(content, 'The line is an editor, named for what it holds');
  assert.ok(!host.querySelector('textarea'));
  assert.ok(content.querySelector('.cm-line span'), 'The markup is coloured');
  assert.deepEqual(written, []);
  const view = code.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '<?xml?>' } }));
  assert.deepEqual(written, ['<?xml?>']);
});

test('a history diff colours its code rows and leaves its headings plain', async () => {
  const props = {
    projectPath: '/project',
    commit: { hash: 'a'.repeat(40), shortHash: 'aaaaaaa', parents: [], isMerge: false },
    file: { path: 'src/a.ts' },
    onBack: () => {},
  };
  const host = await mount(create(code.HistoryFileDiff, props));
  await waitFor(() => host.querySelector('.history-diff-lines'), 'the diff');
  const [deleted, added] = [...host.querySelectorAll('.history-diff-code')];
  assert.equal(deleted.textContent, 'const before = 1;');
  assert.equal(added.textContent, 'const after = "two";');
  assert.ok(deleted.querySelector('.code-token'));
  assert.ok(added.querySelector('.code-token'));
  assert.ok(!host.querySelector('.history-diff-heading .code-token'));
});

test('both sides of a merge conflict are highlighted by the file they came from', async () => {
  const model = {
    file: { path: 'a.ts' },
    draft: { mode: 'merged', regions: [{ choice: 'ours', review: 'pending', selectable: true }] },
    ours: 'main',
    clashes: [{ ours: 'const a = 1;', theirs: 'const a = 2;', changedBy: 'both' }],
    active: 0,
    select: () => {},
    edit: () => {},
    choose: () => {},
  };
  const host = await mount(create(code.MergeConflictDetail, { model, conflict: { branch: 'feature' }, working: false }));
  const blocks = [...host.querySelectorAll('pre.merge-source-code')];
  assert.deepEqual(
    blocks.map((block) => block.textContent),
    ['const a = 1;', 'const a = 2;'],
  );
  assert.ok(blocks.every((block) => block.querySelector('.code-token')));
});

test('a chat fence is highlighted by the language it names, and an unnamed one stays plain', async () => {
  const text = 'Before\n\n```ts\nconst a = 1;\n```\n\n```\nplain\n```\n';
  const host = await mount(create(code.ChatText, { text }));
  const [named, unnamed] = [...host.querySelectorAll('pre')];
  assert.equal(named.textContent, 'const a = 1;\n');
  assert.ok(named.querySelector('code .code-token'));
  assert.equal(unnamed.textContent, 'plain\n');
  assert.ok(!unnamed.querySelector('.code-token'));
});

test('a chat proposal highlights both versions of a file, and a new file says so in words', async () => {
  const proposal = (before) => ({ changes: [{ file: 'src/a.css', before, after: '.a { color: red; }' }] });
  const chat = (before) => ({ id: 'c', status: 'idle', messages: [{ id: 'm', role: 'assistant', content: '', images: [], proposal: proposal(before) }] });
  const changed = await mount(create(code.ChatMessages, { chat: chat('.a { margin: 0; }'), refresh: () => {} }));
  assert.ok(changed.querySelector('pre.diff-before .code-token'));
  assert.ok(changed.querySelector('pre.diff-after .code-token'));
  const created = await mount(create(code.ChatMessages, { chat: chat(''), refresh: () => {} }));
  assert.equal(created.querySelector('pre.diff-before').textContent, '(new file)');
  assert.ok(!created.querySelector('pre.diff-before .code-token'));
});

test('a collection source that does not parse opens in the highlighted editor', async () => {
  const edits = [];
  const source = '{ "title": ';
  const shared = { file: 'src/content/posts/a.json', text: { toString: () => source, length: source.length }, edit: (edit) => edits.push(edit) };
  const host = await mount(create(code.CollectionEditor, { document: shared }));
  const editor = host.querySelector('[aria-label="Collection source"] .cm-editor');
  assert.ok(editor, 'The source is an editor');
  assert.ok(!host.querySelector('textarea'));
  const view = code.EditorView.findFromDOM(editor);
  assert.equal(view.state.doc.toString(), source);
  await act(async () => view.dispatch({ changes: { from: source.length, insert: '1 }' } }));
  assert.deepEqual(edits, [{ start: 0, end: source.length, text: '{ "title": 1 }' }]);
});
