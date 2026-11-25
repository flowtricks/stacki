// Goal: a component default can hold an imported image and a list or object, and
// every place an instance comes from writes it as picking it by hand would. A
// chosen src/ image or Select's list of options failed to save with "Default
// props must be literal text, numbers, or booleans." Method: the real defaults
// canvas writer and reader and the real Astro parser: a recipe is drawn into a
// canvas page, read back, inserted into a page (Desktop's own placement) and
// drawn by the component canvas; then the stored format's parser, relinking and
// missing files. The negative space: code is never accepted as a literal, a name
// that imports no media file is not an asset, and a deleted file is never
// imported.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');
const { parsePage, parseSlots } = require('#dist/electron/parse/astroParser.js');
const { serializeNodes } = require('#dist/electron/parse/astroSerialize.js');

const bundle = repoPath('node_modules/.stacki-test/default-values.cjs');
esbuild.buildSync({
  stdin: {
    contents: `export * from './src/features/componentDefaults/defaultsCanvasContext';
    export * from './src/features/componentDefaults/defaultsCanvasModel';
    export * from './src/features/preview/componentCanvas/canvasPage';
    export { componentInstance, componentInstancePlacement } from './src/app/model/componentInstances';
    export * from './shared/properties/componentDefaults';
    export * from './shared/properties/componentDefaultValues';`,
    resolveDir: path.dirname(repoPath('package.json')),
    loader: 'ts',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  loader: { '.css': 'empty', '.svg': 'empty' },
  logLevel: 'silent',
});
const app = require(bundle);

const IMG = 'src/components/Img.astro';
const SELECT = 'src/components/Select.astro';
const SVG = 'src/assets/lumos-background.svg';
const PHOTO = 'src/assets/photos/default.png';
const CANVAS = '.stacki/canvas/12345678-1234-1234-1234-123456789012.astro';
const entry = (file, extra = {}) => ({ file, name: path.basename(file, '.astro'), props: [], slots: ['default'], slotText: false, ...extra });
const catalog = [entry(IMG), entry(SELECT)];
const OPTIONS = '[{ label: "Option 1", value: "1" }, { label: "Option 2", value: "2" }]';

function model(source) {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable, parsed.reason);
  return parsed.model;
}

// The defaults editor on `<Tag />`, opened on a page, with `recipe` stored.
function editor(component, recipe, extra = {}) {
  const tag = path.basename(component, '.astro');
  const source = `---\nimport ${tag} from '../${component.slice(4)}';\n---\n<main><${tag} /></main>\n`;
  return app.prepareDefaultsCanvas(
    CANVAS,
    { catalog, config: app.parseComponentDefaults({ version: 1, components: { [component]: recipe } }), ...extra },
    { file: 'src/pages/index.astro', source, model: model(source), path: '0.0' },
  );
}
const saved = (prepared, source = prepared.source) => app.recipeFromCanvas(model(source), prepared.session);

test('an image picked by hand in the defaults editor saves, and reopens as it was', () => {
  const prepared = editor(IMG, {});
  // What the Props panel writes for a src/ pick: an import, and its name (or its address).
  const picked = prepared.source
    .replace(/^---\n/, `---\nimport lumos_background from '../../${SVG}';\n`)
    .replace('<Img />', '<Img src={lumos_background} srcMobile={lumos_background.src} alt="" />');
  const recipe = saved(prepared, picked);
  assert.deepEqual(recipe.assets, { src: { file: SVG }, srcMobile: { file: SVG, url: true } });
  assert.deepEqual(recipe.props, { alt: '' });
  const reopened = editor(IMG, recipe);
  assert.deepEqual(saved(reopened), recipe);
  assert.equal(reopened.source.match(/lumos-background\.svg/g).length, 1, 'the file is imported once');
});

test('an alias the host resolves is an asset too', () => {
  const prepared = editor(IMG, {});
  const picked = prepared.source.replace(/^---\n/, "---\nimport hero from '~media/hero.png';\n").replace('<Img />', '<Img src={hero} />');
  const recipe = app.recipeFromCanvas(model(picked), prepared.session, new Map([['~media/hero.png', 'src/media/hero.png']]));
  assert.deepEqual(recipe.assets, { src: { file: 'src/media/hero.png' } });
});

