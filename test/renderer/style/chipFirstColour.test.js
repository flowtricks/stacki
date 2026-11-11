// A component instance's selector chips are drawn in their settled colours from the
// first render, never blue first and green a moment later.
//
//   node test/renderer/style/chipFirstColour.test.js
//
// Goal: an instance's green (inComponentMarkup) needs its component's file text, read
// asynchronously into the component source cache. The page's component files are read
// as the page loads (pageComponentFiles, prefetchComponentSources), so the first render
// after load already has them and equals the settled one. If a read is genuinely still
// in flight, the chips are neutral grey (provenancePending), never the blue they would
// lose.
//
// Method: the host holds a page with a `<Heading>` instance and its resolved file; the
// panel's own functions are asked, in the order the panel asks them, for the markup, the
// pending flag and each chip's classes; a small cascade over the real embedEditor.css
// (as selectorChipColour.test.js does) names the colour family each chip wins, at rest,
// on hover and active.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'chip-first-colour.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { selectorSpecificity } from './src/features/style/model/selectors';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
      "export { chipClassName } from './src/features/style/embed/SelectorPicker';",
      "export { writtenInMarkup } from './src/features/style/model/componentMarkup';",
      "export { selectedInstanceMarkup, selectedInstanceMarkupPending } from './src/features/style/model/webflowElement';",
      "export { setHost, getHost } from './src/features/style/model/host';",
      "export { componentSource, componentSourcePending, prefetchComponentSources, rememberComponentSource, forgetComponentSources } from './src/features/style/model/componentSourceCache';",
      "export { withProvenancePending } from './src/features/style/embed/useEditorContexts';",
      "export { pageComponentFiles } from './src/app/model/componentReference';",
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

const HEADING_PATH = '/project/src/components/Heading.astro';
const HEADING_SOURCE = '---\nconst { className } = Astro.props;\n---\n<h2 class:list={["heading", "text-style-display", className]}><slot /></h2>\n';
const INSTANCE = { id: 'n1', kind: 'component', name: 'Heading', props: {} };

function selectInstance(componentPath, rendered = { classes: ['heading', 'text-style-display'], known: true }) {
  model.setHost({
    ...model.getHost(),
    projectPath: '/project',
    nodes: [INSTANCE],
    selectedId: INSTANCE.id,
    openFileKind: 'page',
    openFilePath: '/project/src/pages/index.astro',
    selectedComponentPath: componentPath,
    renderedClasses: rendered.classes,
    renderedClassesKnown: rendered.known,
  });
}

const TEXTS = ['.heading', '.text-style-display', '[class*="text-style-"]'];
const matched = (text) => ({ text, specificity: model.selectorSpecificity(text), state: '', simple: false, key: text, fromComponent: false });

// The chips as the panel builds them on one render: markup if the file is held, the
// pending flag otherwise (useSelectorChips).
function chipsNow() {
  const markup = model.selectedInstanceMarkup([], model.componentSource);
  const pending = markup === undefined && model.selectedInstanceMarkupPending([], model.componentSourcePending);
  const chips = TEXTS.map((text) => (model.writtenInMarkup(text, markup) ? { ...matched(text), inComponentMarkup: true } : matched(text)));
  return model.withProvenancePending(chips, { pending });
}

const CHIP = '.embed-editor_selector-chip';
const css = postcss.parse(fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8'));
const chipRules = [];
css.walkRules((rule) => {
  for (const selector of rule.selectors) {
    const onChip = selector.startsWith(CHIP) && !/^[-_a-z]/i.test(selector.slice(CHIP.length));
    if (onChip && !/[\s>+~]/.test(selector.replace(/\([^()]*\)/g, '')) && rule.parent?.type === 'root') {
      const declarations = {};
      rule.walkDecls((declaration) => {
        declarations[declaration.prop] = declaration.value;
      });
      chipRules.push({ selector, order: chipRules.length, declarations, specificity: model.selectorSpecificity(selector) });
    }
  }
});
const button = new JSDOM('<!doctype html><button></button>').window.document.querySelector('button');
function family(className, { hover }) {
  button.className = hover ? `${className} test-hover` : className;
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.specificity[index] !== right.specificity[index]) {
        return left.specificity[index] - right.specificity[index];
      }
    }
    return left.order - right.order;
  };
  const winners = {};
  for (const rule of chipRules.filter((entry) => button.matches(entry.selector.replace(/:hover/g, '.test-hover'))).sort(compare)) {
    Object.assign(winners, rule.declarations);
  }
  const background = winners.background ?? '';
  if (background.includes('component-tag')) {
    return 'green';
  }
  if (background.includes('class-tag')) {
    return 'blue';
  }
  if (background.includes('selector-context')) {
    return 'grey';
  }
  return background;
}
const families = (chip, active) => [false, true].map((hover) => family(model.chipClassName(model.classifySelector(chip), { active }), { hover }));

