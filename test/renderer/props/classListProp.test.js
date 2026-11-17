// Goal: "New Class list property" moves an element's classes into
// `class:list` with the new prop last, for every shape a class can be written
// in, and refuses, with the reason, every shape it cannot rewrite without
// guessing what the page means.
//
// Method: the pure modules, bundled as the app bundles them. Each shape goes
// in as the attribute list the parser gives and comes out as the list the
// element is written with: the classes as quoted words, an expression as the
// list's first entry, an existing list appended to with its layout kept, and
// every other attribute in its place. The negative space is tested beside it:
// a component tag, a spread that could pass its own class, a component that
// already declares `class`, and values that do not read as one expression.
// Then the declaration: `class?: string` read as `class: className`, and the
// alias when that name is taken.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const model = load('src/features/props/classListProp.ts');
const declaration = load('src/editor/propDeclaration.ts');
const newProp = load('src/features/props/newPropModel.ts');

const text = (value) => ({ type: 'string', value });
const code = (value) => ({ type: 'expr', value });
const rewrite = (props, restLocal = undefined) => model.withClassListProp(props, 'className', restLocal);
const HOST = { propKeys: ['title'], restLocal: undefined };
const element = (props, name = 'div') => ({ kind: 'element', name, props });

// ── Shapes it rewrites ──────────────────────────────────────────────────────

test('static classes become quoted words with the prop last, in the place of class', () => {
  const out = rewrite({ id: text('hero'), class: text('card  hero'), 'data-x': code('x') });
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.value), ['id', 'class:list', 'data-x'], 'class:list takes class’s place; the rest keep theirs');
  assert.deepEqual(out.value['class:list'], code('["card", "hero", className]'));
  assert.deepEqual(out.value.id, text('hero'), 'another attribute is passed through as it was');
  assert.equal(Object.hasOwn(out.value, 'class'), false, 'the class moved into the list');
});

test('no class, or an empty one, gives a list of just the prop', () => {
  const none = rewrite({ id: text('a') });
  assert.ok(none.ok);
  assert.deepEqual(Object.keys(none.value), ['id', 'class:list'], 'a new list goes last');
  assert.deepEqual(none.value['class:list'], code('[className]'));
  const bare = rewrite({ class: { type: 'bare' } });
  assert.ok(bare.ok);
  assert.deepEqual(bare.value['class:list'], code('[className]'));
  const blank = rewrite({ class: text('   ') });
  assert.ok(blank.ok);
  assert.deepEqual(blank.value['class:list'], code('[className]'));
});

test('a class expression is the list’s first entry', () => {
  const reference = rewrite({ class: code('tone') });
  assert.ok(reference.ok);
  assert.deepEqual(reference.value['class:list'], code('[tone, className]'));
  const template = rewrite({ class: code('`card ${tone}`') });
  assert.ok(template.ok);
  assert.deepEqual(template.value['class:list'], code('[`card ${tone}`, className]'));
  const ternary = rewrite({ class: code(' on ? "a" : "b" ') });
  assert.ok(ternary.ok);
  assert.deepEqual(ternary.value['class:list'], code('[on ? "a" : "b", className]'), 'trimmed, and whole');
});

test('an existing class:list array is appended to, its layout kept', () => {
  const line = rewrite({ 'class:list': code('["card", on && "is-on"]') });
  assert.ok(line.ok);
  assert.deepEqual(line.value['class:list'], code('["card", on && "is-on", className]'));
  const lines = rewrite({ 'class:list': code('[\n      "button",\n      variant,\n    ]') });
  assert.ok(lines.ok);
  assert.deepEqual(lines.value['class:list'], code('[\n      "button",\n      variant,\n      className,\n    ]'), 'one entry per line, trailing comma kept');
  const empty = rewrite({ 'class:list': code('[]') });
  assert.ok(empty.ok);
  assert.deepEqual(empty.value['class:list'], code('[className]'));
  const object = rewrite({ 'class:list': code('{ "is-on": on }') });
  assert.ok(object.ok);
  assert.deepEqual(object.value['class:list'], code('[{ "is-on": on }, className]'), 'any other list is wrapped, as class:list flattens it');
});

test('a class beside a class:list stays as it was', () => {
  const out = rewrite({ class: text('card'), 'class:list': code('[x]') });
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.value), ['class', 'class:list']);
  assert.deepEqual(out.value.class, text('card'));
  assert.deepEqual(out.value['class:list'], code('[x, className]'));
});

test('the component’s own rest props may be spread: declaring class takes it out of them', () => {
  const out = rewrite({ class: text('card'), '...rest': { type: 'spread', value: 'rest' } }, 'rest');
  assert.ok(out.ok);
  assert.deepEqual(Object.keys(out.value), ['class:list', '...rest']);
});

test('a value picked from the data joins a class list', () => {
  assert.deepEqual(model.classListAppended(code('["card"]'), 'post.tone'), code('["card", post.tone]'));
  assert.deepEqual(model.classListAppended({ type: 'bare' }, 'tone'), code('[tone]'));
  assert.equal(model.classListAppended(code('["card"'), 'tone'), undefined, 'a broken list is left alone');
  assert.equal(model.classListAppended({ type: 'spread', value: 'rest' }, 'tone'), undefined);
});

