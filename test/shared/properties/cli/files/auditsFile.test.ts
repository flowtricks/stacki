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

test('the size rule and the allowed units are settable, and the app parser keeps them', () => {
  const tokens = {
    properties: ['padding*'],
    colors: true,
    px: true,
    remOutsideVariables: false,
    sizes: true,
    allowed: ['0'],
    allowedUnits: ['em', 'vw', 'ch'],
  };
  const document = { ...good, tokens };
  assert.equal(checkValue(schema, document, 'audits'), undefined);
  const written: unknown = JSON.parse(serializeDocument(AUDITS_FILE, document));
  assert.ok(typeof written === 'object' && written !== null, 'the writer writes an object');
  const writtenTokens: unknown = Reflect.get(written, 'tokens');
  assert.ok(typeof writtenTokens === 'object' && writtenTokens !== null, 'with a tokens object');
  assert.equal(Reflect.get(writtenTokens, 'sizes'), true, 'the size rule survives the canonical writer');
  assert.deepEqual(Reflect.get(writtenTokens, 'allowedUnits'), ['em', 'vw', 'ch'], 'and so do the allowed units, in the app’s order');
  assert.equal(refusalOfSource(AUDITS_FILE, serializeDocument(AUDITS_FILE, document)), undefined);
});

test('a unit that is not allowable, px and rem among them, is refused', () => {
  for (const unit of ['px', 'rem', 'furlong', '']) {
    const document = { ...good, tokens: { ...good.tokens, allowedUnits: [unit] } };
    assert.notEqual(checkValue(schema, document, 'audits'), undefined, `${JSON.stringify(unit)} is not an allowable unit`);
  }
  assert.notEqual(checkValue(schema, { ...good, tokens: { ...good.tokens, sizes: 'yes' } }, 'audits'), undefined, 'sizes is a boolean');
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
