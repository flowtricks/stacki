// Goal: a document's fields are checked against their rules as the Studio would — text limits in
// characters, list limits in items, links by scheme, unique items by content — and only errors
// block publishing. An Astro entry's required fields are missing while empty, which refuses its
// Create and any save that would empty one, and says "… is required".
// Method: fields with rules are checked against valid values, then each kind of invalid one;
// requiredFieldsMissing is fed each value shape, empty and present, on required, optional and
// defaulted fields; the create path is replayed on a pending stats card as it is filled in, and
// the save path on single-field edits of an existing one.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { problemsOf, publishBlockers, requiredFieldsMissing, requiredMessage, saveRefused, valuesOf } = loadRenderer('src/features/cms/remoteValidation.ts');

const error = (kind, more = {}) => ({ level: 'error', kind, ...more });
const messages = (rules, value) => problemsOf({ rules }, value).map((problem) => problem.message);

test('required, limits and lengths read in the value’s own unit', () => {
  assert.deepEqual(messages([error('required')], ''), ['Required']);
  assert.deepEqual(messages([error('required')], 'ok'), []);
  const reference = { _type: 'reference', _ref: 'series-1' };
  assert.deepEqual(messages([error('required')], reference), [], 'a reference is a value');
  const image = { _type: 'image', asset: { _type: 'reference', _ref: 'image-1' } };
  assert.deepEqual(messages([error('required')], image), [], 'so is an image');
  assert.deepEqual(messages([error('max', { limit: 3 })], 'four'), ['At most 3 characters']);
  assert.deepEqual(messages([error('max', { limit: 1 })], ['a', 'b']), ['At most 1 items']);
  assert.deepEqual(messages([error('min', { limit: 10 })], 4), ['At least 10']);
  assert.deepEqual(messages([error('min', { limit: 2 })], ''), [], 'empty is required’s to judge');
});

test('emails, links, unique lists and numbers', () => {
  assert.deepEqual(messages([error('email')], 'pastor@'), ['Not an email address']);
  const uri = error('uri', { schemes: ['https'], relative: false });
  assert.deepEqual(messages([uri], 'http://x.com'), ['Not a valid link']);
  assert.deepEqual(messages([uri], '/about'), ['Not a valid link']);
  assert.deepEqual(messages([{ ...uri, relative: true }], '/about'), []);
  const items = [
    { _key: 'a', _type: 'reference', _ref: 'x' },
    { _key: 'b', _type: 'reference', _ref: 'x' },
  ];
  assert.deepEqual(messages([error('unique')], items), ['Items must be unique']);
  assert.deepEqual(messages([error('integer'), error('positive')], -1.5), ['Must be a whole number', 'Must be positive']);
});

test('only errors block publishing, each named by its field', () => {
  const document = {
    fields: [
      { name: 'name', title: 'Name', rules: [error('required')], value: undefined },
      {
        name: 'blurb',
        title: '',
        rules: [{ level: 'warning', kind: 'max', limit: 2 }],
        value: 'xyz',
      },
    ],
  };
  assert.deepEqual(publishBlockers(document), ['Name: Required']);
});

// Fields as astroRemoteSchema.ts maps them: `required` is false for `.optional()`, `.default()` and nullable.
const field = (name, required, value) => ({ name, title: name, required, rules: required ? [error('required')] : [], value });
const missingOf = (fields) => requiredFieldsMissing(fields, valuesOf({ fields }));

test('each value shape is empty or present, as a required field reads it', () => {
  const empty = [undefined, '', '   ', '\n\t', [], { _type: 'image' }, { _type: 'reference', _ref: '' }];
  for (const value of empty) {
    assert.deepEqual(missingOf([field('x', true, value)]), ['x'], `${JSON.stringify(value)} is empty`);
  }
  const present = ['61.4%', ' a ', 0, false, ['tag'], './cover.jpg', 'authors-ada', { _type: 'reference', _ref: 'ada' }];
  for (const value of present) {
    assert.deepEqual(missingOf([field('x', true, value)]), [], `${JSON.stringify(value)} is a value`);
  }
});

test('optional and defaulted fields never block, and missing fields come in field order', () => {
  const fields = [field('Optional', false, undefined), field('Defaulted', false, ''), field('B', true, ''), field('A', true, [])];
  assert.deepEqual(missingOf(fields), ['B', 'A']);
  assert.deepEqual(missingOf([field('Optional', false, undefined)]), []);
  assert.deepEqual(requiredFieldsMissing(fields, new Map()), ['B', 'A'], 'an absent value is empty');
  assert.equal(requiredMessage({ name: 'Number', title: 'Number' }), 'Number is required');
  assert.equal(requiredMessage({ name: 'heroImage', title: '' }), 'Hero image is required');
});

test('Create is refused on a blank stats card, then allowed once each required field is filled', () => {
  let fields = [field('Number', true, undefined), field('Header', true, undefined), field('Description', true, undefined), field('Body', false, undefined)];
  assert.deepEqual(missingOf(fields), ['Number', 'Header', 'Description']);
  const fill = (name, value) => {
    fields = fields.map((each) => (each.name === name ? { ...each, value } : each));
  };
  fill('Number', '61.4%');
  fill('Header', '   ');
  assert.deepEqual(missingOf(fields), ['Header', 'Description'], 'whitespace is not a header');
  fill('Header', 'Uptime');
  fill('Description', 'weather permitting');
  assert.deepEqual(missingOf(fields), [], 'the body stays optional');
});

test('an existing entry refuses the save that empties a required field, and only that one', () => {
  const description = field('Description', true, 'weather permitting');
  assert.equal(saveRefused(description, ''), true);
  assert.equal(saveRefused(description, '  '), true);
  assert.equal(saveRefused(description, undefined), true);
  assert.equal(saveRefused(description, 'dry'), false);
  assert.equal(saveRefused(field('Body', false, 'text'), ''), false, 'an optional field may be emptied');
});
