// The selector well's chip colours: one colour family per chip, in every state.
//
//   node test/renderer/style/selectorChipColour.test.js
//
// Goal: a chip's colour says what its selector is and where its rule lives, and the
// pointer never changes that. A class chip (a class, id or attribute in any compound,
// nested ones included) is blue; a plain chip (tags, `*`, pseudos) is grey; a chip
// whose classes are written in the open component's markup is green, over either,
// wherever its CSS lives (componentMarkup.ts). The bug this pins: a grey
// inherited component chip turned its text green on hover only, because the
// component hover rule set `color` where the grey rest rule did not.
//
// Method: writtenInMarkup is pinned on the user's ContentWrapper root; the root is also
// read the way the panel reads it for an instance selected on a page (templateRootNode
// over the component's source text, selectedInstanceMarkup over the host). An instance's
// origin is decided from its side (instanceMarkupOf): the user's Heading, whose classes
// are computed with `class:list` and a variant template, is green for every rendered
// class it did not pass and blue for its `class` prop; then selectorKind on every shape the well meets (class, attribute,
// nested with a class, tag, bare pseudo, universal, `:is(.a)`, `:where(...)`). Then
// chipClassName gives each chip's classes in each state (rest, hover, active, active
// hover, pending, dimmed), and a small cascade over the real embedEditor.css picks the
// winning `background` and `color` for that chip: jsdom matches each chip rule
// (`:hover` rewritten to a class, which weighs the same), the app's own
// selectorSpecificity ranks them, and source order breaks ties. The colour family of
// the winners must be the same with and without hover, green exactly when the rule
// comes from a component, and absent on a pending chip.
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
const bundle = path.join(directory, 'selector-chip-colour.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { selectorKind, selectorSpecificity } from './src/features/style/model/selectors';",
      "export { classifySelector } from './src/features/style/embed/LayoutRows';",
      "export { chipClassName } from './src/features/style/embed/SelectorPicker';",
      "export { INSTANCE_RENDERED_CLASSES_MAX, componentMarkupOf, instanceMarkupOf, writtenInMarkup } from './src/features/style/model/componentMarkup';",
      "export { templateRootNode } from './src/features/style/model/templateRoot';",
      "export { selectedComponentMarkup, selectedInstanceMarkup } from './src/features/style/model/webflowElement';",
      "export { setHost, getHost } from './src/features/style/model/host';",
      "export { COMPONENT_SOURCES_MAX, componentSource, componentSourceVersion, forgetComponentSources, rememberComponentSource } from './src/features/style/model/componentSourceCache';",
      "export { componentFileOf } from './src/app/model/componentReference';",
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

const CHIP = '.embed-editor_selector-chip';
// The chip's own rules: a single compound on the chip, so its state classes decide it.
const css = postcss.parse(fs.readFileSync(repoPath('src/features/style/embedEditor.css'), 'utf8'));
const chipRules = [];
css.walkRules((rule) => {
  for (const selector of rule.selectors) {
    const outside = selector.replace(/\([^()]*\)/g, '');
    const onChip = selector.startsWith(CHIP) && !/^[-_a-z]/i.test(selector.slice(CHIP.length));
    if (onChip && !/[\s>+~]/.test(outside) && rule.parent?.type === 'root') {
      const declarations = {};
      rule.walkDecls((declaration) => {
        declarations[declaration.prop] = declaration.value;
      });
      chipRules.push({ selector, order: chipRules.length, declarations, specificity: model.selectorSpecificity(selector) });
    }
  }
});
assert.ok(chipRules.length > 10, `the chip rules are read from the stylesheet (${chipRules.length})`);
assert.ok(chipRules.length < 200, 'the chip rules stay a handful');

const { document } = new JSDOM('<!doctype html><button></button>').window;
const button = document.querySelector('button');

const compare = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left.specificity[index] !== right.specificity[index]) {
      return left.specificity[index] - right.specificity[index];
    }
  }
  return left.order - right.order;
};

