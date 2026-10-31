// Goal: a document's fields are checked against their rules as the Studio would — text limits in
// characters, list limits in items, links by scheme, unique items by content — and only errors
// block publishing.
// Method: fields with rules are checked against valid values, then each kind of invalid one.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { problemsOf, publishBlockers } = loadRenderer('src/features/cms/remoteValidation.ts');

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
  assert.deepEqual(messages([error('integer'), error('positive')], -1.5), [
    'Must be a whole number',
    'Must be positive',
  ]);
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