test('a list of options saves and is written back as the panel wrote it', () => {
  const prepared = editor(SELECT, {});
  const written = prepared.source.replace('<Select />', `<Select options={${OPTIONS}} meta={{ "data-x": [1, true, null] }} empty={[]} />`);
  const recipe = saved(prepared, written);
  assert.deepEqual(recipe.literals, { options: OPTIONS, meta: '{ "data-x": [1, true, null] }', empty: '[]' });
  assert.deepEqual(saved(editor(SELECT, recipe)), recipe);
});

test('a list naming imported files keeps them, under the names each page gives them', () => {
  const prepared = editor(SELECT, {});
  const picked = prepared.source
    .replace(/^---\n/, `---\nimport art from '../../${PHOTO}';\n`)
    .replace('<Select />', '<Select options={[{ label: "art", image: art, url: art.src }]} />');
  const recipe = saved(prepared, picked);
  assert.deepEqual(recipe.literals, {
    options: { source: '[{ label: "art", image: art, url: art.src }]', imports: { art: PHOTO } },
  });
  // `default` is not a name JavaScript allows, and the key and the string that say `art` stay as they are.
  const redrawn = editor(SELECT, recipe).source;
  assert.ok(redrawn.includes(`import _default from "../../${PHOTO}";`), redrawn);
  assert.match(redrawn, /options=\{\[\{ label: "art", image: _default, url: _default\.src \}\]\}/);
});

test('code that reads the page is refused, naming the prop, and nothing else is', () => {
  const prepared = editor(SELECT, {});
  for (const value of ['user.options', 'options', '[...more]', '[makeOne()]', '{ a: b }', '`x ${y}`', 'a ? 1 : 2', '() => 1']) {
    const changed = prepared.source.replace('<Select />', `<Select options={${value}} />`);
    assert.throws(
      () => saved(prepared, changed),
      (error) => error instanceof app.UnsupportedDefaultError && error.prop === 'options' && error.tag === 'Select',
      value,
    );
  }
});

test('the literal reader takes data and comments, never anything that runs', () => {
  for (const source of ['[]', '{}', '[\'a\', "b", `c`]', '[1, -2.5, 1e3,]', '[/* one */ 1, // two\n 2]', '{ a: { b: [null, undefined] } }']) {
    assert.equal(app.isLiteralSource(source), true, source);
  }
  for (const source of [
    '',
    '[1] [2]',
    'x',
    'a()',
    '[1 2]',
    '{ a }',
    '{ [a]: 1 }',
    '1 + 1',
    '[1] // swallows the brace',
    'import("x")',
    '[}',
    '['.repeat(20) + ']'.repeat(20),
  ]) {
    assert.equal(app.isLiteralSource(source), false, source);
  }
});

const parse = (recipe) => app.parseComponentDefaults({ version: 1, components: { [IMG]: recipe } });

test('the stored format is parsed with its bounds', () => {
  const good = { assets: { src: { file: SVG, url: true } }, literals: { list: '[]', pics: { source: '[a]', imports: { a: PHOTO } } } };
  assert.deepEqual(parse(good).components[IMG], good);
  const bad = [
    { assets: { src: 'src/assets/a.png' } },
    { assets: { src: { file: 'public/a.png' } } },
    { assets: { src: { file: 'src/../a.png' } } },
    { assets: { src: { file: 'src/lib/code.ts' } } },
    { assets: { src: { file: SVG, url: false } } },
    { assets: { src: { file: SVG, other: 1 } } },
    { assets: { '1x': { file: SVG } } },
    { assets: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`p${index}`, { file: SVG }])) },
    { literals: { a: 'alert(1)' } },
    { literals: { a: `[${'1,'.repeat(10_000)}]` } },
    { literals: { a: { source: '[x]', imports: {} } } },
    { literals: { a: { source: '[x]', imports: { x: PHOTO, unused: SVG } } } },
    { literals: { a: { source: '[true]', imports: { true: PHOTO } } } },
    { props: { src: '/a.png' }, assets: { src: { file: SVG } } },
  ];
  for (const recipe of bad) {
    assert.throws(() => parse(recipe), Error, JSON.stringify(recipe).slice(0, 120));
  }
});

