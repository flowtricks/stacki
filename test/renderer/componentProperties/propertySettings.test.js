// Goal: the Properties panel edits what the bind dot's new-prop form writes,
// and writes nothing it was not asked to. A Number's Min, Max and Decimals and
// a Switch's On and Off labels are JSDoc tags on the member's comment; the
// tooltip is the comment's words without them; the Kind picker writes the
// native type for each kind; the attributes prop (`...rest`) shows as a row
// with its tooltip, defaults and connected elements.
//
// Method: the pure helpers (settingTags.ts, propertyKinds.ts,
// attributesProperty.ts) are checked directly, valid and invalid input
// alike. Then the real panel is mounted in jsdom with main's real reader and
// writer (`readComponentProperties`, `editPropertyDefinition`) behind a stub
// bridge, driven through its controls, and the bytes written are compared
// with the source: every save must change only the line it was asked to.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');

const JSDOC_SOURCE = `---
interface Props {
  /** The text on the button. */
  label?: string;
  /**
   * How many columns the grid uses.
   * @default 3
   * @min 1
   * @max 6
   * @decimals 0
   */
  columns?: number;
  /**
   * Whether the panel starts open.
   * @onLabel Shown
   * @offLabel Hidden
   */
  open?: boolean;
  caption?: string;
}
const { label = 'Go', columns = 3, open = true, caption } = Astro.props;
---
<p>{label} {columns} {open} {caption}</p>
`;

const ATTRIBUTES_SOURCE = `---
import type { HTMLAttributes } from 'astro/types';
/** @attributes Extra link attributes */
interface Props extends HTMLAttributes<'a'> {
  label?: string;
}
const { label = 'Link', ...rest } = Astro.props;
---
<a href="/x" {...rest}>{label}</a><div {...rest} />
`;

