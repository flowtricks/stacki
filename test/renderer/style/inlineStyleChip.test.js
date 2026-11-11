// The "Inline styles" chip and target: the selected element's `style` attribute as a
// Style panel edit target.
//
//   node test/renderer/style/inlineStyleChip.test.js
//
// Goal: the chip appears exactly when the attribute holds something; a plain string is
// edited through the panel, code is left to Settings; writes keep every untouched
// declaration's bytes, and removing the last removes the attribute; the attribute
// outranks every rule in the resolved style (so a picked rule's value reads overridden),
// and picking the chip makes its values the selected ones; the chip is amber in every
// state; and one panel write is one page edit, so one undo step.
//
// Method: the pure model (model/inlineTarget.ts) on attributes of every shape the page
// model holds (string, expression, bare, empty, unreadable); resolveStyle on a hand-built
// rule model with the inline input; the well rendered to markup with and without the
// chip; a small cascade over the real embedEditor.css (as selectorChipColour.test.js
// does) picking the chip's winning background and colour in each state; and the page
// edit a write becomes (inlineStyleGesture), counted.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const postcss = require('postcss');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const dom = new JSDOM('<!doctype html><body></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.Element = dom.window.Element;

const directory = repoPath('node_modules/.stacki-test');
fs.mkdirSync(directory, { recursive: true });
const bundle = path.join(directory, 'inline-style-chip.bundle.js');
esbuild.buildSync({
  stdin: {
    contents: [
      "export { readableStyleCode, styleBranches, styleExpressionInSource } from './src/features/style/model/inlineCode';",
      "export { chipInlineStyle, inlineChipShown, inlineStyleOf, inlineStyleWrite, inlineDeclaration, inlineEditBase, hasInlineChip, INLINE_STYLE_SELECTOR } from './src/features/style/model/inlineTarget';",
      "export { resolveStyle } from './src/features/style/model/resolved';",
      "export { selectorSpecificity } from './src/features/style/model/selectors';",
      "export { inlineChipClassName } from './src/features/style/embed/InlineStyleChip';",
      "export { inlineResolveInput } from './src/features/style/embed/useInlineTarget';",
      "export { SelectorPicker } from './src/features/style/embed/SelectorPicker';",
      "export { inlineStyleGesture } from './src/editor/editGestures';",
    ].join('\n'),
    resolveDir: ROOT,
    loader: 'tsx',
  },
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react-dom/server', 'react/jsx-runtime'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const model = require(bundle);
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

// A code state's kind and reason; its readable CSS is checked on its own.
const codeState = (style) => ({ kind: style.kind, reason: style.reason });
const string = (value) => ({ props: { style: { type: 'string', value } } });

test('the chip appears only when the style attribute holds a value', () => {
  const none = [
    undefined,
    { props: {} },
    { props: { style: { type: 'bare' } } },
    string(''),
    string('   '),
    string(' ; ;'),
    { props: { style: { type: 'expr', value: ' ' } } },
  ];
  for (const node of none) {
    assert.equal(model.hasInlineChip(model.inlineStyleOf(node)), false, JSON.stringify(node));
  }
  const style = model.inlineStyleOf(string('color: red; padding: 1rem !important'));
  assert.equal(style.kind, 'declarations');
  assert.deepEqual(style.declarations, [
    { property: 'color', value: 'red', important: false },
    { property: 'padding', value: '1rem', important: true },
  ]);
  assert.equal(model.hasInlineChip(style), true);
});

test('an expression the conditional model reads is edited by branch; anything else is read-only code', () => {
  const conditional = { props: { style: { type: 'expr', value: 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined' } } };
  const branched = model.inlineStyleOf(conditional);
  assert.equal(branched.kind, 'branched');
  assert.deepEqual(
    branched.branches.map((branch) => [branch.label, branch.body]),
    [
      ['when maxWidth is set', '--_mw: ${maxWidth}ch;'],
      ['otherwise', ''],
    ],
  );
  assert.deepEqual(branched.source, { kind: 'node' });
  const template = model.inlineStyleOf({ props: { style: { type: 'expr', value: '`color: red; width: ${width}px`' } } });
  assert.deepEqual(
    template.branches.map((branch) => branch.label),
    ['always'],
  );
  assert.deepEqual(codeState(model.inlineStyleOf({ props: { style: { type: 'expr', value: 'styles' } } })), { kind: 'code', reason: 'expression' });
  assert.deepEqual(codeState(model.inlineStyleOf(string('color red'))), { kind: 'code', reason: 'unreadable' });
  assert.deepEqual(codeState(model.inlineStyleOf(string('background: url(a'))), { kind: 'code', reason: 'unreadable' });
  // The edited branch's declarations are what the controls read, selected with the chip.
  assert.deepEqual(model.inlineResolveInput({ style: branched, active: true, branchKey: '0' }), {
    declarations: [{ property: '--_mw', value: '${maxWidth}ch', important: false }],
    selected: true,
  });
  assert.deepEqual(model.inlineResolveInput({ style: branched, active: true, branchKey: '1' }), { declarations: [], selected: true });
  // Read-only code is never folded in: its values are not known here.
  assert.equal(model.inlineResolveInput({ style: model.inlineStyleOf(string('color red')), active: true, branchKey: undefined }), undefined);
});

test('writes round-trip and keep every untouched declaration as written', () => {
  const text = 'color:red;  /* x */ margin : 0 auto ;padding: 4px';
  const set = model.inlineStyleWrite(text, ['color'], model.inlineDeclaration('blue', { important: false }));
  assert.deepEqual(set, { tag: 'write', next: 'color:blue;  /* x */ margin : 0 auto ;padding: 4px' });
  const added = model.inlineStyleWrite('color: red;', ['gap'], model.inlineDeclaration(' 1rem ', { important: true }));
  assert.deepEqual(added, { tag: 'write', next: 'color: red; gap: 1rem !important;' });
  const removed = model.inlineStyleWrite('color: red; gap: 1rem; width: 2px', ['gap'], { tag: 'remove' });
  assert.deepEqual(removed, { tag: 'write', next: 'color: red; width: 2px' });
  // Read back, the write says what was meant.
  assert.deepEqual(model.inlineStyleOf(string(added.next)).declarations, [
    { property: 'color', value: 'red', important: false },
    { property: 'gap', value: '1rem', important: true },
  ]);
  // Several properties in one write (a clear of a section) are one next text.
  assert.deepEqual(model.inlineStyleWrite('a: 1; b: 2; c: 3', ['a', 'c'], { tag: 'remove' }), { tag: 'write', next: 'b: 2;' });
});

test('removing the last declaration removes the attribute', () => {
  assert.deepEqual(model.inlineStyleWrite('color: red;', ['color'], { tag: 'remove' }), { tag: 'write', next: undefined });
  assert.deepEqual(model.inlineStyleWrite(' color: red ', ['color'], { tag: 'remove' }), { tag: 'write', next: undefined });
  assert.deepEqual(model.inlineStyleWrite('a: 1; b: 2', ['a', 'b'], { tag: 'remove' }), { tag: 'write', next: undefined });
});

test('writes the panel cannot make safely are refused, with the reason', () => {
  const twice = model.inlineStyleWrite('color: red; color: blue', ['color'], model.inlineDeclaration('green', { important: false }));
  assert.equal(twice.tag, 'refused');
  assert.match(twice.message, /declared twice/);
  const semicolon = model.inlineStyleWrite('color: red', ['width'], model.inlineDeclaration('1px; display: none', { important: false }));
  assert.equal(semicolon.tag, 'refused');
  const bracket = model.inlineStyleWrite('color: red', ['background'], model.inlineDeclaration('url(a', { important: false }));
  assert.equal(bracket.tag, 'refused');
  assert.throws(() => model.inlineStyleWrite('color: red', [], { tag: 'remove' }), /names a property/);
  assert.throws(() => model.inlineDeclaration('  ', { important: false }), /empty one is a removal/);
});

test('two writes before the model catches up build on each other', () => {
  const held = { nodeId: 'n1', base: 'a: 1', next: 'a: 1; b: 2' };
  assert.equal(model.inlineEditBase('a: 1', 'n1', held), 'a: 1; b: 2');
  assert.equal(model.inlineEditBase('a: 1; b: 2', 'n1', held), 'a: 1; b: 2');
  assert.equal(model.inlineEditBase('a: 9', 'n1', held), 'a: 9');
  assert.equal(model.inlineEditBase('a: 1', 'n2', held), 'a: 1');
  assert.equal(model.inlineEditBase(undefined, 'n1', undefined), '');
});

// One `.card` rule setting color and margin, matched in Base.
function ruleModel({ important = false } = {}) {
  const specificity = model.selectorSpecificity('.card');
  const rule = {
    ruleId: 'r1',
    selectorText: '.card',
    selectors: [{ text: '.card', specificity, pseudoElement: '' }],
    declarations: [
      { prop: 'color', value: 'red', important },
      { prop: 'margin', value: '0', important: false },
    ],
    atContext: [],
    order: 1,
    embedKey: 'e1',
    embedLabel: 'styles.css',
    fromComponent: false,
  };
  const matched = { rule, matchedSelectors: rule.selectors, kind: 'base', conditional: false, label: '.card' };
  return { base: [matched], conditional: [], matchedRuleCount: 1 };
}

const inline = (selected) => ({
  declarations: [
    { property: 'color', value: 'blue', important: false },
    { property: 'padding', value: '1rem', important: false },
  ],
  selected,
});

test('the attribute outranks a picked rule, whose value then reads overridden', () => {
  const resolved = model.resolveStyle(ruleModel(), '', '.card', undefined, inline(false));
  const color = resolved.props.get('color');
  assert.equal(color.source, 'selected');
  assert.equal(color.overridden, true);
  assert.equal(color.winner.origin, 'inline');
  assert.equal(color.winner.selectorText, model.INLINE_STYLE_SELECTOR);
  assert.equal(color.selectedValue.value, 'red');
  // A property only the attribute sets is somebody else's for the rule.
  assert.equal(resolved.props.get('padding').source, 'other');
  assert.equal(resolved.props.get('padding-top').winner.value, '1rem');
  // A property only the rule sets is unaffected.
  assert.equal(resolved.props.get('margin').overridden, false);
});

test('an !important rule still beats a plain inline declaration', () => {
  const resolved = model.resolveStyle(ruleModel({ important: true }), '', '.card', undefined, inline(false));
  assert.equal(resolved.props.get('color').winner.origin, 'embed');
  assert.equal(resolved.props.get('color').overridden, false);
});

test('picking the chip makes the attribute’s values the selected ones', () => {
  const resolved = model.resolveStyle(ruleModel(), '', '', undefined, inline(true));
  const color = resolved.props.get('color');
  assert.equal(color.source, 'selected');
  assert.equal(color.selectedOrigin, 'inline');
  assert.deepEqual(color.selectedValue, { value: 'blue', important: false });
  assert.equal(color.overridden, false);
  assert.equal(resolved.props.get('margin').source, 'other');
  assert.equal(resolved.selectedRule, undefined);
});

test('the attribute never reaches a ::before view', () => {
  const resolved = model.resolveStyle(ruleModel(), '', '.card::before', undefined, inline(false));
  assert.equal(resolved.props.has('padding'), false);
});

function well(inlineChip) {
  return renderToStaticMarkup(
    React.createElement(model.SelectorPicker, {
      selectors: [{ text: '.card', specificity: [0, 1, 0], state: '', simple: true, key: '.card', fromComponent: false }],
      suggestions: [],
      activeSelector: '',
      activePicked: false,
      busy: false,
      loading: false,
      onSelect: () => undefined,
      onDeselect: () => undefined,
      onAdd: () => undefined,
      inline: inlineChip,
    }),
  );
}

test('the well draws the chip after the last selector, and only when given one', () => {
  assert.equal(well(undefined).includes('is-inline'), false);
  const markup = well({ state: 'editable', active: false, onSelect: () => undefined, onDeselect: () => undefined, onClear: () => undefined });
  assert.ok(markup.indexOf('.card') < markup.indexOf('Inline styles'), 'the chip ends the list');
  assert.match(markup, /Inline styles options/);
  // Code has nothing to clear from here: no menu.
  const code = well({ state: 'code', active: false, onSelect: () => undefined, onDeselect: () => undefined, onClear: undefined });
  assert.match(code, /is-code/);
  assert.equal(code.includes('Inline styles options'), false);
});

// The chip rules of the real stylesheet, ranked as selectorChipColour.test.js ranks them.
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
const button = document.createElement('button');
function cascade(className, { hover }) {
  button.className = hover ? `${className} test-hover` : className;
  const winners = {};
  const compare = (left, right) => {
    for (let index = 0; index < 3; index += 1) {
      if (left.specificity[index] !== right.specificity[index]) {
        return left.specificity[index] - right.specificity[index];
      }
    }
    return left.order - right.order;
  };
  for (const rule of chipRules.filter((entry) => button.matches(entry.selector.replace(/:hover/g, '.test-hover'))).sort(compare)) {
    Object.assign(winners, rule.declarations);
  }
  return winners;
}

test('the chip is amber in every state, with distinct rest, hover and active fills', () => {
  for (const state of ['editable', 'code']) {
    const rest = cascade(model.inlineChipClassName({ state, active: false }), { hover: false });
    const hover = cascade(model.inlineChipClassName({ state, active: false }), { hover: true });
    const active = cascade(model.inlineChipClassName({ state, active: true }), { hover: false });
    const activeHover = cascade(model.inlineChipClassName({ state, active: true }), { hover: true });
    assert.equal(rest.background, 'var(--color-inline-tag-bg)', state);
    assert.equal(hover.background, 'var(--color-inline-tag-bg-hover)', state);
    assert.equal(active.background, 'var(--color-inline-tag-bg-active)', state);
    assert.equal(activeHover.background, 'var(--color-inline-tag-bg-active)', state);
    assert.equal(rest.color, 'var(--color-inline-tag)', state);
    assert.equal(hover.color, 'var(--color-inline-tag)', state);
    assert.equal(active.color, '#fff', state);
    assert.equal(activeHover.color, '#fff', state);
  }
  const tokens = fs.readFileSync(repoPath('src/features/style/tokens.css'), 'utf8');
  for (const token of ['--color-inline-tag:', '--color-inline-tag-bg:', '--color-inline-tag-bg-hover:', '--color-inline-tag-bg-active:']) {
    assert.ok(tokens.includes(token), token);
  }
});

test('one panel write is one page edit: one gesture, one declaration request', () => {
  const before = 'color: red; margin: 0';
  const write = model.inlineStyleWrite(before, ['color'], model.inlineDeclaration('blue', { important: false }));
  const gesture = model.inlineStyleGesture('n1', { before, after: write.next }, { coalesceKey: 'prop:n1:style', urgency: true });
  const requests = gesture.request(() => 'ref', undefined);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].tag, 'set-inline-style');
  assert.equal(requests[0].property, 'color');
  assert.deepEqual(requests[0].declaration, { tag: 'set', value: 'blue' });
});

test('an expression, a conditional or a template style always shows the chip', () => {
  const shapes = {
    expression: ['styles', 'code'],
    conditional: ['maxWidth ? `--_mw: ${maxWidth}ch;` : undefined', 'branched'],
    nested: ['maxWidth ? `--_mw: ${maxWidth}ch;` : render ? "color: red" : undefined', 'branched'],
    template: ['`color: ${color}; width: 2px`', 'branched'],
  };
  for (const [name, [value, kind]] of Object.entries(shapes)) {
    const style = model.inlineStyleOf({ props: { style: { type: 'expr', value } } });
    assert.equal(style.kind, kind, name);
    assert.equal(model.inlineChipShown(style, { writable: true, pseudo: false }), true, name);
    assert.equal(model.inlineChipShown(style, { writable: true, pseudo: true }), false, `${name}: not on a ::before row`);
  }
  // A readable string needs a host that can write it back.
  const plain = model.inlineStyleOf({ props: { style: { type: 'string', value: 'color: red' } } });
  assert.equal(model.inlineChipShown(plain, { writable: false, pseudo: false }), false);
  assert.equal(model.inlineChipShown(plain, { writable: true, pseudo: false }), true);
});

const HEADING_FILE =
  '---\nconst { maxWidth, render = true } = Astro.props;\n---\n{render && (\n  <Tag\n    style={maxWidth ? `--_mw: ${maxWidth}ch;` : render ? "color: red" : undefined}\n  />\n)}\n';

test('an instance whose component writes a style edits it in the component file, by branch', () => {
  const none = model.inlineStyleOf({ props: {} });
  const component = { path: '/p/src/components/Heading.astro', text: HEADING_FILE };
  const rendered = model.chipInlineStyle(none, { instance: true, style: '--_mw: 30ch;', component });
  assert.equal(rendered.kind, 'branched');
  assert.equal(rendered.source.kind, 'component');
  assert.equal(rendered.source.fileName, 'Heading.astro');
  assert.equal(HEADING_FILE.slice(rendered.source.start, rendered.source.end), rendered.expression);
  assert.deepEqual(
    rendered.branches.map((branch) => branch.label),
    ['when maxWidth is set', 'otherwise (render is set)', 'otherwise'],
  );
  // Without the component's file, what the canvas rendered is shown read-only.
  const unread = model.chipInlineStyle(none, { instance: true, style: '--_mw: 30ch;', component: undefined });
  assert.equal(unread.kind, 'code');
  assert.equal(unread.code, 'element.style {\n  --_mw: 30ch;\n}');
  assert.deepEqual(model.chipInlineStyle(none, { instance: true, style: '  ', component }), none);
  assert.deepEqual(model.chipInlineStyle(none, { instance: true, style: undefined, component }), none);
  // A plain element's rendered style is its own attribute, read from the page.
  assert.deepEqual(model.chipInlineStyle(none, { instance: false, style: 'color: red', component }), none);
  // The instance's own `style` prop comes first: it is what is edited.
  const own = model.inlineStyleOf({ props: { style: { type: 'string', value: 'color: red' } } });
  assert.equal(model.chipInlineStyle(own, { instance: true, style: 'color: red; --_mw: 3ch', component }), own);
});

test('code is shown read-only and readably: branches, placeholders, nothing for undefined', () => {
  assert.equal(
    model.readableStyleCode('maxWidth ? `--_mw: ${maxWidth}ch;` : undefined'),
    'element.style {\n  /* when maxWidth is set */\n  --_mw: {maxWidth}ch;\n}',
  );
  assert.equal(model.readableStyleCode('`color: ${color}; width: 2px`'), 'element.style {\n  color: {color};\n  width: 2px;\n}');
  assert.equal(model.readableStyleCode('dark && "color: white"'), 'element.style {\n  /* when dark is set */\n  color: white;\n}');
  assert.equal(model.readableStyleCode('styles'), 'element.style {\n  {styles}\n}');
  assert.equal(model.readableStyleCode('undefined'), 'element.style {\n  /* renders no declarations */\n}');
  // `?.` and `??` are not conditionals.
  assert.deepEqual(model.styleBranches('theme?.style ?? "color: red"'), [{ when: undefined, css: '{theme?.style ?? "color: red"}' }]);
  // A string the declaration reader cannot hold is shown as written.
  assert.equal(model.inlineStyleOf(string('color red')).code, 'element.style {\n  color red;\n}');
});

test('the component’s style expression is found in its template, not its frontmatter', () => {
  const source =
    '---\nconst style = { a: 1 };\nconst x = `style={nope}`;\n---\n{render && (\n  <Tag class="heading"\n    style={maxWidth ? `--_mw: ${maxWidth}ch;` : undefined}\n  >hi</Tag>\n)}\n';
  assert.equal(model.styleExpressionInSource(source), 'maxWidth ? `--_mw: ${maxWidth}ch;` : undefined');
  assert.equal(model.styleExpressionInSource('<div class="a">'), undefined);
  assert.equal(model.styleExpressionInSource('<div style={open'), undefined);
});
