// Goal: offsets, spans and exact bytes (plan §3.2). ByteOffset and Utf16Offset
// accept only nonnegative safe integers; spans are ordered; the one UTF-16 →
// byte conversion agrees with a brute-force reference on every offset of
// hostile strings; strict decoding refuses invalid UTF-8 instead of replacing
// it; ByteString copies its input so no caller keeps a mutable alias.
// Method: known-good values, then each known-bad shape; the conversion is
// compared with Buffer.byteLength of every prefix (slow and obviously right).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toByteOffset, toIntentId, toUtf16Offset } from '#dist/shared/core/brand.js';
import { LIMITS } from '#dist/shared/core/limits.js';
import {
  byteStringsEqual,
  decodeUtf8,
  encodeUtf8,
  parseByteSpan,
  parseUtf16Span,
  spanContains,
  spansAscending,
  toByteSpan,
  toByteString,
  toUtf16Span,
  utf16ToByteOffsets,
  utf8ByteLength,
} from '#dist/shared/core/span.js';

// Null as a boundary receives it, parsed from JSON: inputs may hold it; our values never do.
const jsonNull: unknown = JSON.parse('null');

const HOSTILE = ['', 'ascii', 'café', '🎉', 'a🎉b', '﻿---\r\n', 'Zoë 👋🏽 naïve', 'ࠀ￿', '\uD800x'];

test('offset brands accept nonnegative safe integers only', () => {
  assert.equal(toByteOffset(0), 0);
  assert.equal(toUtf16Offset(42), 42);
  for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => toByteOffset(bad), /ByteOffset/);
    assert.throws(() => toUtf16Offset(bad), /Utf16Offset/);
  }
});

test('intent ids are short, printable and bounded', () => {
  assert.equal(toIntentId('i1'), 'i1');
  assert.equal(toIntentId('a'.repeat(64)), 'a'.repeat(64));
  for (const bad of ['', 'a'.repeat(65), 'has space', 'slash/id', 'ünï']) {
    assert.throws(() => toIntentId(bad), /IntentId/);
  }
});

test('spans are ordered, and containment and ordering read positively', () => {
  const outer = toByteSpan(2, 10);
  assert.equal(spanContains(outer, toByteSpan(2, 10)), true);
  assert.equal(spanContains(outer, toByteSpan(3, 4)), true);
  assert.equal(spanContains(outer, toByteSpan(1, 4)), false);
  assert.equal(spanContains(outer, toByteSpan(9, 11)), false);
  assert.equal(spansAscending([toByteSpan(0, 2), toByteSpan(2, 3), toByteSpan(5, 5)]), true);
  assert.equal(spansAscending([toByteSpan(0, 3), toByteSpan(2, 4)]), false);
  assert.equal(spansAscending([toByteSpan(4, 5), toByteSpan(0, 1)]), false);
  assert.throws(() => toByteSpan(5, 4), /end must not precede start/);
  assert.throws(() => toUtf16Span(5, 4), /end must not precede start/);
});

test('span wire parsers reject every malformed shape and the bounds', () => {
  assert.deepEqual(parseByteSpan({ start: 1, end: 3 }, 'span'), { start: 1, end: 3 });
  assert.deepEqual(parseUtf16Span({ start: 0, end: 0 }, 'span'), { start: 0, end: 0 });
  const bad: readonly [unknown, RegExp][] = [
    [jsonNull, /expected span object/],
    [[1, 2], /expected span object/],
    [{ start: '1', end: 2 }, /start: expected number/],
    [{ start: 1 }, /end: expected number/],
    [{ start: 3, end: 1 }, /end must not precede start/],
    [{ start: -1, end: 1 }, /nonnegative/],
    [{ start: 0, end: 1.5 }, /safe integer/],
    [{ start: 0, end: LIMITS.sourceBytesMax + 1 }, /exceeds/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseByteSpan(input, 'span'), message);
  }
  assert.throws(() => parseUtf16Span({ start: 0, end: LIMITS.ipcFieldCharsMax + 1 }, 'span'), /exceeds/);
});

test('UTF-16 → byte conversion agrees with a brute-force reference at every offset', () => {
  for (const text of HOSTILE) {
    const offsets = [];
    for (let unit = 0; unit <= text.length; unit++) {
      const code = text.charCodeAt(unit - 1);
      const next = text.charCodeAt(unit);
      const splitsPair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
      if (!splitsPair) {
        offsets.push(toUtf16Offset(unit));
      }
    }
    const converted = utf16ToByteOffsets(text, offsets);
    offsets.forEach((offset, index) => {
      const reference = Buffer.byteLength(text.slice(0, offset), 'utf8');
      assert.equal(converted[index], reference, `${JSON.stringify(text)} at ${offset}`);
    });
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text, 'utf8'));
    assert.equal(utf8ByteLength(text), encodeUtf8(text).length);
  }
});

test('conversion refuses offsets out of order, past the end, or inside a surrogate pair', () => {
  assert.throws(() => utf16ToByteOffsets('abc', [toUtf16Offset(2), toUtf16Offset(1)]), /ascending/);
  assert.throws(() => utf16ToByteOffsets('abc', [toUtf16Offset(4)]), /inside the text/);
  assert.throws(() => utf16ToByteOffsets('a🎉', [toUtf16Offset(2)]), /surrogate pair/);
  assert.deepEqual(utf16ToByteOffsets('a🎉', [toUtf16Offset(1), toUtf16Offset(1), toUtf16Offset(3)]), [1, 1, 5]);
});

test('decoding is strict and keeps a byte-order mark; byte strings are private copies', () => {
  const bom = encodeUtf8('﻿hi');
  const decoded = decodeUtf8(bom);
  assert.deepEqual(decoded, { ok: true, value: '﻿hi' });
  const invalid = decodeUtf8(toByteString(Uint8Array.from([0x68, 0xff, 0x69])));
  assert.equal(invalid.ok, false);
  if (!invalid.ok) {
    assert.equal(invalid.error.code, 'invalid-utf8');
  }
  const source = Uint8Array.from([1, 2, 3]);
  const copy = toByteString(source);
  source[0] = 9;
  assert.equal(copy[0], 1, 'the byte string does not alias its input');
  // A Node Buffer's `slice` is a view: the copy must not be one (step-3 spike).
  const buffer = Buffer.from([1, 2, 3]);
  const fromBuffer = toByteString(buffer);
  buffer[0] = 9;
  assert.equal(fromBuffer[0], 1, 'a byte string does not alias a Buffer input');
  assert.equal(Buffer.isBuffer(fromBuffer), false, 'a byte string is a plain Uint8Array');
  assert.equal(byteStringsEqual(copy, toByteString(Uint8Array.from([1, 2, 3]))), true);
  assert.equal(byteStringsEqual(copy, toByteString(Uint8Array.from([1, 2]))), false);
  assert.throws(() => toByteString(new Uint8Array(LIMITS.sourceBytesMax + 1)), /exceeds/);
});
