// Goal: a Properties panel save writes exactly the change it was given. A save
// with nothing changed leaves the file byte-identical; a changed save edits
// only the changed member's text (its doc comment, name, modifiers, type, or
// its destructure entry) and keeps every other byte: other members' comments,
// separators, union layout, inline annotations and the template. A component
// that types its props another way, or forwards attributes through an untyped
// `...rest`, is never given an `interface Props`.
//
// Method: every component of the prop zoo (test/fixtures/propZoo, the
// stress-test fixture written the way agents write props) is read with
// `readComponentProperties`, and each property is saved four ways through
// `editPropertyDefinition`: unchanged, with a new tooltip, a new default and
// the required flag flipped. Every accepted save must read back with the
// change and with every other property exactly as before; refusals must say
// why. Hand-written cases then pin the exact bytes for the shapes the stress
// test found being rewritten (docs/plans/prop-stress-findings.md).
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { repoPath } = require('../../helpers/sources.js');
const { readComponentProperties, editPropertyDefinition } = require('#dist/electron/properties/propertyDefinitions.js');

const COMPONENTS = repoPath('test/fixtures/propZoo/src/components');
const FIELDS = ['name', 'type', 'required', 'readonly', 'defaultValue', 'description'];
const stated = (property) => Object.fromEntries(FIELDS.map((key) => [key, property[key]]));
const templateOf = (source) => source.slice(source.indexOf('---', 3));
const save = (property, overrides) => ({ kind: 'save', originalName: property.name, property: { ...property, ...overrides } });

