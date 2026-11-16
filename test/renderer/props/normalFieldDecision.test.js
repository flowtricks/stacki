// Goal: "Use the normal field" never deletes what the user wrote. The pure
// decision behind it (normalFieldDecision.ts) either rewrites an expression as
// the equal plain value or refuses with a reason, and leaves the rest alone.
// Method: the real module bundled with esbuild and driven over a table of
// expressions per field type: literal-equivalent conversions, real code
// (identifier, member access, call, concatenation), enum options a literal
// is or is not among, a required prop, an empty expression, and the negative
// space where a literal does not fit the type. The old behaviour, clearing the
// attribute, is pinned as gone: no input yields a bare removal except an
// empty, optional expression.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/normal-field-decision');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(entry, `export { decideNormalField } from ${JSON.stringify(repoPath('src/features/props/normalFieldDecision.ts'))};`);
const output = path.join(directory, 'bundle.cjs');
buildSync({
  entryPoints: [entry],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
  loader: { '.css': 'empty' },
  logLevel: 'silent',
});
const { decideNormalField } = require(output);

const text = { name: 'content', type: 'string', optional: false };
const enumField = { name: 'tone', type: 'enum', optional: true, options: ['soft', 'bold'] };
const decide = (field, source, required = false) => decideNormalField({ field, source, required });
const convertedText = (value) => ({ kind: 'convert', value: { type: 'string', value } });

test('literal-equivalent expressions convert to the plain attribute value', () => {
  assert.deepEqual(decide(text, '"text"'), convertedText('text'));
  assert.deepEqual(decide(text, "'text'"), convertedText('text'));
  assert.deepEqual(decide(text, '`text`'), convertedText('text'));
  assert.deepEqual(decide(text, ' "padded" '), convertedText('padded'));
  assert.deepEqual(decide(text, '42'), convertedText('42'));
  assert.deepEqual(decide(text, 'true'), convertedText('true'));
  assert.deepEqual(decide(text, '""', true), convertedText(''), 'an empty string is a value, even for a required prop');
  assert.deepEqual(decide({ name: 'n', type: 'number', optional: true }, '42'), { kind: 'convert', value: { type: 'expr', value: '42' } });
  assert.deepEqual(decide({ name: 'b', type: 'boolean', optional: true }, 'true'), { kind: 'convert', value: { type: 'expr', value: 'true' } });
});

test('real expressions are refused as code and never converted', () => {
  for (const source of [
    'customerStoriesMachineMode',
    'page.title',
    'getTitle()',
    '"a" + b',
    '"a" + "b"',
    '`hi ${name}`',
    'cond ? "a" : "b"',
    '[1, 2]',
    '{ a: 1 }',
  ]) {
    assert.deepEqual(decide(text, source), { kind: 'blocked', reason: 'code' }, source);
    assert.deepEqual(decide(text, source, true), { kind: 'blocked', reason: 'code' }, `${source} (required)`);
  }
});

test('an enum takes only a literal that is one of its options', () => {
  assert.deepEqual(decide(enumField, '"soft"'), convertedText('soft'));
  assert.deepEqual(decide(enumField, '`bold`'), convertedText('bold'));
  assert.deepEqual(decide(enumField, '"loud"'), { kind: 'blocked', reason: 'invalid-literal' });
  assert.deepEqual(decide(enumField, 'tone'), { kind: 'blocked', reason: 'code' });
});

test('a literal the type refuses is refused, not rewritten', () => {
  const number = { name: 'n', type: 'number', optional: true };
  const flag = { name: 'b', type: 'boolean', optional: true };
  assert.deepEqual(decide(number, '"5"'), { kind: 'blocked', reason: 'invalid-literal' });
  assert.deepEqual(decide(flag, '"true"'), { kind: 'blocked', reason: 'invalid-literal' });
  assert.deepEqual(decide(number, 'true'), { kind: 'blocked', reason: 'invalid-literal' });
  assert.deepEqual(decide(flag, '1'), { kind: 'blocked', reason: 'invalid-literal' });
  assert.deepEqual(decide(number, 'count'), { kind: 'blocked', reason: 'code' });
});

test('an empty expression clears only when the prop is optional', () => {
  assert.deepEqual(decide(text, '  ', false), { kind: 'convert', value: undefined });
  assert.deepEqual(decide(text, '', true), { kind: 'blocked', reason: 'required-empty' });
});

test('a very long expression is decided like any other, never refused for its size', () => {
  // No size limit (owner requirement): the decision reads the whole source and still refuses code it cannot hold.
  const decision = decide(text, 'x'.repeat(100_000));
  assert.equal(decision.kind, 'blocked');
});