test('a file from before reads as before, and a key this version does not know is skipped, as older versions skip the new two', () => {
  assert.deepEqual(parse({ props: { alt: 'x' } }).components[IMG], { props: { alt: 'x' } });
  assert.deepEqual(parse({ props: { alt: 'x' }, someLaterKey: {} }).components[IMG], { props: { alt: 'x' } });
});

test('a child that sets a prop replaces the default wherever the component held it', () => {
  const config = app.parseComponentDefaults({
    version: 1,
    components: {
      [IMG]: { assets: { src: { file: SVG } }, props: { alt: 'own' } },
      [SELECT]: {
        children: [
          { component: IMG, props: { src: '/public.png' } },
          { component: IMG, assets: { alt: { file: PHOTO } } },
        ],
      },
    },
  });
  const resolved = app.resolveComponentRecipe(SELECT, config, catalog);
  assert.ok(resolved.ok);
  const [first, second] = resolved.value.content.children;
  assert.deepEqual([first.props, first.assets], [{ alt: 'own', src: '/public.png' }, undefined]);
  assert.deepEqual([second.props, second.assets], [{}, { src: { file: SVG }, alt: { file: PHOTO } }]);
});

test('moving a file or its folder carries every default that imports it', () => {
  const config = app.parseComponentDefaults({
    version: 1,
    components: {
      [IMG]: { assets: { src: { file: SVG } } },
      [SELECT]: { children: [{ element: 'div', literals: { list: { source: '[a]', imports: { a: PHOTO } } } }] },
    },
  });
  const renamed = app.relinkDefaultAssets(config, SVG, 'src/assets/new name.svg');
  assert.equal(renamed.components[IMG].assets.src.file, 'src/assets/new name.svg');
  const folder = app.relinkDefaultAssets(config, 'src/assets', 'src/media');
  assert.deepEqual(
    app.defaultAssetUses(folder).map((use) => use.file),
    ['src/media/lumos-background.svg', 'src/media/photos/default.png'],
  );
  assert.equal(app.relinkDefaultAssets(config, 'src/other', 'src/else'), config, 'nothing named it: nothing to write');
  assert.equal(app.relinkDefaultAssets(config, SVG, 'public/a.svg'), config, 'a page cannot import from public/');
});

test('a binding name is the file’s own, made a free identifier', () => {
  assert.equal(app.assetBindingName('src/a/lumos-background.svg', new Set()), 'lumos_background');
  assert.equal(app.assetBindingName('src/a/lumos-background.svg', new Set(['lumos_background'])), 'lumos_background2');
  assert.equal(app.assetBindingName('src/a/2x.png', new Set()), '_2x');
  assert.equal(app.assetBindingName('src/a/default.png', new Set()), '_default');
});

// Desktop's insert: the scan's components, the stored defaults, then the page's imports.
const project = '/site';
const scanned = (file) => ({ name: path.basename(file, '.astro'), path: `${project}/${file}`, slots: ['default'], schema: [] });
const config = () =>
  app.parseComponentDefaults({
    version: 1,
    components: {
      [IMG]: { assets: { src: { file: SVG } } },
      [SELECT]: {
        literals: { options: { source: '[{ image: art }]', imports: { art: PHOTO } } },
        children: [{ component: IMG, props: { alt: 'Child' } }],
      },
    },
  });

function inserted(page, component, missingAssets = []) {
  const instance = app.componentInstance(scanned(component), [scanned(IMG), scanned(SELECT)], { config: config(), projectPath: project, missingAssets });
  const resolved = [
    ...instance.components.map((item) => ({ component: item, paths: { relative: `../components/${item.name}.astro` } })),
    ...instance.assets.map((asset) => ({ asset, paths: { relative: `../${asset.slice(4)}` } })),
  ];
  return { instance, ...app.componentInstancePlacement(page, instance, resolved) };
}
const emptyPage = (frontmatter = '') => model(`---\n${frontmatter}---\n<main />\n`);