test('the page’s component files are read with the page, so the first render is the settled one', () => {
  model.forgetComponentSources([]);
  const files = model.pageComponentFiles(
    [
      {
        kind: 'element',
        name: 'main',
        children: [
          { kind: 'component', name: 'Heading' },
          { kind: 'component', name: 'Tag', dynamicTag: true },
          { kind: 'component', name: 'Fragment' },
        ],
      },
    ],
    {
      project: '/project',
      file: '/project/src/pages/index.astro',
      imports: [{ name: 'Heading', path: '../components/Heading.astro' }],
      components: [{ name: 'Heading', path: HEADING_PATH }],
    },
    8,
  );
  assert.deepEqual(files, [HEADING_PATH], 'the instance’s file, and no dynamic tag or fragment');
  // The read lands as the page loads (prefetchComponentSources asks; the answer is held).
  model.rememberComponentSource(HEADING_PATH, HEADING_SOURCE);
  model.prefetchComponentSources(files);
  selectInstance(HEADING_PATH);
  const first = chipsNow().map((chip) => model.chipClassName(model.classifySelector(chip), {}));
  const settled = chipsNow().map((chip) => model.chipClassName(model.classifySelector(chip), {}));
  assert.deepEqual(first, settled);
  for (const chip of chipsNow()) {
    assert.equal(chip.provenancePending, undefined, chip.text);
    assert.deepEqual(families(chip, false), ['green', 'green'], chip.text);
    assert.deepEqual(families(chip, true), ['green', 'green'], chip.text);
  }
});

test('a read still in flight draws the chips neutral, never blue', () => {
  model.forgetComponentSources([]);
  // The canvas has not yet said what the instance renders (Heading's root is an
  // expression, so its rendered classes alone make it green).
  selectInstance(HEADING_PATH, { classes: [], known: false });
  assert.equal(model.selectedInstanceMarkupPending([], model.componentSourcePending), true);
  for (const chip of chipsNow()) {
    assert.deepEqual(families(chip, false), ['grey', 'grey'], chip.text);
  }
  // The file is still being read, and the classes reported say nothing alone.
  selectInstance('/project/src/components/Unread.astro', { classes: [], known: true });
  const chips = chipsNow();
  assert.equal(model.componentSourcePending('/project/src/components/Unread.astro'), true);
  for (const chip of chips) {
    assert.equal(chip.provenancePending, true, chip.text);
    assert.deepEqual(families(chip, false), ['grey', 'grey'], chip.text);
    assert.equal(families(chip, true)[0], 'grey', chip.text);
    assert.ok(model.chipClassName(model.classifySelector(chip), {}).includes('is-provenance-pending'));
  }
  // A pending chip (no rule yet) keeps its own look: no provenance to wait on.
  const typed = model.withProvenancePending([{ ...matched('.new'), pending: true }], { pending: true });
  assert.equal(typed[0].provenancePending, undefined);
  // Nothing pending: the chips are returned as they are.
  const settled = [matched('.heading')];
  assert.equal(model.withProvenancePending(settled, { pending: false }), settled);
});

test('nothing waits for an element written in the page, or inside the open component', () => {
  model.forgetComponentSources([]);
  model.setHost({
    ...model.getHost(),
    nodes: [{ id: 'd1', kind: 'element', name: 'div' }],
    selectedId: 'd1',
    openFileKind: 'page',
    selectedComponentPath: undefined,
  });
  assert.equal(model.selectedInstanceMarkupPending([], model.componentSourcePending), false);
  selectInstance('/project/src/components/Other.astro');
  model.setHost({ ...model.getHost(), openFileKind: 'component' });
  assert.equal(model.selectedInstanceMarkupPending([], model.componentSourcePending), false);
});
