// Goal: the List and Image property types are written into a component's
// frontmatter as a person writes them in Astro, read back the same way by the
// main process's prop schema, and offered only on the fields they fit.
//
// Method: the pure modules, bundled as the app bundles them, plus main's own
// prop schema reader (electron/parse/astroPropSchema.ts). Each declaration
// case starts from a frontmatter as text and checks the text that comes out:
// a list's inline item type (or a type the file already declares) and its
// default array, an image's ImageMetadata import or URL string, and the
// imports the caller is asked to add. The negative space sits beside each:
// lists with no fields, clashing or invalid names, values that do not fit
// their kind, an image default that names no image. Then the written list is
// read by main's schema reader and handed to the data tree a loop reads, so a
// loop over the new prop offers its item's fields; and a hand-written list
// prop reads as it did. Last, the picker's fit rules, the item shapes the
// list editor draws, and the booleans a list item can now hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const declaration = load('src/editor/propDeclaration.ts');
const listType = load('src/editor/listPropType.ts');
const imageDefault = load('src/editor/imagePropDefault.ts');
const model = load('src/features/props/newPropModel.ts');
const shape = load('src/features/props/listItemShape.ts');
const arrays = load('src/features/props/arrayValue.ts');
const suggest = load('src/editor/dataSuggest.ts');
const schemaReader = require('#dist/electron/parse/astroPropSchema.js');

const NONE = { min: undefined, max: undefined, decimals: undefined };
const EMPTY_LIST = { fields: [], items: [] };
const declare = (fields) => ({
  tooltip: '',
  defaultText: '',
  options: [],
  number: NONE,
  attributes: [],
  tag: '',
  list: EMPTY_LIST,
  image: '',
  ...fields,
});
const declared = (frontmatter, fields, taken = [], existing = []) => declaration.declaredProp(frontmatter, declare(fields), new Set(taken), existing);
const TITLE_TEXT = [
  { name: 'title', kind: 'text' },
  { name: 'text', kind: 'text' },
];

// ── List ─────────────────────────────────────────────────────────────────────

test('a list prop is an inline readonly item type with its default array', () => {
  const before = 'interface Props {\n  heading?: string;\n}\nconst { heading = "Values" } = Astro.props;\n';
  const out = declared(before, {
    key: 'items',
    kind: 'list',
    tooltip: 'The rows, in order',
    list: { fields: TITLE_TEXT, items: [{ title: 'Commit', text: 'to a genuine "relationship"' }] },
  });
  assert.ok(out.ok, out.error);
  assert.equal(
    out.value.frontmatter,
    'interface Props {\n  heading?: string;\n  /** The rows, in order */\n  items?: readonly { title: string; text: string }[];\n}\n' +
      'const { heading = "Values", items = [{ title: "Commit", text: "to a genuine \\"relationship\\"" }] } = Astro.props;\n',
  );
  assert.deepEqual(out.value.imports, [], 'a list needs no import');
});

test('a list with no items still gets a default it can be looped over', () => {
  const out = declared('', { key: 'items', kind: 'list', list: { fields: TITLE_TEXT, items: [] } });
  assert.ok(out.ok, out.error);
  assert.equal(out.value.frontmatter, 'interface Props {\n\titems?: readonly { title: string; text: string }[];\n}\nconst { items = [] } = Astro.props;\n');
});

