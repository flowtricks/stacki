// Goal: the instance Settings panel says what a component asks of each prop
// (docs/plans/prop-controls.md §7.1): a required prop carries a marker and,
// while the instance leaves it out, a note; an unset prop shows the
// component's default dimmed and writes nothing; a set prop is "overridden"
// (the label in the accent) whose menu holds a Reset to default that removes
// the attribute, with no reset button in the label row; a `@deprecated` prop has a muted tag and its notice in the
// tooltip; and a colour prop gets a swatch beside its text, round-tripping
// what is picked or typed.
// Method: the real PropsPanel, bundled with esbuild and mounted in jsdom over
// a hand-made schema, its onSetProp recording every write and re-rendering
// with it, as the app does. Each case reads the DOM a designer sees and the
// writes the panel made, including the negative space: optional props, props
// with defaults, a spread on the instance, a defaults recipe, and names that
// look like colours but hold words. The pure helpers the controls use are
// checked directly. The app's own undo of a reset is in
// test/renderer/app/propReset.test.js.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/prop-instance-ux');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(
  entry,
  [
    `export { default as PropsPanel } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};`,
    `export { isRequiredField, isColorField, isColorText, hexOfColor, fieldDeprecation } from ${JSON.stringify(repoPath('src/features/props/propFieldModel.ts'))};`,
    `export { fieldTooltip } from ${JSON.stringify(repoPath('src/editor/propDocumentation.ts'))};`,
  ].join('\n'),
);
const output = path.join(directory, 'bundle.cjs');
buildSync({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
global.window = dom.window;
global.document = dom.window.document;
for (const name of ['Node', 'Element', 'HTMLElement', 'MutationObserver', 'DOMRect', 'Window']) {
  global[name] = dom.window[name];
}
global.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
global.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
global.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
global.IS_REACT_ACT_ENVIRONMENT = true;
global.ResizeObserver = dom.window.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
dom.window.Range.prototype.getBoundingClientRect = () => new dom.window.DOMRect();
dom.window.Range.prototype.getClientRects = () => [];
dom.window.HTMLElement.prototype.scrollIntoView = () => {};
const React = require('react');
const { createRoot } = require('react-dom/client');
const { act } = React;
const ux = require(output);
require('../../helpers/popupDom.js').installPopupDOM(dom.window);

const root = createRoot(document.getElementById('root'));
const noop = () => {};
const BASE = {
  slotOptions: [],
  takesSlotText: false,
  tagOptions: [],
  projectClasses: [],
  layouts: [],
  bindContext: {},
  allowAttrs: false,
  onSetProps: noop,
  onRenameProp: noop,
  onSetText: noop,
  onSetContent: noop,
  onSetInline: noop,
  onOpenCode: noop,
  onSetComment: noop,
};

// One mounted panel: its values, the writes it made, and a way to re-render.
function mount(schema, initial = {}, policy = 'instance') {
  // The write re-renders through the panel object, as the app's state update would.
  const panel = { values: { ...initial }, writes: [], render: noop };
  panel.render = () =>
    root.render(
      React.createElement(ux.PropsPanel, {
        ...BASE,
        schema,
        valuePolicy: policy,
        node: { id: 'n0', kind: 'component', name: 'Card', props: panel.values, children: undefined },
        onSetProp: (name, value, immediate) => {
          panel.writes.push({ name, value, immediate });
          const next = { ...panel.values };
          if (value === undefined) {
            delete next[name];
          } else {
            next[name] = value;
          }
          panel.values = next;
          panel.render();
        },
      }),
    );
  act(panel.render);
  return panel;
}

function label(name) {
  const found = [...document.querySelectorAll('.prop-label')].find((item) => item.firstChild?.textContent === name || item.textContent === name);
  assert.ok(found, `a label for ${name}`);
  return found;
}
const field = (name) => label(name).closest('.props-field');
// The first match under an element, undefined when there is none.
const one = (element, selector) => element.querySelector(selector) ?? undefined;
// The open menu's item that starts with these words, undefined when there is none.
const menuItem = (words) => [...document.querySelectorAll('.prop-menu-item')].find((item) => item.textContent.startsWith(words));
// The note PropField puts after the field, or undefined.
function noteAfter(name) {
  let next = field(name).nextElementSibling ?? undefined;
  // The zoo wraps controls; here the field is the panel's own box.
  while (next !== undefined && !next.classList.contains('props-field')) {
    if (next.classList.contains('prop-field-note')) {
      return next;
    }
    next = next.nextElementSibling ?? undefined;
  }
  return undefined;
}
function typeInto(input, text) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
}

test('a required prop carries a marker, and a note while the instance leaves it out', () => {
  const schema = [
    { name: 'title', type: 'string', optional: false },
    { name: 'subtitle', type: 'string', optional: true },
    { name: 'count', type: 'number', optional: false, default: 1 },
  ];
  const panel = mount(schema);
  const marker = label('title').querySelector('.prop-required');
  assert.ok(marker, 'the required prop is marked');
  assert.ok(marker.classList.contains('missing'), 'unset, the marker says it is missing');
  assert.equal(noteAfter('title')?.textContent, 'Required — the component needs a value');
  assert.equal(one(label('subtitle'), '.prop-required'), undefined, 'an optional prop is not marked');
  assert.equal(one(label('count'), '.prop-required'), undefined, 'a prop with a default is not marked');
  assert.equal(noteAfter('subtitle'), undefined);
  assert.equal(noteAfter('count'), undefined);
  typeInto(field('title').querySelector('input'), 'Hello');
  assert.deepEqual(panel.values.title, { type: 'string', value: 'Hello' });
  assert.ok(label('title').querySelector('.prop-required'), 'still required once set');
  assert.equal(one(label('title'), '.prop-required.missing'), undefined, 'no longer missing');
  assert.equal(noteAfter('title'), undefined, 'the note goes once a value is given');
  act(() => root.render(React.createElement(React.Fragment)));
});

test('a spread on the instance, or a defaults recipe, does not report a required prop missing', () => {
  const schema = [{ name: 'title', type: 'string', optional: false }];
  mount(schema, { '...rest': { type: 'spread', value: 'rest' } });
  assert.ok(label('title').querySelector('.prop-required'), 'still marked: the type asks for it');
  assert.equal(one(label('title'), '.prop-required.missing'), undefined);
  assert.equal(noteAfter('title'), undefined, 'the spread may carry it');
  act(() => root.render(React.createElement(React.Fragment)));
  mount(schema, {}, 'defaults');
  assert.equal(one(label('title'), '.prop-required'), undefined, 'a recipe states its own obligations');
  assert.equal(noteAfter('title'), undefined);
  act(() => root.render(React.createElement(React.Fragment)));
});

test('isRequiredField: no `?` and no default of any kind', () => {
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string', optional: false }, undefined), true);
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string', optional: true }, undefined), false);
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string' }, undefined), false, 'an element attribute leaves optional unset');
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string', optional: false, default: 'x' }, undefined), false);
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string', optional: false, defaultExpr: true }, undefined), false);
  assert.equal(ux.isRequiredField({ name: 'a', type: 'string', optional: false }, 'sm'), false, 'a variant default counts');
});

test('an unset prop shows its default dimmed and writes nothing', () => {
  const schema = [
    { name: 'heading', type: 'string', optional: true, default: 'Welcome' },
    { name: 'size', type: 'number', optional: true, default: 12 },
  ];
  const panel = mount(schema);
  const heading = field('heading').querySelector('input');
  assert.equal(heading.value, '', 'the default is not the value');
  assert.equal(heading.getAttribute('placeholder'), 'Welcome', 'it is the placeholder');
  assert.equal(field('size').querySelector('input').getAttribute('placeholder'), '12');
  assert.equal(label('heading').classList.contains('set'), false, 'not overridden');
  assert.equal(menuItem('Reset to default'), undefined, 'nothing to reset');
  act(() => label('heading').click());
  assert.equal(menuItem('Reset to default'), undefined, 'the unset label opens no menu');
  assert.deepEqual(panel.writes, [], 'showing a default writes nothing');
  assert.deepEqual(panel.values, {});
  act(() => root.render(React.createElement(React.Fragment)));
});

test('a set prop is overridden, and Reset to default removes the attribute in one immediate write', async () => {
  const schema = [{ name: 'heading', type: 'string', optional: true, default: 'Welcome' }];
  const panel = mount(schema, { heading: { type: 'string', value: 'Hi' } });
  assert.ok(label('heading').classList.contains('set'), 'the label takes the overridden state');
  act(() => label('heading').click());
  const clicked = menuItem('Reset to default');
  assert.ok(clicked, "the label's menu offers Reset to default");
  act(() => clicked.click());
  assert.deepEqual(panel.writes, [{ name: 'heading', value: undefined, immediate: true }], 'one write: the removal, committed as its own step');
  assert.equal(panel.values.heading, undefined);
  assert.equal(label('heading').classList.contains('set'), false);
  assert.equal(field('heading').querySelector('input').getAttribute('placeholder'), 'Welcome', 'the default shows again');
  // Right-clicking the label opens the same menu, where the click was.
  typeInto(field('heading').querySelector('input'), 'Again');
  assert.ok(label('heading').classList.contains('set'));
  await act(async () => label('heading').dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 6 })));
  const item = menuItem('Reset to default');
  assert.ok(item, 'the context menu offers Reset to default');
  await act(async () => item.click());
  assert.deepEqual(panel.writes.at(-1), { name: 'heading', value: undefined, immediate: true });
  assert.equal(panel.values.heading, undefined);
  act(() => root.render(React.createElement(React.Fragment)));
});