test('inserting a component, and an Img inside it, imports each default file once', () => {
  const placed = inserted(emptyPage(), SELECT);
  assert.deepEqual(
    placed.imports.map((item) => [item.name, item.path]),
    [
      ['Select', '../components/Select.astro'],
      ['Img', '../components/Img.astro'],
      ['_default', '../assets/photos/default.png'],
      ['lumos_background', '../assets/lumos-background.svg'],
    ],
  );
  assert.deepEqual(placed.node.props.options, { type: 'expr', value: '[{ image: _default }]' });
  assert.deepEqual(placed.node.children[0].props, { src: { type: 'expr', value: 'lumos_background' }, alt: { type: 'string', value: 'Child' } });
});

test('a page that imports the file keeps its name, and a taken name is not reused', () => {
  const reused = inserted(emptyPage("import background from '../assets/lumos-background.svg';\n"), IMG);
  assert.deepEqual(reused.node.props.src, { type: 'expr', value: 'background' });
  assert.equal(reused.imports.length, 2);
  const taken = inserted(emptyPage('const lumos_background = 1;\n'), IMG);
  assert.deepEqual(taken.node.props.src, { type: 'expr', value: 'lumos_background2' });
});

test('a deleted file is left out of the insert and named, never imported', () => {
  const placed = inserted(emptyPage(), SELECT, [SVG, PHOTO]);
  assert.deepEqual(placed.instance.missing.sort(), [SVG, PHOTO].sort());
  assert.deepEqual(
    placed.imports.map((item) => item.name),
    ['Select', 'Img'],
  );
  assert.deepEqual([placed.node.props, placed.node.children[0].props], [{}, { alt: { type: 'string', value: 'Child' } }]);
});

test('the defaults editor and the component canvas draw without a deleted file', () => {
  const prepared = editor(IMG, { assets: { src: { file: SVG } } }, { missingAssets: [SVG] });
  assert.doesNotMatch(prepared.source, /lumos-background/);
  const frame = { key: 'a', label: 'A', row: 0, props: {}, omitted: new Set(), width: 'hug', height: 'hug' };
  const page = (extra, frames = [frame]) =>
    app.canvasPageSource({
      id: '12345678-1234-1234-1234-123456789012',
      component: SELECT,
      fallbackText: 'Select',
      theme: 'light',
      snapshot: { catalog, config: config(), ...extra },
      frames,
    });
  const drawn = page({});
  assert.ok(drawn.includes(`from "../../${SVG}";`), drawn);
  assert.match(drawn, /options=\{\[\{ image: canvasAsset\d \}\]\}/);
  assert.doesNotMatch(page({ missingAssets: [SVG, PHOTO] }), /src\/assets/);
  // A frame's own value replaces the default, written once.
  const overridden = page({}, [{ ...frame, props: { options: 'mine' } }]);
  assert.equal(overridden.match(/ options=/g).length, 1);
  assert.match(overridden, / options="mine"/);
});

// A Lumos-like Tabs, with the slots its own source reports (it reads `links` through a helper, with no <slot name>).
const TABS = 'src/components/Tabs.astro';
const tabsSource = fs.readFileSync(repoPath('test/fixtures/lumos/components/interactive/Tabs.astro'), 'utf8');
const lumos = ['Tabs', 'TabLink', 'ContentWrapper', 'Heading', 'Paragraph', 'ButtonWrapper'].map((name) =>
  entry(`src/components/${name}.astro`, name === 'Tabs' ? { slots: parseSlots(tabsSource) } : {}),
);

function tabsEditor(body, frontmatter = '') {
  const source = `---\nimport Tabs from '../components/Tabs.astro';\n---\n<main><Tabs /></main>\n`;
  const prepared = app.prepareDefaultsCanvas(
    CANVAS,
    { catalog: lumos, config: { version: 1, components: {} } },
    { file: 'src/pages/index.astro', source, model: model(source), path: '0.0' },
  );
  const imports = lumos.slice(1).map((item) => `import ${item.name} from '../../${item.file}';`);
  const written = prepared.source.replace(/^---\n/, `---\n${imports.join('\n')}\n${frontmatter}`).replace('<Tabs />', `<Tabs>\n${body}\n</Tabs>`);
  return { prepared, written };
}

