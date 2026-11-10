// Goal: the media hosting contract (shared/properties/mediaHosting.ts) admits
// exactly the connections, drafts, names, folders, orders and listings the
// panel and the main process agree on, and refuses every other shape at the
// boundary — including the secret ever riding along with a public connection.
// Method: one known-good value per parser, then each known-bad variation of it
// (wrong kind, wrong key type, out-of-bound lengths, path tricks, mismatched
// listing entries), and the replacement rule over every media kind.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MEDIA_HOSTING_LIMITS,
  MEDIA_ORDER_FILE,
  mediaKindOf,
  parseMediaConnection,
  parseMediaConnectionDraft,
  parseMediaConnectionList,
  parseMediaFolder,
  parseMediaKey,
  parseMediaListing,
  parseMediaName,
  parseMediaOrder,
  parseMediaResult,
  parseMediaSaveResult,
  parseMediaURL,
  replacementRefusal,
} from '#dist/shared/properties/mediaHosting.js';

const ID = '00000000-0000-4000-8000-000000000000';
const KEY_PAIR = { kind: 'keyPair', accessKeyId: 'AKID', secretAccessKey: 'secret/key+1' };
const CLOUDFLARE = { kind: 'r2', label: 'Media', accountId: 'a'.repeat(32), bucket: 'site-media', publicBaseUrl: 'https://pub-1.cloudflare.dev/' };
const BUNNY = { kind: 'bunny', label: 'CDN', storageZone: 'site-zone', region: 'ny', publicBaseUrl: 'https://site.b-cdn.net' };
const SPACES = {
  kind: 's3',
  label: 'Spaces',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  region: 'us-east-1',
  bucket: 'media',
  addressing: 'virtual',
  publicBaseUrl: 'https://media.nyc3.cdn.digitaloceanspaces.com',
};

test('drafts: each provider with its own kind of key, trimmed and normalised', () => {
  const cloudflare = parseMediaConnectionDraft({ ...CLOUDFLARE, secret: KEY_PAIR });
  assert.equal(cloudflare.kind, 'r2');
  assert.equal(cloudflare.publicBaseUrl, 'https://pub-1.cloudflare.dev', 'a trailing slash is dropped');
  assert.deepEqual(cloudflare.secret, KEY_PAIR);
  const bunny = parseMediaConnectionDraft({ ...BUNNY, secret: { kind: 'accessKey', accessKey: 'zone-password' } });
  assert.equal(bunny.kind === 'bunny' ? bunny.region : '', 'ny');
  assert.equal(parseMediaConnectionDraft({ ...SPACES, secret: KEY_PAIR }).kind, 's3');
});

test('drafts: every malformed field is refused with a sentence', () => {
  const bad: readonly (readonly [Record<string, unknown>, RegExp])[] = [
    [{ ...CLOUDFLARE, secret: { kind: 'accessKey', accessKey: 'x' } }, /access key ID and a secret/],
    [{ ...BUNNY, secret: KEY_PAIR }, /storage zone password/],
    [{ ...CLOUDFLARE, accountId: 'not-hex', secret: KEY_PAIR }, /account id/],
    [{ ...CLOUDFLARE, bucket: 'UPPER', secret: KEY_PAIR }, /bucket name/],
    [{ ...CLOUDFLARE, bucket: 'a/b', secret: KEY_PAIR }, /bucket name/],
    [{ ...CLOUDFLARE, publicBaseUrl: 'http://cdn.example.com', secret: KEY_PAIR }, /https/],
    [{ ...CLOUDFLARE, publicBaseUrl: 'https://user:pass@cdn.example.com', secret: KEY_PAIR }, /login/],
    [{ ...CLOUDFLARE, publicBaseUrl: 'https://cdn.example.com/?a=1', secret: KEY_PAIR }, /query/],
    [{ ...CLOUDFLARE, label: '', secret: KEY_PAIR }, /connection name/],
    [{ ...CLOUDFLARE, label: 'x'.repeat(MEDIA_HOSTING_LIMITS.labelCharsMax + 1), secret: KEY_PAIR }, /connection name/],
    [{ ...BUNNY, region: 'mars', secret: { kind: 'accessKey', accessKey: 'x' } }, /region/],
    [{ ...SPACES, endpoint: 'https://s3.example.com/path', secret: KEY_PAIR }, /without a path/],
    [{ ...SPACES, addressing: 'dns', secret: KEY_PAIR }, /addressing/],
    [{ ...CLOUDFLARE, secret: { ...KEY_PAIR, secretAccessKey: 'has space' } }, /printable/],
    [{ ...CLOUDFLARE, secret: { ...KEY_PAIR, accessKeyId: '' } }, /Paste/],
    [{ ...CLOUDFLARE, secret: { ...KEY_PAIR, secretAccessKey: 'x'.repeat(MEDIA_HOSTING_LIMITS.secretCharsMax + 1) } }, /Paste/],
    [{ ...CLOUDFLARE, kind: 'dropbox', secret: KEY_PAIR }, /Unknown media host/],
  ];
  for (const [input, message] of bad) {
    assert.throws(() => parseMediaConnectionDraft(input), message, JSON.stringify(input));
  }
});