test('no field kind has an inline reset button, and each resets from its label menu', () => {
  const kinds = [
    { schema: { name: 'heading', type: 'string', optional: true }, value: { type: 'string', value: 'Hi' } },
    { schema: { name: 'size', type: 'number', optional: true }, value: { type: 'expr', value: '12' } },
    { schema: { name: 'open', type: 'boolean', optional: true }, value: { type: 'expr', value: 'true' } },
    { schema: { name: 'tone', type: 'enum', options: ['warm', 'cool'], optional: true }, value: { type: 'string', value: 'warm' } },
    {
      schema: { name: 'features', type: 'code', shape: [{ name: 'title', type: 'string' }], shapeIsList: true, optional: true },
      value: { type: 'expr', value: '[{ title: "Fast" }]' },
    },
  ];
  for (const kind of kinds) {
    const { name } = kind.schema;
    const panel = mount([kind.schema], { [name]: kind.value });
    assert.ok(label(name).classList.contains('set'), `${name} is overridden`);
    const row = label(name).closest('label');
    const buttons = [...row.querySelectorAll('button')];
    const resets = buttons.filter((button) => /reset/i.test(`${button.title} ${button.getAttribute('aria-label')}`));
    assert.deepEqual(resets, [], `${name} has no inline reset button`);
    assert.equal(one(row, '.prop-reset'), undefined, `${name} has no reset class left in its row`);
    act(() => label(name).click());
    const item = menuItem('Reset to default');
    assert.ok(item, `${name} resets from its label menu`);
    act(() => item.click());
    assert.deepEqual(panel.writes, [{ name, value: undefined, immediate: true }], `${name} is removed in one write`);
    assert.equal(panel.values[name], undefined);
    act(() => root.render(React.createElement(React.Fragment)));
  }
});

