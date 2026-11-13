// Goal: CMS connections cross every boundary parsed — what the Settings section sends, what the
// main process or Studio answers, and the Sanity sign-in steps — and keys are never part of a
// reply. Method: one known-good value per shape, then each known-bad field, bound and address.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CMS_CONNECTION_LIMITS,
  CmsInputError,
  parseCmsCheckRequest,
  parseCmsCheckResult,
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
  assert.equal(parsed.kind === 'payload' ? parsed.baseUrl : undefined, 'https://cms.example.com', 'a trailing slash is dropped');
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
  // Found against a real Payload server: IPv6 loopback is a local server, a query corrupts every address built from it.
  assert.equal(parseCmsURL('http://[::1]:3101/'), 'http://[::1]:3101');
  assert.throws(() => parseCmsURL('https://cms.example.com/?x=1'), /query/);
  assert.throws(() => parseCmsURL(''), /Enter the CMS address/);
});

test('replies hold public fields only, within their bounds', () => {
  const list = parseCmsConnectionList({ encryption: 'available', connections: [SANITY] });
  assert.equal(list.connections.length, 1);
  assert.equal('secret' in (list.connections[0] ?? {}), false, 'a key is never read back');
  assert.throws(() => parseCmsConnectionList({ encryption: 'maybe', connections: [] }));
  const many = Array.from({ length: CMS_CONNECTION_LIMITS.connectionsPerProjectMax + 1 }, () => SANITY);
  assert.throws(() => parseCmsConnectionList({ encryption: 'available', connections: many }), /Too many/);
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

const PAYLOAD_DRAFT = { kind: 'payload', label: 'CMS', baseUrl: 'https://cms.example.com/', collection: 'users', secret: 'key-123' };

test('a Payload connection saved before logins existed is an API-key connection that names no collections', () => {
  const parsed = parseCmsConnection({ kind: 'payload', id: ID, label: 'CMS', baseUrl: 'https://cms.example.com', collection: 'users' });
  assert.deepEqual(parsed, {
    kind: 'payload',
    id: ID,
    label: 'CMS',
    baseUrl: 'https://cms.example.com',
    collection: 'users',
    auth: 'apiKey',
    email: undefined,
    collections: [],
  });
});

test('a Payload login names its email, and a password may hold what an API key may not', () => {
  const login = parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'password', email: ' admin@example.test ', secret: 'päss word ✓' });
  assert.equal(login.kind === 'payload' ? login.email : undefined, 'admin@example.test');
  assert.equal(login.secret, 'päss word ✓', 'a password is kept as typed');
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'password', secret: 'x' }), /email/i);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'password', email: 'not an email', secret: 'x' }), /email/i);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'password', email: 'a@b.test', secret: 'one\ntwo' }), /one line/);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, secret: 'päss' }), /printable/, 'an API key is still printable ASCII');
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'oauth' }), /API key or a login/);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, auth: 'password', email: 'a@b.test', secret: '' }), /password/i);
});

test('the collections a connection names are slugs, once each, and bounded', () => {
  const named = parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, collections: ['posts', 'blog-pages', 'media_files'] });
  assert.deepEqual(named.kind === 'payload' ? named.collections : undefined, ['posts', 'blog-pages', 'media_files']);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, collections: ['posts', 'posts'] }), /twice/);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, collections: ['a/b'] }), /Payload collection/);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, collections: 'posts' }), /collections/);
  const tooMany = Array.from({ length: CMS_CONNECTION_LIMITS.payloadCollectionsMax + 1 }, (_, index) => `c${index}`);
  assert.throws(() => parseCmsConnectionDraft({ ...PAYLOAD_DRAFT, collections: tooMany }), /few Payload collections/);
});

test('a connection list never carries a password or a key, even if a producer sends one', () => {
  const parsed = parseCmsConnection({
    kind: 'payload',
    id: ID,
    label: 'CMS',
    baseUrl: 'https://cms.example.com',
    collection: 'users',
    auth: 'password',
    email: 'a@b.test',
    secret: 'leak',
  });
  assert.equal(JSON.stringify(parsed).includes('leak'), false);
});