/** The winning value of each property for a chip with these classes. */
function cascade(className, { hover }) {
  button.className = hover ? `${className} test-hover` : className;
  const winners = {};
  const matching = chipRules.filter((rule) => button.matches(rule.selector.replace(/:hover/g, '.test-hover'))).sort(compare);
  for (const rule of matching) {
    Object.assign(winners, rule.declarations);
  }
  return winners;
}

/** The colour family a declared value belongs to. */
function family(value) {
  if (value === undefined) {
    return 'unset';
  }
  if (value.includes('component-tag')) {
    return 'green';
  }
  if (value.includes('class-tag')) {
    return 'blue';
  }
  if (value.includes('selector-context')) {
    return 'grey';
  }
  return value;
}

const entry = (text, extra) =>
  model.classifySelector({ text, specificity: model.selectorSpecificity(text), state: '', simple: false, key: text, fromComponent: false, ...extra });

// `ContentWrapper.astro`'s root, as the user has it: `class:list={["layout", "card-layout",
// "theme-dark", "flex-grow", className]}`, where the page fills `className` with
// `theme-brand`. Only the literal classes are the component's.
const CONTENT_WRAPPER = model.componentMarkupOf({
  classes: ['layout', 'card-layout', 'theme-dark', 'flex-grow'],
  props: {
    'class:list': { type: 'expression', value: '["layout", "card-layout", "theme-dark", "flex-grow", className]' },
    'data-wrapper': { type: 'string', value: 'content' },
    id: { type: 'string', value: 'main' },
    role: { type: 'expression' },
  },
});

test('writtenInMarkup: green means every class and attribute the element needs is in the component markup', () => {
  const cases = [
    ['.layout', true],
    ['.theme-dark', true],
    ['.layout.card-layout', true],
    ['.layout:hover', true],
    ['[class*="theme-"]', true],
    ['[class~="flex-grow"]', true],
    ['[data-wrapper="content"]', true],
    ['#main', true],
    [':is(.layout, .missing)', true],
    // A presence-only attribute is set from either side alike, so it says nothing
    // about where the selector is applied: neutral, never green on its own.
    ['[data-wrapper]', false],
    ['[role]', false],
    ['[class]', false],
    ['[class].layout', true],
    // The root's parent is outside the component (the page, or the component around
    // it), so a part matched there is applied from outside.
    ['.container > [class]', false],
    ['.container > .layout', false],
    ['.page .layout', false],
    ['.intro + .layout', false],
    // A neutral part outside does not decide.
    ['main > .layout', true],
    ['* + .layout', true],
    ['.layout:not(.theme-brand)', true],
    // The page's class, or anything the markup does not write.
    ['.theme-brand', false],
    ['.layout.theme-brand', false],
    ['[class*="brand"]', false],
    ['[data-wrapper="other"]', false],
    ['[role="main"]', false],
    ['#other', false],
    [':is(.missing, .other)', false],
    ['.layout > .child', false],
    // Plain selectors need nothing written, so they are never green.
    ['div', false],
    [':target', false],
    ['*', false],
    [':where(div)', false],
    // Every member of a list must qualify.
    ['.layout, .theme-dark', true],
    ['.layout, .theme-brand', false],
    // Text that does not parse.
    ['.a > > (', false],
  ];
  for (const [text, expected] of cases) {
    assert.equal(model.writtenInMarkup(text, CONTENT_WRAPPER), expected, text);
  }
  // On a page there is no component markup, so nothing is green.
  assert.equal(model.writtenInMarkup('.layout', undefined), false);
  // A directive is not an attribute, and classes stay apart from attributes.
  assert.equal(CONTENT_WRAPPER.attributes.has('class:list'), false);
  assert.equal(CONTENT_WRAPPER.attributes.has('class'), false);
});