test('⌥-clicking a set label resets at once, with no menu', () => {
  const panel = mount([{ name: 'heading', type: 'string', optional: true }], { heading: { type: 'string', value: 'Hi' } });
  act(() => label('heading').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, altKey: true })));
  assert.deepEqual(panel.writes, [{ name: 'heading', value: undefined, immediate: true }]);
  assert.equal(menuItem('Reset to default'), undefined, 'the shortcut opens nothing');
  act(() => root.render(React.createElement(React.Fragment)));
});

test('a deprecated prop shows a muted tag, with its notice leading the tooltip', () => {
  const schema = [
    { name: 'text', type: 'string', optional: true, doc: 'The old name for label.\n@deprecated Use `label` instead.' },
    // The schema may state it as a field, the tag already read out of the doc.
    { name: 'caption', type: 'string', optional: true, deprecated: '' },
    { name: 'label', type: 'string', optional: true, doc: 'The text on the button.' },
  ];
  mount(schema);
  const tag = field('text').querySelector('.prop-deprecated');
  assert.ok(tag, 'the deprecated prop is tagged');
  assert.equal(tag.textContent, 'Deprecated');
  assert.equal(tag.getAttribute('title'), 'Deprecated: Use `label` instead.');
  assert.ok(label('text').classList.contains('deprecated'));
  const tip = field('text').querySelector('.prop-tip-icon');
  assert.equal(tip.getAttribute('aria-label'), 'Deprecated: Use `label` instead.\nThe old name for label.');
  assert.equal(field('caption').querySelector('.prop-deprecated')?.textContent, 'Deprecated');
  assert.equal(field('caption').querySelector('.prop-tip-icon').getAttribute('aria-label'), 'Deprecated.');
  assert.equal(one(field('label'), '.prop-deprecated'), undefined, 'a prop that is not deprecated is not tagged');
  assert.equal(field('label').querySelector('.prop-tip-icon').getAttribute('aria-label'), 'The text on the button.');
  act(() => root.render(React.createElement(React.Fragment)));
});

test('fieldTooltip and fieldDeprecation read the notice wherever it is stated', () => {
  assert.equal(ux.fieldDeprecation({ name: 'a', type: 'string', doc: '@deprecated' }), '');
  assert.equal(ux.fieldDeprecation({ name: 'a', type: 'string', doc: 'Words.' }), undefined);
  assert.equal(ux.fieldDeprecation({ name: 'a', type: 'string', deprecated: 'Gone.', doc: '@deprecated Old.' }), 'Gone.', 'the schema field wins');
  assert.equal(ux.fieldTooltip('Shown @min 0 @deprecated Use b.', 'Use b.'), 'Deprecated: Use b.\nShown');
  assert.equal(ux.fieldTooltip(undefined, undefined), '');
  assert.equal(ux.fieldTooltip('Plain words @max 3', undefined), 'Plain words');
});

