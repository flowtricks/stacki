// Goal: the small result unions in shared/ipc/ipcContract.ts — a symbol read, a resolved
// path, a text reply and a bare ok — accept exactly the shapes main returns and
// refuse everything else, including values past the wire bounds.
// Methodology: one known-good value per variant must round-trip unchanged; each
// known-bad shape (wrong discriminant, missing or mistyped field, out-of-range
// line, text or path past its limit) must throw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseOkResult, parseResolvePathResult, parseSymbolReadResult, parseTextResult } from '#dist/shared/ipc/ipcContract.js';
import { BOUNDARY_LIMITS } from '#dist/shared/core/boundary.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const textOverLimit = 'x'.repeat(BOUNDARY_LIMITS.textLengthMax + 1);
const pathOverLimit = 'p'.repeat(BOUNDARY_LIMITS.pathLengthMax + 1);

test('a symbol read keeps every variant main returns', () => {
  const found = { ok: true, rel: 'src/data.ts', text: 'export const a = 1;', line: 0 };
  assert.deepEqual(parseSymbolReadResult(found), found);
  assert.deepEqual(parseSymbolReadResult({ ok: false }), { ok: false });
  assert.deepEqual(parseSymbolReadResult({ ok: false, reason: 'not-found' }), {
    ok: false,
    reason: 'not-found',
  });
  assert.deepEqual(parseSymbolReadResult({ ok: false, reason: 'too-large' }), {
    ok: false,
    reason: 'too-large',
  });
});

test('a symbol read refuses malformed and oversized shapes', () => {
  const good = { ok: true, rel: 'src/data.ts', text: 'x', line: 3 };
  const bad: readonly unknown[] = [
    undefined,
    jsonNull,
    'ok',
    [],
    { ok: 'yes' },
    { ok: false, reason: 'gone' },
    { ...good, rel: 1 },
    { ...good, rel: 'a\0b' },
    { ...good, rel: pathOverLimit },
    { ...good, text: undefined },
    { ...good, text: textOverLimit },
    { ...good, line: -1 },
    { ...good, line: 1.5 },
    { ...good, line: Number.NaN },
    { ...good, line: '3' },
  ];
  for (const input of bad) {
    assert.throws(() => parseSymbolReadResult(input), `refused: ${JSON.stringify(input)}`);
  }
});

test('a resolved path is ok with a bounded path, or a bare refusal', () => {
  assert.deepEqual(parseResolvePathResult({ ok: true, rel: 'src/a.ts' }), {
    ok: true,
    rel: 'src/a.ts',
  });
  assert.deepEqual(parseResolvePathResult({ ok: false, rel: 'ignored' }), { ok: false });
  for (const input of [jsonNull, {}, { ok: 1 }, { ok: true }, { ok: true, rel: pathOverLimit }]) {
    assert.throws(() => parseResolvePathResult(input));
  }
});

test('a text reply carries bounded text and a bare ok carries nothing else', () => {
  assert.deepEqual(parseTextResult({ text: '' }), { text: '' });
  assert.deepEqual(parseTextResult({ text: 'body', extra: 1 }), { text: 'body' });
  for (const input of [jsonNull, {}, { text: 3 }, { text: textOverLimit }]) {
    assert.throws(() => parseTextResult(input));
  }
  assert.deepEqual(parseOkResult({ ok: true, note: 'x' }), { ok: true });
  for (const input of [jsonNull, undefined, {}, { ok: false }, { ok: 'true' }]) {
    assert.throws(() => parseOkResult(input), /OkResult|Expected object/);
  }
});
