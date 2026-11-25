// Goal: reject the incomplete optional dependency graphs that broke clean CI installs.
// Method: check all shipped lockfiles, then remove historical missing packages and
// exercise nested resolution, foreign platforms, optional peers, and malformed input.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { lockfileMissingDependencies } from '#dist/scripts/release/lockfileClosure.js';
import { record } from '#dist/shared/core/boundary.js';

const LOCKFILES = [
  'package-lock.json',
  'studio/package-lock.json',
  'studio/test/fixtures/site/package-lock.json',
] as const;

function readLockfile(file: string): Record<string, unknown> {
  const source = readFileSync(file, 'utf8');
  assert.ok(source.length < 5_000_000, 'Lockfile exceeds test input limit');
  const input: unknown = JSON.parse(source);
  return record(input);
}

for (const file of LOCKFILES) {
  test(`${file} includes dependencies for every platform, including native peers`, () => {
    assert.deepEqual(lockfileMissingDependencies(readLockfile(file)), []);
  });
}

for (const name of [
  '@emnapi/core',
  '@emnapi/runtime',
  '@emnapi/wasi-threads',
  '@electron/windows-sign',
  'cross-dirname',
  'postject',
]) {
  test(`removing ${name} reproduces the October clean-install failures`, () => {
    const lockfile = readLockfile('package-lock.json');
    const packages = record(lockfile['packages']);
    assert.ok(Object.hasOwn(packages, `node_modules/${name}`));
    const remaining = Object.fromEntries(
      Object.entries(packages).filter(([location]) => location !== `node_modules/${name}`),
    );
    const missing = lockfileMissingDependencies({ ...lockfile, packages: remaining });
    assert.ok(
      missing.some((edge) => edge.endsWith(` ${name}`)),
      missing.join('\n'),
    );
  });
}

test('foreign native packages are required even on a Mac with a warm install', () => {
  const packages = {
    '': { dependencies: { builder: '1' } },
    'node_modules/builder': { optionalDependencies: { 'windows-sign': '1' } },
    'node_modules/windows-sign': { os: ['win32'], dependencies: { postject: '1' } },
  };
  const lockfile = { lockfileVersion: 3, packages };
  assert.deepEqual(lockfileMissingDependencies(lockfile), [
    'node_modules/windows-sign -> postject',
  ]);
  assert.deepEqual(
    lockfileMissingDependencies({
      ...lockfile,
      packages: { ...packages, 'node_modules/windows-sign/node_modules/postject': {} },
    }),
    [],
  );
});

test('required peers resolve beside their consumer; optional peers may be absent', () => {
  const packages = {
    '': {},
    'node_modules/consumer': {
      peerDependencies: { required: '1', optional: '1' },
      peerDependenciesMeta: { optional: { optional: true } },
    },
    'node_modules/consumer/node_modules/required': {},
  };
  assert.deepEqual(lockfileMissingDependencies({ lockfileVersion: 3, packages }), [
    'node_modules/consumer -> peer required',
  ]);
  assert.deepEqual(
    lockfileMissingDependencies({
      lockfileVersion: 3,
      packages: { ...packages, 'node_modules/required': {} },
    }),
    [],
  );
});

test('lockfile boundaries reject malformed and excessive inputs', () => {
  for (const input of [undefined, [], {}, { lockfileVersion: 2, packages: {} }]) {
    assert.throws(() => lockfileMissingDependencies(input));
  }
  for (const entry of [
    { dependencies: { package: 1 } },
    { dependencies: { '../escape': '1' } },
    { dependencies: { ['x'.repeat(215)]: '1' } },
    { peerDependencies: { package: '1' }, peerDependenciesMeta: { package: { optional: 'yes' } } },
    { dependencies: Object.fromEntries(Array.from({ length: 1001 }, (_, index) => [index, '1'])) },
  ]) {
    assert.throws(() =>
      lockfileMissingDependencies({ lockfileVersion: 3, packages: { '': entry } }),
    );
  }
  assert.throws(() => lockfileMissingDependencies({ lockfileVersion: 3, packages: {} }), /root/);
  assert.throws(
    () =>
      lockfileMissingDependencies({
        lockfileVersion: 3,
        packages: { '': {}, ['/'.repeat(65)]: {} },
      }),
    /depth/,
  );
});
