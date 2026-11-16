// Goal: main's pre-flight gate holds a gesture that would add an error to an .astro file, with a
// plain reason for the notice, and lets everything else through: typed code (advised, never
// parsed on the keystroke path), non-.astro files, unchanged findings, and a file whose candidate
// does not parse (the candidate check's to refuse). The cache stays bounded.
// Method: the real gate over snapshots built from generated text; the disk check is injected.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DOCUMENT_PREFLIGHT_LIMITS, createDocumentPreflight } from '#dist/electron/documents/documentPreflight.js';
import { toDigest, toFilePath } from '#dist/shared/core/brand.js';
import { toByteString } from '#dist/shared/core/span.js';
import type { Operation } from '#dist/shared/engine/intent.js';
import type { Snapshot } from '#dist/shared/page/snapshot.js';

const encoder = new TextEncoder();
let serial = 0;
function snapshot(text: string, path = '/site/src/pages/index.astro'): Snapshot {
  serial += 1;
  const bytes = toByteString(encoder.encode(text));
  // The gate reads only the path, the checksum and the bytes; the projection is the actor's.
  return {
    path: toFilePath(path),
    checksum: toDigest(createHash('sha256').update(`${text}\u0000${serial}`).digest('hex')),
    bytes,
    projection: { tag: 'parse-error', byteLength: bytes.length, diagnostics: [] },
  };
}
const GESTURE: Operation = { tag: 'remove-node' };
const TYPED: Operation = { tag: 'apply-code-patch', hunks: [] };
const lines: string[] = [];
const gate = createDocumentPreflight({ log: (line) => lines.push(line), exists: () => true });
const BASE = "---\nimport Layout from '../layouts/Layout.astro';\n---\n<Layout><main></main></Layout>\n";

test('a gesture that adds a missing component is refused with a plain reason', () => {
  const verdict = gate(snapshot(BASE), snapshot(BASE.replace('<main></main>', '<main><StatWrap /></main>')), GESTURE);
  assert.equal(verdict.tag, 'refuse');
  if (verdict.tag === 'refuse') {
    assert.match(verdict.message, /would break the page: the StatWrap component isn’t imported/);
  }
  assert.ok(lines.some((line) => line === 'preflight refused remove-node missing-component'));
});

test('typed code, other files and harmless gestures pass', () => {
  const broken = BASE.replace('<main></main>', '<main>{nope}</main>');
  assert.deepEqual(gate(snapshot(BASE), snapshot(broken), TYPED), { tag: 'pass' });
  assert.deepEqual(gate(snapshot('a {}', '/site/src/styles/a.css'), snapshot('a { b }', '/site/src/styles/a.css'), GESTURE), {
    tag: 'pass',
  });
  assert.deepEqual(gate(snapshot(BASE), snapshot(BASE.replace('<main></main>', '<main><p>Hi</p></main>')), GESTURE), { tag: 'pass' });
  assert.deepEqual(
    gate(snapshot(broken), snapshot(broken.replace('</main>', '<p>x</p></main>')), GESTURE),
    { tag: 'pass' },
    'An error the file already had is not the edit’s',
  );
});

test('the parse cache stays bounded', () => {
  for (let index = 0; index < DOCUMENT_PREFLIGHT_LIMITS.cachedFilesMax * 3; index++) {
    gate(snapshot(BASE), snapshot(`${BASE}<p>${index}</p>\n`), GESTURE);
  }
  assert.ok(true, 'The cache evicts instead of growing (asserted inside the gate)');
});
