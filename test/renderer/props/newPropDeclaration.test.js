// Goal: a prop made from the binding picker is written into the component's
// frontmatter exactly as a person would write it, and read back the same way.
//
// Method: the pure modules, bundled as the app bundles them. Each case starts
// from a frontmatter as text and checks the text that comes out: the member
// in `interface Props` (with its tooltip and settings as JSDoc), the entry in
// the `Astro.props` destructure (with its default), both created when absent,
// and every other byte kept. The negative space is tested beside each case:
// names already taken, defaults that do not fit their settings, a second
// rest binding, a `type Props` the edit cannot extend (an attributes prop
// intersects it), a tag astro/types does not type, a frontmatter that does not
// parse, and disconnecting an attributes prop. Then the readers:
// settings tags round-trip through readPropDocumentation, the attributes
// prop's tag and tooltip read back, and the picker's fit and naming rules.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const declaration = load('src/editor/propDeclaration.ts');
const documentation = load('src/editor/propDocumentation.ts');
const model = load('src/features/props/newPropModel.ts');

const NONE = { min: undefined, max: undefined, decimals: undefined };
const declare = (fields) => ({ tooltip: '', defaultText: '', options: [], number: NONE, attributes: [], tag: '', ...fields });
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
  assert.equal(out.value.frontmatter, 'interface Props {\n\tcount?: number;\n}\nconst { count = 3 } = Astro.props;\nconst other = 1;\n');
  const empty = declared('', { key: 'label', kind: 'string' });
  assert.ok(empty.ok);
  assert.equal(empty.value.frontmatter, 'interface Props {\n\tlabel?: string;\n}\nconst { label } = Astro.props;\n', 'an empty default is no default');
});

