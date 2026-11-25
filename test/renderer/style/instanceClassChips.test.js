// Goal: inside a component opened from an instance, a class that instance passed in
// is a selector chip, and a rule for it is written to the page, not the component.
// The marketing site's home page has `<ContentWrapper class="hero_inner"
// column1Class="hero_copy">`, and ContentWrapper renders column 1 as
// `<div class:list={[column1Class]}>`. Entering the component and selecting that
// div, the Style header read `div.hero_copy`, but the well listed only the
// component's own `.layout > :first-child`-style rules: `.hero_copy` had no rule,
// so it had no chip, and nothing could be picked to style it.
// Method: the panel's own pieces with no React. The host is set the way the app
// sets it (a component open, the page it is shown on, the classes the canvas
// reported); the chip list comes from chipsFor over a rule model the real matcher
// built; the write target from instanceSourceKey and embedWriteTarget over
// documents parsed from real `.astro` text. Valid and invalid shapes both: no
// instance outside a component, no page block that is scoped, the cap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'instance-class-chips.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { parseRegion, collectRules, splitEmbed } from './src/features/style/model/css';",
      "export { computeRuleModel } from './src/features/style/model/cascade';",
      "export { EmbedDocument } from './src/features/style/model/webflow';",
      "export { selectedInstanceClasses } from './src/features/style/model/webflowElement';",
      "export { INSTANCE_CLASSES_MAX, instanceClassesOf, instanceSourceKey, namesInstanceClass, withInstanceChips, writableRegion } from './src/features/style/model/instanceClasses';",
      "export { chipsFor, embedWriteTarget, createRuleForWrite } from './src/features/style/embed/editorModel';",
      "export { classifySelector, selectorAccessibleLabel } from './src/features/style/embed/LayoutRows';",
      "export { chipHint } from './src/features/style/embed/SelectorPicker';",
      "export { setHost, getHost } from './src/features/style/model/host';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);

const PAGE = '/site/src/pages/index.astro';
const COMPONENT = '/site/src/components/wrapper/ContentWrapper.astro';
const SHEET = '/site/src/styles/global.css';
const BASE = { key: '', label: 'Base', breakpoint: undefined, embedAtContext: '' };

// ContentWrapper's tree as the open component: layout > column 1.
const COLUMN = { id: '0.0', kind: 'element', name: 'div', props: { 'class:list': { type: 'expr', value: '[column1Class]' } } };
const LAYOUT = { id: '0', kind: 'element', name: 'div', props: { 'class:list': { type: 'expr', value: '["layout", className]' } }, children: [COLUMN] };

function openComponent(overrides) {
  model.setHost({
    ...model.getHost(),
    nodes: [LAYOUT],
    selectedId: COLUMN.id,
    openFilePath: COMPONENT,
    openFileKind: 'component',
    contextPagePath: PAGE,
    renderedClasses: ['hero_copy'],
    ...overrides,
  });
}

// The component's own rules, matched against layout > column.
const COMPONENT_CSS = `.layout > :first-child { min-width: 0; }\n:focus-visible { outline: 2px solid; }`;
const NODES = {
  layout: { tag: 'div', classes: ['layout', 'hero_inner'], parent: undefined, children: ['column'] },
  column: { tag: 'div', classes: ['hero_copy'], parent: 'layout', children: [] },
};
const view = {
  truncated: false,
  parentKey: (key) => NODES[key].parent,
  childKeys: (key) => NODES[key].children,
  elementChildKeys: (key) => NODES[key].children,
  snapshot: async (key) => ({ tag: NODES[key].tag, id: undefined, classes: NODES[key].classes, classList: NODES[key].classes, attributes: {} }),
};

async function ruleModelOf(css, embedKey) {
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  const rules = model.collectRules(region, {
    embedKey,
    embedLabel: embedKey,
    fromComponent: false,
    componentName: undefined,
    regionIndex: 0,
    idSeed: embedKey,
    order: { n: 0 },
  });
  return model.computeRuleModel(rules, { rootKey: 'column', view });
}