// ── Shapes it refuses ───────────────────────────────────────────────────────

test('a spread that could pass its own class is refused', () => {
  const props = { class: text('card'), '...Astro.props': { type: 'spread', value: 'Astro.props' } };
  assert.deepEqual(rewrite(props), { ok: false, error: 'spread' });
  assert.deepEqual(
    rewrite({ class: text('card'), '...rest': { type: 'spread', value: 'rest' } }),
    { ok: false, error: 'spread' },
    'rest is not the component’s',
  );
  assert.equal(model.classListRefusal(element(props), HOST), 'spread');
});

test('a value that is not one expression is refused, never guessed at', () => {
  assert.deepEqual(rewrite({ class: code('a, b') }), { ok: false, error: 'shape' }, 'a sequence would split in two');
  assert.deepEqual(rewrite({ class: code('a +') }), { ok: false, error: 'shape' });
  assert.deepEqual(rewrite({ class: code('') }), { ok: false, error: 'shape' });
  assert.deepEqual(rewrite({ 'class:list': code('[a, b') }), { ok: false, error: 'shape' });
  assert.deepEqual(rewrite({ 'class:list': code('[a], [b]') }), { ok: false, error: 'shape' });
});

test('a component tag, or a component that already has class, is refused', () => {
  assert.equal(model.classListRefusal({ kind: 'component', name: 'Card', props: {} }, HOST), 'component');
  assert.equal(model.classListRefusal({ kind: 'element', name: 'Card', props: {} }, HOST), 'component', 'a capitalised tag is a component');
  assert.equal(model.classListRefusal(element({}), { propKeys: ['class'], restLocal: undefined }), 'taken');
  assert.equal(model.classListRefusal(element({ class: text('card') }), HOST), undefined);
  assert.equal(model.classListRefusal(element({}, 'my-widget'), HOST), undefined, 'a custom element is an HTML element');
});

test('the offer writes the rewrite through the host, and only in a component', () => {
  const written = [];
  const offer = model.classListOfferOf(element({ class: text('card') }), HOST, (props) => written.push(props));
  assert.ok(offer);
  assert.equal(offer.refusal, undefined);
  offer.onCreated('className');
  assert.deepEqual(written, [{ 'class:list': code('["card", className]') }]);
  assert.equal(
    model.classListOfferOf(element({}), undefined, () => {}),
    undefined,
    'no component, no row',
  );
  assert.equal(model.classListOfferOf(element({}), HOST, undefined), undefined, 'no way to write the element, no row');
  const refused = model.classListOfferOf({ kind: 'component', name: 'Card', props: {} }, HOST, () => {});
  assert.equal(refused.refusal, 'component');
  assert.throws(() => refused.onCreated('className'), /Assertion failed: classListOfferOf: a refused row/, 'a refused shape is never written');
});

test('an invalid local is a programmer error', () => {
  assert.throws(() => model.withClassListProp({}, 'class name', undefined), /Assertion failed: withClassListProp: the prop is read by an identifier/);
});

// ── The declaration ─────────────────────────────────────────────────────────

const NONE = { min: undefined, max: undefined, decimals: undefined };
const classProp = (fields) => ({ tooltip: '', defaultText: '', options: [], number: NONE, attributes: [], tag: '', kind: 'string', key: 'class', ...fields });

test('a class list prop is `class?: string`, read as className', () => {
  const local = model.classListLocal(model.CLASS_LIST_SEED, 'class');
  assert.equal(local, 'className');
  const out = declaration.declaredProp('interface Props {\n  title?: string;\n}\nconst { title } = Astro.props;\n', classProp({ local }), new Set(['title']));
  assert.ok(out.ok);
  assert.equal(out.value.frontmatter, 'interface Props {\n  title?: string;\n  class?: string;\n}\nconst { title, class: className } = Astro.props;\n');
  assert.equal(out.value.local, 'className');
});

test('className taken, or a name asked for that is reserved, falls back to the alias', () => {
  const taken = declaration.declaredProp('const className = "x";\n', classProp({ local: 'className' }), new Set(['className']));
  assert.ok(taken.ok);
  assert.equal(taken.value.local, 'propClass');
  const reserved = declaration.declaredProp('', classProp({ local: 'default' }), new Set());
  assert.ok(reserved.ok);
  assert.equal(reserved.value.local, 'propClass');
  assert.equal(model.classListLocal(model.CLASS_LIST_SEED, 'extraClasses'), undefined, 'another name is read by itself');
  assert.equal(model.classListLocal({ fit: 'text' }, 'class'), undefined, 'a Plain Text prop keeps its own naming');
});

test('the picker names the kind and fits text props to it', () => {
  assert.equal(newProp.newPropTitle('classList'), 'Class list');
  assert.deepEqual(newProp.FIT_KINDS.classList, ['string']);
  assert.equal(newProp.propFits('string', 'classList'), true);
  assert.equal(newProp.propFits('boolean', 'classList'), false);
  assert.equal(newProp.suggestedPropName(newProp.seedName(model.CLASS_LIST_SEED), HOST), 'class');
});
