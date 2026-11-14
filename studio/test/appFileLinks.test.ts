// Goal: an app file link opens one app's folder on one host until it expires, and nothing
// else: no other app, host or route, no traversal out of the folder, no forged or
// stretched expiry, and no MAC that verifies under another purpose (issue #80).
// Method: the pure link module (src/cloudflare/appFileLinks.ts) under Node's WebCrypto,
// which implements the same HMAC and HKDF as the Workers runtime. Paths go through
// `new URL` first, as the Worker reads them, and also raw, since an attacker controls
// the bytes. Every tamper case changes exactly one field of a valid link.
// cloudflareAppFiles.test.ts checks the same rules end to end in workerd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_FILE_LINK_LIMITS, appFileContainerPath, mintAppFileLink, parseAppFilePath, verifyAppFileLink } from '../src/cloudflare/appFileLinks';

// A fake secret for tests only.
const SECRET = 'app-file-link-test-secret-0123456789abcdef';
const HOST = 'studio.example.com';
const NOW_MS = 1_800_000_000_000;
const HOUR_MS = 3_600_000;

async function link(id = 'notes', file = 'app.css', options: { readonly host?: string; readonly secret?: string; readonly sessionExpiresMs?: number } = {}) {
  const minted = await mintAppFileLink({
    secret: options.secret ?? SECRET,
    host: options.host ?? HOST,
    id,
    file,
    sessionExpiresMs: options.sessionExpiresMs ?? NOW_MS + 24 * HOUR_MS,
    nowMs: NOW_MS,
  });
  assert.ok(minted, 'The link was minted');
  return minted;
}

function linked(pathname: string) {
  const parsed = parseAppFilePath(pathname);
  assert.equal(parsed.kind, 'linked', pathname);
  if (parsed.kind !== 'linked') {
    throw new Error('unreachable');
  }
  return parsed;
}

async function verifies(pathname: string, options: { readonly host?: string; readonly nowMs?: number; readonly secret?: string } = {}) {
  const parsed = parseAppFilePath(pathname);
  if (parsed.kind !== 'linked') {
    return false;
  }
  return verifyAppFileLink({ secret: options.secret ?? SECRET, host: options.host ?? HOST, link: parsed, nowMs: options.nowMs ?? NOW_MS });
}

test('a minted link stays in its app folder and verifies for its host until it expires', async () => {
  const minted = await link('notes', 'styles/app.css');
  assert.match(minted, /^\/studio\/api\/apps\/files\/notes\/~[1-9][0-9]*\.[A-Za-z0-9_-]{43}\/styles\/app\.css$/);
  const parsed = linked(minted);
  assert.equal(parsed.id, 'notes');
  assert.equal(parsed.file, 'styles/app.css');
  assert.equal(parsed.expiresSeconds, Math.floor(NOW_MS / 1000) + APP_FILE_LINK_LIMITS.lifetimeSecondsMax);
  assert.equal(await verifies(minted), true);
  assert.equal(await verifies(minted, { nowMs: NOW_MS + 8 * HOUR_MS - 1000 }), true);
  assert.equal(await verifies(minted, { nowMs: NOW_MS + 8 * HOUR_MS }), false, 'Expired');
  assert.equal(appFileContainerPath(parsed.id, parsed.file), '/studio/api/apps/files/notes/styles/app.css');
});

test('relative loads under one link reach other files of the same app folder only', async () => {
  const minted = await link('notes', 'index.html');
  const sibling = minted.replace(/index\.html$/, '__stacki/ui.js');
  assert.equal(await verifies(sibling), true, 'The frame loads its siblings with the same link');
  assert.equal(linked(sibling).file, '__stacki/ui.js');
  assert.equal(await verifies(minted.replace('/files/notes/', '/files/other-app/')), false, 'Another app');
});

test('a link expires with its session and never lasts longer than eight hours', async () => {
  const short = await link('notes', 'app.css', { sessionExpiresMs: NOW_MS + 10 * 60_000 });
  assert.equal(linked(short).expiresSeconds, Math.floor((NOW_MS + 10 * 60_000) / 1000));
  assert.equal(await verifies(short, { nowMs: NOW_MS + 11 * 60_000 }), false);
  const expiredSession = await mintAppFileLink({ secret: SECRET, host: HOST, id: 'notes', file: 'app.css', sessionExpiresMs: NOW_MS - 1, nowMs: NOW_MS });
  assert.equal(expiredSession, undefined, 'An expired session cannot mint');
  const endingSession = await mintAppFileLink({ secret: SECRET, host: HOST, id: 'notes', file: 'app.css', sessionExpiresMs: NOW_MS + 999, nowMs: NOW_MS });
  assert.equal(endingSession, undefined, 'A session with less than a second left cannot mint');
  // Seen from before it was minted, the same valid MAC is more than eight hours away: refused.
  const stretched = await link();
  assert.equal(await verifies(stretched, { nowMs: NOW_MS - 60_000 }), false);
});

test('changing any signed field, the host or the key refuses the link', async () => {
  const minted = await link('notes', 'app.css');
  const parsed = linked(minted);
  const signature = parsed.signature;
  const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
  assert.equal(await verifies(minted.replace(signature, flipped)), false, 'Signature');
  assert.equal(await verifies(minted.replace('~' + parsed.expiresSeconds, '~' + (parsed.expiresSeconds - 1))), false, 'Expiry');
  assert.equal(await verifies(minted.replace('/files/notes/', '/files/notes2/')), false, 'App id');
  assert.equal(await verifies(minted, { host: 'preview.example.com' }), false, 'Host');
  assert.equal(await verifies(minted, { host: HOST + ':8443' }), false, 'Port');
  assert.equal(await verifies(minted, { secret: SECRET + '-rotated' }), false, 'Key');
  assert.equal(await verifies(minted, { host: HOST.toUpperCase() }), true, 'Host names compare without case');
});