function chips(ruleModel, instanceClasses) {
  return model.chipsFor({
    model: ruleModel,
    nativeModel: undefined,
    currentContext: BASE,
    activeSelector: '',
    selectedSelectorText: undefined,
    tokens: [],
    classList: ['hero_copy'],
    removedClasses: new Set(),
    pseudo: '',
    instanceClasses,
  });
}

// An `.astro` source parsed the way webflow.ts parses the context page: every block.
function astroDocument(key, filePath, code) {
  const { segments, regions } = model.splitEmbed(code);
  const parsed = regions.map((region) => model.parseRegion(region));
  return new model.EmbedDocument(
    {
      key,
      label: key,
      classNames: [],
      fromComponent: false,
      componentName: undefined,
      order: 0,
      element: filePath,
      origin: { kind: 'astro', path: filePath, reach: 'page' },
    },
    code,
    segments,
    parsed,
  );
}
function sheetDocument(key, filePath, css) {
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  return new model.EmbedDocument(
    { key, label: key, classNames: [], fromComponent: false, componentName: undefined, order: 1, element: filePath, origin: { kind: 'file', path: filePath } },
    css,
    ['', ''],
    [region],
  );
}
function componentDocument() {
  const css = COMPONENT_CSS;
  const region = model.parseRegion({ start: 0, end: css.length, css, root: undefined });
  return new model.EmbedDocument(
    {
      key: `node:${COMPONENT}:1`,
      label: '<style is:global>',
      classNames: [],
      fromComponent: true,
      componentName: 'ContentWrapper',
      order: 2,
      element: '1',
      origin: { kind: 'node', nodeId: '1', filePath: COMPONENT },
    },
    css,
    ['', ''],
    [region],
  );
}
const PAGE_KEY = `astro:${PAGE}`;
const PAGE_CODE = `---\n---\n<main></main>\n<style>\n.hero { color: red; }\n</style>\n<style is:global>\n.page_wrap { display: block; }\n</style>\n`;
const SCOPED_PAGE_CODE = `---\n---\n<main></main>\n<style>\n.hero { color: red; }\n</style>\n`;

test('the instance class of column 1 is the element’s instance class, and only there', () => {
  openComponent({});
  assert.deepEqual(model.selectedInstanceClasses(['hero_copy']), ['hero_copy']);
  // The layout's literal `layout` is the component's; `hero_inner` came from the page.
  openComponent({ selectedId: LAYOUT.id, renderedClasses: ['layout', 'hero_inner'] });
  assert.deepEqual(model.selectedInstanceClasses(['layout', 'hero_inner']), ['hero_inner']);
  // A page, or a component opened on its own, has no instance to speak of.
  openComponent({ openFileKind: 'page', openFilePath: PAGE });
  assert.deepEqual(model.selectedInstanceClasses(['hero_copy']), []);
  openComponent({ contextPagePath: undefined });
  assert.deepEqual(model.selectedInstanceClasses(['hero_copy']), []);
});

test('instanceClassesOf leaves out authored classes, Astro scope hashes and duplicates, and is capped', () => {
  assert.deepEqual(model.instanceClassesOf({ authored: ['x'], rendered: ['x', 'card', 'card', 'astro-j7pv25f6'] }), ['card']);
  assert.deepEqual(model.instanceClassesOf({ authored: [], rendered: [] }), []);
  const many = Array.from({ length: model.INSTANCE_CLASSES_MAX + 10 }, (_, index) => `c${index}`);
  assert.equal(model.instanceClassesOf({ authored: [], rendered: many }).length, model.INSTANCE_CLASSES_MAX);
});