test('a type the file declares with exactly those fields is reused by name', () => {
  const interfaced = declared('interface Value { title: string; text: string }\nconst { a } = Astro.props;\n', {
    key: 'items',
    kind: 'list',
    list: { fields: TITLE_TEXT, items: [] },
  });
  assert.ok(interfaced.ok, interfaced.error);
  assert.match(interfaced.value.frontmatter, /items\?: readonly Value\[\];/);
  const aliased = declared('export type Row = { title: string; text: string };\n', { key: 'rows', kind: 'list', list: { fields: TITLE_TEXT, items: [] } });
  assert.ok(aliased.ok);
  assert.match(aliased.value.frontmatter, /rows\?: readonly Row\[\];/, 'an exported alias counts');
  const other = declared('interface Value { title: string; body: string }\n', { key: 'items', kind: 'list', list: { fields: TITLE_TEXT, items: [] } });
  assert.ok(other.ok);
  assert.match(other.value.frontmatter, /items\?: readonly \{ title: string; text: string \}\[\];/, 'a type with other fields is not reused');
  const extended = declared('interface Value extends Base { title: string; text: string }\n', {
    key: 'items',
    kind: 'list',
    list: { fields: TITLE_TEXT, items: [] },
  });
  assert.ok(extended.ok);
  assert.doesNotMatch(extended.value.frontmatter, /readonly Value\[\]/, 'an extending type holds more than its body says');
  assert.equal(listType.namedItemType('interface Props { title: string; text: string }\n', TITLE_TEXT), undefined, 'Props itself is never the item type');
});

test('each field kind is typed and written as its literal', () => {
  const fields = [
    { name: 'title', kind: 'text' },
    { name: 'count', kind: 'number' },
    { name: 'featured', kind: 'switch' },
    { name: 'image', kind: 'image' },
    { name: 'href', kind: 'link' },
  ];
  const out = declared('', {
    key: 'cards',
    kind: 'list',
    list: { fields, items: [{ title: 'A', count: '3', featured: 'true', image: '/a.png', href: '/a' }, { title: 'B' }] },
  });
  assert.ok(out.ok, out.error);
  assert.match(out.value.frontmatter, /cards\?: readonly \{ title: string; count: number; featured: boolean; image: string; href: string \}\[\];/);
  assert.match(
    out.value.frontmatter,
    /cards = \[\{ title: "A", count: 3, featured: true, image: "\/a\.png", href: "\/a" \}, \{ title: "B", count: 0, featured: false, image: "", href: "" \}\]/,
    'a field left empty is written blank in its kind',
  );
});

test('a list that cannot be written says why', () => {
  const problem = (list) => {
    const out = declared('', { key: 'items', kind: 'list', list });
    assert.equal(out.ok, false);
    return out.error;
  };
  assert.equal(problem({ fields: [], items: [] }), 'Add at least one field to each item.');
  assert.equal(
    problem({
      fields: [
        { name: 'a', kind: 'text' },
        { name: 'a', kind: 'number' },
      ],
      items: [],
    }),
    'Each field has to have its own name.',
  );
  assert.equal(problem({ fields: [{ name: '', kind: 'text' }], items: [] }), 'Each field needs a name.');
  assert.match(problem({ fields: [{ name: '2x', kind: 'text' }], items: [] }), /is not a field name/);
  assert.equal(problem({ fields: [{ name: 'n', kind: 'number' }], items: [{ n: 'three' }] }), 'The n of item 1 has to be a number.');
  assert.equal(problem({ fields: [{ name: 'on', kind: 'switch' }], items: [{}, { on: 'yes' }] }), 'The on of item 2 is on or off.');
  const many = Array.from({ length: listType.LIST_LIMITS.fieldsMax + 1 }, (_, index) => ({ name: `f${index}`, kind: 'text' }));
  assert.equal(problem({ fields: many, items: [] }), 'That is too many fields.');
});

// ── Image ────────────────────────────────────────────────────────────────────

test('an image from src/ is imported and typed ImageMetadata', () => {
  const out = declared('interface Props {}\nconst {} = Astro.props;\n', {
    key: 'image',
    kind: 'image',
    tooltip: 'The card’s picture',
    image: '../assets/placeholder.svg',
  });
  assert.ok(out.ok, out.error);
  assert.equal(
    out.value.frontmatter,
    'interface Props {\n\t/** The card’s picture */\n\timage?: ImageMetadata;\n}\nconst { image = placeholder } = Astro.props;\n',
  );
  assert.deepEqual(out.value.imports, [
    { name: 'ImageMetadata', path: 'astro', named: true, typeOnly: true },
    { name: 'placeholder', path: '../assets/placeholder.svg', named: false, typeOnly: false },
  ]);
});

