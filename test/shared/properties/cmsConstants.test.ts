// Goal: the contract both processes share for a data file's variables holds: a typed name
// becomes an identifier in the file's naming, the name rules refuse what JavaScript would,
// the serializer writes each value type in the given style, and the wire parsers accept the
// known-good shapes and refuse each known-bad one (unknown kinds, bad style values, values
// that are not a variable's, over-long names and previews).
// Method: constantIdentifier, constantNameProblem and constantStatement run over literal
// inputs; each parser gets one good value, then one corruption per field.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  CMS_CONSTANT_LIMITS,
  constantIdentifier,
  constantNameProblem,
  constantStatement,
  movedNames,
  parseConstantEdit,
  parseConstantEditReply,
  parseConstantField,
  parseConstantListingReply,
  parseConstantStyle,
  type ConstantStyle,
} from '#dist/shared/properties/cmsConstants.js';

// JSON's null, as a reply parsed from JSON carries it.
const JSON_NULL: unknown = JSON.parse('null');
const STYLE: ConstantStyle = {
  host: 'module',
  script: 'ts',
  quote: 'double',
  semicolons: true,
  asConst: false,
  typeAnnotations: false,
  descriptionComments: false,
  trailingCommas: true,
  blankLineBetween: false,
  indent: '  ',
  newline: 'lf',
  naming: 'screamingSnake',
};

test('a typed name becomes the identifier the file would write', () => {
  assert.equal(constantIdentifier('site tagline', 'screamingSnake'), 'SITE_TAGLINE');
  assert.equal(constantIdentifier('siteTagline', 'screamingSnake'), 'SITE_TAGLINE');
  assert.equal(constantIdentifier('Site tagline', 'camel'), 'siteTagline');
  assert.equal(constantIdentifier('SITE_TAGLINE', 'camel'), 'siteTagline');
  assert.equal(constantIdentifier('$keep_As_Is', 'mixed'), '$keep_As_Is');
  assert.equal(constantIdentifier('two words', 'mixed'), 'twoWords');
  assert.equal(constantIdentifier('été', 'camel'), 't', 'letters outside ASCII separate words');
  assert.equal(constantIdentifier('   ', 'camel'), '');
});

test('the name rules refuse empty, invalid, over-long, reserved and taken names', () => {
  assert.equal(constantNameProblem('SITE', []), undefined);
  assert.equal(constantNameProblem('', []), 'invalidName');
  assert.equal(constantNameProblem('9lives', []), 'invalidName');
  assert.equal(constantNameProblem('a-b', []), 'invalidName');
  assert.equal(constantNameProblem('A'.repeat(CMS_CONSTANT_LIMITS.nameCharsMax + 1), []), 'invalidName');
  assert.equal(constantNameProblem('await', []), 'reservedName');
  assert.equal(constantNameProblem('undefined', []), 'reservedName');
  assert.equal(constantNameProblem('SITE', ['SITE']), 'duplicateName');
});

test('each value type is written in the style, short values inline and long ones broken', () => {
  assert.equal(constantStatement({ name: 'A', value: 'say "hi"\n' }, STYLE), 'export const A = "say \\"hi\\"\\n";');
  assert.equal(constantStatement({ name: 'A', value: "it's" }, { ...STYLE, quote: 'single' }), "export const A = 'it\\'s';");
  assert.equal(constantStatement({ name: 'A', value: -0 }, STYLE), 'export const A = -0;');
  assert.equal(constantStatement({ name: 'A', value: false }, { ...STYLE, semicolons: false }), 'export const A = false');
  assert.equal(constantStatement({ name: 'a', value: [] }, { ...STYLE, host: 'page' }), 'const a = [];');
  assert.equal(constantStatement({ name: 'A', value: {} }, { ...STYLE, asConst: true }), 'export const A = {} as const;');
  assert.equal(constantStatement({ name: 'A', value: 1 }, { ...STYLE, typeAnnotations: true }), 'export const A: number = 1;');
  assert.equal(
    constantStatement({ name: 'A', value: [1, 'x'] }, { ...STYLE, typeAnnotations: true }),
    'export const A = [1, "x"];',
    'a mixed list is left to inference',
  );
  const long = constantStatement({ name: 'A', value: ['a'.repeat(40), 'b'.repeat(40)] }, { ...STYLE, trailingCommas: false, indent: '\t' });
  assert.equal(long, `export const A = [\n\t"${'a'.repeat(40)}",\n\t"${'b'.repeat(40)}"\n];`);
  assert.equal(
    constantStatement({ name: 'A', value: 'x', description: 'Shown\nin the footer' }, { ...STYLE, descriptionComments: true, newline: 'crlf' }),
    '/** Shown in the footer */\r\nexport const A = "x";',
  );
  assert.throws(() => constantStatement({ name: 'class', value: 1 }, STYLE), /valid identifier/);
  assert.throws(() => constantStatement({ name: 'A', value: undefined }, STYLE), /plain value/);
});

