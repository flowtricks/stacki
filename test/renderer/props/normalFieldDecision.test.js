// Goal: the {} toggle's decision never loses a value silently and never leaves
// a required prop without one. The pure decision (normalFieldDecision.ts) keeps
// a literal-equivalent expression as the plain value ("literal"), replaces code
// with the control's empty value ("replace": undefined for an optional prop, a
// valid empty value for a required one), and blocks only a required prop that
// has no valid empty value.
// Method: the real module bundled with esbuild and driven over tables of
// expressions per field type: literals, real code (identifier, member access,
// call, concatenation), enum options a literal is or is not among, required
// and optional props, empty expressions, and the types with no empty value.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { buildSync } = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const directory = repoPath('node_modules/.stacki-test/normal-field-decision');
fs.mkdirSync(directory, { recursive: true });
const entry = path.join(directory, 'entry.js');
fs.writeFileSync(entry, `export { decideNormalField, planReset } from ${JSON.stringify(repoPath('src/features/props/normalFieldDecision.ts'))};`);
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
const { decideNormalField, planReset } = require(output);

const text = { name: 'content', type: 'string', optional: false };
const enumField = { name: 'tone', type: 'enum', optional: true, options: ['soft', 'bold'] };
const decide = (field, source, required = false) => decideNormalField({ field, source, required });
const literal = (value) => ({ kind: 'literal', value });
const replace = (value) => ({ kind: 'replace', value });
const plain = (value) => ({ type: 'string', value });

test('literal-equivalent expressions are kept as the plain attribute value', () => {
  assert.deepEqual(decide(text, '"text"'), literal(plain('text')));
  assert.deepEqual(decide(text, "'text'"), literal(plain('text')));
  assert.deepEqual(decide(text, '`text`'), literal(plain('text')));
  assert.deepEqual(decide(text, ' "padded" '), literal(plain('padded')));
  assert.deepEqual(decide(text, '42'), literal(plain('42')));
  assert.deepEqual(decide(text, 'true'), literal(plain('true')));
  assert.deepEqual(decide(text, '""', true), literal(plain('')), 'an empty string is a value');
  assert.deepEqual(decide({ name: 'n', type: 'number', optional: true }, '42'), literal({ type: 'expr', value: '42' }));
  assert.deepEqual(decide({ name: 'b', type: 'boolean', optional: true }, 'true'), literal({ type: 'expr', value: 'true' }));
});

test('code is replaced by the empty value: nothing for optional, a valid empty value for required', () => {
  for (const source of ['card.image', 'getTitle()', '"a" + b', '"a" + "b"', '`hi ${name}`', 'cond ? "a" : "b"', '[1, 2]', '{ a: 1 }', '']) {
    assert.deepEqual(decide(text, source), replace(undefined), source);
    assert.deepEqual(decide(text, source, true), replace(plain('')), `${source} (required)`);
  }
});

test('required empty values by type', () => {
  const required = (field, source = 'code') => decide({ optional: false, name: 'p', ...field }, source, true);
  assert.deepEqual(required({ type: 'boolean' }), replace({ type: 'expr', value: 'false' }));
  assert.deepEqual(required({ type: 'number' }), replace({ type: 'expr', value: '0' }));
  assert.deepEqual(required({ type: 'number', min: 3 }), replace({ type: 'expr', value: '3' }));
  assert.deepEqual(required({ type: 'enum', options: ['a', 'b'] }), replace(plain('a')));
  assert.deepEqual(required({ type: 'code' }), replace({ type: 'expr', value: '[]' }));
  assert.deepEqual(required({ type: 'number', min: 0, minExclusive: true }), { kind: 'blocked' }, 'no valid empty value');
  assert.deepEqual(required({ type: 'enum', options: [] }), { kind: 'blocked' });
  assert.deepEqual(required({ type: 'code', codeKind: 'function' }), { kind: 'blocked' });
});

test('an enum keeps a literal that is an option and replaces one that is not', () => {
  assert.deepEqual(decide(enumField, '"soft"'), literal(plain('soft')));
  assert.deepEqual(decide(enumField, '`bold`'), literal(plain('bold')));
  assert.deepEqual(decide(enumField, '"loud"'), replace(undefined));
  assert.deepEqual(decide({ ...enumField, optional: false }, '"loud"', true), replace(plain('soft')));
});

test('a literal the type refuses is replaced, not rewritten', () => {
  const number = { name: 'n', type: 'number', optional: true };
  const flag = { name: 'b', type: 'boolean', optional: true };
  for (const [field, source] of [
    [number, '"5"'],
    [flag, '"true"'],
    [number, 'true'],
    [flag, '1'],
  ]) {
    assert.deepEqual(decide(field, source), replace(undefined), source);
  }
});

test('planReset: overridden resets, unset or already-empty is disabled, required resets to its empty value', () => {
  const plan = (field, value, required = false) => planReset({ field, value, required });
  const withDefault = { name: 'heading', type: 'string', optional: true, default: 'Welcome' };
  assert.deepEqual(plan(withDefault, plain('Hi')), { kind: 'remove' });
  assert.deepEqual(plan(withDefault, plain('Welcome')), { kind: 'remove' }, 'written is overridden even when equal to the default');
  assert.deepEqual(plan(withDefault, undefined), { kind: 'disabled', reason: 'already-default' });
  assert.deepEqual(plan({ name: 'p', type: 'string', optional: true }, plain('x')), { kind: 'remove' }, 'no default: removal is the reset');
  const alt = { name: 'alt', type: 'string', optional: false };
  assert.deepEqual(plan(alt, plain('A cat'), true), { kind: 'write', value: plain('') });
  assert.deepEqual(plan(alt, { type: 'expr', value: 'card.alt' }, true), { kind: 'write', value: plain('') });
  assert.deepEqual(plan(alt, plain(''), true), { kind: 'disabled', reason: 'already-default' });
  assert.deepEqual(plan({ name: 'n', type: 'number', optional: false, min: 0, minExclusive: true }, { type: 'expr', value: '3' }, true), {
    kind: 'disabled',
    reason: 'no-empty-value',
  });
});