test('the import is named after the file, numbered when that name is taken, and reused when the file has it', () => {
  const taken = declared('', { key: 'image', kind: 'image', image: '../assets/hero-shot.png' }, ['heroShot']);
  assert.ok(taken.ok);
  assert.match(taken.value.frontmatter, /image = heroShot2/);
  assert.equal(taken.value.imports[1].name, 'heroShot2');
  const clash = declared('', { key: 'placeholder', kind: 'image', image: '../assets/placeholder.svg' });
  assert.ok(clash.ok);
  assert.match(clash.value.frontmatter, /const \{ placeholder = placeholder2 \}/, 'the import never shadows the prop');
  const reused = declared(
    '',
    { key: 'image', kind: 'image', image: '../assets/placeholder.svg' },
    ['square'],
    [{ name: 'square', path: '../assets/placeholder.svg' }],
  );
  assert.ok(reused.ok);
  assert.match(reused.value.frontmatter, /image = square/);
  assert.deepEqual(
    reused.value.imports.map((entry) => entry.name),
    ['ImageMetadata'],
    'only the type is still needed',
  );
});

test('an image in public/ or on the web is a URL string', () => {
  const remote = declared('', { key: 'image', kind: 'image', image: 'https://cdn.example.com/hero.jpg' });
  assert.ok(remote.ok);
  assert.equal(remote.value.frontmatter, 'interface Props {\n\timage?: string;\n}\nconst { image = "https://cdn.example.com/hero.jpg" } = Astro.props;\n');
  assert.deepEqual(remote.value.imports, []);
  const local = declared('', { key: 'cover', kind: 'image', image: '/images/cover.webp' });
  assert.ok(local.ok);
  assert.match(local.value.frontmatter, /cover\?: string;[\s\S]*cover = "\/images\/cover\.webp"/);
});

test('an image default that names no image says why', () => {
  const problem = (image) => {
    const out = declared('', { key: 'image', kind: 'image', image });
    assert.equal(out.ok, false);
    return out.error;
  };
  assert.equal(problem(''), 'Choose a default image.');
  assert.equal(problem('../assets/brochure.pdf'), 'Only an image file can be imported as an image.');
  assert.equal(problem('hero.png'), 'Choose an image from the project, or enter its URL.');
  assert.equal(problem('/a".png'), 'That is not an image address.');
  assert.ok(imageDefault.isImageType('ImageMetadata | string'));
  assert.ok(!imageDefault.isImageType('string'));
});

// ── Read back by main, and looped over ────────────────────────────────────────

// The frontmatter as a component file, read by main's prop schema reader.
const schemaOf = (frontmatter) => schemaReader.parsePropSchema(`---\n${frontmatter}---\n<div />\n`);

test('a written list prop reads back with its item shape, and a loop over it offers the item’s fields', () => {
  const out = declared('', { key: 'items', kind: 'list', list: { fields: [...TITLE_TEXT, { name: 'featured', kind: 'switch' }], items: [{ title: 'Fast' }] } });
  assert.ok(out.ok);
  const schema = schemaOf(out.value.frontmatter);
  const items = schema.find((field) => field.name === 'items');
  assert.equal(items.type, 'code');
  assert.equal(items.shapeIsList, true, 'the readonly array is a list');
  assert.deepEqual(
    items.shape.map((field) => `${field.name}:${field.type}`),
    ['title:string', 'text:string', 'featured:boolean'],
  );
  const tree = suggest.dataTree({ frontmatter: out.value.frontmatter, propsSchema: schema, ancestorHeads: ['items.map((item) => ('] });
  const loopItem = tree.find((node) => node.section === 'loop' && node.path === 'item');
  assert.ok(loopItem, 'the loop item leads the tree');
  assert.deepEqual(
    (loopItem.children ?? []).map((node) => node.path),
    ['item.title', 'item.text', 'item.featured'],
    'its fields are the declared item type’s',
  );
  const named = schemaOf(
    `interface Value { title: string; text: string }\n${declared('interface Value { title: string; text: string }\n', { key: 'items', kind: 'list', list: { fields: TITLE_TEXT, items: [] } }).value.frontmatter.replace('interface Value { title: string; text: string }\n', '')}`,
  );
  assert.deepEqual(
    named.find((field) => field.name === 'items').shape.map((field) => field.name),
    ['title', 'text'],
    'a named item type reads the same',
  );
});

