// Goal: the recovery dialog of an interrupted "Move styles" stays short however many files the move touched: its files
// are folded under one line, and open in place, every one of them, in a box capped at eight lines that scrolls.
// Method: StyleMoveFiles is bundled and mounted in jsdom with a long move (forty stylesheets left) and a short one. The
// fold is read through its button's aria-expanded and the rows it shows; jsdom lays nothing out, so the eight-line cap
// and the scrolling are checked in the stylesheets that hold them. The negative space: a move with no file at all, and
// two groups sharing a heading, are programmer errors and throw.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/style-move-files');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'styleMoveFiles.cjs');
buildSync({
  stdin: { contents: "export * from './src/app/shell/StyleMoveFiles';", resolveDir: repoPath('.'), loader: 'ts' },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
});

const dom = new JSDOM('<!doctype html><body></body>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
global.navigator = dom.window.navigator;
global.Node = dom.window.Node;
global.Element = dom.window.Element;
global.HTMLElement = dom.window.HTMLElement;
global.IS_REACT_ACT_ENVIRONMENT = true;
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = require('react');
const { StyleMoveFiles } = require(bundle);

const SENTENCE = 'Creating the Portfolio component stopped part way. No style was lost.';
const sheets = Array.from({ length: 40 }, (_, index) => `src/styles/sheet-${index}.css`);

async function render(props) {
  const container = dom.window.document.createElement('div');
  dom.window.document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(StyleMoveFiles, props)));
  return { container, unmount: () => act(async () => root.unmount()) };
}

const rows = (container) => [...container.querySelectorAll('.style-move-files-rows > *')].map((row) => `${row.tagName}:${row.textContent}`);

test('a long move shows its sentence and one folded line; the fold opens every file in place, left first', async () => {
  const view = await render({
    sentence: SENTENCE,
    label: 'See the files',
    groups: [
      { label: 'Not done yet:', files: sheets },
      { label: 'Done:', files: ['src/components/Portfolio.astro', 'src/pages/index.astro'] },
    ],
  });
  const toggle = view.container.querySelector('button.breakpoints-usage-toggle');
  assert.equal(view.container.textContent, `${SENTENCE}See the files`, 'folded: the sentence and the line, no file');
  assert.equal(toggle.getAttribute('aria-expanded'), 'false');
  await act(async () => toggle.click());
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  const list = view.container.querySelector('.breakpoints-usage-list');
  assert.equal(list.id, toggle.getAttribute('aria-controls'), 'the line names the box it opens');
  assert.deepEqual(rows(view.container), [
    'STRONG:Not done yet:',
    ...sheets.map((sheet) => `SPAN:${sheet}`),
    'STRONG:Done:',
    'SPAN:src/components/Portfolio.astro',
    'SPAN:src/pages/index.astro',
  ]);
  await act(async () => toggle.click());
  assert.equal(view.container.querySelector('.breakpoints-usage-list') ?? undefined, undefined, 'a second click folds it again');
  await view.unmount();
});

test('a group with no file is left out, and the box holds what remains', async () => {
  const view = await render({
    sentence: SENTENCE,
    label: 'See the files',
    groups: [
      { label: 'Changed since:', files: ['src/styles/base.css'] },
      { label: 'Done:', files: [] },
    ],
  });
  await act(async () => view.container.querySelector('button').click());
  assert.deepEqual(rows(view.container), ['STRONG:Changed since:', 'SPAN:src/styles/base.css']);
  await view.unmount();
});

test('the box is capped at eight lines and scrolls past them, with a stable gutter', () => {
  const own = fs.readFileSync(repoPath('src/app/shell/styleMoveFiles.css'), 'utf8');
  assert.match(own, /\.style-move-files-rows \{[^}]*max-height: calc\(8lh \+ 7 \* 4px\);/);
  const breakpoints = fs.readFileSync(repoPath('src/app/settings/breakpointsSettings.css'), 'utf8');
  const files = /\.breakpoints-usage-files \{([^}]*)\}/.exec(breakpoints)?.[1] ?? '';
  assert.match(files, /gap: 4px;/, 'the cap counts this gap between lines');
  assert.match(files, /overflow-y: auto;/);
  assert.match(files, /scrollbar-gutter: stable;/);
});

test('a move with no file, or two groups under one heading, is a programmer error', async () => {
  const errors = [];
  const quiet = console.error;
  console.error = () => {};
  try {
    for (const groups of [
      [],
      [{ label: 'Done:', files: [] }],
      [
        { label: 'Done:', files: ['a'] },
        { label: 'Done:', files: ['b'] },
      ],
    ]) {
      await render({ sentence: SENTENCE, label: 'See the files', groups }).catch((error) => errors.push(String(error)));
    }
  } finally {
    console.error = quiet;
  }
  assert.equal(errors.length, 3, 'each bad shape throws');
  assert.match(errors[0], /StyleMoveFiles: a move names at least one file/);
  assert.match(errors[1], /StyleMoveFiles: a move names at least one file/);
  assert.match(errors[2], /StyleMoveFiles: each group has its own heading/);
});