// What Desktop writes into a page when Tabs is inserted with this recipe.
function insertedTabs(recipe) {
  const config = app.parseComponentDefaults({ version: 1, components: { [TABS]: recipe } });
  const scans = lumos.map((item) => ({ name: item.name, path: `${project}/${item.file}`, slots: item.slots, schema: [] }));
  const instance = app.componentInstance(scans[0], scans, { config, projectPath: project });
  const resolved = [
    ...instance.components.map((item) => ({ component: item, paths: { relative: `../components/${item.name}.astro` } })),
    ...instance.assets.map((asset) => ({ asset, paths: { relative: `../${asset.slice(4)}` } })),
  ];
  const page = emptyPage();
  const placed = app.componentInstancePlacement(page, instance, resolved);
  const [main] = page.nodes;
  const lines = placed.imports.map((item) => {
    const named = item.imported === item.name ? item.name : `${item.imported} as ${item.name}`;
    return `import ${item.named ? `{ ${named} }` : item.name} from '${item.path}';`;
  });
  return `---\n${lines.join('\n')}\n---\n${serializeNodes([{ ...main, children: [placed.node] }], '  ')}\n`;
}

const SECTION = (number) =>
  `<ContentWrapper><Heading tag="h3">Section ${number}</Heading><Paragraph>Body</Paragraph><ButtonWrapper><!-- actions --></ButtonWrapper></ContentWrapper>`;

test('Tabs with links in a Fragment saves and inserts with its slot, and no Fragment import', () => {
  const { prepared, written } = tabsEditor(
    `<Fragment slot="links"><TabLink>One</TabLink><TabLink>Two</TabLink></Fragment>\n<Fragment><p>x</p><Fragment slot="links" set:html="<b>raw</b>" /></Fragment>\n<><em>y</em></>\n<Fragment slot="links" set:text={"plain"} />\n${SECTION(1)}`,
  );
  const recipe = saved(prepared, written);
  assert.deepEqual(
    recipe.children.map((child) => [child.element, child.tag, child.props?.slot]),
    [
      ['div', 'Fragment', 'links'],
      ['div', 'Fragment', undefined],
      ['div', '<>', undefined],
      ['div', 'Fragment', 'links'],
      [undefined, undefined, undefined],
    ],
  );
  const stored = app.parseComponentDefaults({ version: 1, components: { [TABS]: recipe } }).components[TABS];
  assert.deepEqual(stored, recipe);
  const page = insertedTabs(recipe);
  assert.doesNotMatch(page, /import \w*Fragment/);
  assert.match(page, /<Fragment slot="links">\s*<TabLink>One<\/TabLink>/);
  assert.match(page, /<Fragment slot="links" set:html="<b>raw<\/b>" \/>/);
  assert.match(page, /<>\s*<em>y<\/em>\s*<\/>/);
  assert.match(page, /set:text=\{"plain"\}/);
  // The defaults editor reopens on the same tree.
  const again = app.prepareDefaultsCanvas(
    CANVAS,
    { catalog: lumos, config: { version: 1, components: { [TABS]: recipe } } },
    { file: 'src/pages/index.astro', source: page, model: model(page), path: '0.0' },
  );
  assert.deepEqual(saved(again), recipe);
});

test('links as direct children, with the comments and spaces the editor keeps, save and insert', () => {
  const { prepared, written } = tabsEditor(
    `<!-- Links -->\n<TabLink slot="links">One</TabLink>\n<TabLink slot="links">Two</TabLink>\n{/* panels below */}\n{" "}\n{}\n${SECTION(1)}\n${SECTION(2)}\n<!-- end -->`,
  );
  const recipe = saved(prepared, written);
  assert.deepEqual(
    recipe.children.flatMap((child) => (child.verbatim === undefined ? [] : [child.verbatim])),
    ['<!-- Links -->', '{/* panels below */}', '{" "}', '{}', '<!-- end -->'],
  );
  const page = insertedTabs(recipe);
  assert.equal(page.match(/<TabLink slot="links">/g).length, 2);
  // A braces comment stays one: written as HTML it would ship in the built page.
  for (const kept of ['<!-- Links -->', '{/* panels below */}', '{" "}', '<!-- actions -->', '<!-- end -->']) {
    assert.ok(page.includes(kept), kept);
  }
  // A comment in a component with only named slots needs no slot of its own.
  const named = lumos.map((item) => (item.file === TABS ? { ...item, slots: ['links'] } : item));
  const config = app.parseComponentDefaults({
    version: 1,
    components: { [TABS]: { children: [{ literal: '', verbatim: '<!-- only links -->' }] } },
  });
  assert.ok(app.resolveComponentRecipe(TABS, config, named).ok);
});

