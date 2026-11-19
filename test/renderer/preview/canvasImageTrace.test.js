// Goal: a double click on an image names the prop of the page's component instance that decides the
// picture, and the prop that feeds its alt text, whatever either is called, through as many components as
// hand it on. And whatever cannot be followed to a place the editor may write is refused with its reason, so
// the popup never rewrites code it did not understand.
// Method: parse Card, VisualImage and Img shaped Astro sources (Img is the Lumos component, reduced), and ask
// the tracer about the image node with the marker paths a rendered image carries: its own node in the file
// that draws it and the node of each instance that rendered it, up to the page. Each test is one spelling of
// the same question: a direct prop, a renamed prop, an `image.alt` object, a `{...image}` spread, a
// pass-through, a default, a static alt, no alt, and then the refusals (an expression, a loop, a fixed
// picture, a computed one, an image outside the open file).
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const loadRenderer = require('../../helpers/rendererModule');
const { traceImage } = loadRenderer('src/app/model/canvasImageTrace.ts');
const { traceValue, componentScope, topLevelConsts, objectLiteral } = loadRenderer('src/app/model/canvasImageExpression.ts');

const ROOT = '/site';
const PAGE = '/site/src/pages/index.astro';

const parsed = (text) => {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true, 'the source parses');
  return result.model;
};

// The tree path of the first node the test accepts, as the preview's markers write it (`0.1.2`).
function pathOf(nodes, match) {
  const queue = nodes.map((node, index) => ({ node, trail: [index] }));
  for (let at = 0; at < queue.length && at < 5000; at++) {
    const { node, trail } = queue[at];
    if (match(node)) {
      return trail.join('.');
    }
    (node.children ?? []).forEach((child, index) => queue.push({ node: child, trail: [...trail, index] }));
  }
  return undefined;
}

const field = (name) => ({ name, type: 'string' });
const component = (name, file, schema) => ({ name, path: `${ROOT}/src/components/${file}`, schema: schema.map(field) });
const COMPONENTS = [
  component('Card', 'Card.astro', ['image', 'imageAlt', 'heading']),
  component('VisualImage', 'VisualImage.astro', ['src', 'alt']),
  component('Img', 'Img.astro', ['src', 'alt']),
  component('Photo', 'Photo.astro', ['image', 'altText']),
];
const rel = (file) => file.slice(ROOT.length + 1);

// A Lumos-shaped Img: the alt reaches the element through a const, a shorthand in an object, and a spread.
const IMG = [
  '---',
  'import { Image } from "astro:assets";',
  'const { src, alt: altProp, width, ...attrs } = Astro.props;',
  'const alt = altProp ?? "";',
  'const isPublicPath = typeof src === "string";',
  'const shared = { src, alt, width, ...attrs } as unknown as LocalImageProps;',
  '---',
  '{src && (isPublicPath ? (<img src={src as string} {...{ alt, width }} {...attrs} />) : (<Image {...shared} />))}',
].join('\n');
const VISUAL_IMAGE = [
  '---',
  'import Img from "@/components/Img.astro";',
  'const { src, alt } = Astro.props;',
  '---',
  '<div class="visual"><Img src={src} alt={alt} class="inner" /></div>',
].join('\n');
const CARD = [
  '---',
  'import VisualImage from "@/components/VisualImage.astro";',
  'const { image, imageAlt, heading } = Astro.props;',
  '---',
  '<div class="card"><VisualImage src={image} alt={imageAlt} /><h3>{heading}</h3></div>',
].join('\n');
const FILES = {
  '/site/src/components/Card.astro': CARD,
  '/site/src/components/VisualImage.astro': VISUAL_IMAGE,
  '/site/src/components/Img.astro': IMG,
};

