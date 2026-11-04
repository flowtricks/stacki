// Goal: a prop made from the binding picker is written into the component's
// frontmatter exactly as a person would write it, and read back the same way.
//
// Method: the pure modules, bundled as the app bundles them. Each case starts
// from a frontmatter as text and checks the text that comes out: the member
// in `interface Props` (with its tooltip and settings as JSDoc), the entry in
// the `Astro.props` destructure (with its default), both created when absent,
// and every other byte kept. The negative space is tested beside each case:
// names already taken, defaults that do not fit their settings, a second
// rest binding, a `type Props` the edit cannot extend. Then the readers:
// settings tags round-trip through readPropDocumentation, the attributes
// prop's tag and tooltip read back, and the picker's fit and naming rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const declaration = load('src/editor/propDeclaration.ts');
const documentation = load('src/editor/propDocumentation.ts');
const model = load('src/features/props/newPropModel.ts');

const NONE = { min: undefined, max: undefined, decimals: undefined };
const SWITCH = { onLabel: 'On', offLabel: 'Off' };
const declare = (fields) => ({ tooltip: '', defaultText: '', options: [], number: NONE, switch: SWITCH, attributes: [], tag: '', ...fields });
const declared = (frontmatter, fields, taken = []) => declaration.declaredProp(frontmatter, declare(fields), new Set(taken));

// ── Text, number, switch and option props ───────────────────────────────────

test('a text prop joins interface Props and the destructure, with its tooltip and default', () => {
  const before = 'interface Props {\n  title?: string;\n}\nconst { title = "Hi" } = Astro.props;\nconst other = 1;\n';
  const out = declared(before, { key: 'label', kind: 'string', tooltip: 'The button’s words', defaultText: 'Click me' });
  assert.ok(out.ok);
  assert.equal(
    out.value.frontmatter,
    'interface Props {\n  title?: string;\n  /** The button’s words */\n  label?: string;\n}\nconst { title = "Hi", label = "Click me" } = Astro.props;\nconst other = 1;\n',
  );
  assert.equal(out.value.local, 'label');
});

test('a file with neither gets an interface and a destructure', () => {
  const out = declared('const other = 1;\n', { key: 'count', kind: 'number', defaultText: '3' });
  assert.ok(out.ok);
  assert.equal(out.value.frontmatter, 'interface Props {\n  count?: number;\n}\nconst { count = 3 } = Astro.props;\nconst other = 1;\n');
  const empty = declared('', { key: 'label', kind: 'string' });
  assert.ok(empty.ok);
  assert.equal(empty.value.frontmatter, 'interface Props {\n  label?: string;\n}\nconst { label } = Astro.props;\n', 'an empty default is no default');
});

test('a destructure without an interface keeps its props typed in the new interface', () => {
  const out = declared('const { title = "Hi", size = 2, on = true, data } = Astro.props;\n', { key: 'label', kind: 'string' });
  assert.ok(out.ok);
  assert.match(
    out.value.frontmatter,
    /^interface Props \{\n {2}title\?: string;\n {2}size\?: number;\n {2}on\?: boolean;\n {2}data\?: unknown;\n {2}label\?: string;\n\}\n/,
  );
});

test('a multi-line destructure stays one entry per line, and a rest binding stays last', () => {
  const multi = declared('interface Props {}\nconst {\n  title,\n} = Astro.props;\n', { key: 'label', kind: 'string' });
  assert.ok(multi.ok);
  assert.equal(multi.value.frontmatter, 'interface Props {\n  label?: string;\n}\nconst {\n  title,\n  label,\n} = Astro.props;\n', 'a trailing comma stays');
  const rest = declared('interface Props extends HTMLAttributes<"div"> {}\nconst { title, ...rest } = Astro.props;\n', { key: 'label', kind: 'string' });
  assert.ok(rest.ok);
  assert.match(rest.value.frontmatter, /const \{ title, label, \.\.\.rest \} = Astro\.props;/);
});

test('a name already bound in the frontmatter, or reserved, is read by an alias', () => {
  const taken = declared('const label = "x";\n', { key: 'label', kind: 'string', defaultText: 'Hi' }, ['label']);
  assert.ok(taken.ok);
  assert.equal(taken.value.local, 'propLabel');
  assert.match(taken.value.frontmatter, /const \{ label: propLabel = "Hi" \} = Astro\.props;/);
  const reserved = declared('', { key: 'class', kind: 'string' });
  assert.ok(reserved.ok);
  assert.equal(reserved.value.local, 'propClass');
});