test('a hand-written list prop still reads as it did', () => {
  const schema = schemaOf('interface Props {\n  links: { label: string; href: string }[];\n  tags?: string[];\n}\nconst { links, tags = [] } = Astro.props;\n');
  const links = schema.find((field) => field.name === 'links');
  assert.equal(links.shapeIsList, true);
  assert.deepEqual(
    links.shape.map((field) => field.name),
    ['label', 'href'],
  );
  assert.equal(schema.find((field) => field.name === 'tags').shape, undefined, 'a list of words has no item shape');
  assert.deepEqual(shape.itemShapeOf(links.shape), [
    { name: 'label', kind: 'text' },
    { name: 'href', kind: 'link' },
  ]);
});

test('a written image prop reads back as the type its default gives it', () => {
  const asset = declared('', { key: 'image', kind: 'image', image: '../assets/placeholder.svg' });
  const read = schemaOf(asset.value.frontmatter).find((field) => field.name === 'image');
  assert.equal(read.default, 'placeholder');
  assert.equal(read.defaultExpr, true);
  assert.deepEqual([...model.imagePropsOf(asset.value.frontmatter)], [['image', 'asset']]);
  const url = declared('', { key: 'hero', kind: 'image', image: '/images/hero.jpg' });
  assert.deepEqual([...model.imagePropsOf(url.value.frontmatter)], [['hero', 'url']], 'a URL default says image even when the name does not');
  assert.deepEqual([...model.imagePropsOf('interface Props { title?: string }\nconst { title = "Hi" } = Astro.props;\n')], [], 'words are not images');
});

// ── Where each fits ───────────────────────────────────────────────────────────

test('an image field offers Image, and a list field offers List', () => {
  assert.equal(model.fitOfFieldType('string', { media: true }), 'image', 'an <img> src');
  assert.equal(model.fitOfFieldType('other', { media: true }), 'image', 'an astro:assets <Image> src');
  assert.equal(model.fitOfFieldType('string', {}), 'text', 'a text field is not an image field');
  assert.equal(model.fitOfFieldType('code', { list: true }), 'list');
  assert.equal(model.fitOfFieldType('code', {}), undefined);
  assert.deepEqual(model.FIT_KINDS.image, ['image']);
  assert.deepEqual(model.FIT_KINDS.list, ['list']);
  assert.equal(model.newPropTitle('image'), 'Image');
  assert.equal(model.newPropTitle('list'), 'List');
  assert.equal(model.seedName({ fit: 'image', label: 'src' }), 'image', 'an src makes an image prop');
  assert.equal(model.seedName({ fit: 'text', label: 'src' }), 'src');
});

test('an ImageMetadata prop fits only image fields; a URL image fits both; a list only a list', () => {
  const tree = [
    { path: 'photo', key: 'photo', kind: 'other', section: 'props' },
    { path: 'hero', key: 'hero', kind: 'string', section: 'props' },
    { path: 'title', key: 'title', kind: 'string', section: 'props' },
    { path: 'items', key: 'items', kind: 'list', section: 'props', children: [{ path: 'items[0]', key: '0', kind: 'object' }] },
    { path: 'posts', key: 'posts', kind: 'collection', section: 'collections' },
  ];
  const images = new Map([
    ['photo', 'asset'],
    ['hero', 'url'],
  ]);
  const paths = (fit) => model.fittingTree(tree, fit, images).map((node) => node.path);
  assert.deepEqual(paths('image'), ['photo', 'hero', 'items', 'posts'], 'images, and a list kept for its fields');
  assert.deepEqual(paths('text'), ['hero', 'title', 'items', 'posts'], 'an imported image is not words');
  assert.deepEqual(paths('list'), ['items', 'posts']);
  assert.equal(model.fittingTree(tree, 'image', images)[0].kind, 'image', 'listed as an image, for its icon');
  assert.equal(model.fittingTree(tree, 'text', images)[0].kind, 'image url');
  assert.ok(!model.propFits('image', 'content'));
  assert.ok(model.propFits('image url', 'content'));
  assert.ok(!model.propFits('list', 'text'));
});

