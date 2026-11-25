// Goal: a component field's editing settings (lineBreaks, richText) live in .stacki/components.json only while on,
// under the component's recipe by prop name or `slot:<name>`, read the same in every host, follow a component rename
// and a prop rename or delete, and are offered only where the field can render them.
// Method: parse known-good and each known-bad shape, switch settings on and off and compare the file byte for byte,
// relink a renamed owner and move a renamed prop, decide what each kind of field is offered, and check that
// check-project names a stored setting a field cannot take, without the parser dropping it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  defaultsIssues,
  editingOffered,
  effectiveEditing,
  fieldEditing,
  parseComponentDefaults,
  parseDefaultsSource,
  relinkDefaults,
  resolveComponentRecipe,
  withEditingFieldMoved,
  withFieldEditing,
} from '#dist/shared/properties/componentDefaults.js';
import { COMPONENTS_FILE } from '#dist/shared/properties/cli/files/componentsFile.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const paragraph = 'src/components/Paragraph.astro';
const rich = 'src/components/RichText.astro';
const block = 'src/components/HtmlBlock.astro';
const catalog = [
  { file: paragraph, name: 'Paragraph', props: ['size'], slots: ['default'], slotText: true },
  { file: rich, name: 'RichText', props: [], slots: ['default', 'aside'], slotText: false },
  { file: block, name: 'HtmlBlock', props: ['html', 'title'], slots: [], slotText: false, setHtml: true, htmlProps: ['html'] },
];

test('settings parse per field, only as true, and an absent key is off', () => {
  const config = parseComponentDefaults({
    version: 1,
    components: { [paragraph]: { editing: { 'slot:default': { lineBreaks: true } } }, [block]: { props: {}, editing: { html: { richText: true } } } },
  });
  assert.deepEqual(fieldEditing(config, paragraph, 'slot:default'), { lineBreaks: true });
  assert.deepEqual(fieldEditing(config, block, 'html'), { richText: true });
  assert.deepEqual(fieldEditing(config, block, 'title'), {});
  for (const bad of [false, 'true', 1, {}]) {
    assert.throws(
      () => parseComponentDefaults({ version: 1, components: { [paragraph]: { editing: { 'slot:default': { lineBreaks: bad } } } } }),
      /lineBreaks is true or left out/,
    );
  }
  for (const field of ['1x', 'slot:', 'slot:a b', 'a.b', '']) {
    assert.throws(() => parseComponentDefaults({ version: 1, components: { [paragraph]: { editing: { [field]: { lineBreaks: true } } } } }), /editing field/);
  }
  assert.throws(() => parseComponentDefaults({ version: 1, components: { [paragraph]: { editing: [] } } }));
});

test('a setting does not change what the component inserts with', () => {
  const plain = parseComponentDefaults({ version: 1, components: { [paragraph]: { text: 'Words' } } });
  const set = withFieldEditing(plain, { file: paragraph, field: 'slot:default' }, { setting: 'lineBreaks', state: 'on' });
  assert.deepEqual(resolveComponentRecipe(paragraph, set, catalog), resolveComponentRecipe(paragraph, plain, catalog));
});