test('style, field and edit parsers accept the good shapes and refuse each bad one', () => {
  assert.deepEqual(parseConstantStyle(STYLE), STYLE);
  assert.throws(() => parseConstantStyle({ ...STYLE, quote: 'backtick' }), /unknown quote/);
  assert.throws(() => parseConstantStyle({ ...STYLE, indent: '' }), /indent/);
  assert.throws(() => parseConstantStyle({ ...STYLE, indent: 'xx' }), /indent/);
  assert.throws(() => parseConstantStyle({ ...STYLE, semicolons: 'yes' }), /boolean/);
  assert.deepEqual(parseConstantField({ name: 'A', value: [1] }), { name: 'A', value: [1] });
  assert.throws(() => parseConstantField({ name: 'A', value: JSON_NULL }), /value must be/);
  assert.throws(() => parseConstantField({ name: 'A'.repeat(CMS_CONSTANT_LIMITS.nameCharsMax + 1), value: 1 }), /name exceeds/);
  assert.throws(() => parseConstantField({ name: 'A', value: 1, description: 'd'.repeat(CMS_CONSTANT_LIMITS.descriptionCharsMax + 1) }), /description/);
  assert.throws(() => parseConstantField({ name: 'A', value: Number.NaN }), /finite/);
  assert.deepEqual(parseConstantEdit({ kind: 'remove', name: 'A' }), { kind: 'remove', name: 'A' });
  assert.deepEqual(parseConstantEdit({ kind: 'restore', text: 'a', expected: 'b' }), { kind: 'restore', text: 'a', expected: 'b' });
  assert.throws(() => parseConstantEdit({ kind: 'rename', from: 'A', to: 'B' }), /unknown edit kind/);
  assert.throws(() => parseConstantEdit({ kind: 'remove', name: '' }), /non-empty/);
  assert.throws(() => parseConstantEdit({ kind: 'restore', text: 'a' }), /string/);
});

test('reply parsers read listings, edits and refusals, and refuse broken replies', () => {
  const listing = { style: STYLE, fields: [{ name: 'A', type: 'string', preview: '"a"' }], taken: ['A', 'x'] };
  const read = parseConstantListingReply({ ok: true, listing });
  assert.ok(read.ok);
  assert.equal(read.value.fields[0]?.name, 'A');
  assert.deepEqual(parseConstantListingReply({ ok: false, refusal: 'syntax' }), { ok: false, error: 'syntax' });
  assert.throws(() => parseConstantListingReply({ ok: false, refusal: 'other' }), /unknown refusal/);
  assert.throws(() => parseConstantListingReply({ ok: true, listing: { ...listing, taken: [] } }), /taken name/);
  assert.throws(() => parseConstantListingReply({ ok: true, listing: { ...listing, fields: [{ name: 'A', type: 'date', preview: '' }] } }), /unknown type/);
  assert.throws(
    () =>
      parseConstantListingReply({
        ok: true,
        listing: { ...listing, fields: [{ name: 'A', type: 'string', preview: 'x'.repeat(CMS_CONSTANT_LIMITS.previewCharsMax + 2) }] },
      }),
    /preview exceeds/,
  );
  assert.deepEqual(parseConstantEditReply({ ok: true, before: 'a', after: 'b' }), { ok: true, value: { before: 'a', after: 'b' } });
  assert.deepEqual(parseConstantEditReply({ ok: false, refusal: 'inUse' }), { ok: false, error: 'inUse' });
  assert.throws(() => parseConstantEditReply({ ok: true, before: 'a' }), /string/);
});

test('a drag moves a name to its drop index, measured before removal, and a bad index is a programmer error', () => {
  const names = ['A', 'B', 'C'];
  assert.deepEqual(movedNames(names, 0, 3), ['B', 'C', 'A']);
  assert.deepEqual(movedNames(names, 2, 0), ['C', 'A', 'B']);
  assert.deepEqual(movedNames(names, 1, 1), names);
  assert.deepEqual(movedNames(names, 1, 2), names, 'dropping just below itself is no move');
  assert.throws(() => movedNames(names, 3, 0), /dragged row exists/);
  assert.throws(() => movedNames(names, 0, 4), /within the list/);
  assert.deepEqual(parseConstantEdit({ kind: 'reorder', order: ['B', 'A'] }), { kind: 'reorder', order: ['B', 'A'] });
  assert.throws(() => parseConstantEdit({ kind: 'reorder', order: ['A', 'A'] }), /twice/);
  assert.throws(() => parseConstantEdit({ kind: 'reorder', order: [''] }), /non-empty/);
});