async function bundle() {
  const directory = repoPath('node_modules/.stacki-test/properties');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, 'settings.js');
  await esbuild.build({
    stdin: {
      contents: `export {default as Panel} from './src/features/componentProperties/ComponentPropertiesPanel';
       export * from './src/features/componentProperties/settingTags';
       export * from './src/features/componentProperties/propertyKinds';
       export * from './src/features/componentProperties/attributesProperty';`,
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile,
    inject: [repoPath('test/helpers/toastCaptureEntry.js')],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  return outfile;
}

let modules;
test.before(async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  require('../../helpers/popupDom').installPopupDOM(dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'Window', 'DOMRect']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  window.HTMLElement.prototype.scrollIntoView = () => {};
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect();
  window.Range.prototype.getClientRects = () => [];
  modules = require(await bundle());
});

test('setting tags: the tooltip and each tag read and write apart', () => {
  const { tooltipOf, withTooltip, tagValue, withTag, numberSettingProblem, switchLabelTag } = modules;
  const description = 'How many columns.\n@default 3\n@min 1\n@max 6';
  assert.equal(tooltipOf(description), 'How many columns.\n@default 3');
  assert.equal(withTooltip(description, 'How many columns.\n@default 3'), description);
  assert.equal(withTooltip(description, 'Columns'), 'Columns\n@min 1\n@max 6');
  assert.equal(withTooltip(description, ''), '@min 1\n@max 6');
  assert.equal(tooltipOf(withTooltip(description, 'Typing\n')), 'Typing\n');
  assert.equal(withTooltip('Plain', 'Other'), 'Other');
  assert.equal(tagValue(description, 'max'), '6');
  assert.equal(tagValue(description, 'decimals'), undefined);
  assert.equal(withTag(description, 'max', '8'), description.replace('@max 6', '@max 8'));
  assert.equal(withTag(description, 'max', undefined), 'How many columns.\n@default 3\n@min 1');
  assert.equal(withTag(description, 'decimals', '0'), `${description}\n@decimals 0`);
  assert.equal(withTag('', 'format', 'uri'), '@format uri');
  assert.equal(withTag('@format uri', 'format', undefined), '');
  assert.equal(withTag(description, 'max', '  '), 'How many columns.\n@default 3\n@min 1');
  assert.equal(numberSettingProblem({ min: 5, max: 1, decimals: undefined }), 'The minimum is above the maximum.');
  assert.equal(numberSettingProblem({ min: undefined, max: undefined, decimals: 1.5 }), 'Decimals is a whole number.');
  assert.match(numberSettingProblem({ min: undefined, max: undefined, decimals: 11 }), /between 0 and 10/);
  assert.equal(numberSettingProblem({ min: 0, max: 0, decimals: 0 }), undefined);
  assert.equal(switchLabelTag(' On ', 'onLabel'), undefined);
  assert.equal(switchLabelTag('Shown', 'onLabel'), 'Shown');
  assert.equal(switchLabelTag('Off', 'offLabel'), undefined);
  assert.equal(switchLabelTag('x'.repeat(60), 'offLabel').length, 40);
  assert.throws(() => tooltipOf('x'.repeat(40000)), /description is bounded/);
});

test('kinds: each kind reads from and writes its native type', () => {
  const { propertyKind, withKind, kindType, carriedDefault, UNION_TYPE } = modules;
  const kindOf = (type, description = '') => propertyKind({ type, description });
  assert.equal(kindOf('string'), 'text');
  assert.equal(kindOf('string', 'A link.\n@format uri'), 'link');
  assert.equal(kindOf('string', '@format color'), 'color');
  assert.equal(kindOf('number'), 'number');
  assert.equal(kindOf('boolean'), 'switch');
  assert.equal(kindOf("'a' | 'b'"), 'choice');
  assert.equal(kindOf('ImageMetadata | string'), 'image');
  assert.equal(kindOf('Date'), 'date');
  assert.equal(kindOf('readonly string[]'), 'list');
  assert.equal(kindOf('Array<{ label: string }>'), 'list');
  assert.equal(kindOf('{ label: string; href: string }'), 'group');
  assert.equal(kindOf('Record<string, string>'), 'record');
  assert.equal(kindOf('readonly [string, number]'), 'code');
  assert.equal(kindOf('typeof theme'), 'code');
  assert.equal(kindOf('unknown'), 'code');
  assert.deepEqual(withKind({ type: 'string', description: 'Where.' }, 'link', ''), { type: 'string', description: 'Where.\n@format uri' });
  assert.deepEqual(withKind({ type: 'string', description: 'Where.\n@format uri' }, 'text', ''), { type: 'string', description: 'Where.' });
  assert.deepEqual(withKind({ type: 'string', description: '' }, 'number', ''), { type: 'number', description: '' });
  // A kind it already is keeps its type: a Choice keeps its options.
  assert.equal(withKind({ type: "'a' | 'b'", description: '' }, 'choice', '').type, "'a' | 'b'");
  assert.equal(withKind({ type: 'string', description: '' }, 'choice', '').type, UNION_TYPE);
  assert.equal(kindType('image', ''), 'import("astro").ImageMetadata | string');
  assert.equal(kindType('image', "import type { ImageMetadata } from 'astro';"), 'ImageMetadata | string');
  // A List is items of fields, typed as the Settings panel's new List types one.
  assert.equal(kindType('list', ''), 'readonly { title: string; text: string }[]');
  assert.equal(kindType('record', ''), 'Record<string, string>');
  assert.equal(carriedDefault('"3"', 'number', 'number'), '3');
  assert.equal(carriedDefault('"three"', 'number', 'number'), '');
  assert.equal(carriedDefault('3', 'text', 'string'), '"3"');
  assert.equal(carriedDefault("'yes'", 'text', 'string'), "'yes'");
  assert.equal(carriedDefault('"true"', 'switch', 'boolean'), 'true');
  assert.equal(carriedDefault('maybe', 'switch', 'boolean'), '');
  assert.equal(carriedDefault("'b'", 'choice', "'a' | 'b'"), "'b'");
  assert.equal(carriedDefault('"b"', 'choice', "'a' | 'b'"), '"b"');
  assert.equal(carriedDefault('"c"', 'choice', "'a' | 'b'"), '');
  assert.equal(carriedDefault('[]', 'list', 'readonly string[]'), '[]');
  assert.equal(carriedDefault('', 'number', 'number'), '');
});

test('attributes prop: read from the rest binding and the elements that spread it', () => {
  const { readAttributesProperty, defaultsAgree, sameDefaults } = modules;
  const frontmatter = ATTRIBUTES_SOURCE.split('---')[1];
  assert.equal(readAttributesProperty('const { label } = Astro.props;', []), undefined);
  const nodes = attributeNodes();
  const read = readAttributesProperty(frontmatter, nodes);
  assert.equal(read.local, 'rest');
  assert.equal(read.tooltip, 'Extra link attributes');
  assert.deepEqual(
    read.connections.map((connection) => [connection.id, connection.label, connection.defaults]),
    [
      ['n0', 'a.cta', [{ name: 'href', value: '/x' }]],
      ['n2', 'div', []],
    ],
  );
  assert.equal(defaultsAgree(read.connections), false);
  assert.equal(defaultsAgree([]), true);
  assert.equal(sameDefaults([{ name: 'a', value: '1' }], [{ name: 'a', value: '1' }]), true);
  assert.equal(sameDefaults([{ name: 'a', value: '1' }], [{ name: 'a', value: '2' }]), false);
  assert.equal(readAttributesProperty(frontmatter, undefined).connections.length, 0);
});

// The component's page model: a link and a nested div spread `rest`; a span does not.
function attributeNodes() {
  return [
    {
      kind: 'element',
      id: 'n0',
      name: 'a',
      props: { class: { type: 'string', value: 'cta big' }, href: { type: 'string', value: '/x' }, '...rest': { type: 'spread', value: 'rest' } },
      children: [{ kind: 'element', id: 'n1', name: 'span', props: {}, children: [] }],
    },
    { kind: 'element', id: 'n2', name: 'div', props: { '...rest': { type: 'spread', value: 'rest' } }, children: [] },
  ];
}

// Mount the panel over `source` with main's real reader and writer, and the
// page host the app gives it. Returns helpers that drive it and the log.
async function mountPanel(source, host = {}) {
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  let data = readComponentProperties(source);
  const writes = [];
  window.avb = {
    onFsChanged: () => () => {},
    componentProperties: async () => ({ ok: true, value: data }),
    editComponentProperties: async (request) => {
      const result = editPropertyDefinition(request.source, request.change);
      writes.push({ change: request.change, ok: result.ok });
      if (!result.ok) {
        return result;
      }
      data = readComponentProperties(result.value);
      return { ok: true, value: { ...data, undo: '00000000-0000-4000-8000-000000000000' } };
    },
    revertComponentProperties: async () => ({ ok: true, value: { undo: '00000000-0000-4000-8000-000000000000' } }),
  };
  // A container per mount: React keeps one root per element.
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      React.createElement(modules.Panel, {
        projectPath: '/site',
        file: '/site/src/components/Card.astro',
        name: 'Card',
        flushSave: async () => {},
        onSavePhase: () => {},
        onSaved: async () => {},
        ...host,
      }),
    ),
  );
  const setValue = async (element, value) =>
    act(async () => {
      const prototype = element.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value);
      element.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  const click = async (element) => act(async () => element.click());
  const row = (name) => [...document.querySelectorAll('.property-row-main')].find((button) => button.textContent.startsWith(name));
  const saveButton = () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Save property');
  const field = (label) => document.querySelector(`.property-editor input[aria-label="${label}"]`);
  const tooltip = () =>
    [...document.querySelectorAll('.property-editor label')].find((label) => label.textContent.trim().startsWith('Tooltip')).querySelector('textarea');
  const pickKind = async (search) => {
    await click(document.querySelector('.property-type .dd-trigger'));
    await setValue(document.querySelector('.dd-search'), search);
    const option = [...document.querySelectorAll('.dd-option')].find((item) => item.querySelector('.dd-option-label').textContent.startsWith(search));
    assert.ok(option, `the Kind picker offers ${search}`);
    await click(option);
  };
  return {
    source: () => data.source,
    writes,
    setValue,
    click,
    row,
    saveButton,
    field,
    tooltip,
    pickKind,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

test('number and switch settings round-trip through the JSDoc tags, one line at a time', async () => {
  const panel = await mountPanel(JSDOC_SOURCE);
  // An unchanged save writes the same bytes.
  await panel.click(panel.row('label'));
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), JSDOC_SOURCE);
  // A Number shows its settings; the tooltip leaves the setting tags out.
  await panel.click(panel.row('columns'));
  assert.equal(panel.field('Min').value, '1');
  assert.equal(panel.field('Max').value, '6');
  assert.equal(panel.field('Decimals').value, '0');
  assert.equal(panel.tooltip().value, 'How many columns the grid uses.\n@default 3');
  // A half-typed or contradictory setting is shown and not written.
  await panel.setValue(panel.field('Max'), '-');
  assert.match(document.querySelector('.property-settings-problem').textContent, /Enter a number/);
  await panel.setValue(panel.field('Max'), '0');
  assert.match(document.querySelector('.property-settings-problem').textContent, /minimum is above the maximum/);
  await panel.setValue(panel.field('Max'), '8');
  assert.ok(document.querySelector('.property-settings-problem') === null);
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), JSDOC_SOURCE.replace('   * @max 6\n', '   * @max 8\n'));
  // Clearing a setting takes its line out; a default outside the range is flagged.
  const afterMax = panel.source();
  await panel.click(panel.row('columns'));
  await panel.setValue(panel.field('Decimals'), '');
  await panel.setValue(panel.field('Min'), '4');
  assert.match(document.querySelector('.property-default-note').textContent, /least this takes is 4/);
  await panel.setValue(panel.field('Min'), '1');
  assert.ok(document.querySelector('.property-default-note') === null);
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), afterMax.replace('   * @decimals 0\n', ''));
  // A Switch's labels: the default word removes its tag.
  const beforeSwitch = panel.source();
  await panel.click(panel.row('open'));
  assert.equal(panel.field('On label').value, 'Shown');
  assert.equal(panel.field('Off label').value, 'Hidden');
  await panel.setValue(panel.field('On label'), 'On');
  await panel.setValue(panel.field('Off label'), 'Closed');
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), beforeSwitch.replace('   * @onLabel Shown\n', '').replace('@offLabel Hidden', '@offLabel Closed'));
  // Editing the tooltip keeps the setting tags after it.
  const beforeTooltip = panel.source();
  await panel.click(panel.row('open'));
  await panel.setValue(panel.tooltip(), 'Whether it starts open.');
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), beforeTooltip.replace('Whether the panel starts open.', 'Whether it starts open.'));
  // A Text prop has no kind settings.
  await panel.click(panel.row('caption'));
  assert.ok(document.querySelector('.property-settings') === null);
  await panel.unmount();
});