test('switching on and off again leaves the file as it was, keeping the other keys and their order', () => {
  const source = `${JSON.stringify({ version: 1, components: { [rich]: { text: 'Hi' }, [paragraph]: { props: { size: 'm' } } } }, undefined, 2)}\n`;
  const parsed = parseDefaultsSource(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const on = withFieldEditing(parsed.value, { file: rich, field: 'slot:default' }, { setting: 'richText', state: 'on' });
  assert.deepEqual(Object.keys(on.components), [rich, paragraph]);
  assert.deepEqual(on.components[rich], { text: 'Hi', editing: { 'slot:default': { richText: true } } });
  const off = withFieldEditing(on, { file: rich, field: 'slot:default' }, { setting: 'richText', state: 'off' });
  assert.equal(`${JSON.stringify(off, undefined, 2)}\n`, source);
  const created = withFieldEditing(parsed.value, { file: block, field: 'html' }, { setting: 'lineBreaks', state: 'on' });
  assert.deepEqual(created.components[block], { editing: { html: { lineBreaks: true } } });
  const removed = withFieldEditing(created, { file: block, field: 'html' }, { setting: 'lineBreaks', state: 'off' });
  assert.equal(`${JSON.stringify(removed, undefined, 2)}\n`, source);
  assert.throws(() => withFieldEditing(parsed.value, { file: '../outside.astro', field: 'html' }, { setting: 'lineBreaks', state: 'on' }), /project-relative/);
  assert.throws(() => withFieldEditing(parsed.value, { file: block, field: 'not a field' }, { setting: 'lineBreaks', state: 'on' }), /editing field/);
});

test('a component rename and a prop rename or delete carry the settings', () => {
  const config = withFieldEditing(parseComponentDefaults({ version: 1, components: {} }), { file: block, field: 'html' }, { setting: 'richText', state: 'on' });
  const moved = relinkDefaults(config, block, 'src/ui/HtmlBlock.astro');
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.deepEqual(fieldEditing(moved.value, 'src/ui/HtmlBlock.astro', 'html'), { richText: true });
  }
  const renamed = withEditingFieldMoved(config, block, 'html', 'body');
  assert.deepEqual(fieldEditing(renamed, block, 'body'), { richText: true });
  assert.deepEqual(fieldEditing(renamed, block, 'html'), {});
  assert.deepEqual(withEditingFieldMoved(config, block, 'html', undefined).components[block], {});
  assert.equal(withEditingFieldMoved(config, block, 'title', 'name'), config, 'a field with no settings changes nothing');
});

test('each field is offered only what it can render', () => {
  const [paragraphEntry, richEntry, blockEntry] = catalog;
  assert.ok(paragraphEntry && richEntry && blockEntry);
  assert.deepEqual(editingOffered(paragraphEntry, 'slot:default'), ['lineBreaks'], 'a slot inside <p> takes words, not blocks');
  assert.deepEqual(editingOffered(richEntry, 'slot:default'), ['lineBreaks', 'richText']);
  assert.deepEqual(editingOffered(richEntry, 'slot:aside'), ['lineBreaks', 'richText']);
  assert.deepEqual(editingOffered(richEntry, 'slot:missing'), []);
  assert.deepEqual(editingOffered(blockEntry, 'html'), ['lineBreaks', 'richText']);
  assert.deepEqual(editingOffered(blockEntry, 'title'), [], 'a prop printed as text escapes a <br>');
  assert.deepEqual(editingOffered(paragraphEntry, 'size'), []);
  const config = parseComponentDefaults({
    version: 1,
    components: { [paragraph]: { editing: { 'slot:default': { richText: true, lineBreaks: true }, size: { lineBreaks: true } } } },
  });
  assert.deepEqual(effectiveEditing(config, paragraphEntry, 'slot:default'), { lineBreaks: true });
  assert.deepEqual(effectiveEditing(config, paragraphEntry, 'size'), {});
  assert.equal(config.components[paragraph]?.editing?.['slot:default']?.richText, true, 'the stored key stays');
  assert.deepEqual(defaultsIssues(config, catalog), [
    `${paragraph} has richText on for slot:default, which cannot take it (no such slot, or not a set:html prop); it is ignored.`,
    `${paragraph} has lineBreaks on for size, which cannot take it (no such slot, or not a set:html prop); it is ignored.`,
  ]);
});

test('the CLI schema describes the editing map and accepts only true', () => {
  const schema = COMPONENTS_FILE.fields['components'];
  assert.ok(schema);
  assert.equal(checkValue(schema.type, { [rich]: { editing: { 'slot:default': { richText: true, lineBreaks: true } } } }, 'components'), undefined);
  assert.notEqual(checkValue(schema.type, { [rich]: { editing: { 'slot:default': { richText: false } } } }, 'components'), undefined);
  assert.notEqual(checkValue(schema.type, { [rich]: { editing: { 'bad field': { lineBreaks: true } } } }, 'components'), undefined);
});
