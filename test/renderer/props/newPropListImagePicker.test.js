// Goal: the List and Image property types work where a designer meets them:
// an image field's bind menu offers "New Image property" and the image props
// that fit (never on a text field), the form's default makes the type and the
// binding (`image.src` for an <img>), a loop's Source menu makes a List
// property and loops over it in one undo step, and the instance's list editor
// adds, removes and reorders items of any component's list prop, writing the
// whole array as the file holds it.
//
// Method: the real picker, form, Source menu and list editor, bundled as the
// app bundles them and rendered in jsdom with React. Clicks and typing are
// dispatched as a person makes them; what each control hands back (the path a
// field binds, the declaration the host is asked to create, the array text an
// instance writes) is checked as text. The image and loop cases go first,
// through main's real page parser and page:edit in the windowless harness:
// the held declaration and the field's (or the loop's) edit are sequenced as
// the app sequences them, the file is checked byte for byte, and the step's
// inverses must put it back exactly.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');

const directory = repoPath('node_modules/.stacki-test/new-prop-list-image');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'new-prop-list-image.cjs');
buildSync({
  stdin: {
    contents: [
      "export { FieldDataPicker } from './src/features/props/BindingEditors';",
      "export { SourcePicker } from './src/features/props/LoopSourcePicker';",
      "export { default as ListField } from './src/features/props/ListField';",
      "export { newPropGesture } from './src/app/model/newPropGesture';",
      "export { nodeGesture, propsGesture, sequence, frontmatterGesture } from './src/editor/editGestures';",
      "export { sendGesture } from './src/editor/pageEdits';",
      "export { planLoop } from './src/editor/loopQueryPlan';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});

// The DOM is installed after main's harness has read the file: the Astro
// compiler main loads takes a global `document` as a browser and fails.
let dom;
let React;
let act;
let createRoot;
let modules;
function installDom() {
  if (dom !== undefined) {
    return;
  }
  dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'PointerEvent']) {
    global[name] = dom.window[name];
  }
  global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
  global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  global.IS_REACT_ACT_ENVIRONMENT = true;
  global.ResizeObserver = dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  installPopupDOM(dom.window);
  React = require('react');
  ({ createRoot } = require('react-dom/client'));
  ({ act } = React);
  modules = require(output);
}
const { parsePageDiskRead, parsePageEditResult } = require('#dist/shared/ipc/pageSave.js');

const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const choose = (select, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLSelectElement.prototype, 'value').set;
    setter.call(select, value);
    select.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
const byText = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
const keys = () => [...document.querySelectorAll('.dp-row .dp-key')].map((row) => row.textContent);

async function render(element) {
  const container = document.getElementById('root');
  const root = createRoot(container);
  await act(async () => root.render(element));
  return root;
}

// A host as App.tsx builds one, recording what it is asked to create.
function recordingHost(extra = {}) {
  const asked = [];
  return {
    asked,
    host: {
      componentName: 'Card.astro',
      propKeys: ['title', 'photo', 'hero'],
      restLocal: undefined,
      imageProps: new Map([
        ['photo', 'asset'],
        ['hero', 'url'],
      ]),
      create: (declaration) => {
        asked.push(declaration);
        return { ok: true, value: declaration.key };
      },
      ...extra,
    },
  };
}

const PROPS_SCHEMA = [
  { name: 'title', type: 'string' },
  { name: 'photo', type: 'other' },
  { name: 'hero', type: 'string' },
];

function picker(host, seed, handlers) {
  return React.createElement(modules.FieldDataPicker, {
    pos: { left: 0, top: 0, width: 280 },
    bindContext: {
      frontmatter: 'const { title = "Hi", photo = square, hero = "/hero.png" } = Astro.props;\n',
      propsSchema: PROPS_SCHEMA,
      newProp: host,
    },
    seed,
    onClose() {},
    ...handlers,
  });
}

// ── Through main: the file as it is written ───────────────────────────────────

async function project(context, component) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-list-image-'));
  fs.mkdirSync(path.join(root, 'src/components'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src/assets'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/assets/placeholder.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.mkdirSync(path.join(root, 'user'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"dependencies":{"astro":"*"}}');
  const { mainHarness } = await import('../../helpers/mainHarness.ts');
  const harness = mainHarness(path.join(root, 'user'));
  context.after(() => {
    harness.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const file = path.join(root, 'src/components/Card.astro');
  fs.writeFileSync(file, component);
  return { harness, file };
}

async function sendAndUndo(harness, file, read, gesture) {
  const record = { outcome: { tag: 'pending', waiting: 1, applied: [] } };
  const send = async (request) => parsePageEditResult(await harness.invoke('page:edit', request));
  const outcome = await modules.sendGesture({ path: file, origin: { checksum: read.checksum, source: read.source, model: read.model }, gesture, record, send });
  assert.equal(outcome.tag, 'applied');
  const written = fs.readFileSync(file, 'utf8');
  for (const step of [...record.outcome.applied].reverse()) {
    if (step.inverse.length > 0) {
      const answer = await send({ pagePath: file, authoredChecksum: step.checksum, edit: { tag: 'revert', hunks: step.inverse } });
      assert.ok(answer.ok, 'main reverted the write');
    }
  }
  return written;
}

const BASE = {
  tooltip: '',
  defaultText: '',
  options: [],
  number: { min: undefined, max: undefined, decimals: undefined },
  switch: { onLabel: 'On', offLabel: 'Off' },
  attributes: [],
  tag: '',
};

test('an image prop and its <img> binding are one step: the imports, the type and src={image.src}', async (context) => {
  const component =
    '---\ninterface Props {\n  title?: string;\n}\nconst { title = "Hi" } = Astro.props;\n---\n<figure><img src="/images/old.png" alt={title} /></figure>\n';
  const { harness, file } = await project(context, component);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  assert.ok(read.editable);
  const made = modules.newPropGesture(read.model, {
    ...BASE,
    key: 'image',
    kind: 'image',
    list: { fields: [], items: [] },
    image: '../assets/placeholder.svg',
  });
  assert.ok(made.ok, made.error);
  const img = read.model.nodes[0].children.find((node) => node.name === 'img');
  const bind = modules.propsGesture(img.id, { src: { type: 'expr', value: `${made.value.local}.src` } }, { coalesceKey: undefined, urgency: true });
  const written = await sendAndUndo(harness, file, read, modules.sequence(made.value.gesture, bind));
  // The printer spells a type-only named import inline; TypeScript reads both spellings alike.
  assert.match(
    written,
    /^---\nimport (type \{ ImageMetadata \}|\{ type ImageMetadata \}) from "astro";\nimport placeholder from "\.\.\/assets\/placeholder\.svg";\n/,
  );
  assert.ok(written.includes('  title?: string;\n  image?: ImageMetadata;\n}\nconst { title = "Hi", image = placeholder } = Astro.props;\n'), written);
  assert.ok(written.includes('<img src={image.src} alt={title} />'), written);
  assert.equal(fs.readFileSync(file, 'utf8'), component, 'one undo takes back the prop, its imports and the binding');
});

test('a List property made from a loop’s Source is declared and looped over in one step', async (context) => {
  const component = '---\nconst { heading = "Values" } = Astro.props;\n---\n<ul>{[].map((item) => (<li>{item}</li>))}</ul>\n';
  const { harness, file } = await project(context, component);
  const read = parsePageDiskRead(await harness.invoke('page:read', file));
  installDom();
  assert.ok(read.editable);
  const list = {
    fields: [
      { name: 'title', kind: 'text' },
      { name: 'text', kind: 'text' },
    ],
    items: [{ title: 'Commit', text: 'to a genuine relationship' }],
  };
  // As appLoopEdits.ts does it: declare, plan the loop against the declared frontmatter, send both.
  const made = modules.newPropGesture(read.model, { ...BASE, key: 'items', kind: 'list', list, image: '' });
  assert.ok(made.ok, made.error);
  const model = made.value.gesture.apply(read.model);
  const loop = model.nodes[0].children.find((node) => node.kind === 'map');
  assert.ok(loop, 'the loop is on the page');
  const planned = modules.planLoop({ model, loop, target: { kind: 'value', data: made.value.local }, sanityClient: 'unavailable', restore: undefined });
  assert.ok(planned.ok, planned.message);
  const options = { coalesceKey: undefined, urgency: true };
  let gesture = modules.sequence(made.value.gesture, modules.nodeGesture(loop.id, planned.plan.loop, options));
  if (planned.plan.extraFrontmatter !== model.extraFrontmatter) {
    gesture = modules.sequence(
      gesture,
      modules.frontmatterGesture(model, options, (shown) => ({ ...shown, extraFrontmatter: planned.plan.extraFrontmatter })),
    );
  }
  const written = await sendAndUndo(harness, file, read, gesture);
  assert.ok(
    written.startsWith(
      '---\ninterface Props {\n  heading?: string;\n  items?: readonly { title: string; text: string }[];\n}\n' +
        'const { heading = "Values", items = [{ title: "Commit", text: "to a genuine relationship" }] } = Astro.props;\n---\n',
    ),
    written,
  );
  assert.match(written, /<ul>\{\s*items\.map\(\(item\) => \(/, 'the loop goes over the new prop');
  assert.equal(fs.readFileSync(file, 'utf8'), component, 'one undo takes back the prop and the loop’s source');
});

// ── In the panel ─────────────────────────────────────────────────────────────

test('an <img> src offers New Image property and the image props, and an imported image binds its src', async () => {
  installDom();
  const { host, asked } = recordingHost();
  const picked = [];
  const bound = [];
  const root = await render(
    picker(
      host,
      { fit: 'image', label: 'src', value: '/images/old.png', reference: 'url' },
      { onPick: (value) => picked.push(value), onBindNew: (value) => bound.push(value) },
    ),
  );
  assert.ok(byText('New Image property'), 'the menu offers an Image property');
  assert.deepEqual(keys(), ['photo', 'hero'], 'only the image props, not the text one');
  assert.equal(document.querySelectorAll('.dp-kind-icon[title="Image"]').length, 2, 'each with the image glyph');
  await click([...document.querySelectorAll('.dp-row')].find((row) => row.textContent.includes('photo')));
  assert.deepEqual(picked, ['photo.src'], 'an imported image picked for a URL reads its src');

  await click(byText('New Image property'));
  const name = document.querySelector('.new-prop-form input[aria-label="Name"]');
  assert.equal(name.value, 'image', 'an src makes an image prop');
  const fallback = document.querySelector('.new-prop-form input[aria-label="Default"]');
  assert.equal(fallback.value, '/images/old.png', 'the default starts from what the field shows');
  await type(fallback, '../assets/placeholder.svg');
  await click(byText('Create'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'image');
  assert.equal(asked[0].image, '../assets/placeholder.svg');
  assert.deepEqual(bound, ['image.src'], 'the <img> reads the new ImageMetadata prop’s URL');
  await act(async () => root.unmount());
});

test('an astro:assets <Image> binds the metadata itself, and a URL default binds as it is', async () => {
  installDom();
  for (const [reference, image, expected] of [
    ['module', '../assets/placeholder.svg', 'image'],
    ['url', 'https://cdn.example.com/a.jpg', 'image'],
  ]) {
    const { host } = recordingHost();
    const bound = [];
    const root = await render(picker(host, { fit: 'image', label: 'src', value: '', reference }, { onPick() {}, onBindNew: (value) => bound.push(value) }));
    await click(byText('New Image property'));
    assert.ok(byText('Create').disabled, 'an image prop needs a default');
    assert.equal(document.querySelector('.new-prop-form .loop-bind-problem').textContent, 'Choose a default image.');
    await type(document.querySelector('.new-prop-form input[aria-label="Default"]'), image);
    await click(byText('Create'));
    assert.deepEqual(bound, [expected]);
    await act(async () => root.unmount());
  }
});

test('a text field never offers Image, and lists an imported image prop nowhere', async () => {
  installDom();
  const { host } = recordingHost();
  const root = await render(picker(host, { fit: 'text', label: 'alt', value: '' }, { onPick() {} }));
  assert.equal(byText('New Image property'), undefined);
  assert.ok(byText('New Plain Text property'));
  assert.deepEqual(keys(), ['title', 'hero'], 'a URL image is words too; an imported one is not');
  await act(async () => root.unmount());
});

test('a child component’s list field offers New List property with its item fields', async () => {
  installDom();
  const { host, asked } = recordingHost();
  const bound = [];
  const seed = {
    fit: 'list',
    label: 'items',
    value: '[{ title: "Commit", text: "to Jesus" }]',
    itemFields: [
      { name: 'title', kind: 'text' },
      { name: 'text', kind: 'text' },
    ],
  };
  const root = await render(picker(host, seed, { onPick() {}, onBindNew: (value) => bound.push(value) }));
  await click(byText('New List property'));
  const names = [...document.querySelectorAll('.new-prop-form input[aria-label="Field name"]')].map((input) => input.value);
  assert.deepEqual(names, ['title', 'text'], 'the form starts from the field’s items');
  assert.deepEqual(
    [...document.querySelectorAll('.new-prop-form .list-field-row')].map((row) => row.textContent.trim()),
    ['Commit'],
    'and its items, as the instance editor shows them',
  );
  await click(byText('Create'));
  assert.deepEqual(asked[0].list, { fields: seed.itemFields, items: [{ title: 'Commit', text: 'to Jesus' }] });
  assert.deepEqual(bound, ['items']);
  await act(async () => root.unmount());
});

test('the Source menu makes a List property with the item fields the designer defines', async () => {
  installDom();
  const { host, asked } = recordingHost();
  const anchor = document.createElement('div');
  document.body.append(anchor);
  const root = await render(
    React.createElement(modules.SourcePicker, {
      label: 'None',
      icon: undefined,
      current: undefined,
      catalog: undefined,
      data: undefined,
      newList: { host, seed: { fit: 'list', label: 'items', value: '' } },
      onPick() {},
    }),
  );
  await click(document.querySelector('.loop-source-trigger'));
  await click(byText('New List property'));
  assert.equal(document.querySelector('.new-prop-form input[aria-label="Name"]').value, 'items');
  const fieldNames = () => [...document.querySelectorAll('.new-prop-form input[aria-label="Field name"]')];
  assert.deepEqual(
    fieldNames().map((input) => input.value),
    ['title', 'text'],
    'a list starts with a title and a text',
  );
  await click(byText('Add field'));
  await type(fieldNames()[2], 'featured');
  await click([...document.querySelectorAll('.new-prop-form .dd-trigger[aria-label="Field type"]')][2]);
  await click([...document.querySelectorAll('.dd-option')].find((option) => option.textContent.includes('Switch')));
  await type(fieldNames()[2], 'featured!');
  assert.equal(fieldNames()[2].value, 'featured', 'a field name takes only what a name can hold');

  // A default item, through the same editor an instance uses: the popup has every field.
  await click(document.querySelector('.new-prop-form .list-field-add'));
  const popup = document.querySelector('.list-item-editor');
  assert.ok(popup, 'Add item opens the item');
  assert.deepEqual(
    [...popup.querySelectorAll('.prop-label')].map((label) => label.textContent),
    ['title', 'text', 'featured'],
  );
  await type(popup.querySelector('.props-field input'), 'Fast');
  await click([...popup.querySelectorAll('button')].find((button) => button.textContent === 'True'));
  await click(popup.querySelector('button[title="Close"]'));
  assert.deepEqual(
    [...document.querySelectorAll('.new-prop-form .list-field-row')].map((row) => row.textContent.trim()),
    ['Fast'],
  );
  await click(byText('Create'));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, 'list');
  assert.equal(asked[0].key, 'items');
  assert.deepEqual(asked[0].list, {
    fields: [
      { name: 'title', kind: 'text' },
      { name: 'text', kind: 'text' },
      { name: 'featured', kind: 'switch' },
    ],
    items: [{ title: 'Fast', text: '', featured: 'true' }],
  });
  assert.equal(document.querySelector('.new-prop-form') ?? undefined, undefined, 'the menu closes once the list is made');
  await act(async () => root.unmount());
});

test('the instance list editor adds, removes and reorders items of any declared list', async () => {
  installDom();
  const writes = [];
  const itemShape = [
    { name: 'title', kind: 'text' },
    { name: 'count', kind: 'number' },
    { name: 'on', kind: 'switch' },
  ];
  const container = document.getElementById('root');
  const root = createRoot(container);
  const draw = (value, fallback) =>
    act(async () => root.render(React.createElement(modules.ListField, { value, fallback, itemShape, onChange: (text) => writes.push(text) })));

  // Unset: the component's default items stand in, and nothing is written by looking.
  await draw('', '[{ title: "Default", count: 1, on: false }]');
  assert.ok(container.querySelector('.list-field.is-fallback'));
  assert.deepEqual(
    [...container.querySelectorAll('.list-field-row')].map((row) => row.textContent.trim()),
    ['Default'],
  );
  await click(container.querySelector('.list-field-text'));
  await click(container.querySelector('.list-field-text'));
  assert.deepEqual(writes, [], 'opening and closing a default item writes nothing');

  // An empty list adds an item with every declared field.
  await draw('[]', undefined);
  await click(container.querySelector('.list-field-add'));
  const popup = document.querySelector('.list-item-editor');
  await type(popup.querySelector('.props-field input'), 'One');
  await type(popup.querySelector('.num-field input'), '-');
  assert.equal(popup.querySelector('.num-field input').value, '-', 'a half-typed number stays on screen');
  await type(popup.querySelector('.num-field input'), '-2');
  await click(container.querySelector('.list-field-add'));
  assert.deepEqual(writes, ['[{ title: "One", count: -2, on: false }]'], 'a half-typed number is never written');

  await draw('[{ title: "One", count: 1, on: true }, { title: "Two", count: 2, on: false }, { title: "Three", count: 3, on: false }]', undefined);
  await click(container.querySelector('button[aria-label="Remove Two"]'));
  assert.equal(writes.at(-1), '[{ title: "One", count: 1, on: true }, { title: "Three", count: 3, on: false }]');

  // Drag the first row into the gap after the last.
  const rows = [...container.querySelectorAll('.list-field-row')];
  dom.window.Element.prototype.getBoundingClientRect = function () {
    const list = [...(this.parentElement?.querySelectorAll('.list-field-row') ?? [])];
    const top = Math.max(0, list.indexOf(this)) * 30;
    return { x: 0, y: top, width: 200, height: 30, top, left: 0, right: 200, bottom: top + 30 };
  };
  const drag = (element, kind, clientY) =>
    act(async () => {
      const event = new dom.window.Event(kind, { bubbles: true, cancelable: true });
      Object.assign(event, { clientY, dataTransfer: { setData() {}, effectAllowed: 'move', dropEffect: 'move' } });
      element.dispatchEvent(event);
    });
  await drag(rows[0], 'dragstart', 5);
  await drag(rows[2], 'dragover', 85);
  await drag(rows[2], 'drop', 85);
  assert.equal(writes.at(-1), '[{ title: "Two", count: 2, on: false }, { title: "Three", count: 3, on: false }, { title: "One", count: 1, on: true }]');
  await act(async () => root.unmount());
});