test('a destructure without an interface keeps its props typed in the new interface', () => {
  const out = declared('const { title = "Hi", size = 2, on = true, data } = Astro.props;\n', { key: 'label', kind: 'string' });
  assert.ok(out.ok);
  assert.match(
    out.value.frontmatter,
    /^interface Props \{\n\ttitle\?: string;\n\tsize\?: number;\n\ton\?: boolean;\n\tdata\?: unknown;\n\tlabel\?: string;\n\}\n/,
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
  assert.match(out.value.frontmatter, /\/\*\* Card count shown in the badge\n\t \* @min 0\n\t \* @max 10\n\t \* @decimals 0 \*\/\n\tcount\?: number;/);
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

test('a switch writes no label tags, and its default is true or false', () => {
  const out = declared('', { key: 'shown', kind: 'boolean', defaultText: 'true' });
  assert.ok(out.ok);
  assert.match(out.value.frontmatter, /\tshown\?: boolean;\n\}\nconst \{ shown = true \}/);
  assert.doesNotMatch(out.value.frontmatter, /@onLabel|@offLabel/);
  // An old doc's labels are ignored: no switch settings are read from it.
  assert.equal('switch' in documentation.readPropDocumentation('@onLabel Visible'), false);
  assert.equal(documentation.readPropDocumentation('Shown. @onLabel Visible').tooltip, 'Shown.');
  assert.equal(declared('', { key: 'shown', kind: 'boolean', defaultText: 'yes' }).error, 'The default is on or off.');
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

test('the Attributes header’s purple + declares rest typed by the tag, across every Props shape, once', () => {
  const host = { propKeys: ['title'], restLocal: undefined };
  const write = (frontmatter, tag) => {
    const offer = model.restConnectOffer(host, { tag, connected: false });
    assert.equal(offer.kind, 'declare');
    return declaration.declaredProp(frontmatter, offer.declaration, new Set(['title']));
  };
  // Each tag gets its own attributes type: an input's `type`, an img's `alt`, a button's `disabled`.
  for (const tag of ['a', 'input', 'img', 'button']) {
    const out = write('interface Props {\n  title?: string;\n}\nconst { title } = Astro.props;\n', tag);
    assert.ok(out.ok);
    assert.equal(
      out.value.frontmatter,
      `interface Props extends HTMLAttributes<"${tag}"> {\n  title?: string;\n}\nconst { title, ...rest } = Astro.props;\n`,
      `${tag}: the extends and the rest entry are the only new text`,
    );
    assert.deepEqual(
      out.value.imports.map((entry) => `${entry.name} ${entry.path} ${entry.typeOnly}`),
      ['HTMLAttributes astro/types true'],
    );
  }
  const alias = write('type Props = { title?: string };\nconst { title } = Astro.props;\n', 'a');
  assert.ok(alias.ok);
  assert.equal(alias.value.frontmatter, 'type Props = { title?: string } & HTMLAttributes<"a">;\nconst { title, ...rest } = Astro.props;\n');
  const extended = write('interface Props extends Base {}\nconst { title, count = 2 } = Astro.props;\n', 'button');
  assert.ok(extended.ok);
  assert.equal(extended.value.frontmatter, 'interface Props extends Base, HTMLAttributes<"button"> {}\nconst { title, count = 2, ...rest } = Astro.props;\n');
  const custom = write('', 'my-card');
  assert.ok(custom.ok);
  assert.match(custom.value.frontmatter, /^interface Props extends astroHTML\.JSX\.HTMLAttributes \{/, 'a custom element: the global type');
  assert.deepEqual(custom.value.imports, [], 'which needs no import');
  // Idempotent: once the rest binding exists the + only spreads it, so a second press declares nothing.
  assert.equal(declaration.readRestBinding(extended.value.frontmatter).local, 'rest');
  assert.deepEqual(model.restConnectOffer({ propKeys: ['title'], restLocal: 'rest' }, { tag: 'button', connected: false }), { kind: 'spread', local: 'rest' });
  assert.equal(model.restConnectOffer({ propKeys: [], restLocal: 'rest' }, { tag: 'button', connected: true }), undefined, 'connected: the chip shows');
  assert.equal(model.restConnectOffer(undefined, { tag: 'a', connected: false }), undefined, 'a page: no prop to connect');
  assert.equal(model.restConnectOffer(host, { tag: 'Button', connected: false }), undefined, 'an instance: its attributes are its props');
  assert.equal(
    model.restConnectOffer({ propKeys: ['rest'], restLocal: undefined }, { tag: 'a', connected: false }).declaration.key,
    'rest2',
    'a taken name is numbered',
  );
  assert.throws(() => model.restDeclaration({ propKeys: [], restLocal: 'rest' }, 'a'), /passes its attributes on once/);
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

test('a type Props alias is intersected with HTMLAttributes, a union in parentheses', () => {
  const object = declared('type Props = { title?: string };\nconst { title } = Astro.props;\n', { key: 'rest', kind: 'attributes', tag: 'img' });
  assert.ok(object.ok);
  assert.equal(object.value.frontmatter, 'type Props = { title?: string } & HTMLAttributes<"img">;\nconst { title, ...rest } = Astro.props;\n');
  assert.equal(declaration.attributesTag(object.value.frontmatter), 'img');
  assert.deepEqual(object.value.imports, [{ name: 'HTMLAttributes', path: 'astro/types', named: true, typeOnly: true }]);
  const union = declared('type Props = { a: string } | { b: number };\n', { key: 'rest', kind: 'attributes', tag: 'a' });
  assert.ok(union.ok);
  assert.match(union.value.frontmatter, /^type Props = \(\{ a: string \} \| \{ b: number \}\) & HTMLAttributes<"a">;\n/);
  assert.match(
    declared('type Props = { a: string };\n', { key: 'label', kind: 'string' }).error,
    /declares its props as a type/,
    'a member still cannot be added to one',
  );
});

test('a tag astro/types does not type extends the global attributes type, with no import', () => {
  const custom = declared('', { key: 'rest', kind: 'attributes', tag: 'my-card' });
  assert.ok(custom.ok);
  assert.equal(custom.value.frontmatter, 'interface Props extends astroHTML.JSX.HTMLAttributes {\n}\nconst { ...rest } = Astro.props;\n');
  assert.deepEqual(custom.value.imports, []);
  assert.equal(declaration.attributesTag(custom.value.frontmatter), undefined, 'no tag: an instance takes any name');
  assert.equal(declaration.attributesTyped(custom.value.frontmatter), true);
  assert.equal(declaration.attributesBase('template'), 'astroHTML.JSX.HTMLAttributes');
  assert.equal(declaration.attributesBase('button'), 'HTMLAttributes<"button">');
  const typed = declared('interface Props extends HTMLAttributes<"p"> {}\n', { key: 'rest', kind: 'attributes', tag: 'p' });
  assert.ok(typed.ok);
  assert.deepEqual(typed.value.imports, [], 'already typed: nothing new names HTMLAttributes');
});

test('a frontmatter that does not parse is refused, not rewritten', () => {
  const broken = declared('interface Props {\n  title?: string\nconst { title = } = Astro.props;\n', { key: 'rest', kind: 'attributes', tag: 'img' });
  assert.equal(broken.error, 'Fix the code in this component’s frontmatter before connecting its attributes.');
});

test('disconnecting releases the rest binding, its typing and its tooltip, and nothing else', () => {
  const connected = declared('interface Props extends Base {\n  title?: string;\n}\nconst { title } = Astro.props;\n', {
    key: 'rest',
    kind: 'attributes',
    tag: 'img',
    tooltip: 'Extra',
  });
  assert.ok(connected.ok);
  assert.equal(
    declaration.restReleased(connected.value.frontmatter, 'rest'),
    'interface Props extends Base {\n  title?: string;\n}\nconst { title } = Astro.props;\n',
  );
  const alone = declared('', { key: 'rest', kind: 'attributes', tag: 'img' });
  assert.ok(alone.ok);
  assert.equal(declaration.restReleased(alone.value.frontmatter, 'rest'), 'interface Props {\n}\n', 'a destructure of the rest alone goes');
  const alias = declared('type Props = { a: string } | { b: number };\nconst { a } = Astro.props;\n', { key: 'rest', kind: 'attributes', tag: 'a' });
  assert.ok(alias.ok);
  assert.equal(declaration.restReleased(alias.value.frontmatter, 'rest'), 'type Props = ({ a: string } | { b: number });\nconst { a } = Astro.props;\n');
  const read = 'interface Props extends HTMLAttributes<"img"> {}\nconst { ...rest } = Astro.props;\nconst id = rest.id;\n';
  assert.equal(declaration.restReleased(read, 'rest'), undefined, 'the frontmatter still reads it');
  assert.equal(declaration.restReleased(read, 'other'), undefined, 'not this component’s rest binding');
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
  assert.equal(model.fitOfFieldType('style'), 'text', 'a style attribute offers the same rows a class field does');
  assert.equal(model.literalOf({ type: 'expr', value: '3' }), '3');
  assert.equal(model.literalOf({ type: 'expr', value: 'post.title' }), '', 'an expression is not a default');
});

test('the schema reader turns the number settings into the instance field’s bounds', () => {
  const types = load('electron/parse/propModel/propProse.ts');
  assert.deepEqual({ ...types.numberRules('Count\n@min 0\n@max 10\n@decimals 2') }, { min: 0, max: 10, step: 0.01 });
  assert.deepEqual({ ...types.numberRules('@decimals 0') }, { step: 1 }, 'no decimals is a whole number');
  assert.deepEqual({ ...types.numberRules('@decimals 99') }, {}, 'decimals past the bound is ignored');
});
