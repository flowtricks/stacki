// Goal: in the binding picker, groups of data the file does not read yet (a
// project data file such as consts.ts, the content collections) fold under
// their headings: closed by default, opened and closed by a click, Enter or
// Space on the heading, which says so in aria-expanded; a search still reaches
// into a folded group, and clearing it leaves each group as it was. Data in
// scope (the frontmatter) has no chevron and is always open. A data file's
// heading carries the file icon the Pages panel uses; the collections keep
// Astro's mark. A picker opened on a binding inside a folded group opens it.
// Method: the real DataPicker is bundled with its icons and rendered into
// jsdom with React's act; the tree is dataTree's for a page with one
// frontmatter value, one collection and consts.ts's exports (projectDataSources).
// Headings, rows and attributes are read from the DOM after each gesture, and
// each heading's icon is compared with the markup of the icon it should be.
// Last, a component's frontmatter is read as part of the component's own group
// (sectionHeads, then the rendered picker), a page's keeps its own group, and
// an imported function is drawn dimmed, says why, and picks nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const loadRenderer = require('../../helpers/rendererModule');

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'FocusEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const { renderToStaticMarkup } = require('react-dom/server');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'data-picker-sections.bundle.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as DataPicker } from './src/features/props/DataPicker.tsx';",
      "export { AstroIcon, CmsIcon, FileIcon } from './src/ui/Icons.tsx';",
    ].join('\n'),
    resolveDir: ROOT,
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
});
const { DataPicker, AstroIcon, CmsIcon, FileIcon } = require(output);
const { dataTree } = loadRenderer('src/editor/dataSuggest.ts');
const { sectionHeads } = loadRenderer('src/features/props/dataPickerModel.ts');
const { dataFileExports, projectSourceNodes } = loadRenderer('src/features/props/projectDataSources.ts');

const PAGE = 'src/pages/index.astro';
const EXPORTS = dataFileExports([{ rel: 'consts.ts#*general', data: { SITE: { name: 'Acme', url: 'https://acme.test' } } }]);
const projectSources = projectSourceNodes({ exports: EXPORTS, config: undefined, style: { kind: 'alias' }, file: PAGE, frontmatter: '', imports: [] });
const TREE = dataTree({ frontmatter: "const title = 'Home';", collections: [{ name: 'stats', count: 2 }], projectSources });

const headings = () => [...document.querySelectorAll('.dp-section')];
const heading = (text) => headings().find((element) => element.querySelector('.dp-section-heading')?.textContent === text);
const rowPaths = () => [...document.querySelectorAll('.dp-row')].map((row) => row.getAttribute('title').split(' — ')[0]);
const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const press = (element, key) => act(async () => element.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true })));
const search = (value) =>
  act(async () => {
    const input = document.querySelector('.dp-search input');
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });

async function mount(props) {
  // A fresh container each time: a root is never made twice on one.
  const container = document.createElement('div');
  document.body.replaceChildren(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(DataPicker, { tree: TREE, origin: { file: PAGE, page: undefined }, onPick() {}, ...props })));
  return root;
}

test('source groups start folded with a chevron; data in scope is open with none', async () => {
  const root = await mount({ current: undefined });
  assert.equal(heading('index.astro frontmatter').querySelector('.dp-twist') ?? undefined, undefined, 'the frontmatter has no chevron');
  assert.equal(heading('index.astro frontmatter').hasAttribute('aria-expanded'), false);
  for (const text of ['consts.ts', 'Content Collections']) {
    assert.ok(heading(text).querySelector('.dp-twist'), `${text} has a chevron`);
    assert.equal(heading(text).getAttribute('aria-expanded'), 'false', `${text} starts closed`);
  }
  assert.deepEqual(rowPaths(), ['title'], 'only data in scope is drawn');
  await act(async () => root.unmount());
});

test('a click, Enter or Space toggles a group, and only that group', async () => {
  const root = await mount({ current: undefined });
  await click(heading('consts.ts'));
  assert.equal(heading('consts.ts').getAttribute('aria-expanded'), 'true');
  assert.ok(heading('consts.ts').querySelector('.dp-twist.open'), 'the chevron turns as a row’s does');
  assert.deepEqual(rowPaths(), ['title', 'SITE'], 'the collections stay folded');
  await press(heading('consts.ts'), 'Enter');
  assert.deepEqual(rowPaths(), ['title']);
  await press(heading('Content Collections'), ' ');
  assert.deepEqual(rowPaths(), ['title', 'statsEntries']);
  await press(heading('Content Collections'), 'a');
  assert.deepEqual(rowPaths(), ['title', 'statsEntries'], 'other keys do nothing');
  await act(async () => root.unmount());
});

