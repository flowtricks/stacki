// Goal: the CMS presents content without exposing executable helpers.
// Method: inspect inferred fields and collection visibility while keeping the
// original values available for a write after a content edit.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { blankItem, collectionHasContent, collectionOf, contentFieldsOf, fieldsOf, reassemble } = load('src/features/cms/cmsSchema.ts');

const helper = { __expr: '(entry) => entry.summary || entry.subtitle' };
const image = { __expr: 'hero', __asset: 'src/assets/hero.avif' };

test('code-only General collections disappear without altering their values', () => {
  const data = { orderedStories: { __expr: '[...stories].sort(compare)' }, logo: helper };
  const collection = collectionOf({
    rel: 'pages/index.astro#*general',
    name: 'General',
    dir: '',
    data,
  });
  assert.deepEqual(
    fieldsOf(collection.items).map((field) => field.key),
    ['orderedStories', 'logo'],
  );
  assert.deepEqual(contentFieldsOf(collection.items), []);
  assert.equal(collectionHasContent(collection), false);
  assert.deepEqual(reassemble(collection, collection.items), data);
});

test('mixed records keep copy and imported images but hide nested helper code', () => {
  const data = {
    title: 'Retreats',
    description: helper,
    landingImages: { cover: image, selectImage: helper },
  };
  const collection = collectionOf({ rel: 'data/site.ts#*general', name: 'General', dir: '', data });
  assert.deepEqual(
    contentFieldsOf(collection.items).map((field) => field.key),
    ['title', 'landingImages'],
  );
  assert.deepEqual(
    contentFieldsOf([data.landingImages]).map((field) => field.key),
    ['cover'],
  );
  assert.equal(collectionHasContent(collection), true);
  const edited = { ...data, title: 'New retreats' };
  assert.deepEqual(reassemble(collection, [edited]), edited);
  assert.equal(edited.description, helper);
  assert.deepEqual(blankItem([data]), { title: '', landingImages: { cover: '' } });
});

test('empty content records remain visible so fields can be added', () => {
  const collection = collectionOf({
    rel: 'data/blank.json',
    name: 'blank.json',
    dir: '',
    data: {},
  });
  assert.equal(collectionHasContent(collection), true);
});