test('the MAC is domain-separated from the raw session secret', async () => {
  const minted = await link('notes', 'app.css');
  const parsed = linked(minted);
  // The same message signed with the raw secret, as session.ts signs sessions, must not verify.
  const raw = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const field = (value: string) => `${value.length}:${value}`;
  const message = ['stacki-app-file-link-v1', field(HOST), field('notes'), field(String(parsed.expiresSeconds))].join('\n');
  const forged = Buffer.from(await crypto.subtle.sign('HMAC', raw, new TextEncoder().encode(message))).toString('base64url');
  assert.equal(await verifies(minted.replace(parsed.signature, forged)), false);
});

test('traversal, encoded separators and unusual names are refused under a link', async () => {
  const minted = await link('notes', 'app.css');
  const prefix = minted.slice(0, minted.length - 'app.css'.length);
  const attempts = [
    '%2e%2e/%2e%2e/session',
    '..%2f..%2fsession',
    '%2E%2E%2Fsecret',
    '%252e%252e/%252e%252e/session',
    '..%5c..%5csession',
    'a%00.css',
    '.env',
    'dir/.git/config',
    '%2e/app.css',
    'a:b.css',
    '%EF%BC%8E%EF%BC%8E/session',
    'caf%C3%A9.css',
    'bad%zz.css',
    'dir//app.css',
    'dir/',
    'x/'.repeat(APP_FILE_LINK_LIMITS.segmentsMax) + 'deep.css',
    'a'.repeat(APP_FILE_LINK_LIMITS.pathCharsMax) + '.css',
  ];
  for (const attempt of attempts) {
    assert.equal(parseAppFilePath(prefix + attempt).kind, 'refused', 'raw ' + attempt);
    // As the Worker sees it after URL parsing, which resolves literal and %2e dot segments.
    const seen = new URL(prefix + attempt, 'https://' + HOST).pathname;
    const parsed = parseAppFilePath(seen);
    if (parsed.kind === 'linked') {
      assert.equal(parsed.id, 'notes', 'parsed ' + attempt);
      assert.doesNotMatch(parsed.file, /(^|\/)\.|%2f|%5c|\\/i, 'parsed ' + attempt);
    }
  }
  // Backslashes become slashes in a URL; raw, they are refused.
  assert.equal(parseAppFilePath(prefix + '..\\..\\session').kind, 'refused');
  // Dot segments a URL resolves can only climb out of the link segment, never keep it.
  for (const climb of ['../../other/app.css', '%2e%2e/%2e%2e/other/app.css']) {
    const seen = new URL(prefix + climb, 'https://' + HOST).pathname;
    assert.notEqual(parseAppFilePath(seen).kind, 'linked', climb);
  }
});

test('names a frame really uses keep working, re-encoded canonically', () => {
  const parsed = parseAppFilePath('/studio/api/apps/files/notes/~1800000000.' + 'A'.repeat(43) + '/assets/My%20Icon%20(2).svg');
  assert.equal(parsed.kind, 'linked');
  if (parsed.kind === 'linked') {
    assert.equal(parsed.file, 'assets/My%20Icon%20(2).svg');
  }
  const root = parseAppFilePath('/studio/api/apps/files/notes/~1800000000.' + 'A'.repeat(43) + '/');
  assert.equal(root.kind === 'linked' ? root.file : undefined, '');
});

test('link-shaped paths with a malformed link or app id are refused; others are not this module’s', () => {
  const signature = 'A'.repeat(43);
  for (const pathname of [
    `/studio/api/apps/files/notes/~0123.${signature}/app.css`,
    `/studio/api/apps/files/notes/~-5.${signature}/app.css`,
    `/studio/api/apps/files/notes/~1.5.${signature}/app.css`,
    `/studio/api/apps/files/notes/~99999999999999.${signature}/app.css`,
    `/studio/api/apps/files/notes/~1800000000.${signature}A/app.css`,
    `/studio/api/apps/files/notes/~1800000000.${signature.slice(1)}/app.css`,
    `/studio/api/apps/files/notes/~1800000000/app.css`,
    `/studio/api/apps/files/Notes/~1800000000.${signature}/app.css`,
    `/studio/api/apps/files/no%74es/~1800000000.${signature}/app.css`,
  ]) {
    assert.equal(parseAppFilePath(pathname).kind, 'refused', pathname);
  }
  assert.deepEqual(parseAppFilePath('/studio/api/apps'), { kind: 'other' });
  assert.deepEqual(parseAppFilePath('/studio/api/apps/files'), { kind: 'other' });
  assert.deepEqual(parseAppFilePath('/studio/api/apps/files/notes/.env'), { kind: 'other' });
  assert.deepEqual(parseAppFilePath('/studio/api/apps/files/notes'), { kind: 'plain', id: 'notes', file: '' });
  assert.deepEqual(parseAppFilePath('/studio/api/apps/files/notes/a%20b.css'), { kind: 'plain', id: 'notes', file: 'a%20b.css' });
});
