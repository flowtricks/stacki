// Goal: a refused property edit reaches the window as its English message plus references the window translates, and the wire parsers keep a
// good reference, drop a bad one, and never fail the refusal that carried it (docs/i18n-playbook.md section 7).
// Method: pure calls. `refusal`, `inFile` and `withLead` build refusals; `propertyErrorText` words them with a fake translator that
// prefixes the key; `parsePropertiesResult` and `parseRefusal` read good, bad and absent references; condition and editing references
// parse beside their English strings.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { described } from '#dist/shared/properties/i18n/messageRef.js';
import { parseComponentProperty, parsePropertiesResult } from '#dist/shared/properties/propertyEditing.js';
import { inFile, parseRefusal, propertyErrorText, refusal, withLead } from '#dist/shared/properties/propertyErrors.js';

const say = (message: string, ref: { readonly key: string } | undefined): string => (ref === undefined ? message : `[${ref.key}]`);

test('a refusal keeps its English sentence and carries the reference', () => {
  assert.deepEqual(refusal('conflict', 'props.edit.conflict'), {
    code: 'conflict',
    message: 'This component changed on disk. Reload before saving.',
    messageRef: { key: 'props.edit.conflict' },
  });
});

test('a file prefix keeps the English order and gives each part its reference', () => {
  const error = inFile('src/Card.astro', refusal('collision', 'props.rename.instanceCollision', { name: 'title' }));
  assert.equal(error.message, 'src/Card.astro: An instance already passes title.');
  assert.deepEqual(error.leadRef, { key: 'props.edit.inFile', params: { file: 'src/Card.astro' } });
  assert.deepEqual(error.messageRef, { key: 'props.rename.instanceCollision', params: { name: 'title' } });
  assert.equal(propertyErrorText(error, say), '[props.edit.inFile] [props.rename.instanceCollision]');
});

test('free-form text under a lead travels as a detail and is shown as received', () => {
  const error = withLead(described('props.edit.restored'), { code: 'filesystem', message: 'EACCES: permission denied' });
  assert.equal(error.message, 'Save failed; changes restored. EACCES: permission denied');
  assert.deepEqual(error.messageRef, { key: 'props.edit.detail', params: { detail: 'EACCES: permission denied' } });
  assert.throws(() => withLead(described('props.edit.restored'), error), /one lead/);
});

test('a refusal without references falls back to its English message', () => {
  assert.equal(propertyErrorText({ code: 'x', message: 'Plain.' }, say), 'Plain.');
  assert.equal(propertyErrorText({ code: 'x', message: 'Lead only.', leadRef: { key: 'props.edit.restored' } }, say), 'Lead only.');
  // A part this window cannot word (the sayer answers nothing) shows the whole English message.
  assert.equal(
    propertyErrorText(inFile('a.astro', refusal('x', 'props.edit.missing')), () => ''),
    'a.astro: This property no longer exists. Reload the panel.',
  );
});

test('a wire refusal keeps good references, drops bad ones, and parses without any', () => {
  const wire = { code: 'path', message: 'Select it.' };
  assert.deepEqual(parseRefusal(wire), wire);
  assert.deepEqual(parseRefusal({ ...wire, messageRef: { key: 'props.edit.badPath' } }), { ...wire, messageRef: { key: 'props.edit.badPath' } });
  assert.deepEqual(parseRefusal({ ...wire, messageRef: { key: 'not a key' }, leadRef: 7 }), wire);
  assert.deepEqual(parseRefusal({ ...wire, leadRef: { key: 'props.edit.inFile', params: { file: 'a' } } }).leadRef, {
    key: 'props.edit.inFile',
    params: { file: 'a' },
  });
  assert.throws(() => parseRefusal({ code: 'x' }));
  const failed = parsePropertiesResult({ ok: false, error: { ...wire, messageRef: { key: 'props.edit.badPath' } } }, () => 1);
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.error.messageRef, { key: 'props.edit.badPath' });
  assert.throws(() => parsePropertiesResult({ ok: 'maybe' }, () => 1));
});

test('an editing permission and the variant conditions keep their references', () => {
  const base = { name: 'size', type: 'string', required: false, readonly: false, defaultValue: '', description: '' };
  const restricted = parseComponentProperty({
    ...base,
    editing: { kind: 'restricted', reason: 'Edit it in source.', reasonRef: { key: 'props.contract.quotedName' } },
    conditions: ['Variant branch 1: required', 'kind = "a": optional'],
    // A JSON array writes an absent reference as null; the parser reads it back as undefined.
    // eslint-disable-next-line stacki/no-null -- the wire shape under test
    conditionRefs: [{ key: 'props.contract.condition.numberedRequired', params: { number: 1 } }, null],
  });
  assert.deepEqual(restricted.editing, { kind: 'restricted', reason: 'Edit it in source.', reasonRef: { key: 'props.contract.quotedName' } });
  assert.deepEqual(restricted.conditionRefs, [{ key: 'props.contract.condition.numberedRequired', params: { number: 1 } }, undefined]);
  const warned = parseComponentProperty({ ...base, editing: { kind: 'editable', warning: 'Shared.', warningRef: { key: 'bad key' } } });
  assert.deepEqual(warned.editing, { kind: 'editable', warning: 'Shared.' });
  const old = parseComponentProperty({ ...base, editing: { kind: 'override', reason: 'Local.' } });
  assert.deepEqual(old.editing, { kind: 'override', reason: 'Local.' });
});
