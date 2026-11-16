// Goal: the audits registry accepts a document written the way the app writes `.stacki/audits.json`, and refuses what the app would ignore or reject.
// Method: build a realistic document (finding and page ignores, a check override, token rules, placeholders), run it through the registry check and
// the app parser (refusalOfSource), then check known-bad shapes: unknown key, wrong type, out-of-bounds, missing required, legacy-free closed world.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AUDITS_FILE } from '#dist/shared/properties/cli/files/auditsFile.js';
import { refusalOfSource, serializeDocument } from '#dist/shared/properties/cli/stackiFiles.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';

const schema = { kind: 'object', fields: AUDITS_FILE.fields } as const;
const good = {
  version: 2,
  ignored: [{ id: 'img-alt|src/pages/index.astro|0.3|src="/a.png"', reason: 'Decorative hero' }],
  ignoredPages: [{ file: 'src/pages/legal.astro', reason: 'Copy comes from the lawyers' }],
  checks: { 'token-value': { enabled: false }, 'token-color': { priority: 'high' } },
  tokens: { properties: ['border-radius', 'padding*'], colors: true, px: false, remOutsideVariables: true, allowed: ['1px', '100%'] },
  placeholders: ['lorem ipsum'],
};

test('a document the app writes passes the registry and the parser', () => {
  assert.equal(checkValue(schema, good, 'audits'), undefined);
  assert.equal(refusalOfSource(AUDITS_FILE, serializeDocument(AUDITS_FILE, good)), undefined);
  assert.equal(checkValue(schema, AUDITS_FILE.empty, 'audits'), undefined);
});

test('the canonical writer leaves out settings at their defaults', () => {
  const text = serializeDocument(AUDITS_FILE, { version: 2, ignored: [], checks: {} });
  assert.deepEqual(JSON.parse(text), { version: 2, ignored: [] });
});

// JSON.parse makes __proto__ an own key, as a hand-edited file would.
const prototypeDocument: unknown = JSON.parse('{"version":2,"ignored":[],"checks":{"__proto__":{}}}');
const bad: ReadonlyArray<readonly [string, unknown]> = [
  ['an unknown top-level key', { ...good, ignoreed: [] }],
  ['an unknown token key', { ...good, tokens: { colours: true } }],
  ['an unknown check key', { ...good, checks: { 'token-value': { enable: false } } }],
  ['a wrong type', { ...good, ignored: 'none' }],
  ['a bad priority', { ...good, checks: { a: { priority: 'urgent' } } }],
  ['a check id that is not one', { ...good, checks: { 'Not An Id': { enabled: false } } }],
  ['an empty ignore id', { ...good, ignored: [{ id: '', reason: 'x' }] }],
  ['a reason over its bound', { ...good, ignored: [{ id: 'a', reason: 'x'.repeat(501) }] }],
  ['a missing reason', { ...good, ignored: [{ id: 'a' }] }],
  ['a missing version', { ignored: [] }],
  ['a missing ignored list', { version: 2 }],
  ['a prototype key in checks', prototypeDocument],
];
for (const [name, document] of bad) {
  test(`the registry refuses ${name}`, () => {
    assert.notEqual(checkValue(schema, document, 'audits'), undefined);
  });
}