test('a search reaches into folded groups, and clearing it leaves each group as it was', async () => {
  const root = await mount({ current: undefined });
  await click(heading('Content Collections'));
  await search('acme');
  assert.deepEqual(rowPaths(), ['SITE.name', 'SITE.url'], 'matches in a folded group are shown');
  await search('');
  assert.equal(heading('consts.ts').getAttribute('aria-expanded'), 'false', 'still folded');
  assert.equal(heading('Content Collections').getAttribute('aria-expanded'), 'true', 'still open');
  await act(async () => root.unmount());
});

test('a picker opened on a binding inside a folded group opens that group; the Source picker folds nothing', async () => {
  const root = await mount({ current: 'SITE.name' });
  assert.equal(heading('consts.ts').getAttribute('aria-expanded'), 'true');
  assert.equal(heading('Content Collections').getAttribute('aria-expanded'), 'false');
  await act(async () => root.unmount());
  const open = await mount({ current: undefined, sources: 'open' });
  assert.equal(heading('consts.ts').querySelector('.dp-twist') ?? undefined, undefined);
  assert.ok(rowPaths().includes('SITE'));
  await act(async () => open.unmount());
});

test('a data file is headed by the file icon; the collections keep Astro’s mark, never the CMS one', async () => {
  const root = await mount({ current: undefined });
  // Compared by drawing: the live DOM and static markup write the style attribute differently.
  const drawing = (html) => [...html.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]).join('|');
  const icon = (text) => drawing(heading(text).querySelector('.dp-section-icon').outerHTML);
  const markup = (Icon) => drawing(renderToStaticMarkup(React.createElement(Icon, { size: 11 })));
  assert.equal(icon('consts.ts'), markup(FileIcon));
  assert.equal(icon('Content Collections'), markup(AstroIcon));
  assert.notEqual(icon('consts.ts'), markup(CmsIcon));
  await act(async () => root.unmount());
});

test('a component’s frontmatter is a part of its own group; a page’s keeps its own', async () => {
  const component = { file: 'src/components/Heading.astro', page: PAGE };
  assert.deepEqual(sectionHeads('frontmatter', 'props', component), [{ kind: 'part', heading: 'Frontmatter' }]);
  assert.deepEqual(sectionHeads('frontmatter', 'loop', component), [
    { kind: 'group', heading: 'Heading', section: 'props' },
    { kind: 'part', heading: 'Frontmatter' },
  ]);
  assert.deepEqual(sectionHeads('frontmatter', 'props', { file: PAGE, page: undefined }), [
    { kind: 'group', heading: 'index.astro frontmatter', section: 'frontmatter' },
  ]);
  const tree = dataTree({ frontmatter: "const { Tag = 'h2' } = Astro.props;\nconst content = 'Hi';" });
  const root = await mount({ tree, current: undefined, origin: component });
  assert.deepEqual(
    headings().map((element) => element.textContent),
    ['Heading'],
    'one green group, no HEADING.ASTRO FRONTMATTER',
  );
  assert.equal(document.querySelector('.dp-subsection')?.textContent, 'Frontmatter');
  assert.deepEqual(rowPaths(), ['Tag', 'content']);
  await act(async () => root.unmount());
});

test('an imported function is dimmed, says why, and picks nothing', async () => {
  const tree = dataTree({
    frontmatter: '',
    imports: [{ name: 'slotContent', path: '@/utils/slots.ts', named: true, imported: 'slotContent' }],
    importedValues: { slotContent: { kind: 'function' } },
  });
  const picks = [];
  const root = await mount({ tree, current: undefined, onPick: (picked) => picks.push(picked) });
  const row = [...document.querySelectorAll('.dp-row')].find((element) => element.querySelector('.dp-key')?.textContent === 'slotContent');
  assert.equal(row.getAttribute('aria-disabled'), 'true');
  assert.match(row.getAttribute('title'), /slotContent is a function: call it in the frontmatter/);
  assert.match(row.textContent, /function · @\/utils\/slots\.ts/);
  await click(row);
  assert.deepEqual(picks, [], 'a function is not bound');
  await act(async () => root.unmount());
});