test('number settings are JSDoc tags, and the default has to fit them', () => {
  const settings = { min: 0, max: 10, decimals: 0 };
  const out = declared('', { key: 'count', kind: 'number', tooltip: 'Card count shown in the badge', number: settings, defaultText: '4' });
  assert.ok(out.ok);
  assert.match(out.value.frontmatter, /\/\*\* Card count shown in the badge\n {3}\* @min 0\n {3}\* @max 10\n {3}\* @decimals 0 \*\/\n {2}count\?: number;/);
  const read = documentation.readPropDocumentation('Card count shown in the badge\n@min 0\n@max 10\n@decimals 0');
  assert.deepEqual(read.number, settings);
  assert.equal(read.tooltip, 'Card count shown in the badge');
  assert.equal(declared('', { key: 'count', kind: 'number', number: settings, defaultText: '11' }).error, 'The default has to be at most 10.');
  assert.equal(declared('', { key: 'count', kind: 'number', number: settings, defaultText: '1.5' }).error, 'The default has to be a whole number.');
  assert.equal(declared('', { key: 'count', kind: 'number', number: { min: 5, max: 1, decimals: undefined } }).error, 'Min has to be no more than Max.');
  assert.equal(declared('', { key: 'count', kind: 'number', number: { ...NONE, decimals: 11 } }).error, 'Decimals goes from 0 to 10.');
  assert.equal(declared('', { key: 'count', kind: 'number', defaultText: 'many' }).error, 'The default has to be a number.');
});

test('number settings read back bounded, and a typed number is held to them', () => {
  assert.deepEqual(
    documentation.readPropDocumentation('@min 3 @max 1').number,
    { min: 3, max: undefined, decimals: undefined },
    'a max below the min is dropped',
  );
  assert.equal(documentation.readPropDocumentation('@decimals 1.5').number.decimals, undefined, 'decimals is a whole number');
  assert.equal(documentation.readPropDocumentation('@min lots').number.min, undefined, 'a tag that is not a number is ignored');
  const settings = { min: 0, max: 10, decimals: 1 };
  assert.equal(documentation.settledNumber(12, settings), 10);
  assert.equal(documentation.settledNumber(-1, settings), 0);
  assert.equal(documentation.settledNumber(3.14159, settings), 3.1);
  assert.equal(documentation.numberNote(12, settings), 'The most this takes is 10.');
  assert.equal(documentation.numberNote(3.1, settings), undefined);
  assert.equal(documentation.withoutSettingTags('Shown in the badge @min 0 @max 10'), 'Shown in the badge');
});

test('switch labels are JSDoc tags with On and Off left out, and the default is true or false', () => {
  const out = declared('', { key: 'shown', kind: 'boolean', switch: { onLabel: 'Visible', offLabel: 'Off' }, defaultText: 'true' });
  assert.ok(out.ok);
  assert.match(out.value.frontmatter, /\/\*\* @onLabel Visible \*\/\n {2}shown\?: boolean;\n\}\nconst \{ shown = true \}/);
  assert.deepEqual(documentation.readPropDocumentation('@onLabel Visible').switch, { onLabel: 'Visible', offLabel: 'Off' });
  assert.equal(documentation.statedSwitchLabels('Just words'), undefined, 'a doc without labels keeps the field’s words');
  assert.equal(declared('', { key: 'shown', kind: 'boolean', defaultText: 'yes' }).error, 'The default is on or off.');
  assert.equal(declared('', { key: 'shown', kind: 'boolean', switch: { onLabel: 'a@b', offLabel: 'Off' } }).error, 'A label is one line of words.');
});

test('an option prop is a union of its words, and its default is one of them', () => {
  const out = declared('', { key: 'variant', kind: 'option', options: ['primary', 'secondary'], defaultText: 'primary' });
  assert.ok(out.ok);
  assert.match(out.value.frontmatter, /variant\?: "primary" \| "secondary";[\s\S]*const \{ variant = "primary" \}/);
  assert.equal(declared('', { key: 'variant', kind: 'option', options: [] }).error, 'Add at least one option.');
  assert.equal(declared('', { key: 'variant', kind: 'option', options: ['a', 'a'] }).error, 'Each option has to be different.');
  assert.equal(declared('', { key: 'variant', kind: 'option', options: ['a'], defaultText: 'b' }).error, 'The default has to be one of the options.');
});

