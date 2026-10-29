// Goal: one Mac channel safely serves both CPUs and preserves the OS floor.
// Method: round-trip realistic dual-architecture metadata, then remove each
// required artifact and corrupt boundary fields to prevent partial publication.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseDocument, stringify } from 'yaml';
import { macUpdateMetadata } from '#dist/scripts/release/macUpdateMetadata.js';

const files = ['arm64', 'x64'].flatMap((architecture) =>
  ['zip', 'dmg'].map((extension) => ({
    url: `Stacki-0.1.88-${architecture}.${extension}`,
    sha512: Buffer.alloc(64).toString('base64'),
    size: 12345,
  })),
);

function manifest(artifacts: readonly unknown[]): string {
  return stringify({ version: '0.1.88', files: artifacts });
}

test('Mac update requirements preserve both architectures and release metadata', () => {
  const source = manifest(files);
  const output = macUpdateMetadata(source);
  const expected = parseDocument(source);
  expected.set('minimumSystemVersion', '22.0.0');
  assert.equal(output, expected.toString());
  assert.equal(macUpdateMetadata(output), output);
});

test('every architecture needs both its updater ZIP and installer DMG', () => {
  for (const missing of files) {
    assert.throws(
      () => macUpdateMetadata(manifest(files.filter((file) => file !== missing))),
      /Update manifest needs the/,
    );
  }
});

test('invalid artifact fields prevent publication', () => {
  const valid = files[0];
  assert.ok(valid);
  const invalid = [
    undefined,
    'file',
    { ...valid, url: 42 },
    { ...valid, url: 'a'.repeat(257) },
    { ...valid, sha512: undefined },
    { ...valid, sha512: 'wrong' },
    { ...valid, size: undefined },
    { ...valid, size: 0 },
    { ...valid, size: -1 },
    { ...valid, size: 1.5 },
    { ...valid, size: Number.MAX_SAFE_INTEGER + 1 },
  ];
  for (const file of invalid) {
    assert.throws(() => macUpdateMetadata(manifest([file, ...files])));
  }
});

test('invalid update metadata cannot be uploaded as a compatible release', () => {
  for (const source of [
    'invalid: [',
    'files: []',
    'version: 0.1.88',
    'version: 0.1.88\nfiles: []',
    'version: 0.1.88\nfiles: [' + Array(21).fill('file').join(',') + ']',
    'x'.repeat(1_048_577),
  ]) {
    assert.throws(() => macUpdateMetadata(source));
  }
});