async function trace(pageText, files, chain) {
  const page = parsed(pageText);
  const sources = { ...FILES, ...files };
  const context = {
    projectPath: ROOT,
    file: PAGE,
    openRel: '',
    nodes: page.nodes,
    imports: page.imports,
    components: COMPONENTS,
    relative: rel,
    read: async (file) => (sources[file] === undefined ? undefined : parsed(sources[file])),
  };
  const paths = [pathOf(page.nodes, chain.page)];
  for (const [file, match] of chain.files ?? []) {
    paths.push(`${file}|${pathOf(parsed(sources[`${ROOT}/${file}`]).nodes, match)}`);
  }
  return { result: await traceImage(context, paths), page };
}

const named = (name) => (node) => node.kind === 'component' && node.name === name;
const element = (tag) => (node) => node.kind === 'element' && node.name === tag;
const IMPORT_CARD = 'import Card from "@/components/Card.astro";';
const IMPORT_PHOTO = 'import Photo from "@/components/Photo.astro";';
const page = (body, imports = IMPORT_CARD) => ['---', imports, 'import hero from "@/assets/hero.png";', '---', body].join('\n');
const cardChain = (leaf = element('img')) => ({
  page: named('Card'),
  files: [
    ['src/components/Card.astro', named('VisualImage')],
    ['src/components/VisualImage.astro', named('Img')],
    ['src/components/Img.astro', leaf],
  ],
});

test('a Card image resolves through VisualImage and Img to the Card prop, and its alt to the renamed alt prop', async () => {
  const { result, page: parsedPage } = await trace(page('<Card image="/a.png" imageAlt="A cat" />'), {}, cardChain());
  assert.equal(result.ok, true, JSON.stringify(result));
  const card = parsedPage.nodes.find(named('Card'));
  assert.equal(result.value.kind, 'instance');
  assert.equal(result.value.instanceId, card.id);
  assert.equal(result.value.srcProp, 'image', 'Card calls the picture image, though Img calls it src');
  assert.deepEqual(result.value.alt, { kind: 'prop', prop: 'imageAlt' }, 'the alt prop is found by tracing, not by its name');
  assert.equal(result.value.state, 'literal');
});

test('the Astro Image branch of Img traces through the shared object and its alias const', async () => {
  const { result } = await trace(
    page('<Card image="/a.png" imageAlt="A cat" />'),
    {},
    cardChain((node) => node.kind === 'component' && node.name === 'Image'),
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.srcProp, 'image');
  assert.deepEqual(result.value.alt, { kind: 'prop', prop: 'imageAlt' }, '`alt` is `altProp ?? ""`, shorthand in `shared`, spread into <Image>');
});

test('a prop the page leaves unset shows the component default and is editable', async () => {
  const { result } = await trace(page('<Card />'), {}, cardChain());
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'default');
});

test('an imported asset the page binds is a value the panel replaces', async () => {
  const { result } = await trace(page('<Card image={hero} imageAlt="x" />'), {}, cardChain());
  assert.equal(result.ok, true);
  assert.equal(result.value.state, 'asset');
});

const PHOTO_PAGE = page('<Photo image="/a.png" altText="Cat" />', IMPORT_PHOTO);
const photoChain = { page: named('Photo'), files: [['src/components/Photo.astro', element('img')]] };
const photo = (template, frontmatter = 'const { image, altText } = Astro.props;') => ({
  '/site/src/components/Photo.astro': ['---', frontmatter, '---', template].join('\n'),
});

test('image.alt and image.src name the one object prop', async () => {
  const { result } = await trace(PHOTO_PAGE, photo('<img src={image.src} alt={image.alt} />'), photoChain);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.value.srcProp, result.value.srcMember], ['image', 'src']);
  assert.deepEqual(result.value.alt, { kind: 'prop', prop: 'image', member: 'alt' });
});

test('a {...image} spread reads src and alt from the object prop', async () => {
  const { result } = await trace(PHOTO_PAGE, photo('<img {...image} />'), photoChain);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual([result.value.srcProp, result.value.srcMember], ['image', 'src']);
  assert.deepEqual(result.value.alt, { kind: 'prop', prop: 'image', member: 'alt' });
});

