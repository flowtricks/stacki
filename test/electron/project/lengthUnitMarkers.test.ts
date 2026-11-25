// Goal: electron/project/lengthUnitMarkers.ts reads a project's markers from disk
// and derives its length unit — the one reader Desktop's scan and Studio's scan
// share, so a Lumos site writes rem in both.
//
// Methodology: build throwaway projects on a temporary disk — Lumos by manifest,
// by LUMOS.md, plain, broken, with a root font size in src/styles, and with a
// LUMOS.md that is a symbolic link — and check the unit each one reads as.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readLengthUnit } from '#dist/electron/project/lengthUnitMarkers.js';

function project(context: { after: (fn: () => void) => void }, files: Readonly<Record<string, string>>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-length-unit-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), text);
  }
  return root;
}

test('a lumos block in package.json reads as rem at 16px', (context) => {
  const root = project(context, { 'package.json': JSON.stringify({ lumos: { version: '1.0.2' } }) });
  assert.deepEqual(readLengthUnit(root), { kind: 'rem', rootFontPx: 16 });
});

test('a LUMOS.md alone reads as rem', (context) => {
  const root = project(context, { 'package.json': '{}', 'LUMOS.md': '# Building with Lumos' });
  assert.deepEqual(readLengthUnit(root), { kind: 'rem', rootFontPx: 16 });
});

test('a plain or broken project reads as px', (context) => {
  assert.deepEqual(readLengthUnit(project(context, { 'package.json': '{"name":"x"}' })), { kind: 'px' });
  assert.deepEqual(readLengthUnit(project(context, { 'package.json': '{ broken' })), { kind: 'px' });
  assert.deepEqual(readLengthUnit(project(context, {})), { kind: 'px' });
});

test('the root font size comes from src/styles', (context) => {
  const root = project(context, {
    'LUMOS.md': '',
    'src/styles/base.css': 'html { font-size: 62.5%; }',
    'src/styles/global.css': '@import "./base.css";',
    'src/styles/notes.txt': 'html { font-size: 30px; }',
  });
  assert.deepEqual(readLengthUnit(root), { kind: 'rem', rootFontPx: 10 });
});

test('a LUMOS.md that is a symbolic link is not read as a marker', (context) => {
  const root = project(context, { 'elsewhere.md': '' });
  fs.symlinkSync(path.join(root, 'elsewhere.md'), path.join(root, 'LUMOS.md'));
  assert.deepEqual(readLengthUnit(root), { kind: 'px' });
});

test('a relative root is a programmer error', () => {
  assert.throws(() => readLengthUnit('relative/site'), { message: 'Assertion failed: readLengthUnit: the project root is absolute' });
});