function value(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

function readZoo() {
  return fs
    .readdirSync(COMPONENTS)
    .filter((file) => file.endsWith('.astro'))
    .sort()
    .map((file) => ({ name: path.basename(file, '.astro'), source: fs.readFileSync(path.join(COMPONENTS, file), 'utf8') }));
}

// The change a variant makes to a property, given how it reads now.
const VARIANTS = {
  tooltip: (property) => ({ description: property.description ? `${property.description} Edited.` : 'A new tooltip.' }),
  default: (property) => ({ defaultValue: property.defaultValue === '"zoo"' ? '"edited"' : '"zoo"', type: property.type === 'unknown' ? 'unknown' : 'string' }),
  required: (property) => ({ required: !property.required }),
};

test('an unchanged save of every zoo property writes nothing', () => {
  let saved = 0;
  for (const { name, source } of readZoo()) {
    for (const property of readComponentProperties(source).properties) {
      const result = editPropertyDefinition(source, { kind: 'save', originalName: property.name, property });
      if (result.ok) {
        assert.equal(result.value, source, `${name}.${property.name}: an unchanged save rewrote the file`);
        saved += 1;
      } else {
        assert.ok(result.error.message.length > 0, `${name}.${property.name}: a refusal says why`);
      }
    }
  }
  assert.ok(saved > 150, 'most zoo properties are saved, not refused');
});

test('a changed save of every zoo property changes that property alone', () => {
  let changed = 0;
  for (const { name, source } of readZoo()) {
    const before = readComponentProperties(source).properties;
    for (const property of before) {
      for (const [variant, change] of Object.entries(VARIANTS)) {
        const overrides = variant === 'default' ? { defaultValue: VARIANTS.default(property).defaultValue } : change(property);
        const result = editPropertyDefinition(source, save(property, overrides));
        const where = `${name}.${property.name} (${variant})`;
        if (!result.ok) {
          assert.ok(result.error.message.length > 0, `${where}: a refusal says why`);
          continue;
        }
        changed += 1;
        assert.notEqual(result.value, source, `${where}: a change is written`);
        const after = readComponentProperties(result.value).properties;
        const edited = after.find((field) => field.name === property.name);
        assert.ok(edited, `${where}: the property reads back`);
        for (const [key, expected] of Object.entries(overrides)) {
          assert.equal(String(edited[key]).trim(), String(expected).trim(), `${where}: ${key} reads back`);
        }
        for (const other of before.filter((field) => field.name !== property.name)) {
          const reread = after.find((field) => field.name === other.name);
          assert.deepEqual(reread && stated(reread), stated(other), `${where}: ${other.name} is untouched`);
        }
        if (variant !== 'default') {
          // Only a new default rebinds `Astro.props.x` reads in the template.
          assert.equal(templateOf(result.value), templateOf(source), `${where}: the template is untouched`);
        }
      }
    }
  }
  assert.ok(changed > 300, 'most changed saves are written');
});

const zoo = (name) => fs.readFileSync(path.join(COMPONENTS, `${name}.astro`), 'utf8');
const propertyOf = (source, name) => readComponentProperties(source).properties.find((field) => field.name === name);

test('a `//` comment is the tooltip, kept on other saves and replaced by a JSDoc tooltip', () => {
  const source = zoo('CommentsInType');
  const title = propertyOf(source, 'title');
  assert.equal(title.description, 'The title, required.');
  // A default change touches the destructure entry alone.
  const subtitle = propertyOf(source, 'subtitle');
  assert.equal(value(editPropertyDefinition(source, save(subtitle, { defaultValue: "'x'" }))), source.replace("subtitle = 'a; b'", "subtitle = 'x'"));
  // The trailing comment and the `,` separator of `title` survive its tooltip edit.
  assert.equal(value(editPropertyDefinition(source, save(title, { description: 'New tip.' }))), source.replace('// The title, required.', '/** New tip. */'));
  // Flags edit the member's head; `/* no semicolon */` stays.
  const count = propertyOf(source, 'count');
  assert.equal(
    value(editPropertyDefinition(source, save(count, { required: true, readonly: true }))),
    source.replace('count?: number /* no semicolon */', 'readonly count: number /* no semicolon */'),
  );
  // An emptied tooltip takes the comment and its line out.
  assert.equal(value(editPropertyDefinition(source, save(title, { description: '' }))), source.replace('  // The title, required.\n', ''));
});

test('a multi-line JSDoc keeps its layout; only the changed line differs', () => {
  const source = zoo('JsDocProps');
  const columns = propertyOf(source, 'columns');
  assert.match(columns.description, /@max 6/);
  const output = value(editPropertyDefinition(source, save(columns, { description: columns.description.replace('@max 6', '@max 8') })));
  assert.equal(output, source.replace('   * @max 6\n', '   * @max 8\n'));
  const label = propertyOf(source, 'label');
  assert.equal(
    value(editPropertyDefinition(source, save(label, { description: 'Two\nlines' }))),
    source.replace('/** The text on the button. */', '/**\n   * Two\n   * lines\n   */'),
  );
});

test('a multi-line union keeps its leading bars when another field changes', () => {
  const source = zoo('MultiLineUnion');
  const color = propertyOf(source, 'color');
  assert.equal(
    value(editPropertyDefinition(source, save(color, { description: 'The colour.' }))),
    source.replace('/** How the badge is coloured. */', '/** The colour. */'),
  );
  const shape = propertyOf(source, 'shape');
  assert.equal(
    value(editPropertyDefinition(source, save(shape, { type: "'pill' | 'square' | 'round'" }))),
    source.replace("shape?: 'pill' | 'square';", "shape?: 'pill' | 'square' | 'round';"),
  );
});

test('an inline annotation is the props type: it is edited, never shadowed by an interface', () => {
  const source = zoo('InlineAnnotation');
  const count = propertyOf(source, 'count');
  assert.equal(count.type, 'number');
  assert.equal(propertyOf(source, 'title').required, true);
  const output = value(editPropertyDefinition(source, save(count, { type: 'number | string' })));
  assert.equal(output, source.replace('count?: number }', 'count?: number | string }'));
  assert.doesNotMatch(output, /interface Props/);
});

test('an untyped component with `...rest` is never given an interface', () => {
  const source = zoo('RestPropsPlain');
  const label = propertyOf(source, 'label');
  assert.equal(value(editPropertyDefinition(source, save(label, { defaultValue: "'Go'" }))), source.replace("label = 'Link'", "label = 'Go'"));
  const typed = editPropertyDefinition(source, save(label, { type: 'number' }));
  assert.equal(typed.ok, false);
  assert.equal(typed.error.code, 'untyped');
  assert.match(typed.error.message, /\.\.\.rest/);
  assert.equal(editPropertyDefinition(source, { kind: 'order', names: ['label'] }).ok, false);
  // A new prop with nothing to type is a destructure entry alone.
  const added = value(
    editPropertyDefinition(source, {
      kind: 'save',
      originalName: '',
      property: { name: 'size', type: 'unknown', required: false, readonly: false, defaultValue: '2', description: '' },
    }),
  );
  assert.doesNotMatch(added, /interface Props/);
  assert.match(added, /const \{ size = 2, label = 'Link', \.\.\.rest \} = Astro\.props;/);
});

test('an untyped component without rest gets an interface only for a type change, in panel order', () => {
  const source = zoo('NoTypeDestructure');
  const title = propertyOf(source, 'title');
  assert.equal(value(editPropertyDefinition(source, save(title, { defaultValue: "'Other'" }))), source.replace("'No types here'", "'Other'"));
  const output = value(editPropertyDefinition(source, save(title, { type: 'number' })));
  assert.deepEqual(
    readComponentProperties(output).properties.map((field) => field.name),
    ['title', 'count', 'active'],
  );
  assert.equal(propertyOf(output, 'title').type, 'number');
});

test('a destructured prop missing from Props gets a member only when its declaration changes', () => {
  const source = zoo('DefaultsMismatch');
  const extra = propertyOf(source, 'extra');
  assert.equal(value(editPropertyDefinition(source, save(extra, { defaultValue: "'y'" }))), source.replace("extra = 'not in Props'", "extra = 'y'"));
  const declared = value(editPropertyDefinition(source, save(extra, { type: 'number' })));
  assert.match(declared, /\n {2}extra\?: number;\n\}/);
});

