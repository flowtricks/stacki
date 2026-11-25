// Goal: a text field is offered choices only when it plainly holds a locale or a time zone —
// never for a short slug or word — and the current value is always among the choices.
// Method: values and field names like real ones are checked for the choices they get.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { suggestedOptions } = loadRenderer('src/features/cms/cmsSuggestions.ts');

test('locales and time zones get choices that include the current value', () => {
  assert.ok(suggestedOptions('Site locale', 'en-US').includes('en-GB'));
  assert.equal(suggestedOptions('Site locale', 'xx-QQ')[0], 'xx-QQ', 'an unknown tag is kept');
  const zones = suggestedOptions('Church time zone', 'America/Chicago');
  assert.ok(zones.includes('America/Chicago'));
  assert.ok(zones.every((zone) => zone === 'UTC' || zone.startsWith('America/')));
  assert.ok(suggestedOptions('Time zone', '').length > 0, 'an empty field named for one');
});

test('slugs and short words are not taken for languages', () => {
  assert.deepEqual(suggestedOptions('Slug', 'dvl'), []);
  assert.deepEqual(suggestedOptions('Key', 'en'), []);
  assert.deepEqual(suggestedOptions('Name', 'Donaldsonville'), []);
});
