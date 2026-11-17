// Goal: an unset prop's field shows, muted as its placeholder, the default the
// component computes for this instance's values: Button's label reads Play for
// variant="play", Pause once pressed, Close for close, Next or Previous for
// arrow by direction, and nothing where the table has no entry or variant is
// unset (its own default, main). The same holds for a destructure ternary on
// another prop and a `??` chain; code only the running site could tell (a
// call, a comparison the rows cannot draw, a value in braces that is not a
// literal) gives no placeholder rather than a wrong one. The placeholder is
// never real text and never written, and changing variant changes it in the
// very render that carries the new value.
// Method: the pure rules (createPropRules.branchDefault) and the evaluator
// (evaluateConditionalValue) are bundled with esbuild and driven table-first
// over Button's real schema, read from the Lumos fixture by the built main
// process (#dist parsePropSchema + withComputedDefaults) and passed through the
// scan's schema parser (parseField), as the app receives it; then over small
// schemas in each other shape. Finally the real PropsPanel is mounted in jsdom
// and re-rendered with each variant, reading the label input's placeholder and
// value after each single render and recording every write.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { parsePropSchema } = require('#dist/electron/parse/astroParser.js');
const { withComputedDefaults } = require('#dist/electron/properties/computedDefaults.js');
const { parseField } = require('#dist/shared/properties/propSchema.js');