test('the Kind picker writes the native type, and the format tag for Link', async () => {
  const panel = await mountPanel(JSDOC_SOURCE);
  // Text to Number: the type changes and a default that is not a number is cleared.
  await panel.click(panel.row('label'));
  assert.match(document.querySelector('.property-type .dd-trigger').textContent, /Text/);
  await panel.pickKind('Number');
  assert.match(document.querySelector('.property-type').textContent, /default was cleared/);
  assert.ok(panel.field('Min'), 'a Number shows its settings at once');
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), JSDOC_SOURCE.replace('label?: string;', 'label?: number;').replace("label = 'Go', ", 'label, '));
  const cases = [
    ['Link', 'caption?: string;', /\/\*\* @format uri \*\/\n {2}caption\?: string;/],
    ['Image', 'caption?: string;', /caption\?: import\("astro"\)\.ImageMetadata \| string;/],
    ['List', 'caption?: string;', /caption\?: readonly \{ title: string; text: string \}\[\];/],
    ['Key–value', 'caption?: string;', /caption\?: Record<string, string>;/],
    ['Choice', 'caption?: string;', /caption\?: "Option 1" \| "Option 2";/],
    ['Date', 'caption?: string;', /caption\?: Date;/],
  ];
  for (const [kind, unchanged, written] of cases) {
    const before = panel.source();
    assert.ok(before.includes(unchanged), `${kind}: caption starts as text`);
    await panel.click(panel.row('caption'));
    await panel.pickKind(kind);
    await panel.click(panel.saveButton());
    assert.match(panel.source(), written, `${kind} writes its type`);
    // Back to Text for the next case, through the Code type field.
    await panel.click(panel.row('caption'));
    if (!document.querySelector('input[aria-label="Code type"]')) {
      await panel.click(document.querySelector('.property-code-toggle'));
    }
    await panel.setValue(document.querySelector('input[aria-label="Code type"]'), 'string');
    await panel.pickKind('Text');
    await panel.click(panel.saveButton());
    assert.equal(panel.source(), before, `${kind}: back to Text restores the bytes`);
  }
  // Attributes is made from an element, not here: picking it changes nothing.
  await panel.click(panel.row('caption'));
  await panel.pickKind('Attributes');
  assert.match(document.querySelector('.property-type').textContent, /made from an element/);
  await panel.unmount();
});