test('alt={Astro.props.altText ?? ""} and a props alias read the prop altText', async () => {
  const direct = await trace(PHOTO_PAGE, photo('<img src={image} alt={Astro.props.altText ?? ""} />'), photoChain);
  assert.deepEqual(direct.result.value.alt, { kind: 'prop', prop: 'altText' });
  const aliased = await trace(
    PHOTO_PAGE,
    photo('<img src={image} alt={props.altText ?? ""} />', 'const props = Astro.props;\nconst { image } = Astro.props;'),
    photoChain,
  );
  assert.deepEqual(aliased.result.value.alt, { kind: 'prop', prop: 'altText' });
});

test('a static alt is fixed in the component; no alt at all is none', async () => {
  const fixed = await trace(PHOTO_PAGE, photo('<img src={image} alt="Decorative" />'), photoChain);
  assert.deepEqual(fixed.result.value.alt, { kind: 'fixed', file: '/site/src/components/Photo.astro' });
  const none = await trace(PHOTO_PAGE, photo('<img src={image} />'), photoChain);
  assert.equal(none.result.ok, true);
  assert.equal(none.result.value.alt.kind, 'none');
});

test('an alt the component computes is blocked, and still names the picture', async () => {
  const { result } = await trace(PHOTO_PAGE, photo('<img src={image} alt={altText ? altText : "x"} />'), photoChain);
  assert.equal(result.ok, true);
  assert.equal(result.value.alt.kind, 'blocked');
});

test('a native <img> on the open page edits its own attributes', async () => {
  const { result, page: parsedPage } = await trace(page('<img src="/a.png" alt="x" />'), {}, { page: element('img') });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.kind, 'element');
  assert.equal(result.value.nodeId, parsedPage.nodes.find(element('img')).id);
  assert.deepEqual(result.value.alt, { kind: 'attribute' });
  const bare = await trace(page('<img src="/a.png" />'), {}, { page: element('img') });
  assert.deepEqual(bare.result.value.alt, { kind: 'attribute' }, 'no alt yet: the popup offers to add one');
});

test('refused: a picture the page binds to an expression, a function, or a CMS field', async () => {
  for (const expression of ['cards[0].photo', 'entry.data.image', 'pick(image)']) {
    const { result } = await trace(page(`<Card image={${expression}} />`), {}, cardChain());
    assert.equal(result.ok, false, expression);
    assert.deepEqual(result.error, { kind: 'bound', expression });
  }
});

test('refused: a picture a loop draws once for each pass', async () => {
  const { result } = await trace(page('{items.map((item) => <Card image="/a.png" />)}'), {}, cardChain());
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'loop');
});

test('refused: a picture written in the component is the same for every instance', async () => {
  const { result } = await trace(PHOTO_PAGE, photo('<img src="/fixed.png" alt={altText} />'), photoChain);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { kind: 'fixed', file: '/site/src/components/Photo.astro' });
  const handed = await trace(
    page('<Card image="/a.png" />'),
    { '/site/src/components/Card.astro': CARD.replace('src={image}', 'src="/fixed.png"') },
    cardChain(),
  );
  assert.equal(handed.result.error.kind, 'fixed', 'a literal one component hands the next is as fixed as one in the img');
});

test('refused: a picture the component computes', async () => {
  const { result } = await trace(PHOTO_PAGE, photo('<img src={image ? image : "/x.png"} />'), photoChain);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'computed');
});

test('refused: an image only a layout draws has no instance on the open page', async () => {
  const context = { projectPath: ROOT, file: PAGE, openRel: '', nodes: [], imports: [], components: COMPONENTS, relative: rel, read: async () => undefined };
  const result = await traceImage(context, ['src/layouts/BaseLayout.astro|0.1.0']);
  assert.equal(result.ok, false);
  assert.deepEqual(result.error, { kind: 'outside', file: 'src/layouts/BaseLayout.astro' });
});