test('an imported image bound where a URL is wanted reads its src', () => {
  assert.equal(model.boundPath('image', 'asset', 'url'), 'image.src', 'an <img> src');
  assert.equal(model.boundPath('image', 'asset', 'module'), 'image', 'astro:assets <Image> takes the metadata');
  assert.equal(model.boundPath('image', 'url', 'url'), 'image', 'a URL is already one');
  assert.equal(model.boundPath('items', undefined, undefined), 'items');
  assert.throws(() => model.boundPath('post.data.image', 'asset', 'url'), /boundPath: a prop is read by an identifier/);
});

// ── The list editor's item shapes ─────────────────────────────────────────────

test('item fields take their kinds from the declared shape, else from their values and names', () => {
  const declaredShape = shape.itemShapeOf([
    { name: 'title', type: 'string' },
    { name: 'count', type: 'number' },
    { name: 'on', type: 'boolean' },
    { name: 'heroImage', type: 'string' },
    { name: 'url', type: 'string' },
  ]);
  assert.deepEqual(
    declaredShape.map((field) => field.kind),
    ['text', 'number', 'switch', 'image', 'link'],
  );
  const field = (key, text, quote) => ({ key, keyQuote: undefined, text, quote });
  assert.equal(shape.itemFieldKind(field('on', 'true', undefined), undefined), 'switch');
  assert.equal(shape.itemFieldKind(field('n', '4', undefined), undefined), 'number');
  assert.equal(shape.itemFieldKind(field('logo', '/a.svg', '"'), undefined), 'image');
  assert.equal(shape.itemFieldKind(field('title', 'x', '"'), undefined), 'text');
  assert.equal(shape.itemFieldKind(field('count', '', '"'), declaredShape), 'number', 'the declaration wins');
  assert.equal(shape.itemShapeOf(undefined), undefined);
  assert.equal(shape.itemShapeOf([]), undefined);
});

test('a blank item has every declared field, and a conformed one keeps what the shape does not name', () => {
  const declaredShape = [
    { name: 'title', kind: 'text' },
    { name: 'count', kind: 'number' },
    { name: 'on', kind: 'switch' },
  ];
  assert.equal(arrays.arrayText([shape.blankItemOf(declaredShape, "'")]), "[{ title: '', count: 0, on: false }]");
  const [item] = arrays.arrayItems('[{ extra: "kept", title: "A" }]');
  const conformed = shape.conformedItem(item, declaredShape, '"');
  assert.deepEqual(
    conformed.fields.map((entry) => `${entry.key}=${entry.text}`),
    ['title=A', 'count=0', 'on=false', 'extra=kept'],
  );
  assert.throws(() => shape.blankItemOf([], '"'), /blankItemOf: an item has a field/);
  const renamed = shape.renamedItemField(arrays.arrayItems('[{ title: "A" }]'), 'title', 'heading');
  assert.equal(arrays.arrayText(renamed), '[{ heading: "A" }]');
  assert.deepEqual(shape.itemValuesOf(arrays.arrayItems('[{ title: "A", on: true }]')), [{ title: 'A', on: 'true' }]);
});

test('a list item can hold a switch, and it round-trips as a boolean', () => {
  const items = arrays.arrayItems('[{ title: "Fast", featured: true }, { title: "Small", featured: false }]');
  assert.ok(items, 'a boolean field no longer drops the list into code');
  assert.equal(items[0].fields[1].quote, undefined);
  assert.equal(arrays.arrayText(items), '[{ title: "Fast", featured: true }, { title: "Small", featured: false }]');
  assert.equal(arrays.itemLabel(arrays.arrayItems('[{ on: true, name2: "Named" }]')[0]), 'Named', 'a row is named by a text field, not a switch');
  assert.equal(arrays.arrayText(arrays.arrayItems('[{ on: maybe }]')), '[{ on: maybe }]', 'a name standing for a value is a bound field');
});
