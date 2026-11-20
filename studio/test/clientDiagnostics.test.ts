// Goal: the canvas's wait report is accepted only in its bounded shape, and the kept list never outgrows its limit.
// Method: one good report, then the negative space (bad stage, impossible counts, wrong types, long text),
// then the list's cap and its parse of stored data; the route is exercised against an in-memory R2 stand-in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  appendClientDiagnostic,
  CLIENT_DIAGNOSTIC_LIMITS,
  clientDiagnosticsRoute,
  type DiagnosticsStore,
  parseClientDiagnostic,
  parseStoredDiagnostics,
  type StoredClientDiagnostic,
} from '../src/cloudflare/clientDiagnostics';

const good = { stage: 'script', frames: 2, framesLoaded: 2, frameError: '', page: '/', startupStage: '', userAgent: 'test' };

test('a complete report parses', () => {
  assert.deepEqual(parseClientDiagnostic(good), { ok: true, value: good });
});

test('a bad stage, impossible counts and wrong types are refused', () => {
  for (const bad of [
    null,
    [],
    'x',
    { ...good, stage: 'other' },
    { ...good, frames: -1 },
    { ...good, frames: 1.5 },
    { ...good, frames: CLIENT_DIAGNOSTIC_LIMITS.framesMax + 1 },
    { ...good, frames: 1, framesLoaded: 2 },
    { ...good, framesLoaded: '1' },
  ]) {
    assert.equal(parseClientDiagnostic(bad).ok, false);
  }
});

test('text fields are cut to the limit and absent ones become empty', () => {
  const result = parseClientDiagnostic({ stage: 'frame', frames: 1, framesLoaded: 0, frameError: 'x'.repeat(5000) });
  assert.ok(result.ok);
  assert.equal(result.value.frameError.length, CLIENT_DIAGNOSTIC_LIMITS.textCharsMax);
  assert.equal(result.value.page, '');
});

test('the list keeps the newest first and stops at its limit', () => {
  let list: readonly StoredClientDiagnostic[] = [];
  for (let index = 0; index < CLIENT_DIAGNOSTIC_LIMITS.entriesMax + 5; index++) {
    list = appendClientDiagnostic(list, { ...good, stage: 'script', page: `/${index}`, at: `t${index}` });
  }
  assert.equal(list.length, CLIENT_DIAGNOSTIC_LIMITS.entriesMax);
  assert.equal(list[0]?.page, `/${CLIENT_DIAGNOSTIC_LIMITS.entriesMax + 4}`);
});

test('stored data that is not a list of reports reads as empty', () => {
  assert.deepEqual(parseStoredDiagnostics({}), []);
  assert.deepEqual(parseStoredDiagnostics([{ nonsense: true }]), []);
});

function fakeBucket(): DiagnosticsStore {
  const store = new Map<string, string>();
  return {
    get: async (key: string) => {
      const value = store.get(key);
      if (value === undefined) {
        return null;
      }
      const parsed: unknown = JSON.parse(value);
      return { json: async () => parsed };
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

test('POST stores a report and GET reads it back; oversize and invalid are refused', async () => {
  const drafts = fakeBucket();
  const now = () => '2026-01-01T00:00:00Z';
  const post = (body: string) => clientDiagnosticsRoute(new Request('https://x/studio/api/client-diagnostics', { method: 'POST', body }), drafts, now);
  assert.equal((await post(JSON.stringify(good))).status, 204);
  assert.equal((await post('{')).status, 400);
  assert.equal((await post(JSON.stringify({ ...good, stage: 'nope' }))).status, 400);
  assert.equal((await post('x'.repeat(CLIENT_DIAGNOSTIC_LIMITS.bodyBytesMax + 1))).status, 413);
  const read = await clientDiagnosticsRoute(new Request('https://x/studio/api/client-diagnostics'), drafts, now);
  const list: unknown = await read.json();
  assert.ok(Array.isArray(list));
  assert.equal(list.length, 1);
  assert.equal((await clientDiagnosticsRoute(new Request('https://x/studio/api/client-diagnostics', { method: 'DELETE' }), drafts, now)).status, 405);
});