test('the attributes prop is a row with its tooltip, defaults and connections', async () => {
  const selected = [];
  const replaced = [];
  const panel = await mountPanel(ATTRIBUTES_SOURCE, {
    nodes: attributeNodes(),
    onSelectNode: (id) => selected.push(id),
    onReplaceProps: (id, props) => replaced.push({ id, props }),
  });
  const attributesRow = document.querySelector('.property-attributes-row .property-row-main');
  assert.match(attributesRow.textContent, /^rest/);
  assert.match(attributesRow.textContent, /Attributes · 2 elements/);
  assert.equal(attributesRow.title, 'Extra link attributes');
  assert.equal(document.querySelectorAll('.property-list .property-row').length, 1, 'the rest binding is not a declared prop row');
  await panel.click(attributesRow);
  const editor = document.querySelector('.property-attributes-editor');
  assert.match(editor.textContent, /Connections: 2 elements/);
  assert.match(editor.textContent, /different defaults/);
  assert.equal(editor.querySelector('textarea[aria-label="Tooltip"]').value, 'Extra link attributes');
  assert.equal(editor.querySelector('input[aria-label="Default attribute 1 name"]').value, 'href');
  assert.equal(editor.querySelector('input[aria-label="Default attribute 1 value"]').value, '/x');
  // A connection selects its element.
  const connections = [...editor.querySelectorAll('.property-connection')];
  assert.deepEqual(
    connections.map((button) => button.textContent),
    ['a.cta', 'div'],
  );
  await panel.click(connections[1]);
  assert.deepEqual(selected, ['n2']);
  // A nameless default is refused with the reason.
  await panel.click(editor.querySelector('[aria-label="Add default attribute"]'));
  await panel.setValue(editor.querySelector('input[aria-label="Default attribute 2 value"]'), 'x');
  await panel.click(panel.saveButton());
  assert.match(toastMessages(), /needs a name/);
  assert.equal(replaced.length, 0);
  // Saving writes the tooltip as a frontmatter edit and the defaults through the page editor.
  await panel.setValue(editor.querySelector('input[aria-label="Default attribute 2 name"]'), 'target');
  await panel.setValue(editor.querySelector('textarea[aria-label="Tooltip"]'), 'Attributes for the link');
  await panel.click(panel.saveButton());
  assert.equal(panel.source(), ATTRIBUTES_SOURCE.replace('@attributes Extra link attributes', '@attributes Attributes for the link'));
  assert.deepEqual(
    replaced.map((entry) => [entry.id, Object.keys(entry.props)]),
    [
      ['n0', ['href', 'target', '...rest', 'class']],
      ['n2', ['href', 'target', '...rest']],
    ],
  );
  assert.ok(document.querySelector('.property-attributes-editor') === null);
  await panel.unmount();
  // Without the page host the defaults are shown, read-only, and connections cannot select.
  const bare = await mountPanel(ATTRIBUTES_SOURCE, { nodes: attributeNodes() });
  await bare.click(document.querySelector('.property-attributes-row .property-row-main'));
  assert.equal(document.querySelector('input[aria-label="Default attribute 1 name"]').readOnly, true);
  assert.ok(document.querySelector('[aria-label="Add default attribute"]') === null);
  assert.equal(document.querySelector('.property-connection').disabled, true);
  await bare.unmount();
});