test('a check request is a saved connection to test or a Payload draft to detect, and nothing else', () => {
  assert.deepEqual(parseCmsCheckRequest({ action: 'test', id: ID }), { action: 'test', id: ID });
  const detect = parseCmsCheckRequest({ action: 'detect', draft: PAYLOAD_DRAFT });
  assert.equal(detect.action === 'detect' ? detect.draft.kind : undefined, 'payload');
  assert.throws(
    () => parseCmsCheckRequest({ action: 'detect', draft: { kind: 'sanity', label: 'S', projectId: 'abc', dataset: 'production', secret: 'k' } }),
    /Only Payload/,
  );
  assert.throws(() => parseCmsCheckRequest({ action: 'delete', id: ID }), /Unknown CMS check/);
  assert.throws(() => parseCmsCheckRequest({ action: 'test', id: 'x' }), /connection id/);
});

test('a check result parses its summary and its translatable reason, and refuses a malformed one', () => {
  const summary = {
    user: 'a@b.test',
    mode: 'apiKey',
    checkedAt: '2026-11-13T12:00:00.000Z',
    graphql: true,
    locales: ['en', 'fr'],
    collections: [{ slug: 'posts', drafts: true, upload: false }],
  };
  assert.deepEqual(parseCmsCheckResult({ ok: true, summary }), { ok: true, summary });
  const failed = parseCmsCheckResult({ ok: false, message: 'Too many attempts.', messageRef: { key: 'settings.cms.payload.error.locked' } });
  assert.deepEqual(failed, { ok: false, message: 'Too many attempts.', messageRef: { key: 'settings.cms.payload.error.locked' } });
  assert.deepEqual(
    parseCmsCheckResult({ ok: false, message: 'x', messageRef: { key: 'not a key' } }),
    { ok: false, message: 'x' },
    'a bad reference falls back to the English text',
  );
  assert.throws(() => parseCmsCheckResult({ ok: true, summary: { ...summary, mode: 'oauth' } }), /mode/);
  assert.throws(() => parseCmsCheckResult({ ok: true, summary: { ...summary, checkedAt: 'yesterday' } }), /check time/);
  assert.throws(() => parseCmsCheckResult({ ok: true, summary: { ...summary, collections: [{ slug: 'posts', drafts: 'yes', upload: false }] } }), /collection/);
  assert.throws(() => parseCmsCheckResult({ ok: false, message: '' }), /message/);
  const refused = parseCmsSaveResult({ ok: false, message: 'No', messageRef: { key: 'settings.cms.payload.error.noUser', params: { collection: 'users' } } });
  assert.equal(refused.ok === false ? refused.messageRef?.key : undefined, 'settings.cms.payload.error.noUser');
});

test('a failed Sanity sign-in keeps a valid message reference and drops a bad one', () => {
  const good = parseSanityLoginState({ kind: 'failed', message: 'Nope', messageRef: { key: 'cmsConnections.signIn.cancelled' } });
  assert.deepEqual(good, { kind: 'failed', message: 'Nope', messageRef: { key: 'cmsConnections.signIn.cancelled' } });
  assert.deepEqual(parseSanityLoginState({ kind: 'failed', message: 'Nope' }), { kind: 'failed', message: 'Nope' });
  assert.deepEqual(parseSanityLoginState({ kind: 'failed', message: 'Nope', messageRef: { key: 'not a key' } }), { kind: 'failed', message: 'Nope' });
});

test('a form refusal keeps its English sentence and carries the reference the renderer translates', () => {
  assert.throws(
    () => parseCmsURL(''),
    (error: unknown) =>
      error instanceof CmsInputError && error.message === 'Enter the CMS address.' && error.messageRef.key === 'cmsConnections.input.address.empty',
  );
  assert.throws(
    () => parseCmsConnectionDraft({ kind: 'custom', label: '', baseUrl: 'https://cms.example.com', header: 'Authorization', secret: 'k' }),
    (error: unknown) => error instanceof CmsInputError && error.messageRef.key === 'cmsConnections.input.label' && error.messageRef.params?.['max'] === 80,
  );
});