test('public connections: an id, never a key; lists are bounded', () => {
  const connection = parseMediaConnection({ ...CLOUDFLARE, id: ID });
  assert.equal('secret' in connection, false);
  assert.throws(() => parseMediaConnection({ ...CLOUDFLARE, id: 'nope' }), /id/);
  const list = parseMediaConnectionList({ encryption: 'available', connections: [{ ...CLOUDFLARE, id: ID }] });
  assert.equal(list.connections.length, 1);
  assert.throws(() => parseMediaConnectionList({ encryption: 'maybe', connections: [] }), /encryption/);
  const tooMany = Array.from({ length: MEDIA_HOSTING_LIMITS.connectionsPerProjectMax + 1 }, () => ({ ...CLOUDFLARE, id: ID }));
  assert.throws(() => parseMediaConnectionList({ encryption: 'available', connections: tooMany }), /Too many/);
  assert.deepEqual(parseMediaSaveResult({ ok: false, message: 'No' }), { ok: false, message: 'No' });
  assert.throws(() => parseMediaSaveResult({ ok: 'yes' }), /save result/);
});

test('names, folders and keys: one segment each, bounded, no traversal, no manifest', () => {
  assert.equal(parseMediaName('hero shot.png'), 'hero shot.png');
  for (const name of ['', '.', '..', 'a/b', 'a\\b', ' lead', 'tab\t', MEDIA_ORDER_FILE, 'x'.repeat(MEDIA_HOSTING_LIMITS.nameCharsMax + 1)]) {
    assert.throws(() => parseMediaName(name), Error, JSON.stringify(name));
  }
  assert.equal(parseMediaFolder(''), '');
  assert.equal(parseMediaFolder('images/2024'), 'images/2024');
  for (const folder of ['/images', 'images/', 'a//b', '../up', Array.from({ length: MEDIA_HOSTING_LIMITS.folderDepthMax + 1 }, () => 'a').join('/')]) {
    assert.throws(() => parseMediaFolder(folder), Error, folder);
  }
  assert.equal(parseMediaKey('images/hero.png'), 'images/hero.png');
  assert.throws(() => parseMediaKey(`${'é'.repeat(200)}/${'é'.repeat(200)}/${'é'.repeat(200)}`), /bytes/);
  assert.deepEqual(parseMediaOrder(['b.png', 'a.png']), ['b.png', 'a.png']);
  assert.throws(() => parseMediaOrder(['a.png', 'a.png']), /once/);
  assert.throws(() => parseMediaOrder('a.png'), /order/);
});

test('URLs: https anywhere, http only on this machine', () => {
  assert.equal(parseMediaURL('http://localhost:9000/bucket/', 'URL'), 'http://localhost:9000/bucket');
  assert.throws(() => parseMediaURL('ftp://example.com', 'URL'), /https/);
  assert.throws(() => parseMediaURL('javascript:alert(1)', 'URL'), /https/);
  assert.throws(() => parseMediaURL('not a url', 'URL'), /not a URL/);
});

const FILE = {
  name: 'hero.png',
  key: 'images/hero.png',
  kind: 'image',
  sizeBytes: 10,
  modified: '2025-01-01T00:00:00.000Z',
  url: 'https://cdn.example.com/images/hero.png',
};

test('listings: entries belong to the listed folder, once each', () => {
  const listing = parseMediaListing({ folder: 'images', folders: [{ name: 'a', path: 'images/a' }], files: [FILE], truncated: false });
  assert.equal(listing.files[0]?.kind, 'image');
  const bad: readonly Record<string, unknown>[] = [
    { folder: 'images', folders: [{ name: 'a', path: 'other/a' }], files: [], truncated: false },
    { folder: 'images', folders: [], files: [{ ...FILE, key: 'other/hero.png' }], truncated: false },
    { folder: 'images', folders: [], files: [FILE, FILE], truncated: false },
    { folder: 'images', folders: [], files: [{ ...FILE, kind: 'pdf' }], truncated: false },
    { folder: 'images', folders: [], files: [{ ...FILE, sizeBytes: -1 }], truncated: false },
    { folder: 'images', folders: [], files: [{ ...FILE, modified: 'yesterday' }], truncated: false },
    { folder: 'images', folders: [], files: [{ ...FILE, url: 'javascript:alert(1)' }], truncated: false },
    { folder: 'images', folders: [], files: [], truncated: 'no' },
  ];
  for (const input of bad) {
    assert.throws(() => parseMediaListing(input), Error, JSON.stringify(input));
  }
  assert.deepEqual(
    parseMediaResult({ ok: true, value: 3 }, (value) => value),
    { ok: true, value: 3 },
  );
  assert.throws(() => parseMediaResult({ ok: false, message: '' }, (value) => value), /message/);
});

test('kinds and replacement: same kind of media, same extension for other files', () => {
  assert.equal(mediaKindOf('a.JPG'), 'image');
  assert.equal(mediaKindOf('a.webm'), 'video');
  assert.equal(mediaKindOf('a.opus'), 'audio');
  assert.equal(mediaKindOf('a.pdf'), 'file');
  assert.equal(replacementRefusal('hero.png', 'new.jpg'), undefined, 'an image for an image');
  assert.equal(replacementRefusal('guide.pdf', 'guide-v2.PDF'), undefined);
  assert.match(replacementRefusal('hero.png', 'clip.mp4') ?? '', /hero.png is an image; replace it with an image too, not a video/);
  assert.match(replacementRefusal('song.mp3', 'cover.png') ?? '', /an audio file/);
  assert.match(replacementRefusal('guide.pdf', 'guide.zip') ?? '', /another pdf file/);
});
