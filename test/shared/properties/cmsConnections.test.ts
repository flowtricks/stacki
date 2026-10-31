// Goal: CMS connections cross every boundary parsed — what the Settings section sends, what the
// main process or Studio answers, and the Sanity sign-in steps — and keys are never part of a
// reply. Method: one known-good value per shape, then each known-bad field, bound and address.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CMS_CONNECTION_LIMITS,
  parseCmsConnection,
  parseCmsConnectionDraft,
  parseCmsConnectionList,
  parseCmsSaveResult,
  parseCmsURL,
  parseSanityLoginRequest,
  parseSanityLoginState,
  parseSanityLoginURL,
} from '#dist/shared/properties/cmsConnections.js';

const ID = '00000000-0000-4000-8000-000000000000';
const SANITY = {
  kind: 'sanity',
  id: ID,
  label: 'Church',
  projectId: 'abc123',
  dataset: 'production',
};

test('each kind of connection parses, and drafts carry their key', () => {
  assert.deepEqual(parseCmsConnection(SANITY), SANITY);
  const payload = {
    kind: 'payload',
    id: ID,
    label: 'Payload',
    baseUrl: 'https://cms.example.com/',
    collection: 'users',
  };
  const parsed = parseCmsConnection(payload);
  assert.equal(parsed.kind, 'payload');
  assert.equal(
    parsed.kind === 'payload' ? parsed.baseUrl : undefined,
    'https://cms.example.com',
    'a trailing slash is dropped',
  );
  const custom = {
    kind: 'custom',
    id: ID,
    label: 'Mine',
    baseUrl: 'http://localhost:3000/d',
    header: 'X-Key',
  };
  assert.equal(parseCmsConnection(custom).kind, 'custom');
  const draft = parseCmsConnectionDraft({ ...SANITY, id: undefined, secret: '  skAbc  ' });
  assert.equal(draft.secret, 'skAbc', 'surrounding spaces are trimmed');
});

test('known-bad connection fields are refused', () => {
  const bad = (change: object) => () => parseCmsConnection({ ...SANITY, ...change });
  assert.throws(bad({ kind: 'wordpress' }), /Unknown CMS kind/);
  assert.throws(bad({ id: 'not-a-uuid' }), /Invalid CMS connection id/);
  assert.throws(bad({ projectId: 'ABC' }), /Invalid Sanity project id/);
  assert.throws(bad({ dataset: '-prod' }), /Invalid Sanity dataset/);
  assert.throws(bad({ label: '' }), /connection name/);
  assert.throws(bad({ label: 'x'.repeat(CMS_CONNECTION_LIMITS.labelCharsMax + 1) }), /name/);
  const draft = (secret: unknown) => () => parseCmsConnectionDraft({ ...SANITY, secret });
  assert.throws(draft(''), /Paste the API key/);
  assert.throws(draft('two\nlines'), /one line/);
  assert.throws(draft('x'.repeat(CMS_CONNECTION_LIMITS.secretCharsMax + 1)), /Paste the API key/);
});

test('a CMS address is https, or http on this machine only', () => {
  assert.equal(parseCmsURL('https://cms.example.com'), 'https://cms.example.com');
  assert.equal(parseCmsURL('http://127.0.0.1:3000/api'), 'http://127.0.0.1:3000/api');
  assert.throws(() => parseCmsURL('http://cms.example.com'), /https/);
  assert.throws(() => parseCmsURL('ftp://cms.example.com'), /https/);
  assert.throws(() => parseCmsURL('https://user:pw@cms.example.com'), /login/);
  assert.throws(() => parseCmsURL('https://cms.example.com/#x'), /fragment/);
  assert.throws(() => parseCmsURL('not a url'), /not a URL/);
  assert.throws(() => parseCmsURL(''), /Enter the CMS address/);
});

test('replies hold public fields only, within their bounds', () => {
  const list = parseCmsConnectionList({ encryption: 'available', connections: [SANITY] });
  assert.equal(list.connections.length, 1);
  assert.equal('secret' in (list.connections[0] ?? {}), false, 'a key is never read back');
  assert.throws(() => parseCmsConnectionList({ encryption: 'maybe', connections: [] }));
  const many = Array.from(
    { length: CMS_CONNECTION_LIMITS.connectionsPerProjectMax + 1 },
    () => SANITY,
  );
  assert.throws(
    () => parseCmsConnectionList({ encryption: 'available', connections: many }),
    /Too many/,
  );
  assert.deepEqual(parseCmsSaveResult({ ok: false, message: 'No' }), { ok: false, message: 'No' });
  assert.throws(() => parseCmsSaveResult({ ok: false, message: '' }));
});

test('sign-in requests and states parse; the browser goes to Sanity only', () => {
  assert.deepEqual(parseSanityLoginRequest({ action: 'start', id: ID }), {
    action: 'start',
    id: ID,
  });
  assert.throws(() => parseSanityLoginRequest({ action: 'publish', id: ID }), /action/);
  const choose = { action: 'choose', id: ID, projectId: 'abc123', dataset: 'production' };
  assert.equal(parseSanityLoginRequest(choose).action, 'choose');
  const url = 'https://www.sanity.io/login?type=stampedToken&withSid=true';
  assert.deepEqual(parseSanityLoginState({ kind: 'browser', url }), { kind: 'browser', url });
  assert.throws(() => parseSanityLoginURL('https://evil.example.com/login'), /Unexpected/);
  assert.throws(() => parseSanityLoginURL('http://www.sanity.io/login'), /Unexpected/);
  assert.throws(() => parseSanityLoginURL('https://api.sanity.io/v1/auth/login'), /Unexpected/);
  const choosing = parseSanityLoginState({
    kind: 'choosing',
    projects: [{ id: 'abc123', name: 'Church', datasets: ['production'] }],
    suggestion: { projectId: 'abc123', dataset: 'production' },
  });
  assert.equal(choosing.kind, 'choosing');
  assert.throws(() =>
    parseSanityLoginState({
      kind: 'choosing',
      projects: [{ id: 'abc123', name: 'x', datasets: [7] }],
    }),
  );
  assert.throws(() => parseSanityLoginState({ kind: 'waiting' }), /Unknown Sanity sign-in state/);
});
