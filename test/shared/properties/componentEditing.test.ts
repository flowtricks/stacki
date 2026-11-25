// Goal: a component's editing settings (lineBreaks, richText) live in .stacki/components.json only while on, read the
// same in every host, survive a rename and a defaults save, and rich text applies only to a component that can take
// HTML children.
// Method: parse known-good and each known-bad shape, switch settings on and off and compare the file byte for byte,
// relink a renamed owner, decide qualification for slot, text-slot, set:html and slotless components, and check that
// check-project names a stored setting that no longer applies without the parser dropping it.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  componentEditing,
  defaultsIssues,
  effectiveEditing,
  parseComponentDefaults,
  parseDefaultsSource,
  relinkDefaults,
  resolveComponentRecipe,
  richTextAllowed,
  withComponentEditing,
} from '#dist/shared/properties/componentDefaults.js';
import { COMPONENTS_FILE } from '#dist/shared/properties/cli/files/componentsFile.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const paragraph = 'src/components/Paragraph.astro';
const rich = 'src/components/RichText.astro';
const catalog = [
  { file: paragraph, name: 'Paragraph', props: [], slots: ['default'], slotText: true },
  { file: rich, name: 'RichText', props: [], slots: ['default'], slotText: false },
];

test('settings parse only as true on a component, and an absent key is off', () => {
  const config = parseComponentDefaults({ version: 1, components: { [paragraph]: { lineBreaks: true }, [rich]: { richText: true, props: {} } } });
  assert.deepEqual(componentEditing(config, paragraph), { lineBreaks: true });
  assert.deepEqual(componentEditing(config, rich), { richText: true });
  assert.deepEqual(componentEditing(config, 'src/components/Other.astro'), {});
  for (const bad of [false, 'true', 1, {}]) {
    assert.throws(() => parseComponentDefaults({ version: 1, components: { [paragraph]: { lineBreaks: bad } } }), /lineBreaks is true or left out/);
    assert.throws(() => parseComponentDefaults({ version: 1, components: { [paragraph]: { richText: bad } } }), /richText is true or left out/);
  }
});

test('a setting does not change what the component inserts with', () => {
  const plain = parseComponentDefaults({ version: 1, components: { [paragraph]: { text: 'Words' } } });
  const set = withComponentEditing(plain, paragraph, 'lineBreaks', 'on');
  assert.deepEqual(resolveComponentRecipe(paragraph, set, catalog), resolveComponentRecipe(paragraph, plain, catalog));
});

test('switching on and off again leaves the file as it was, keeping the other keys and their order', () => {
  const source = `${JSON.stringify({ version: 1, components: { [rich]: { text: 'Hi' }, [paragraph]: { props: { size: 'm' } } } }, undefined, 2)}\n`;
  const parsed = parseDefaultsSource(source);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) {
    return;
  }
  const on = withComponentEditing(parsed.value, rich, 'richText', 'on');
  assert.deepEqual(Object.keys(on.components), [rich, paragraph]);
  assert.equal(on.components[rich]?.richText, true);
  assert.equal(on.components[rich]?.text, 'Hi');
  const off = withComponentEditing(on, rich, 'richText', 'off');
  assert.equal(`${JSON.stringify(off, undefined, 2)}\n`, source);
  // An owner the setting alone created goes with it.
  const created = withComponentEditing(parsed.value, 'src/components/New.astro', 'lineBreaks', 'on');
  assert.deepEqual(created.components['src/components/New.astro'], { lineBreaks: true });
  assert.equal(`${JSON.stringify(withComponentEditing(created, 'src/components/New.astro', 'lineBreaks', 'off'), undefined, 2)}\n`, source);
  assert.throws(() => withComponentEditing(parsed.value, '../outside.astro', 'lineBreaks', 'on'), /project-relative/);
});

test('a written file reads back with its settings, and a rename carries them', () => {
  const config = withComponentEditing(
    withComponentEditing(parseComponentDefaults({ version: 1, components: {} }), rich, 'richText', 'on'),
    rich,
    'lineBreaks',
    'on',
  );
  const read = parseDefaultsSource(JSON.stringify(config));
  assert.equal(read.ok, true);
  if (!read.ok) {
    return;
  }
  assert.deepEqual(componentEditing(read.value, rich), { lineBreaks: true, richText: true });
  const moved = relinkDefaults(read.value, rich, 'src/ui/RichText.astro');
  assert.equal(moved.ok, true);
  if (moved.ok) {
    assert.deepEqual(componentEditing(moved.value, 'src/ui/RichText.astro'), { lineBreaks: true, richText: true });
    assert.deepEqual(componentEditing(moved.value, rich), {});
  }
});

test('rich text needs a slot for blocks or set:html; a stored setting that no longer applies is ignored, kept and named', () => {
  assert.equal(richTextAllowed({ slots: ['default'], slotText: false }), true);
  assert.equal(richTextAllowed({ slots: ['default', 'aside'], slotText: false }), true);
  assert.equal(richTextAllowed({ slots: ['default'], slotText: true }), false, 'a slot inside <p> takes words only');
  assert.equal(richTextAllowed({ slots: ['aside'], slotText: false }), false);
  assert.equal(richTextAllowed({ slots: [], slotText: false }), false);
  assert.equal(richTextAllowed({ slots: [], slotText: false, setHtml: true }), true);
  const config = parseComponentDefaults({ version: 1, components: { [paragraph]: { richText: true, lineBreaks: true } } });
  const [paragraphEntry] = catalog;
  assert.ok(paragraphEntry);
  assert.deepEqual(effectiveEditing(config, paragraphEntry), { lineBreaks: true });
  assert.equal(config.components[paragraph]?.richText, true, 'the stored key stays');
  assert.deepEqual(defaultsIssues(config, catalog), [`${paragraph} has richText on but no slot or set:html for HTML children; it is ignored.`]);
  assert.deepEqual(defaultsIssues(parseComponentDefaults({ version: 1, components: { [rich]: { richText: true } } }), catalog), []);
});

test('the CLI schema describes both settings and accepts only true', () => {
  const schema = COMPONENTS_FILE.fields['components'];
  assert.ok(schema);
  assert.equal(checkValue(schema.type, { [rich]: { richText: true, lineBreaks: true } }, 'components'), undefined);
  assert.notEqual(checkValue(schema.type, { [rich]: { richText: false } }, 'components'), undefined);
  assert.notEqual(checkValue(schema.type, { [rich]: { lineBreaks: 'yes' } }, 'components'), undefined);
});
