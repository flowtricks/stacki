// Goal: code intelligence's contract lets through only well-formed, bounded questions and answers: a document past its
// bound, a position outside it, a path that climbs out of the project and an unknown or oversized answer all throw.
// Method: table-driven cases against the shared parsers and the payload inventory.
import assert from 'node:assert/strict';
import test from 'node:test';
import { CODE_INTEL_LIMITS, parseCodeIntelReply, parseCodeIntelRequest } from '#dist/shared/ipc/codeIntel.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';

const asked = { projectPath: '/site', path: 'src/pages/index.astro', text: '<p></p>', query: { kind: 'hover', position: 1 } };

const item = {
  label: 'title',
  kind: 'property',
  detail: 'string',
  insert: 'title=""',
  cursor: 7,
  boost: 30,
  required: true,
  color: undefined,
  signature: 'title: string',
  documentation: undefined,
  edits: [{ from: 0, to: 0, insert: 'import A from "./a";' }],
  entry: { name: 'title', source: undefined, data: '1' },
};

test('a question parses, through the payload inventory too', () => {
  assert.deepEqual(parseCodeIntelRequest(asked), asked);
  assert.deepEqual(parseIpcPayload('codeIntel:request', asked), asked);
  for (const query of [
    { kind: 'complete', position: 0, explicit: false },
    { kind: 'signature', position: 7 },
    { kind: 'diagnostics' },
    { kind: 'resolve', position: 2, entry: { name: 'x', source: 'y', data: '3' } },
  ]) {
    assert.deepEqual(parseCodeIntelRequest({ ...asked, query }).query, query);
  }
});

test('a malformed or oversized question is refused', () => {
  const bad: readonly unknown[] = [
    undefined,
    { ...asked, path: '../outside.ts' },
    { ...asked, path: '/etc/passwd' },
    { ...asked, path: '' },
    { ...asked, text: 12 },
    { ...asked, text: 'a'.repeat(CODE_INTEL_LIMITS.documentCharsMax + 1) },
    { ...asked, query: { kind: 'hover', position: 8 } },
    { ...asked, query: { kind: 'hover', position: -1 } },
    { ...asked, query: { kind: 'hover', position: 1.5 } },
    { ...asked, query: { kind: 'run', position: 1 } },
    { ...asked, query: { kind: 'complete', position: 1 } },
  ];
  for (const input of bad) {
    assert.throws(() => parseCodeIntelRequest(input), Error, JSON.stringify(input)?.slice(0, 120));
  }
});

test('every kind of answer parses', () => {
  const answers: readonly unknown[] = [
    { kind: 'completions', completions: { from: 1, to: 2, exclusive: true, incomplete: false, items: [item] } },
    { kind: 'detail', detail: { signature: 'const a: 1', documentation: undefined, edits: [] } },
    { kind: 'hover', hover: { from: 1, to: 3, signature: 'x', documentation: 'y' } },
    { kind: 'hover', hover: undefined },
    { kind: 'signature', help: { from: 1, active: 0, signatures: [{ label: 'a(b)', activeFrom: 2, activeTo: 3, documentation: undefined }] } },
    { kind: 'diagnostics', diagnostics: [{ from: 0, to: 1, severity: 'error', message: 'no' }] },
    { kind: 'unavailable' },
  ];
  for (const answer of answers) {
    // As the wire carries it: absent fields stay absent after structured cloning.
    assert.doesNotThrow(() => parseCodeIntelReply(structuredClone(answer)));
  }
});

test('an answer past its bounds or out of shape is refused', () => {
  const list = (items: readonly unknown[]): unknown => ({ kind: 'completions', completions: { from: 0, to: 0, exclusive: true, incomplete: false, items } });
  const bad: readonly unknown[] = [
    { kind: 'html', body: '<script>' },
    list(Array.from({ length: CODE_INTEL_LIMITS.completionsMax + 1 }, () => item)),
    list([{ ...item, kind: 'surprise' }]),
    list([{ ...item, label: 'x'.repeat(CODE_INTEL_LIMITS.labelCharsMax + 1) }]),
    list([{ ...item, boost: Number.NaN }]),
    list([{ ...item, edits: [{ from: 4, to: 1, insert: '' }] }]),
    { kind: 'completions', completions: { from: 3, to: 1, exclusive: true, incomplete: false, items: [] } },
    { kind: 'diagnostics', diagnostics: [{ from: 0, to: 1, severity: 'fatal', message: 'no' }] },
    { kind: 'hover', hover: { from: 'a', to: 1 } },
  ];
  for (const input of bad) {
    assert.throws(() => parseCodeIntelReply(input), Error, JSON.stringify(input).slice(0, 120));
  }
});