// `ContentWrapper.astro` as the panel loads it for its global styles: frontmatter, a
// comment, then the root, then a `<style is:global>` block.
const CONTENT_WRAPPER_SOURCE = `---
const { className = "", label } = Astro.props;
const open = "{";
---
<!-- The wrapper every content block sits in. -->
<div
  class:list={["layout", "card-layout", "theme-dark", "flex-grow", className, label && \`is-\${label}\`]}
  data-wrapper="content"
  {...Astro.props.rest}
>
  <slot />
</div>
<style is:global>
  .theme-dark { color: white; }
</style>
`;
const HOME = '/project/src/pages/index.astro';
const WRAPPER_PATH = '/project/src/components/ContentWrapper.astro';
const documents = [
  { source: { origin: { kind: 'file', path: '/project/src/styles/global.css' } }, code: '.theme-brand { color: red; }' },
  { source: { origin: { kind: 'astro', path: WRAPPER_PATH } }, code: CONTENT_WRAPPER_SOURCE },
];
// The home page: an instance of ContentWrapper, passed `theme-brand`, beside a div
// written directly in the page.
const INSTANCE = { id: '0.1', kind: 'component', name: 'ContentWrapper', props: { className: { type: 'string', value: 'theme-brand' } } };
const PAGE_DIV = { id: '0.2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'layout theme-dark' } } };
// The app resolves the instance's file through the page's import; `{ path: undefined }`
// is a host that does not.
const selectOnHome = (selectedId, options = {}) =>
  model.setHost({
    ...model.getHost(),
    selectedComponentPath: 'path' in options ? options.path : WRAPPER_PATH,
    nodes: [{ id: '0', kind: 'element', name: 'main', props: {}, children: [INSTANCE, PAGE_DIV] }],
    selectedId,
    openFilePath: HOME,
    openFileKind: 'page',
    contextPagePath: undefined,
    renderedClasses: ['layout', 'card-layout', 'theme-dark', 'flex-grow', 'theme-brand'],
  });

test('templateRootNode reads the component root the instance renders, and nothing else', () => {
  const root = model.templateRootNode(CONTENT_WRAPPER_SOURCE);
  assert.equal(root?.name, 'div');
  assert.equal(root?.props?.['class:list']?.type, 'expr');
  assert.equal(root?.props?.['data-wrapper']?.value, 'content');
  // A root that is not a plain element has no markup of its own to read.
  for (const code of ['---\n---\n<Layout><div class="a"></div></Layout>', '<slot />', '{items.map((x) => <li>{x}</li>)}', 'text', '<div class="open', '']) {
    assert.equal(model.templateRootNode(code), undefined, code);
  }
  assert.equal(model.templateRootNode('<style>.a{}</style>\n<section class="hero">')?.name, 'section');
});

test('an instance selected on a page is green for what its component writes, blue for what the page passes', () => {
  selectOnHome(INSTANCE.id);
  assert.equal(model.selectedComponentMarkup(), undefined, 'the open file is the page, not the component');
  const unread = () => assert.fail('a loaded component is not read again');
  const markup = model.selectedInstanceMarkup(documents, unread);
  assert.deepEqual(markup?.classes, ['layout', 'card-layout', 'theme-dark', 'flex-grow']);
  for (const text of ['.layout', '.theme-dark', '.flex-grow', '.layout.card-layout', '[data-wrapper="content"]', '[class*="theme-"]']) {
    assert.equal(model.writtenInMarkup(text, markup), true, `${text} is the component's`);
    const classes = model.chipClassName(entry(text, { inComponentMarkup: model.writtenInMarkup(text, markup) }), {}).split(' ');
    assert.equal(classes.includes('is-component'), true, `${text} chip is green`);
  }
  // `.container {& > [class]}`: the parent's `.container` is Section's or the page's.
  for (const text of ['.theme-brand', '.layout.theme-brand', 'div', ':target', '.container > [class]', '[class]']) {
    assert.equal(model.writtenInMarkup(text, markup), false, `${text} is not the component's`);
  }

  // An element written directly in the page: nothing is the component's.
  selectOnHome(PAGE_DIV.id, { path: undefined });
  assert.equal(model.selectedInstanceMarkup(documents, unread), undefined);
  assert.equal(model.writtenInMarkup('.layout', model.selectedInstanceMarkup(documents, unread)), false);

  // The imported file decides, even when a file of the same name in another folder
  // is loaded too: the twin's `other` class is never the instance's. Before the canvas
  // reports the rendered classes, the root's literal classes are all that is known.
  const twin = { source: { origin: { kind: 'astro', path: '/project/src/other/ContentWrapper.astro' } }, code: '<div class="other">' };
  const unrendered = (options) => {
    selectOnHome(INSTANCE.id, options);
    model.setHost({ ...model.getHost(), renderedClasses: [] });
  };
  unrendered();
  assert.deepEqual(model.selectedInstanceMarkup([twin, ...documents], unread)?.classes, ['layout', 'card-layout', 'theme-dark', 'flex-grow']);
  unrendered({ path: twin.source.origin.path });
  assert.deepEqual(model.selectedInstanceMarkup([twin, ...documents], unread)?.classes, ['other']);
  // With no resolved file (a host that does not resolve imports), only one loaded
  // file of the name is read, and two are not guessed between.
  unrendered({ path: undefined });
  assert.deepEqual(model.selectedInstanceMarkup(documents, unread)?.classes, ['layout', 'card-layout', 'theme-dark', 'flex-grow']);
  assert.equal(model.selectedInstanceMarkup([...documents, twin], unread), undefined);
  // Once the canvas reports the rendered classes, they decide the classes on their own:
  // the file is still needed for the root's attributes only.
  selectOnHome(INSTANCE.id, { path: undefined });
  const rendered = model.selectedInstanceMarkup([...documents, twin], unread);
  assert.deepEqual(rendered?.classes, ['layout', 'card-layout', 'theme-dark', 'flex-grow']);
  assert.equal(rendered?.attributes.size, 0, 'no file was guessed for the attributes');
  // Inside the open component, the node itself is read instead (selectedComponentMarkup).
  selectOnHome(INSTANCE.id);
  model.setHost({ ...model.getHost(), openFileKind: 'component', openFilePath: WRAPPER_PATH });
  assert.equal(model.selectedInstanceMarkup(documents, unread), undefined);
});

test('a component with no global style block is read once into the source cache and turns green', () => {
  // `Card.astro` has no `<style is:global>`, so the panel never loaded it for styles.
  const CARD_PATH = '/project/src/components/Card.astro';
  const CARD_SOURCE =
    '---\nconst { className } = Astro.props;\n---\n<article class:list={["card", "card--raised", className]}>\n  <slot />\n</article>\n<style>\n  .card { padding: 1rem; }\n</style>\n';
  model.setHost({
    ...model.getHost(),
    nodes: [
      {
        id: '0',
        kind: 'element',
        name: 'main',
        props: {},
        children: [{ id: '0.0', kind: 'component', name: 'Card', props: { class: { type: 'string', value: 'is-featured' } } }],
      },
    ],
    selectedId: '0.0',
    openFilePath: HOME,
    openFileKind: 'page',
    selectedComponentPath: CARD_PATH,
    renderedClasses: ['card', 'card--raised', 'is-featured'],
  });
  const reads = [];
  const pending = model.selectedInstanceMarkup(documents, (path) => {
    reads.push(path);
    return undefined;
  });
  // The rendered classes already say what is the component's; the root's attributes
  // wait for the file.
  assert.deepEqual(pending?.classes, ['card', 'card--raised'], 'the rendered classes are green while the file is read');
  assert.equal(pending?.attributes.size, 0);
  assert.deepEqual(reads, [CARD_PATH], 'only the imported file is read');
  model.setHost({ ...model.getHost(), renderedClasses: [] });
  assert.equal(
    model.selectedInstanceMarkup(documents, () => undefined),
    undefined,
    'nothing is green before anything is rendered or read',
  );
  model.setHost({ ...model.getHost(), renderedClasses: ['card', 'card--raised', 'is-featured'] });

  // The read lands in the cache, which says so through its version.
  const before = model.componentSourceVersion();
  model.rememberComponentSource(CARD_PATH, CARD_SOURCE);
  assert.ok(model.componentSourceVersion() > before, 'a landed read bumps the version');
  assert.equal(model.componentSource(CARD_PATH), CARD_SOURCE);
  const markup = model.selectedInstanceMarkup(documents, model.componentSource);
  assert.deepEqual(markup?.classes, ['card', 'card--raised']);
  assert.equal(model.writtenInMarkup('.card', markup), true);
  assert.equal(model.writtenInMarkup('.card.card--raised', markup), true);
  assert.equal(model.writtenInMarkup('.is-featured', markup), false, "the page's class stays blue");

  // A change to the file drops it. Filling past the bound evicts the oldest read; the
  // cache asserts its own bound on every store, so this would throw past it.
  const dropped = model.componentSourceVersion();
  model.forgetComponentSources([CARD_PATH.replaceAll('/', '\\')]);
  assert.ok(model.componentSourceVersion() > dropped, 'a dropped file bumps the version');
  for (let index = 0; index <= model.COMPONENT_SOURCES_MAX; index += 1) {
    model.rememberComponentSource(`/project/src/components/C${index}.astro`, '<div class="c">');
  }
  assert.equal(model.componentSource(`/project/src/components/C${model.COMPONENT_SOURCES_MAX}.astro`), '<div class="c">');
  model.forgetComponentSources([]);
});

// `Heading.astro` as the user has it: the root sits inside a render condition, so no
// root tag can be read from the source, and its classes are built with `class:list`,
// a variant template literal and the passed `class`.
const HEADING_PATH = '/project/src/components/typography/Heading.astro';
const HEADING_SOURCE = `---
const { render = true, tag: Tag = "h2", variant = Tag, class: className, ...rest } = Astro.props;
---
{render && (
  <Tag class:list={["heading", variant !== "inherit" && \`text-style-\${variant}\`, className]} {...rest}>
    <slot />
  </Tag>
)}
`;
const selectHeading = (props, renderedClasses) =>
  model.setHost({
    ...model.getHost(),
    nodes: [
      {
        id: '0',
        kind: 'component',
        name: 'ContentWrapper',
        props: {},
        children: [{ id: '0.0', kind: 'component', name: 'Heading', props }],
      },
    ],
    selectedId: '0.0',
    openFilePath: HOME,
    openFileKind: 'page',
    contextPagePath: undefined,
    selectedComponentPath: HEADING_PATH,
    renderedClasses,
  });

test('an instance is green for every class its component applies, computed or not, and blue for what it passes', () => {
  // `<Heading variant="display" tag="h1" class="margin-block-8">` inside ContentWrapper on
  // the home page renders `h1.heading.text-style-display.margin-block-8`.
  selectHeading(
    {
      variant: { type: 'string', value: 'display' },
      tag: { type: 'string', value: 'h1' },
      class: { type: 'string', value: 'margin-block-8' },
      'data-feedback': { type: 'string', value: '{}' },
    },
    ['heading', 'text-style-display', 'margin-block-8'],
  );
  assert.equal(model.templateRootNode(HEADING_SOURCE), undefined, 'the root is not readable from the source');
  const headingDocuments = [{ source: { origin: { kind: 'astro', path: HEADING_PATH } }, code: HEADING_SOURCE }];
  const markup = model.selectedInstanceMarkup(headingDocuments, () => assert.fail('a loaded component is not read again'));
  assert.deepEqual(markup?.classes, ['heading', 'text-style-display']);
  for (const text of ['.heading', '.text-style-display', '.heading.text-style-display', '[class*="text-style-"]', '[class~="heading"]', '.heading:hover']) {
    assert.equal(model.writtenInMarkup(text, markup), true, `${text} is applied inside`);
    const classes = model.chipClassName(entry(text, { inComponentMarkup: true }), {}).split(' ');
    assert.equal(classes.includes('is-component'), true, `${text} chip is green`);
  }
  for (const text of ['.margin-block-8', '.heading.margin-block-8', '[class*="margin-"]', '[data-feedback]', '[variant]']) {
    assert.equal(model.writtenInMarkup(text, markup), false, `${text} comes from the instance`);
    const classes = model.chipClassName(entry(text), {}).split(' ');
    assert.equal(classes.includes('is-class'), true, `${text} chip is blue`);
  }
  for (const text of ['h1', ':target', '*']) {
    assert.equal(model.writtenInMarkup(text, markup), false, `${text} stays grey`);
    assert.equal(model.selectorKind(text), 'plain');
  }
});

test('instanceMarkupOf: a prop value written as a class is the instance’s, and an unknown class expression falls back to the root', () => {
  const root = {
    classes: ['button'],
    props: { 'class:list': { type: 'expr', value: '["button", variant, className]' }, role: { type: 'string', value: 'button' } },
  };
  // `<Button variant="primary" class="wide">`: the component writes `variant` straight
  // into its class list, so `primary` is the instance's, like `wide`.
  const passedThrough = model.instanceMarkupOf({
    props: { variant: { type: 'string', value: 'primary' }, class: { type: 'string', value: 'wide' } },
    passed: ['wide'],
    rendered: ['button', 'primary', 'wide'],
    root,
  });
  assert.deepEqual(passedThrough?.classes, ['button']);
  assert.equal(model.writtenInMarkup('[role="button"]', passedThrough), true, 'the root writes the attribute');
  assert.equal(model.writtenInMarkup('.primary', passedThrough), false);
  // A prop the instance passes is the instance's even when the root names it too.
  const overridden = model.instanceMarkupOf({ props: { role: { type: 'string', value: 'link' } }, passed: [], rendered: ['button'], root });
  assert.equal(overridden?.attributes.has('role'), false);
  // `class={extra}` on the instance: which rendered classes it added is not known, so
  // only the root's literal classes are the component's.
  const unknownClass = model.instanceMarkupOf({ props: { class: { type: 'expr', value: 'extra' } }, passed: [], rendered: ['button', 'mystery'], root });
  assert.deepEqual(unknownClass?.classes, ['button']);
  assert.equal(model.instanceMarkupOf({ props: { class: { type: 'expr', value: 'extra' } }, passed: [], rendered: ['button'], root: undefined }), undefined);
  // A class expression of literals only adds what it spells out.
  const literal = model.instanceMarkupOf({
    props: { 'class:list': { type: 'expr', value: '["a", \'b\']' } },
    passed: ['a', 'b'],
    rendered: ['button', 'a', 'b'],
    root,
  });
  assert.deepEqual(literal?.classes, ['button']);
  // Nothing rendered and nothing read: nothing is known.
  assert.equal(model.instanceMarkupOf({ props: {}, passed: [], rendered: [], root: undefined }), undefined);
  // The rendered list is capped.
  const many = Array.from({ length: model.INSTANCE_RENDERED_CLASSES_MAX + 10 }, (_, index) => `c${index}`);
  assert.equal(model.instanceMarkupOf({ props: {}, passed: [], rendered: many, root: undefined })?.classes.length, model.INSTANCE_RENDERED_CLASSES_MAX);
});

test('elements that are not instance roots keep their colours', () => {
  // A page element: nothing is green.
  selectHeading({}, ['heading']);
  model.setHost({
    ...model.getHost(),
    nodes: [{ id: '0.0', kind: 'element', name: 'h1', props: { class: { type: 'string', value: 'heading' } } }],
    selectedComponentPath: undefined,
  });
  assert.equal(
    model.selectedInstanceMarkup([], () => undefined),
    undefined,
  );
  // An element of the open component: its own node's literal classes, as before.
  model.setHost({ ...model.getHost(), openFileKind: 'component', openFilePath: HEADING_PATH });
  assert.equal(
    model.selectedInstanceMarkup([], () => undefined),
    undefined,
  );
  assert.deepEqual(model.selectedComponentMarkup()?.classes, ['heading']);
});

// ContentWrapper opened on its own: the root, a heading inside a condition, and an
// intro before a child, each written in the component's markup.
const WRAPPER_TREE = [
  {
    id: '0',
    kind: 'element',
    name: 'div',
    props: { class: { type: 'string', value: 'layout card-layout' } },
    children: [
      {
        id: '0.0',
        kind: 'cond',
        children: [
          {
            id: '0.0.0',
            kind: 'element',
            name: 'div',
            props: { class: { type: 'string', value: 'inner' } },
            children: [{ id: '0.0.0.0', kind: 'element', name: 'h2', props: { class: { type: 'string', value: 'title' } } }],
          },
        ],
      },
      { id: '0.1', kind: 'element', name: 'p', props: { class: { type: 'string', value: 'intro' } } },
      { id: '0.2', kind: 'element', name: 'div', props: { class: { type: 'string', value: 'child' }, 'data-x': { type: 'string', value: '1' } } },
    ],
  },
];
const selectInWrapper = (selectedId) =>
  model.setHost({
    ...model.getHost(),
    nodes: WRAPPER_TREE,
    selectedId,
    openFilePath: WRAPPER_PATH,
    openFileKind: 'component',
    contextPagePath: undefined,
    selectedComponentPath: undefined,
    renderedClasses: [],
  });

test('every part of a selector counts: ancestors and siblings in the component are inside, beyond it outside', () => {
  selectInWrapper('0.2');
  const child = model.selectedComponentMarkup();
  const cases = [
    // Both parts written in this component.
    ['.card-layout > .child', true],
    ['.layout .child', true],
    ['.intro + .child', true],
    ['.intro ~ .child', true],
    ['.layout > .intro + .child', true],
    // A neutral part moves along without deciding.
    ['div > .child', true],
    ['[class] > .child', true],
    ['.card-layout > *', true],
    // A part nobody here writes, or one past the component's root.
    ['.missing > .child', false],
    ['.container > .child', false],
    ['.container > .layout > .child', false],
    ['.intro > .child', false],
    ['.child + .intro', false],
    // Presence-only attributes alone are neutral.
    ['[class]', false],
    ['[data-x]', false],
    ['[data-x="1"]', true],
  ];
  for (const [text, expected] of cases) {
    assert.equal(model.writtenInMarkup(text, child), expected, text);
  }
  // A descendant combinator reaches an ancestor in the same component through a condition.
  selectInWrapper('0.0.0.0');
  const title = model.selectedComponentMarkup();
  for (const [text, expected] of [
    ['.layout .title', true],
    ['.card-layout .inner > .title', true],
    ['.layout > .title', false],
    ['.intro + .title', false],
    ['.page .title', false],
  ]) {
    assert.equal(model.writtenInMarkup(text, title), expected, text);
  }
  // The component's root has nothing of this component above it.
  selectInWrapper('0');
  assert.equal(model.writtenInMarkup('.container > [class]', model.selectedComponentMarkup()), false);
  assert.equal(model.writtenInMarkup('.layout.card-layout', model.selectedComponentMarkup()), true);
});

test('componentFileOf resolves the page import first, and a name only when it is unique', () => {
  const components = [
    { name: 'Heading', folder: 'ui', path: '/project/src/ui/Heading.astro' },
    { name: 'Heading', folder: 'blog', path: '/project/src/blog/Heading.astro' },
    { name: 'Card', folder: 'components', path: '/project/src/components/Card.astro' },
  ];
  const context = (name, imports) => ({ name, project: '/project', file: '/project/src/pages/index.astro', imports, components });
  assert.equal(model.componentFileOf(context('Heading', [{ name: 'Heading', path: '../blog/Heading.astro' }])), '/project/src/blog/Heading.astro');
  assert.equal(model.componentFileOf(context('Heading', [])), undefined, 'two of one name are not guessed between');
  assert.equal(model.componentFileOf(context('Card', [])), '/project/src/components/Card.astro', 'one of its name is enough');
  assert.equal(model.componentFileOf(context('Missing', [])), undefined);
});

test('selectorKind: a class, id or attribute anywhere makes a class chip; tags, `*` and pseudos a plain one', () => {
  const cases = [
    ['.image', 'class'],
    ['[data-image-component="true"]', 'class'],
    ['#hero', 'class'],
    ['img.image', 'class'],
    [':is(.a)', 'class'],
    [':where(.layout, .text) > *', 'class'],
    [':where(.text, .layout > *) > :first-child', 'class'],
    [':where(.text, .layout > *) > :is(.image, .video, .overlay)', 'class'],
    ['img:not([hidden])', 'class'],
    // The user's nested chips, flattened as the well holds them: the class or attribute
    // may sit in the parent part only, or in the child part only.
    ['.container > [class]', 'class'],
    ['.container > *', 'class'],
    ['main > [class]', 'class'],
    ['.layout.card-layout', 'class'],
    ['[class*="theme-"]', 'class'],
    ['img', 'plain'],
    ['section', 'plain'],
    [':target', 'plain'],
    [':focus-visible', 'plain'],
    ['*', 'plain'],
    [':where(img, video)', 'plain'],
    ['main img::after', 'plain'],
  ];
  for (const [text, kind] of cases) {
    assert.equal(model.selectorKind(text), kind, text);
  }
  // Text that does not parse falls back to looking for a class, id or attribute mark.
  assert.equal(model.selectorKind('.a > > ('), 'class');
});

test('chipClassName: the kind and the component class hold in every state', () => {
  const states = [{}, { active: true }, { dimmed: true }, { active: true, dimmed: true }];
  const shapes = ['.image', ':target', 'img', '.layout > * > :is(.image, .video)'];
  for (const text of shapes) {
    for (const green of [true, false]) {
      for (const pending of [true, false]) {
        const chip = entry(text, { ...(green ? { inComponentMarkup: true } : {}), ...(pending ? { pending: true } : {}) });
        for (const state of states) {
          const classes = model.chipClassName(chip, state).split(' ');
          assert.equal(classes.includes('is-component'), green, `${text} ${JSON.stringify(state)}`);
          assert.equal(classes.includes(`is-${model.selectorKind(text)}`), true, `${text} has its kind`);
          assert.equal(classes.includes('is-class') && classes.includes('is-plain'), false, `${text} has one kind`);
        }
      }
    }
  }
});

test('the stylesheet gives each chip one colour family at rest, on hover, active and active on hover', () => {
  const shapes = [
    { text: '.image', fill: 'blue' },
    { text: '[data-image-component="true"]', fill: 'blue' },
    // Inherited and global, but with classes: still blue (the user's nested chips).
    { text: '.layout > * > :is(.image, .video, .overlay)', fill: 'blue' },
    { text: '.container > [class]', fill: 'blue' },
    { text: '[class*="theme-"]', fill: 'blue' },
    { text: 'img', fill: 'grey' },
    { text: ':target', fill: 'grey' },
    { text: '*', fill: 'grey' },
    { text: 'main img', fill: 'grey' },
  ];
  for (const shape of shapes) {
    for (const green of [true, false]) {
      for (const dimmed of [false, true]) {
        const chip = entry(shape.text, { fromComponent: true, ...(green ? { inComponentMarkup: true } : {}) });
        for (const active of [false, true]) {
          const name = `${shape.text}${green ? ' (component)' : ''}${active ? ' active' : ''}${dimmed ? ' dimmed' : ''}`;
          const className = model.chipClassName(chip, { active, dimmed });
          const rest = cascade(className, { hover: false });
          const hover = cascade(className, { hover: true });
          assert.equal(family(hover.background), family(rest.background), `${name}: hover keeps the fill family`);
          assert.equal(hover.color, rest.color, `${name}: hover keeps the text colour`);
          const expected = green ? 'green' : shape.fill;
          assert.equal(family(rest.background), expected, `${name}: the fill is ${expected}`);
          if (green && !active) {
            assert.equal(rest.color, '#fff', `${name}: a component chip's text is white, as a blue chip's is`);
          }
          if (!green) {
            assert.notEqual(family(rest.color), 'green', `${name}: only a component chip's text is green`);
          }
        }
      }
    }
  }
});

test('a pending chip has no fill and no provenance colour, at rest or on hover', () => {
  for (const text of ['.image', ':target', 'img', '.layout > * > .image']) {
    for (const green of [true, false]) {
      for (const active of [false, true]) {
        const className = model.chipClassName(entry(text, { ...(green ? { inComponentMarkup: true } : {}), pending: true }), { active });
        for (const hover of [false, true]) {
          const winners = cascade(className, { hover });
          const name = `${text}${green ? ' (component)' : ''}${active ? ' active' : ''}${hover ? ' hover' : ''}`;
          assert.equal(winners.background, 'transparent', `${name}: no fill`);
          assert.equal(['green', 'blue', 'grey'].includes(family(winners.color)), false, `${name}: no provenance text colour`);
        }
      }
    }
  }
});
