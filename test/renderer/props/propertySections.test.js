// Goal: the two places a component prop is made or edited — the Settings
// panel's "Property settings" pop-up (NewPropForm) and the Properties panel's
// property editor (PropertyEditor) — offer the same options through the same
// sections (PropertySections.tsx): Required, Readonly, Code type, a List's item
// fields, and its default items in the instance's own list field with the
// `{}` toggle between the list and its code. A List made in either place with
// the same fields, Required off and Readonly on is written the same, an
// existing List reads every option back, and code the list cannot show stays
// code instead of being dropped.
//
// Method: both hosts rendered in jsdom with React from the app's own bundle.
// The controls each draws are read by their accessible names. A List is made
// in each: the pop-up's declaration goes through declaredProp, the editor's
// change through main's property writer (editPropertyDefinition), and the
// member and default each writes are compared. CodeMirror is real, so code is
// typed through its own transactions (EditorView.findFromDOM).

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { installPopupDOM } = require('../../helpers/popupDom.js');
const { editPropertyDefinition, readComponentProperties } = require('#dist/electron/properties/propertyDefinitions.js');

const directory = repoPath('node_modules/.stacki-test/property-sections');
fs.mkdirSync(directory, { recursive: true });
const output = path.join(directory, 'property-sections.cjs');
buildSync({
  stdin: {
    contents: [
      "export { default as NewPropForm } from './src/features/props/NewPropForm';",
      "export { PropertyEditor } from './src/features/componentProperties/PropertyEditor';",
      "export { declaredProp } from './src/editor/propDeclaration';",
      "export { listFieldsOfType, listTypeText } from './src/editor/listPropType';",
      "export { EditorView } from '@codemirror/view';",
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

const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window', 'KeyboardEvent', 'MouseEvent', 'navigator']) {
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
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
installPopupDOM(dom.window);
const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const modules = require(output);

const ITEMS = '[{ title: "One", text: "Two" }]';
const LIST_TYPE = 'readonly { title: string; text: string }[]';
const SOURCE = `---
interface Props {
  heading?: string;
}
const { heading = "Plans" } = Astro.props;
---
<h2>{heading}</h2>
`;

const click = (element) => act(async () => element.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
const type = (input, value) =>
  act(async () => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
const byText = (text) => [...document.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
// The options a host offers, by the names a person reads them by.
function controls() {
  const has = (selector) => document.querySelector(selector) !== null;
  return {
    required: has('input[aria-label="Required"]'),
    readonly: has('input[aria-label="Readonly"]'),
    codeType: has('.property-code-toggle'),
    tooltip: has('textarea[aria-label="Tooltip"]') || [...document.querySelectorAll('label')].some((label) => label.textContent.trim().startsWith('Tooltip')),
    itemFields: has('[aria-label="Item fields"]'),
    defaultItems: has('[aria-label="Default items"]'),
    defaultToggle: has('[aria-label="Default items"] .prop-expr-toggle'),
  };
}
const rows = () => [...document.querySelectorAll('[aria-label="Default items"] .list-field-items > *')].map((row) => row.textContent.trim());
const fieldRows = () =>
  [...document.querySelectorAll('[aria-label="Item fields"] .new-prop-list-field')].map((row) => [
    row.querySelector('input[aria-label="Field name"]').value,
    row.querySelector('.dd-trigger[aria-label="Field type"] .dd-label').textContent.toLowerCase(),
  ]);
const codeView = () => {
  const element = document.querySelector('[aria-label="Default items"] .cm-editor');
  return element === null ? undefined : modules.EditorView.findFromDOM(element);
};
async function typeCode(text) {
  const view = codeView();
  assert.ok(view, 'the code view is open');
  await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }));
}

let root;
async function draw(element) {
  if (root === undefined) {
    root = createRoot(document.getElementById('root'));
  }
  await act(async () => root.render(element));
}
async function clear() {
  if (root !== undefined) {
    await act(async () => root.unmount());
    root = undefined;
  }
}

// The Settings panel's pop-up for a new List, as a loop's source opens it.
async function drawPopup(seed, onCreate) {
  const host = {
    componentName: 'Pricing.astro',
    propKeys: ['heading'],
    restLocal: undefined,
    create: (declaration) => {
      onCreate(declaration);
      return { ok: true, value: declaration.key };
    },
  };
  await draw(React.createElement(modules.NewPropForm, { host, seed, onCreated() {}, onCancel() {} }));
}

// The Properties panel's editor over one property.
async function drawEditor(property, onSave) {
  await draw(
    React.createElement(modules.PropertyEditor, {
      property,
      originalName: property.name === '' ? '' : property.name,
      frontmatter: 'interface Props {\n  heading?: string;\n}\nconst { heading = "Plans" } = Astro.props;\n',
      access: 'editable',
      onClose() {},
      onSave: async (change) => onSave(change),
      saveHost: {
        save: async (change) => {
          onSave(change);
          return { kind: 'saved', source: '' };
        },
        reload: async () => ({ ok: false, error: 'not in this test' }),
      },
    }),
  );
}
const listProperty = (fields) => ({ name: 'features', type: LIST_TYPE, required: false, readonly: false, defaultValue: ITEMS, description: '', ...fields });

// The field a host draws its Code type in, opened.
async function openCodeType() {
  await click(document.querySelector('.property-code-toggle'));
  const field = document.querySelector('.property-code');
  assert.ok(field, 'the Code type field is open');
  return field;
}

test('the Code type is highlighted TypeScript in both hosts, and editing it writes the same type', async () => {
  // With commas, as the pop-up refuses a semicolon in a code type.
  const typed = 'readonly { title: string, note?: string }[]';
  const member = `  features?: ${typed};`;
  const assertHighlighted = (field, host) => {
    assert.ok(field.matches('.expr-input'), `${host}: it is the code field a default uses`);
    assert.ok(!document.querySelector('input[aria-label="Code type"]'), `${host}: not a plain input`);
    assert.ok(field.querySelector('.cm-content[aria-label="Code type"]'), `${host}: it keeps its accessible name`);
    assert.ok(field.querySelector('.cm-line span[class]'), `${host}: its tokens are marked`);
  };
  const typeType = async (field) => {
    const view = modules.EditorView.findFromDOM(field.querySelector('.cm-editor'));
    await act(async () => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: typed } }));
  };

  // The Properties panel: the change it sends is the type typed, written as ever.
  let change;
  await drawEditor(listProperty({}), (made) => {
    change = made;
  });
  // A List keeps its disclosure shut, so the toggle opens it.
  const panelField = await openCodeType();
  assertHighlighted(panelField, 'the Properties panel');
  assert.equal(panelField.querySelector('.cm-content').textContent, LIST_TYPE);
  await typeType(panelField);
  await click(document.querySelector('[aria-label="Close property settings"]'));
  assert.equal(change.property.type, typed);
  const declaredList = SOURCE.replace('heading?: string;', `heading?: string;\n  features?: ${LIST_TYPE};`);
  const written = editPropertyDefinition(declaredList, change);
  assert.ok(written.ok, JSON.stringify(written));
  assert.ok(written.value.includes(member), written.value);
  await clear();

  // The pop-up: the same field, and the declaration carries what was typed.
  let declaration;
  await drawPopup({ fit: 'list', label: 'features', value: ITEMS }, (made) => {
    declaration = made;
  });
  const popupField = await openCodeType();
  await typeType(popupField);
  assertHighlighted(popupField, 'the pop-up');
  await click(byText('Create'));
  assert.equal(declaration.typing.codeType, typed);
  const declared = modules.declaredProp(SOURCE.split('---')[1], declaration, new Set(['heading']));
  assert.ok(declared.ok, JSON.stringify(declared));
  assert.ok(declared.value.frontmatter.includes(member), declared.value.frontmatter);
  await clear();
});

test('both hosts offer the same options for a List and for a Text', async () => {
  const everything = { required: true, readonly: true, codeType: true, tooltip: true, itemFields: true, defaultItems: true, defaultToggle: true };
  await drawPopup({ fit: 'list', label: 'features', value: ITEMS }, () => {});
  assert.deepEqual(controls(), everything, 'the pop-up, for a List');
  await clear();
  await drawEditor(listProperty({}), () => {});
  assert.deepEqual(controls(), everything, 'the Properties panel, for a List');
  await clear();
  const scalar = { required: true, readonly: true, codeType: true, tooltip: true, itemFields: false, defaultItems: false, defaultToggle: false };
  await drawPopup({ fit: 'text', label: 'caption', value: 'Hi' }, () => {});
  assert.deepEqual(controls(), scalar, 'the pop-up, for a Text');
  await clear();
  await drawEditor({ name: 'caption', type: 'string', required: false, readonly: false, defaultValue: '"Hi"', description: '' }, () => {});
  assert.deepEqual(controls(), scalar, 'the Properties panel, for a Text');
  await clear();
});

test('a List with item fields, Required off and Readonly on is written the same from either host', async () => {
  // The pop-up: the fields it starts with, Readonly ticked, then Create.
  let declaration;
  await drawPopup({ fit: 'list', label: 'features', value: ITEMS }, (made) => {
    declaration = made;
  });
  assert.deepEqual(fieldRows(), [
    ['title', 'text'],
    ['text', 'text'],
  ]);
  assert.deepEqual(rows(), ['One'], 'the default items show as rows');
  await click(document.querySelector('input[aria-label="Readonly"]'));
  await click(byText('Create'));
  assert.ok(declaration, 'Create declared the prop');
  const frontmatter = 'interface Props {\n  heading?: string;\n}\nconst { heading = "Plans" } = Astro.props;\n';
  const popup = modules.declaredProp(frontmatter, declaration, new Set(['heading']));
  assert.ok(popup.ok, JSON.stringify(popup));
  await clear();

  // The Properties panel: the same List, Readonly ticked, then Save.
  let change;
  await drawEditor(listProperty({ name: '' }), (made) => {
    change = made;
  });
  await type(document.querySelector('.property-editor label input'), 'features');
  await click(document.querySelector('input[aria-label="Readonly"]'));
  await click(byText('Save property'));
  assert.ok(change, 'Save sent the change');
  const written = editPropertyDefinition(SOURCE, change);
  assert.ok(written.ok, JSON.stringify(written));
  await clear();

  const member = '  readonly features?: readonly { title: string; text: string }[];';
  assert.ok(popup.value.frontmatter.includes(member), popup.value.frontmatter);
  assert.ok(written.value.includes(member), written.value);
  assert.match(popup.value.frontmatter, /features = \[\{ title: "One", text: "Two" \}\]/);
  assert.match(written.value, /features = \[\{ title: "One", text: "Two" \}\]/);
  // What main reads back is the same property from either file.
  const fromPopup = readComponentProperties(`---\n${popup.value.frontmatter}---\n<h2>{heading}</h2>\n`).properties.find((entry) => entry.name === 'features');
  const fromEditor = readComponentProperties(written.value).properties.find((entry) => entry.name === 'features');
  assert.deepEqual(
    { type: fromPopup.type, required: fromPopup.required, readonly: fromPopup.readonly, defaultValue: fromPopup.defaultValue },
    { type: fromEditor.type, required: fromEditor.required, readonly: fromEditor.readonly, defaultValue: fromEditor.defaultValue },
  );
  assert.deepEqual(modules.listFieldsOfType(fromEditor.type, ''), [
    { name: 'title', kind: 'text' },
    { name: 'text', kind: 'text' },
  ]);
});

test('an existing List reads every option back in the Properties panel', async () => {
  const type = 'readonly { title: string; price: number; featured: boolean; photo: string }[]';
  await drawEditor(
    listProperty({
      type,
      required: true,
      readonly: true,
      defaultValue: '[{ title: "Pro", price: 9, featured: true, photo: "/pro.png" }]',
      description: 'The plan’s features',
    }),
    () => {},
  );
  assert.deepEqual(fieldRows(), [
    ['title', 'text'],
    ['price', 'number'],
    ['featured', 'switch'],
    ['photo', 'image'],
  ]);
  assert.equal(document.querySelector('input[aria-label="Required"]').checked, true);
  assert.equal(document.querySelector('input[aria-label="Readonly"]').checked, true);
  assert.deepEqual(rows(), ['Pro']);
  assert.match(document.querySelector('.property-editor textarea').value, /The plan’s features/);
  // A named item type is read through the frontmatter that declares it.
  assert.deepEqual(modules.listFieldsOfType('readonly Plan[]', 'interface Plan {\n  title: string;\n  url: string;\n}\n'), [
    { name: 'title', kind: 'text' },
    { name: 'url', kind: 'link' },
  ]);
  assert.equal(modules.listFieldsOfType('readonly string[]', ''), undefined, 'words are not items of fields');
  assert.equal(modules.listFieldsOfType('readonly { run(): void }[]', ''), undefined, 'a method is not a field');
  assert.equal(modules.listFieldsOfType('(A | B)[]', ''), undefined);
  await clear();
});

test('the default’s {} toggle: both views edit one value, and code the list cannot show stays code', async () => {
  for (const host of ['popup', 'editor']) {
    let saved = '';
    let declaration;
    if (host === 'popup') {
      await drawPopup({ fit: 'list', label: 'features', value: ITEMS }, (made) => {
        declaration = made;
      });
    } else {
      await drawEditor(listProperty({}), (change) => {
        saved = change.property.defaultValue;
      });
    }
    const toggle = () => document.querySelector('[aria-label="Default items"] .prop-expr-toggle');
    assert.ok(toggle(), `${host}: the toggle is on the default`);
    await click(toggle());
    assert.equal(codeView()?.state.doc.toString(), ITEMS, `${host}: the code view shows the same items`);
    await typeCode('[{ title: "Basic", text: "Free" }, { title: "Pro", text: "Paid" }]');
    await click(toggle());
    assert.equal(codeView(), undefined, `${host}: back to the list`);
    assert.deepEqual(rows(), ['Basic', 'Pro'], `${host}: the list shows what the code said`);

    // Code the list cannot hold: the toggle keeps it, and says why.
    await click(toggle());
    await typeCode('[...extraPlans, { title: "Pro", text: "Paid" }]');
    await click(toggle());
    assert.ok(codeView(), `${host}: the code view stays`);
    assert.equal(codeView().state.doc.toString(), '[...extraPlans, { title: "Pro", text: "Paid" }]', `${host}: the code is kept`);
    assert.match(document.querySelector('[aria-label="Default items"] .prop-field-note.problem').textContent, /stays as code/);

    if (host === 'popup') {
      await type(document.querySelector('.new-prop-form input[aria-label="Name"]'), 'features');
      await click(byText('Create'));
      const made = modules.declaredProp('', declaration, new Set());
      assert.ok(made.ok, JSON.stringify(made));
      assert.match(made.value.frontmatter, /features = \[\.\.\.extraPlans, \{ title: "Pro", text: "Paid" \}\]/, 'the pop-up writes the code as typed');
    } else {
      await click(document.querySelector('[aria-label="Close property settings"]'));
      assert.equal(saved, '[...extraPlans, { title: "Pro", text: "Paid" }]', 'the editor saves the code as typed');
    }
    await clear();
  }
});