test('the well lists the instance class as a chip of this instance', async () => {
  const ruleModel = await ruleModelOf(COMPONENT_CSS, `node:${COMPONENT}:1`);
  // Without instance classes the well is what the user saw: no `.hero_copy`.
  assert.ok(!chips(ruleModel, []).some((chip) => chip.text === '.hero_copy'), 'the bug: no instance chip');
  const listed = chips(ruleModel, ['hero_copy']);
  const chip = listed.find((entry) => entry.text === '.hero_copy');
  assert.ok(chip, `.hero_copy is a chip: ${listed.map((entry) => entry.text).join(', ')}`);
  assert.equal(chip.fromInstance, true);
  assert.equal(chip.pending, true, 'no rule styles it yet');
  assert.ok(
    listed.some((entry) => entry.text === '.layout > :first-child'),
    'the component’s chips stay',
  );
  const classified = model.classifySelector(chip);
  assert.equal(model.chipHint(classified, { active: false, dimmed: false }), 'from this instance, no styles yet');
  assert.equal(model.selectorAccessibleLabel(classified, '.hero_copy'), '.hero_copy, instance selector');
});

test('a styled instance class keeps one chip, marked as the instance’s', async () => {
  const ruleModel = await ruleModelOf(`.hero_copy { max-width: 40rem; }`, PAGE_KEY);
  const listed = chips(ruleModel, ['hero_copy']).filter((entry) => entry.text === '.hero_copy');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].fromInstance, true);
  assert.notEqual(listed[0].pending, true);
  assert.equal(model.namesInstanceClass('.hero_inner > .hero_copy:hover', ['hero_copy']), true);
  assert.equal(model.namesInstanceClass('.layout > :first-child', ['hero_copy']), false);
  assert.equal(model.namesInstanceClass('', ['hero_copy']), false);
});

test('a rule for the instance class is written into the page’s global block, not the component', () => {
  const page = astroDocument(PAGE_KEY, PAGE, PAGE_CODE);
  const component = componentDocument();
  const sheet = sheetDocument(`file:${SHEET}`, SHEET, '.u-hide { display: none; }');
  const documents = [page, sheet, component];
  const input = { activeSelector: '.hero_copy', instanceClasses: ['hero_copy'], documents, contextPagePath: PAGE, homeEmbedKey: undefined };
  assert.equal(model.instanceSourceKey(input), PAGE_KEY);
  // A component selector is the component's: the source is left alone.
  assert.equal(model.instanceSourceKey({ ...input, activeSelector: '.layout > :first-child' }), undefined);
  // A rule that already exists is joined where it is.
  assert.equal(model.instanceSourceKey({ ...input, homeEmbedKey: `file:${SHEET}` }), `file:${SHEET}`);
  // A page with only a scoped block would hash the class away: the stylesheet takes it.
  const scoped = astroDocument(PAGE_KEY, PAGE, SCOPED_PAGE_CODE);
  assert.equal(model.instanceSourceKey({ ...input, documents: [scoped, sheet, component] }), `file:${SHEET}`);
  assert.equal(model.instanceSourceKey({ ...input, documents: [scoped, component] }), undefined);

  const documentByKey = new Map(documents.map((document) => [document.source.key, document]));
  const where = model.embedWriteTarget({ model: undefined, selectedEmbedKey: PAGE_KEY, documentByKey }, undefined);
  assert.ok(where);
  assert.equal(where.embedDocument, page);
  assert.equal(where.region, page.regions[1], 'the `<style is:global>` block, not the scoped one before it');
  const wrote = model.createRuleForWrite(where.region, {
    nested: undefined,
    bpMedia: undefined,
    embedContext: undefined,
    wrapper: undefined,
    selector: '.hero_copy',
    write: { prop: 'max-width', value: '40rem', important: false },
  });
  assert.equal(wrote, true);
  assert.match(page.regions[1].root.toString(), /\.hero_copy\s*\{\s*max-width: 40rem/);
  assert.doesNotMatch(page.regions[0].root.toString(), /hero_copy/);
  assert.doesNotMatch(component.regions[0].root.toString(), /hero_copy/);
});