test('a taken name, a type alias and an oversized frontmatter are refused, not rewritten', () => {
  assert.equal(declared('const { label } = Astro.props;\n', { key: 'label', kind: 'string' }).error, 'This component already has a label property.');
  assert.equal(declared('interface Props {\n  label?: string;\n}\n', { key: 'label', kind: 'string' }).error, 'This component already has a label property.');
  assert.match(declared('type Props = { a: string };\n', { key: 'label', kind: 'string' }).error, /declares its props as a type/);
  assert.match(declared('x'.repeat(2 * 1024 * 1024 + 1), { key: 'label', kind: 'string' }).error, /too long/);
  assert.throws(() => declared('', { key: '1bad', kind: 'string' }), /named by an identifier/, 'the form validates names before they get here');
});

test('a tooltip cannot close its comment early or read as a tag', () => {
  const out = declared('', { key: 'label', kind: 'string', tooltip: '@see */ this\nand that' });
  assert.ok(out.ok);
  assert.match(out.value.frontmatter, /\/\*\* see \* \/ this and that \*\//);
});

// ── Attributes props: Astro's rest props, typed by HTMLAttributes ──────────

test('an attributes prop is a rest binding and an interface extending HTMLAttributes for its tag', () => {
  const before = 'interface Props {\n  title?: string;\n}\nconst { title = "Default Title" } = Astro.props;\n';
  const out = declared(before, { key: 'rest', kind: 'attributes', tag: 'div', tooltip: 'Extra attributes for the card' });
  assert.ok(out.ok);
  assert.equal(
    out.value.frontmatter,
    '/** @attributes Extra attributes for the card */\ninterface Props extends HTMLAttributes<"div"> {\n  title?: string;\n}\nconst { title = "Default Title", ...rest } = Astro.props;\n',
  );
  assert.equal(declaration.attributesTag(out.value.frontmatter), 'div');
  assert.equal(declaration.restTooltip(out.value.frontmatter), 'Extra attributes for the card');
  assert.equal(declaration.readRestBinding(out.value.frontmatter).local, 'rest');
});

test('an existing extends list gains HTMLAttributes, and one already there is kept', () => {
  const extended = declared('interface Props extends Base {}\n', { key: 'rest', kind: 'attributes', tag: 'a' });
  assert.ok(extended.ok);
  assert.match(extended.value.frontmatter, /^interface Props extends Base, HTMLAttributes<"a"> \{\}\nconst \{ \.\.\.rest \} = Astro\.props;\n$/);
  const already = declared('interface Props extends HTMLAttributes<"p"> {}\n', { key: 'customAttributes', kind: 'attributes', tag: 'a' });
  assert.ok(already.ok);
  assert.equal(declaration.attributesTag(already.value.frontmatter), 'p', 'the first tag stays: an interface cannot extend two');
  const fresh = declared('', { key: 'rest', kind: 'attributes', tag: 'section' });
  assert.ok(fresh.ok);
  assert.equal(fresh.value.frontmatter, 'interface Props extends HTMLAttributes<"section"> {\n}\nconst { ...rest } = Astro.props;\n');
});

test('a component passes its other attributes on once', () => {
  const out = declared('const { ...rest } = Astro.props;\n', { key: 'more', kind: 'attributes', tag: 'div' });
  assert.equal(out.error, 'This component already passes its other attributes on as rest.');
  assert.equal(declared('', { key: 'rest', kind: 'attributes', tag: 'Card' }).error, 'Only an HTML element can take an attributes property.');
  assert.equal(
    declared('', { key: 'rest', kind: 'attributes', tag: 'div', attributes: [{ name: '', value: '1' }] }).error,
    'Each default attribute needs a name.',
  );
});

test('the attributes tooltip is rewritten and removed in place', () => {
  const start = '/** @attributes Old */\ninterface Props extends HTMLAttributes<"div"> {}\n';
  const changed = declaration.withRestTooltip(start, 'New words');
  assert.ok(changed.ok);
  assert.equal(changed.value, '/** @attributes New words */\ninterface Props extends HTMLAttributes<"div"> {}\n');
  const removed = declaration.withRestTooltip(start, '');
  assert.ok(removed.ok);
  assert.equal(removed.value, 'interface Props extends HTMLAttributes<"div"> {}\n');
  const added = declaration.withRestTooltip('interface Props {}\n', 'Hi');
  assert.ok(added.ok);
  assert.equal(added.value, '/** @attributes Hi */\ninterface Props {}\n');
  assert.equal(declaration.withRestTooltip('', 'Hi').ok, false, 'no interface, nothing to describe');
});

// ── What the picker offers ──────────────────────────────────────────────────

test('props fit fields by what they render as', () => {
  assert.equal(model.propFits('number', 'text'), true, 'a number prints as words');
  assert.equal(model.propFits('string', 'number'), false, 'words do not fit a number field');
  assert.equal(model.propFits('boolean', 'text'), false);
  assert.equal(model.propFits('boolean', 'boolean'), true);
  assert.equal(model.propFits('rest props', 'attributes'), true);
  assert.equal(model.propFits('string', 'attributes'), false);
  assert.equal(model.propFits('prop', 'number'), true, 'a prop of unknown type is offered');
  assert.equal(model.propFits('list', 'content'), false);
  const tree = [
    { path: 'title', kind: 'string', section: 'props', children: undefined },
    { path: 'count', kind: 'number', section: 'props', children: undefined },
    { path: 'on', kind: 'boolean', section: 'props', children: undefined },
    { path: 'image', kind: 'object', section: 'props', children: [{ path: 'image.src', kind: 'string' }] },
    { path: 'rest', kind: 'rest props', section: 'props', children: undefined },
    { path: 'posts', kind: 'list', section: 'collections', children: undefined },
  ];
  assert.deepEqual(
    model.fittingTree(tree, 'text').map((node) => node.path),
    ['title', 'count', 'image', 'posts'],
    'other sources stay, as CMS data binds as before',
  );
  assert.deepEqual(
    model.fittingTree(tree, 'number').map((node) => node.path),
    ['count', 'image', 'posts'],
  );
  assert.deepEqual(
    model.fittingTree(tree, 'attributes').map((node) => node.path),
    ['rest'],
    'attributes bind to the rest props only',
  );
});

test('a new prop starts from the field’s label, deduplicated and validated', () => {
  const host = { propKeys: ['text', 'text2'], restLocal: 'rest' };
  assert.equal(model.suggestedPropName('Text', host), 'text3');
  assert.equal(model.suggestedPropName('data-id', host), 'dataId');
  assert.equal(model.suggestedPropName('Custom attributes', host), 'customAttributes');
  assert.equal(model.suggestedPropName('2up', host), 'prop2up');
  assert.equal(model.suggestedPropName('', host), 'property');
  assert.equal(model.suggestedRestName({ propKeys: [], restLocal: undefined }), 'rest');
  assert.equal(model.propNameProblem('', host), 'Give the property a name.');
  assert.equal(model.propNameProblem('my-prop', host), 'Use letters and numbers, starting with a letter.');
  assert.equal(model.propNameProblem('text', host), 'This component already has a text property.');
  assert.equal(model.propNameProblem('rest', host), 'This component already has a rest property.');
  assert.equal(model.propNameProblem('x'.repeat(129), host), 'That name is too long.');
  assert.equal(model.propNameProblem('label', host), undefined);
  assert.equal(model.newPropTitle('text'), 'Plain Text');
  assert.equal(model.newPropTitle('content'), 'Text');
  assert.deepEqual(model.FIT_KINDS.text, ['string', 'option']);
  assert.equal(model.fitOfFieldType('enum', { numeric: true }), 'number');
  assert.equal(model.fitOfFieldType('code'), undefined);
  assert.equal(model.literalOf({ type: 'expr', value: '3' }), '3');
  assert.equal(model.literalOf({ type: 'expr', value: 'post.title' }), '', 'an expression is not a default');
});

test('the schema reader turns the number settings into the instance field’s bounds', () => {
  const types = load('electron/parse/propModel/propProse.ts');
  assert.deepEqual({ ...types.numberRules('Count\n@min 0\n@max 10\n@decimals 2') }, { min: 0, max: 10, step: 0.01 });
  assert.deepEqual({ ...types.numberRules('@decimals 0') }, { step: 1 }, 'no decimals is a whole number');
  assert.deepEqual({ ...types.numberRules('@decimals 99') }, {}, 'decimals past the bound is ignored');
});