test('a chain longer than the bound is refused, never followed forever', async () => {
  const files = {};
  const components = [];
  for (let level = 0; level < 9; level++) {
    components.push(component(`Wrap${level}`, `Wrap${level}.astro`, ['src']));
    files[`/site/src/components/Wrap${level}.astro`] = [
      '---',
      `import Wrap${level + 1} from "@/components/Wrap${level + 1}.astro";`,
      'const { src } = Astro.props;',
      '---',
      `<Wrap${level + 1} src={src} />`,
    ].join('\n');
  }
  const pageModel = parsed(['---', 'import Wrap0 from "@/components/Wrap0.astro";', '---', '<Wrap0 src="/a.png" />'].join('\n'));
  const context = {
    projectPath: ROOT,
    file: PAGE,
    openRel: '',
    nodes: pageModel.nodes,
    imports: pageModel.imports,
    components,
    relative: rel,
    read: async (file) => (files[file] === undefined ? undefined : parsed(files[file])),
  };
  const paths = ['0', ...components.map((entry, level) => `src/components/Wrap${level}.astro|0`)];
  const result = await traceImage(context, paths);
  assert.equal(result.ok, false);
  assert.equal(result.error.kind, 'unreadable');
});

test('expressions: props, aliases, defaults, casts, members and the unfollowable', () => {
  const scope = componentScope(
    [
      'const { src, alt: altProp = "x", image } = Astro.props as Props;',
      'const alt = altProp ?? "";',
      'const loop = alt;',
      'const frozen = "Words";',
      'const box = { alt: altProp, size: 3 };',
    ].join('\n'),
  );
  assert.deepEqual(traceValue('src', scope), { kind: 'prop', prop: 'src' });
  assert.deepEqual(traceValue('src as string', scope), { kind: 'prop', prop: 'src' });
  assert.deepEqual(traceValue('altProp', scope), { kind: 'prop', prop: 'alt' });
  assert.deepEqual(traceValue('alt', scope), { kind: 'prop', prop: 'alt' }, 'a const that aliases a prop with a fallback');
  assert.deepEqual(traceValue('loop', scope), { kind: 'prop', prop: 'alt' }, 'two aliases deep');
  assert.deepEqual(traceValue('image?.alt', scope), { kind: 'prop', prop: 'image', member: 'alt' });
  assert.deepEqual(traceValue('box.alt', scope), { kind: 'prop', prop: 'alt' }, 'a member of a const object literal');
  assert.deepEqual(traceValue('frozen', scope), { kind: 'literal', text: 'Words' });
  assert.deepEqual(traceValue('"Words"', scope), { kind: 'literal', text: 'Words' });
  assert.equal(traceValue('src ? a : b', scope).kind, 'blocked');
  assert.equal(traceValue('make(src)', scope).kind, 'blocked');
  assert.equal(traceValue('unknownName', scope).kind, 'blocked');
});

test('a cycle of aliases ends blocked, within its bound', () => {
  const scope = componentScope('const a = b;\nconst b = a;');
  assert.equal(traceValue('a', scope).kind, 'blocked');
});

test('the frontmatter reader keeps top-level consts only, drops comments, and ends a statement at its line', () => {
  const found = topLevelConsts(
    [
      '// const hidden = 1;',
      'const one = "a // not a comment";',
      'const two =',
      '  cond',
      '  ? 1',
      '  : 2;',
      'function f() { const inner = 3; }',
      'const three = { a: 1 }',
    ].join('\n'),
  );
  assert.deepEqual([...found.keys()], ['one', 'two', 'three']);
  assert.equal(found.get('one'), '"a // not a comment"');
  assert.equal(found.get('three'), '{ a: 1 }');
});

test('object literals read shorthand, keyed, quoted and spread entries', () => {
  const entries = objectLiteral('{ alt, width: w, "class:list": c, ...rest }');
  assert.deepEqual(
    entries.map((entry) => (entry.kind === 'spread' ? `...${entry.expression}` : `${entry.name}=${entry.expression}`)),
    ['alt=alt', 'width=w', 'class:list=c', '...rest'],
  );
  assert.equal(objectLiteral('image'), undefined);
});