const directory = repoPath('node_modules/.stacki-test/computed-default-placeholder');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(
  entry,
  [
    `export { default as PropsPanel } from ${JSON.stringify(repoPath('src/features/props/PropsPanel.tsx'))};`,
    `export { createPropRules } from ${JSON.stringify(repoPath('src/features/props/propRules.ts'))};`,
    `export { propFieldPlaceholder } from ${JSON.stringify(repoPath('src/features/props/propFieldModel.ts'))};`,
    `export { evaluateConditionalValue, readValueExpression } from ${JSON.stringify(repoPath('src/editor/conditionalValue.ts'))};`,
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
const props = require(output);
require('../../helpers/popupDom.js').installPopupDOM(dom.window);

// Button as the app receives it: read by main, then through the scan's parser.
const BUTTON_SOURCE = fs.readFileSync(repoPath('test/fixtures/lumos/components/Button.astro'), 'utf8');
const BUTTON = withComputedDefaults(parsePropSchema(BUTTON_SOURCE), BUTTON_SOURCE).map((field) => parseField(JSON.parse(JSON.stringify(field)), field.name));

const words = (value) => ({ type: 'string', value });
const code = (value) => ({ type: 'expr', value });
const labelDefault = (schema, values) => props.createPropRules(schema, values).branchDefault('label');

const BUTTON_CASES = [
  { name: 'variant unset (its default, main, has no entry)', values: {}, expected: undefined },
  { name: 'main', values: { variant: words('main') }, expected: undefined },
  { name: 'link', values: { variant: words('link') }, expected: undefined },
  { name: 'play', values: { variant: words('play') }, expected: 'Play' },
  { name: 'play, pressed', values: { variant: words('play'), pressed: { type: 'bare' } }, expected: 'Pause' },
  { name: 'play, pressed={false}', values: { variant: words('play'), pressed: code('false') }, expected: 'Play' },
  { name: 'close', values: { variant: words('close') }, expected: 'Close' },
  { name: 'arrow', values: { variant: words('arrow') }, expected: 'Next' },
  { name: 'arrow, direction back', values: { variant: words('arrow'), direction: words('back') }, expected: 'Previous' },
  { name: 'arrow, direction forward', values: { variant: words('arrow'), direction: words('forward') }, expected: 'Next' },
  { name: 'variant in quoted braces', values: { variant: code('"close"') }, expected: 'Close' },
  { name: 'variant bound to code', values: { variant: code('kind') }, expected: undefined },
  { name: 'play, pressed bound to code', values: { variant: words('play'), pressed: code('isOn') }, expected: undefined },
  { name: 'an option the table lacks', values: { variant: words('ghost') }, expected: undefined },
];

for (const item of BUTTON_CASES) {
  test(`Button label default: ${item.name}`, () => {
    assert.equal(labelDefault(BUTTON, item.values), item.expected);
  });
}

test('Button: the label field shows the default as its placeholder, never its code', () => {
  const label = BUTTON.find((field) => field.name === 'label');
  assert.ok(label?.computedDefault, 'the scan carries the label default');
  assert.equal(props.propFieldPlaceholder(label, undefined, labelDefault(BUTTON, { variant: words('close') })), 'Close');
  assert.equal(props.propFieldPlaceholder(label, undefined, undefined), '', 'no answer, no placeholder');
});

// One schema per shape: `label` computed from `variant` (and `count`), each prop's own default given.
const field = (name, extra = {}) => ({ name, type: 'string', optional: true, ...extra });
const computed = (codeText, tables = {}) => ({ code: codeText, locals: { variant: 'variant', count: 'count', title: 'title' }, tables });
const SHAPES = [
  {
    name: 'a destructure ternary',
    label: { default: 'variant === "x" ? "A" : "B"', defaultExpr: true, computedDefault: computed('variant === "x" ? "A" : "B"') },
    cases: [
      [{ variant: words('x') }, 'A'],
      [{ variant: words('y') }, 'B'],
      [{}, 'B'],
    ],
  },
  {
    name: 'a lookup table',
    label: { computedDefault: computed('named[variant]', { named: { x: '"Ex"', y: '"Why"' } }) },
    cases: [
      [{ variant: words('x') }, 'Ex'],
      [{ variant: words('y') }, 'Why'],
      [{ variant: words('z') }, undefined],
    ],
  },
  {
    name: 'a fallback chain',
    label: { computedDefault: computed('named[variant] ?? "Plain"', { named: { x: '"Ex"' } }) },
    cases: [
      [{ variant: words('x') }, 'Ex'],
      [{ variant: words('y') }, 'Plain'],
    ],
  },
  {
    name: 'a number entry',
    label: { computedDefault: computed('sizes[variant]', { sizes: { x: '3' } }) },
    cases: [[{ variant: words('x') }, 3]],
  },
  {
    name: 'a template of another prop',
    label: { computedDefault: computed('`Open ${title}`') },
    cases: [
      [{ title: words('menu') }, 'Open menu'],
      [{}, undefined],
    ],
  },
  {
    name: 'a call only the site can run',
    label: { computedDefault: computed('slugify(title)') },
    cases: [[{ title: words('Hello') }, undefined]],
  },
  {
    name: 'a comparison the rows cannot draw',
    label: { computedDefault: computed('count > 2 ? "Many" : "Few"') },
    cases: [[{ count: code('5') }, undefined]],
  },
  {
    name: 'an entry that indexes itself',
    label: { computedDefault: computed('named[variant]', { named: { x: 'named[variant]' } }) },
    cases: [[{ variant: words('x') }, undefined]],
  },
];

for (const shape of SHAPES) {
  test(`shape: ${shape.name}`, () => {
    const schema = [field('variant', { default: 'y' }), field('title'), field('count', { type: 'number' }), field('label', shape.label)];
    for (const [values, expected] of shape.cases) {
      assert.equal(labelDefault(schema, values), expected, JSON.stringify(values));
    }
  });
}

test('a computed default wins over the union doc it contradicts', () => {
  const branches = [{ forbids: [], pins: { variant: ['x'] }, defaults: { label: 'Doc' }, rules: {}, docs: {} }];
  const unions = [{ names: ['variant', 'label'], branches }];
  const schema = [field('variant', { unions }), field('label', { computedDefault: computed('named[variant]', { named: { x: '"Code"' } }) })];
  assert.equal(labelDefault(schema, { variant: words('x') }), 'Code');
});

test('the evaluator: a three-valued group decides on a false condition despite an unknown one', () => {
  const model = props.readValueExpression('variant === "x" && count > 2 ? "A" : "B"');
  assert.ok(model, 'the reader takes the chain');
  const scope = (variant) => ({
    name: (name) => (name === 'variant' ? { kind: 'value', value: variant } : { kind: 'unknown' }),
    entry: () => ({ kind: 'unknown' }),
  });
  assert.deepEqual(props.evaluateConditionalValue(model, scope('y')), { kind: 'value', value: 'B' });
  assert.deepEqual(props.evaluateConditionalValue(model, scope('x')), { kind: 'unknown' });
});

// The real panel: a Button instance whose variant changes between renders.
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
  valuePolicy: 'instance',
};

function labelInput() {
  const label = [...document.querySelectorAll('.prop-label')].find((item) => item.firstChild?.textContent === 'label' || item.textContent === 'label');
  assert.ok(label, 'the label field is shown');
  const box = label.closest('.props-field');
  const input = box.querySelector('input, textarea, [data-placeholder]');
  assert.ok(input, 'the label field has a text box');
  return input;
}
const placeholderOf = (input) => input.getAttribute('placeholder') ?? input.getAttribute('data-placeholder') ?? '';
const textOf = (input) => ('value' in input ? input.value : input.textContent);

test('variant changes: the placeholder follows in the same render, and nothing is written', () => {
  const writes = [];
  const render = (values) =>
    act(() =>
      root.render(
        React.createElement(props.PropsPanel, {
          ...BASE,
          schema: BUTTON,
          node: { id: 'n0', kind: 'component', name: 'Button', props: values, children: undefined },
          onSetProp: (name, value) => writes.push({ name, value }),
        }),
      ),
    );
  for (const [values, expected] of [
    [{ variant: words('play') }, 'Play'],
    [{ variant: words('close') }, 'Close'],
    [{ variant: words('arrow') }, 'Next'],
    [{ variant: words('arrow'), direction: words('back') }, 'Previous'],
    [{ variant: words('play'), pressed: { type: 'bare' } }, 'Pause'],
    [{ variant: words('play') }, 'Play'],
  ]) {
    render(values);
    const input = labelInput();
    assert.equal(placeholderOf(input), expected, JSON.stringify(values));
    assert.equal(textOf(input), '', 'the default is a placeholder, not text in the box');
  }
  assert.deepEqual(writes, [], 'showing a default writes nothing');
  act(() => root.render(React.createElement(React.Fragment)));
});