test('renames edit the key, keep the local, and shorthand returns when the names meet again', () => {
  const source = '---\ninterface Props {\n  /** Tip. */\n  title?: string;\n}\nconst { title = "A" } = Astro.props;\n---\n<h1>{title}</h1>';
  const title = propertyOf(source, 'title');
  const renamed = value(editPropertyDefinition(source, save(title, { name: 'heading' })));
  assert.equal(renamed, source.replace('title?: string', 'heading?: string').replace('{ title = "A" }', '{ heading: title = "A" }'));
  const heading = propertyOf(renamed, 'heading');
  const back = value(editPropertyDefinition(renamed, { kind: 'save', originalName: 'heading', property: { ...heading, name: 'title' } }));
  assert.equal(back, source);
  // Removing a default drops ` = …` and nothing else.
  assert.equal(value(editPropertyDefinition(source, save(title, { defaultValue: '' }))), source.replace(' = "A"', ''));
});

test('a doc comment sharing its member’s line is its tooltip; one trailing the member before is not', () => {
  const source = '---\ninterface Props { /** Inline. */ title?: string; count?: number /** Trails count. */\n  mode?: string }\n---\n<p/>';
  assert.equal(propertyOf(source, 'title').description, 'Inline.');
  assert.equal(propertyOf(source, 'count').description, '');
  assert.equal(propertyOf(source, 'mode').description, '');
  // A member that does not open its line gets its new tooltip inline.
  const count = propertyOf(source, 'count');
  assert.equal(value(editPropertyDefinition(source, save(count, { description: 'Count.' }))), source.replace('count?: number', '/** Count. */ count?: number'));
  const title = propertyOf(source, 'title');
  assert.equal(value(editPropertyDefinition(source, save(title, { description: 'Other.' }))), source.replace('Inline.', 'Other.'));
});