test('a colour prop gets a swatch and text, and both write what is chosen', () => {
  const schema = [
    { name: 'color', type: 'string', optional: true, default: '#ff3366' },
    { name: 'tone', type: 'string', optional: true, doc: 'The tone.\n@format color' },
    { name: 'background', type: 'string', optional: true, default: 'transparent' },
  ];
  const panel = mount(schema);
  const color = field('color');
  const swatch = color.querySelector('.prop-color input[type="color"]');
  const text = color.querySelector('.prop-color input:not([type="color"])');
  assert.ok(swatch, 'a colour prop has a swatch');
  assert.equal(swatch.value, '#ff3366', 'the swatch starts at the default');
  assert.equal(text.value, '', 'the default is not written');
  assert.equal(text.getAttribute('placeholder'), '#ff3366');
  assert.ok(color.querySelector('.prop-color').classList.contains('is-default'), 'the default is shown dimmed');
  assert.deepEqual(panel.writes, []);
  typeInto(text, '#00aa55');
  assert.deepEqual(panel.values.color, { type: 'string', value: '#00aa55' }, 'typed text is written as a string');
  assert.equal(field('color').querySelector('.prop-color input:not([type="color"])').value, '#00aa55', 'and reads back');
  assert.equal(field('color').querySelector('.prop-color-fill').style.background, 'rgb(0, 170, 85)', 'the swatch paints it');
  typeInto(field('color').querySelector('input[type="color"]'), '#123456');
  assert.deepEqual(panel.values.color, { type: 'string', value: '#123456' }, 'a picked colour is written the same way');
  typeInto(field('color').querySelector('.prop-color input:not([type="color"])'), '');
  assert.equal(panel.values.color, undefined, 'clearing the text unsets the prop');
  assert.ok(field('tone').querySelector('.prop-color'), '`@format color` makes a colour control whatever the name');
  assert.equal(one(field('background'), '.prop-color'), undefined, 'a word default is text');
  act(() => root.render(React.createElement(React.Fragment)));
});

test('a colour typed as a token keeps its text, and the swatch does not paint the panel’s own variable', () => {
  const schema = [{ name: 'accentColor', type: 'string', optional: true, default: 'var(--brand)' }];
  mount(schema, { accentColor: { type: 'string', value: 'var(--accent)' } });
  const control = field('accentColor').querySelector('.prop-color');
  assert.ok(control);
  assert.equal(control.querySelector('input:not([type="color"])').value, 'var(--accent)');
  assert.ok(control.querySelector('.prop-color-swatch').classList.contains('is-unknown'));
  assert.equal(control.querySelector('.prop-color-fill').getAttribute('style') ?? undefined, undefined);
  act(() => root.render(React.createElement(React.Fragment)));
});

test('colour detection holds names, formats and values apart', () => {
  assert.equal(ux.isColorField({ name: 'color', type: 'string', default: '#fff' }), true);
  assert.equal(ux.isColorField({ name: 'textColour', type: 'string', default: 'rgb(1, 2, 3)' }), true);
  assert.equal(ux.isColorField({ name: 'borderColor', type: 'string', default: 'hsl(0 0% 50%)' }), true);
  assert.equal(ux.isColorField({ name: 'color', type: 'string', default: 'primary' }), false, 'a word is not a colour');
  assert.equal(ux.isColorField({ name: 'color', type: 'string' }), false, 'a name alone is not enough');
  assert.equal(ux.isColorField({ name: 'colorful', type: 'string', default: '#fff' }), false);
  assert.equal(ux.isColorField({ name: 'fill', type: 'string', doc: '@format color' }), true);
  assert.equal(ux.isColorField({ name: 'color', type: 'enum', options: ['red'], default: '#fff' }), false, 'a choice stays a choice');
  assert.equal(ux.isColorText('#abcd'), true);
  assert.equal(ux.isColorText('#abcde'), false);
  assert.equal(ux.isColorText('var(--x, #fff)'), true);
  assert.equal(ux.isColorText('url(x)'), false);
  assert.equal(ux.hexOfColor('#ABC'), '#aabbcc');
  assert.equal(ux.hexOfColor('#11223344'), '#112233');
  assert.equal(ux.hexOfColor('rgb(1, 2, 3)'), undefined);
});

test.after(() => {
  act(() => root.unmount());
  dom.window.close();
});