test('Astro built-ins and SVG elements with capitals are kept, built-ins imported by name', () => {
  const { prepared, written } = tabsEditor(
    '<Picture src="/a.png" alt="" />\n<Source code="x" />\n<svg><linearGradient id="g"><stop /></linearGradient></svg>',
    "import { Picture } from 'astro:assets';\nimport { Code as Source } from 'astro:components';\n",
  );
  const recipe = saved(prepared, written);
  assert.deepEqual(
    recipe.children.slice(0, 2).map((child) => [child.tag, child.from]),
    [
      ['Picture', 'astro:assets'],
      ['Code', 'astro:components'],
    ],
  );
  assert.equal(recipe.children[2].children[0].tag, 'linearGradient');
  const page = insertedTabs(recipe);
  assert.match(page, /import \{ Picture \} from 'astro:assets';/);
  assert.match(page, /import \{ Code \} from 'astro:components';/);
  assert.match(page, /<linearGradient id="g">/);
  // The defaults canvas imports them under names its page does not use.
  const again = app.prepareDefaultsCanvas(
    CANVAS,
    { catalog: lumos, config: { version: 1, components: { [TABS]: recipe } } },
    { file: 'src/pages/index.astro', source: page, model: model(page), path: '0.0' },
  );
  assert.match(again.source, /import \{ Picture as DefaultsPicture\d* \} from "astro:assets";/);
  assert.deepEqual(saved(again), recipe);
});

test('what no default can hold is refused by name, and removing it lets the rest save', () => {
  const frontmatter = `import Counter from '../../${'src'}/components/Counter.tsx';\nconst Tag = 'h2';\n`;
  const cases = [
    ['<Counter client:load />', '<Counter>'],
    ['<Tag>t</Tag>', '<Tag>'],
    ['<Astro.self />', '<Astro.self>'],
    ['{items.map((i) => <li>{i}</li>)}', '{items.map'],
    ['{show && <p>x</p>}', '{show && …}'],
    ['{title}', '{title}'],
    ['<style>.a { color: red }</style>', '<style>'],
  ];
  for (const [markup, named] of cases) {
    const { prepared, written } = tabsEditor(`<p>keep</p>\n${markup}`, frontmatter);
    assert.throws(
      () => saved(prepared, written),
      (error) => error instanceof app.UnsupportedChildError && error.child.startsWith(named),
      markup,
    );
    assert.deepEqual(saved(prepared, written.replace(markup, '')).children, [{ element: 'p', props: {}, text: 'keep' }]);
  }
});

test('verbatim markup is parsed as markup that computes nothing', () => {
  for (const verbatim of ['<!-- a -->', '{}', '{" "}', "{'x'}", '{/* c */}', '{1}']) {
    assert.equal(app.isStaticMarkup(verbatim), true, verbatim);
  }
  for (const verbatim of ['{x}', '{a()}', '<script>1</script>', '<!-- a --><b>', '{"a" "b"}', '{[1]}', 'text']) {
    assert.equal(app.isStaticMarkup(verbatim), false, verbatim);
    assert.throws(() => parse({ children: [{ literal: '', verbatim }] }), Error, verbatim);
  }
  assert.throws(() => parse({ children: [{ literal: 'words', verbatim: '{}' }] }));
  assert.throws(() => parse({ children: [{ element: 'div', tag: 'Evil' }] }));
  assert.throws(() => parse({ children: [{ element: 'div', tag: 'Image', from: 'node:fs' }] }));
});
