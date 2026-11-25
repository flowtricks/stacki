// Goal: the registry of .stacki/breakpoints.json holds exactly what the app accepts: a document written the way the app writes it passes the registry and the app's own parser, and documents the app would ignore or refuse are refused by the registry.
// Method: one known-good document through checkValue and refusalOfSource, the empty document through both, then known-bad documents (unknown key, legacy key, wrong type, out of bounds, missing required) through the registry alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toRecord } from '#dist/shared/core/record.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { BREAKPOINTS_FILE } from '#dist/shared/properties/cli/files/breakpointsFile.js';

// JSON.parse answers any; bound to unknown so the checks below narrow it.
const parseText = (text: string): unknown => JSON.parse(text);

const schema = { kind: 'object', fields: BREAKPOINTS_FILE.fields } as const;

const good = {
  version: 4,
  desktop: { value: 90, unit: 'rem' },
  breakpoints: [
    { id: 'bp-1', name: 'Large', value: 100, unit: 'rem' },
    { id: 'laptop', value: 64, unit: 'rem' },
    { id: 'phone', value: 480, unit: 'px' },
  ],
};

test('a document written the way the app writes it passes the registry and the app parser', () => {
  assert.equal(checkValue(schema, good, 'breakpoints'), undefined);
  assert.equal(refusalOfSource(BREAKPOINTS_FILE, serializeDocument(BREAKPOINTS_FILE, good)), undefined);
  assert.equal(checkValue(schema, BREAKPOINTS_FILE.empty, 'breakpoints'), undefined);
  assert.equal(refusalOfSource(BREAKPOINTS_FILE, serializeDocument(BREAKPOINTS_FILE, { ...BREAKPOINTS_FILE.empty })), undefined);
});

test('the canonical writer fixes the key order and the app text ends in a newline', () => {
  const text = serializeDocument(BREAKPOINTS_FILE, { breakpoints: [], desktop: { unit: 'px', value: 1440 }, version: 4 });
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(Object.keys(toRecord(parseText(text)) ?? {}), ['version', 'desktop', 'breakpoints']);
});

test('documents the app would ignore or refuse are refused by the registry', () => {
  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['an unknown key', { ...good, visibel: true }],
    ['a legacy key', { ...good, laptop: { value: 64, unit: 'rem' } }],
    ['a stored direction (version 3)', { ...good, breakpoints: [{ id: 'laptop', value: 64, unit: 'rem', direction: 'down' }] }],
    ['an unknown key in a breakpoint', { ...good, breakpoints: [{ id: 'laptop', value: 64, unit: 'rem', colour: 'red' }] }],
    ['a wrong type', { ...good, desktop: { value: '90', unit: 'rem' } }],
    ['a value out of bounds', { ...good, desktop: { value: 10, unit: 'rem' } }],
    ['a value past the widest boundary', { ...good, desktop: { value: 9000, unit: 'px' } }],
    ['an unknown unit', { ...good, desktop: { value: 90, unit: 'em' } }],
    ['too many breakpoints', { ...good, breakpoints: Array.from({ length: 12 }, (_, index) => ({ id: `bp-${index + 1}`, value: 20 + index, unit: 'rem' })) }],
    ['an id with capitals', { ...good, breakpoints: [{ id: 'Laptop', value: 64, unit: 'rem' }] }],
    ['a name that is too long', { ...good, breakpoints: [{ id: 'laptop', name: 'x'.repeat(25), value: 64, unit: 'rem' }] }],
    ['a missing version', { desktop: good.desktop, breakpoints: [] }],
    ['a missing breakpoints list', { version: 4 }],
    ['a missing id', { ...good, breakpoints: [{ value: 64, unit: 'rem' }] }],
    ['a missing unit', { ...good, desktop: { value: 90 } }],
    ['an old version', { ...good, version: 3 }],
  ];
  for (const [label, document] of bad) {
    assert.notEqual(checkValue(schema, document, 'breakpoints'), undefined, label);
  }
});
