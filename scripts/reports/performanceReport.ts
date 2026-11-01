#!/usr/bin/env node
// Compare the preview diff against a Git checkpoint without changing checkout.
//
//   node dist/scripts/reports/performanceReport.js [<ref> [<source path at ref>]]
//
// The current diff is read from the build; a reference is read from its
// source at <ref> (the morph client's source path by default; name the path
// the file had at that revision when it differs) and transpiled when it is
// TypeScript.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs = require('node:fs');
import path = require('node:path');
import { performance } from 'node:perf_hooks';
import ts = require('typescript');
import { repositoryRoot } from '../lib/repoRoot';

interface DiffImplementation {
  readonly diff: (before: readonly string[], after: readonly string[]) => unknown;
  readonly allocation: () => number;
  readonly reset: () => void;
}

const root = repositoryRoot();
const SOURCE_PATH = 'electron/previewClient/morphPatch.ts';
// Where the diff lived before the client was split into modules, for a
// reference revision from then.
const SOURCE_PATH_BEFORE_SPLIT = 'electron/previewClient/morphClient.ts';

function load(source: string): DiffImplementation {
  let allocatedBytes = 0;
  const startIndex = source.indexOf('function diffChildren(');
  const endIndex = source.indexOf('// Raised when the live document', startIndex);
  if (startIndex < 0 || endIndex < 0) {
    throw new Error('Cannot locate the preview diff in this revision.');
  }
  function TrackedArray(size: number): Int32Array {
    allocatedBytes += size * Int32Array.BYTES_PER_ELEMENT;
    return new Int32Array(size);
  }
  // The diff charges a per-patch work budget (spendMorphWork) in revisions
  // that have one; the report measures the diff, so the budget is a no-op.
  const factoryInput: unknown = Reflect.construct(Function, ['Int32Array', 'spendMorphWork', `${source.slice(startIndex, endIndex)}\nreturn diffChildren;`]);
  if (typeof factoryInput !== 'function') {
    throw new Error('Preview diff source did not produce a factory');
  }
  const spendMorphWork = (): void => undefined;
  const candidate: unknown = Reflect.apply(factoryInput, undefined, [TrackedArray, spendMorphWork]);
  if (typeof candidate !== 'function') {
    throw new Error('Preview diff source did not produce a function');
  }
  return {
    diff: (before, after) => {
      const result: unknown = Reflect.apply(candidate, undefined, [before, after]);
      return result;
    },
    allocation: () => allocatedBytes,
    reset: () => {
      allocatedBytes = 0;
    },
  };
}

function measure(
  implementation: DiffImplementation,
  before: readonly string[],
  after: readonly string[],
): { readonly ms: string; readonly matrixBytes: number } {
  implementation.diff(before, after);
  implementation.reset();
  const runs = 5;
  const started = performance.now();
  for (let index = 0; index < runs; index += 1) {
    implementation.diff(before, after);
  }
  return {
    ms: ((performance.now() - started) / runs).toFixed(3),
    matrixBytes: implementation.allocation() / runs,
  };
}

// The working tree's source rather than the build: the shipped client is a
// bundle, whose text keeps none of the comments the diff is found by.
const current = load(asJavaScript(fs.readFileSync(path.join(root, SOURCE_PATH), 'utf8'), SOURCE_PATH));
const reference = process.argv[2];
const before = reference ? load(referenceSource(reference, process.argv[3])) : undefined;

// A revision's source, as JavaScript: the named file, or wherever the diff
// lived in that revision.
function referenceSource(revision: string, named: string | undefined): string {
  const candidates = named === undefined ? [SOURCE_PATH, SOURCE_PATH_BEFORE_SPLIT] : [named];
  for (const file of candidates) {
    try {
      const source = execFileSync('git', ['show', `${revision}:${file}`], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return asJavaScript(source, file);
    } catch {
      // Not in this revision; try where it lived before.
    }
  }
  throw new Error(`No preview diff source in ${revision}: ${candidates.join(', ')}`);
}

// A TypeScript file is transpiled, which keeps the comments the diff's own
// markers are found by; JavaScript is taken as it is.
function asJavaScript(source: string, file: string): string {
  if (!file.endsWith('.ts')) {
    return source;
  }
  const options = { compilerOptions: { target: ts.ScriptTarget.ES2022, removeComments: false } };
  return ts.transpileModule(source, options).outputText;
}
const keys = Array.from({ length: 2_000 }, (_, index) => `node:${index}`);
const cases: ReadonlyArray<readonly [label: string, oldKeys: readonly string[], newKeys: readonly string[]]> = [
  ['Unchanged siblings', keys, keys],
  ['Append one sibling', keys, [...keys, 'new']],
  ['Remove last sibling', keys, keys.slice(0, -1)],
  ['Swap first two siblings', keys.slice(0, 200), [keys[1] ?? '', keys[0] ?? '', ...keys.slice(2, 200)]],
];

console.log('Preview sibling diff; mean of 5 warm runs. Matrix bytes exclude inputs.');
for (const [label, oldKeys, newKeys] of cases) {
  if (before) {
    assert.deepEqual(current.diff(oldKeys, newKeys), before.diff(oldKeys, newKeys), `${label} preserves exact edit operations`);
  }
  console.log(
    JSON.stringify({
      case: label,
      siblings: oldKeys.length,
      ...(before ? { before: measure(before, oldKeys, newKeys) } : {}),
      after: measure(current, oldKeys, newKeys),
    }),
  );
}
