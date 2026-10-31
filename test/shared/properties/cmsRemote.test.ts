// Goal: what the CMS panel sends and receives about a connected CMS is parsed at the boundary —
// writes name a published document and one field, and replies stay within their bounds.
// Method: one known-good value per shape, then each known-bad id, field, value, type and size.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CMS_REMOTE_LIMITS,
  parseRemoteDocument,
  parseRemoteDocumentAction,
  parseRemoteDocuments,
  parseRemoteResult,
  parseRemoteRevisionId,
  parseRemoteWrite,
} from '#dist/shared/properties/cmsRemote.js';
import {
  REMOTE_SCHEMA_LIMITS,
  parseRemoteRule,
  parseRemoteType,
} from '#dist/shared/properties/cmsRemoteSchema.js';

test('a write names a published document, one top-level field and a JSON value', () => {
  const write = { id: 'abc-1', field: 'location', value: { _type: 'geopoint', lat: 30.1 } };
  assert.deepEqual(parseRemoteWrite(write), write);
  assert.equal(parseRemoteWrite({ ...write, value: undefined }).value, undefined, 'a removal');
  const withNull: unknown = JSON.parse('["a", null]');
  assert.deepEqual(parseRemoteWrite({ ...write, value: withNull }).value, ['a'], 'nulls drop');
  const bad = (change: object) => () => parseRemoteWrite({ ...write, ...change });
  assert.throws(bad({ id: 'drafts.abc' }), /Invalid CMS document id/, 'never a draft id');
  assert.throws(bad({ id: 'versions.r.abc' }), /Invalid CMS document id/);
  assert.throws(bad({ field: '_id' }), /Invalid field name/, 'never a system field');
  assert.throws(bad({ field: 'a.b' }), /Invalid field name/, 'never a dotted path');
  assert.throws(bad({ value: Number.NaN }), /finite/);
  assert.throws(bad({ value: { 'a b': 1 } }), /Invalid key/);
  const long = 'x'.repeat(REMOTE_SCHEMA_LIMITS.valueCharsMax + 1);
  assert.throws(bad({ value: long }), /too long/);
  let deep: unknown = 'x';
  for (let level = 0; level <= REMOTE_SCHEMA_LIMITS.valueDepthMax + 1; level++) {
    deep = [deep];
  }
  assert.throws(bad({ value: deep }), /too deeply/);
});

test('documents parse with typed fields and assets; unknown types and statuses are refused', () => {
  const field = {
    name: 'name',
    title: 'Name',
    description: '',
    required: true,
    rules: [{ level: 'error', kind: 'required' }],
  };
  const document = {
    id: 'abc',
    type: 'campus',
    status: 'changed',
    assets: [{ id: 'image-1-2x2-png', url: 'https://cdn.sanity.io/x.png', filename: 'x.png' }],
    fields: [
      { ...field, type: { kind: 'string', options: [] }, value: 'Donaldsonville' },
      {
        ...field,
        name: 'serviceTimes',
        required: false,
        type: {
          kind: 'array',
          of: [
            {
              kind: 'object',
              name: 'time',
              fields: [{ ...field, type: { kind: 'datetime', options: [] } }],
            },
          ],
        },
        value: [{ _key: 'k', _type: 'time', name: '2026-10-30T10:00:00Z' }],
      },
    ],
  };
  assert.equal(parseRemoteDocument(document).fields.length, 2);
  const timed = { ...document, editedAt: '2026-10-30T12:00:00Z', publishedAt: undefined };
  assert.equal(parseRemoteDocument(timed).editedAt, '2026-10-30T12:00:00Z');
  assert.throws(() => parseRemoteDocument({ ...document, editedAt: 'yesterday' }), /CMS time/);
  assert.throws(() => parseRemoteDocument({ ...document, status: 'archived' }), /status/);
  const html = { ...field, type: { kind: 'html' }, value: '' };
  assert.throws(() => parseRemoteDocument({ ...document, fields: [html] }), /field type/);
  const unflagged = { ...field, required: 'yes', type: { kind: 'string', options: [] } };
  assert.throws(() => parseRemoteDocument({ ...document, fields: [unflagged] }), /required/);
  const asset = { id: 'image-1', url: 'http://cdn.example.com/x.png', filename: 'x' };
  assert.throws(() => parseRemoteDocument({ ...document, assets: [asset] }), /editor address/);
  assert.throws(
    () => parseRemoteDocument({ ...document, editURL: 'http://studio.example.com' }),
    /editor address/,
  );
  const many = Array.from({ length: CMS_REMOTE_LIMITS.documentsMax + 1 }, () => ({
    id: 'a',
    title: 't',
    status: 'published',
    updatedAt: '',
  }));
  assert.throws(() => parseRemoteDocuments(many), /Too many/);
});

test('rules parse by kind; unknown kinds, levels and limits are refused', () => {
  assert.deepEqual(parseRemoteRule({ level: 'warning', kind: 'max', limit: 5 }), {
    level: 'warning',
    kind: 'max',
    limit: 5,
  });
  const uri = { level: 'error', kind: 'uri', schemes: ['https'], relative: true };
  assert.deepEqual(parseRemoteRule(uri), uri);
  assert.throws(() => parseRemoteRule({ level: 'info', kind: 'required' }), /level/);
  assert.throws(() => parseRemoteRule({ level: 'error', kind: 'custom' }), /Unknown rule/);
  assert.throws(() => parseRemoteRule({ level: 'error', kind: 'min', limit: 'x' }), /limit/);
});

test('document actions and revision ids are named, never free text', () => {
  assert.equal(parseRemoteDocumentAction('unpublish'), 'unpublish');
  assert.throws(() => parseRemoteDocumentAction('delete'), /Unknown document action/);
  assert.equal(parseRemoteRevisionId('tx-1'), 'tx-1');
  assert.throws(() => parseRemoteRevisionId('../x'), /revision id/);
});

test('types nest only to their bound', () => {
  let type: unknown = { kind: 'string', options: [] };
  for (let level = 0; level <= REMOTE_SCHEMA_LIMITS.typeDepthMax + 1; level++) {
    type = { kind: 'array', of: [type] };
  }
  assert.throws(() => parseRemoteType(type), /too deeply/);
  assert.deepEqual(parseRemoteType({ kind: 'reference', to: ['campus'] }), {
    kind: 'reference',
    to: ['campus'],
  });
});

test('results carry a value or a short message', () => {
  assert.deepEqual(
    parseRemoteResult({ ok: true, value: [] }, (value) => value),
    { ok: true, value: [] },
  );
  assert.deepEqual(
    parseRemoteResult({ ok: false, message: 'Offline' }, () => 1),
    {
      ok: false,
      message: 'Offline',
    },
  );
  assert.throws(
    () => parseRemoteResult({ ok: false, message: '' }, () => 1),
    /says what went wrong/,
  );
});
