// Goal: the Stacki Apps contract (shared/properties/apps.ts, appBundle.ts,
// appsRpc.ts) admits exactly the manifests, lockfiles, bundle paths, archives
// and RPC messages Desktop and Studio agree on, and refuses every other shape at
// the boundary: path traversal, unsafe file types, symbolic links, zip bombs,
// corrupted archives, bad lockfile updates and overlay descriptions past their bounds.
// A typed or pasted repository (owner/repo, a github.com address) is read as the
// repository it names only when it keeps to GitHub's name rules.
// Method: one known-good value per parser, then each known-bad variation of it;
// archives are built in memory with writeStoredZip and corrupted byte by byte.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateRawSync } from 'node:zlib';
import {
  APP_LIMITS,
  APP_WINDOW_DEFAULT,
  appPopupSize,
  parseAppWindow,
  compareAppVersions,
  parseAppManifest,
  parseAppsLock,
  parseBundlePath,
  orderReleases,
  releaseAssetChoice,
  parseGitHubSource,
  parseGitHubRepositoryReference,
  parseAppRepositories,
  parseRateLimitMessage,
  rateLimitMessage,
  serializeAppsLock,
  parseStackiRange,
  parseStackiVersionMin,
  stackiVersionMessage,
  stackiVersionProblem,
} from '#dist/shared/properties/apps.js';
import { crc32, readAppBundle, writeStoredZip } from '#dist/shared/properties/appBundle.js';
import { APP_METHOD_NAMES, parseAppRequest, parseOverlayItems, UnsupportedVersionError } from '#dist/shared/properties/appsRpc.js';
import { appContentSecurityPolicy, appSdkSource } from '#dist/shared/properties/appSdk.js';

const inflate = (data: Uint8Array, sizeBytesMax: number) => new Uint8Array(inflateRawSync(data, { maxOutputLength: Math.max(1, sizeBytesMax) }));
const encoder = new TextEncoder();
const MANIFEST = {
  manifestVersion: 1,
  id: 'heat-map',
  name: 'Heat map',
  version: '1.2.0',
  entry: 'index.html',
  icon: 'icon.svg',
  author: { github: 'octocat' },
};
const file = (path: string, text: string) => ({ path, bytes: encoder.encode(text) });
const bundleFiles = (manifest: object = MANIFEST) => [
  file('stacki-app.json', JSON.stringify(manifest)),
  file('index.html', '<!doctype html><script src="stacki-sdk.js"></script>'),
  file('icon.svg', '<svg viewBox="0 0 20 20"/>'),
];

test('a manifest parses, with defaults', () => {
  const manifest = parseAppManifest(MANIFEST);
  assert.equal(manifest.id, 'heat-map');
  assert.deepEqual(manifest.window, { mode: 'panel', widthPx: undefined, heightPx: undefined });
  assert.equal(manifest.description, '');
  assert.equal(manifest.authorGitHub, 'octocat');
  assert.equal(manifest.source, undefined);
  const popup = parseAppManifest({ ...MANIFEST, window: { mode: 'popup', width: 400, height: 300 } });
  assert.deepEqual(popup.window, { mode: 'popup', widthPx: 400, heightPx: 300 });
});

test('the window field bounds its width and height and names its mode', () => {
  const { windowWidthPxMin, windowWidthPxMax, windowHeightPxMin, windowHeightPxMax } = APP_LIMITS;
  // The bounds themselves are valid, each field is optional, and a panel app may set a width alone.
  assert.deepEqual(parseAppWindow({ width: windowWidthPxMin, height: windowHeightPxMax }), {
    mode: 'panel',
    widthPx: windowWidthPxMin,
    heightPx: windowHeightPxMax,
  });
  assert.deepEqual(parseAppWindow({ mode: 'panel', width: 420 }), { mode: 'panel', widthPx: 420, heightPx: undefined });
  assert.deepEqual(parseAppWindow({}), { mode: 'panel', widthPx: undefined, heightPx: undefined });
  // A popup with no size opens at the default; a sized one at its own.
  assert.deepEqual(appPopupSize(parseAppWindow({ mode: 'popup' })), APP_WINDOW_DEFAULT);
  assert.deepEqual(appPopupSize(parseAppWindow({ mode: 'popup', width: windowWidthPxMax, height: windowHeightPxMin })), {
    widthPx: windowWidthPxMax,
    heightPx: windowHeightPxMin,
  });
  const bad: readonly [string, unknown, RegExp][] = [
    ['width below the minimum', { width: windowWidthPxMin - 1 }, /Window width must be 240 to 1600 pixels/],
    ['width above the maximum', { width: windowWidthPxMax + 1 }, /Window width must be/],
    ['height below the minimum', { height: windowHeightPxMin - 1 }, /Window height must be 160 to 1200 pixels/],
    ['height above the maximum', { height: windowHeightPxMax + 1 }, /Window height must be/],
    ['fractional width', { width: 300.5 }, /whole number of pixels/],
    ['string width', { width: '300' }, /whole number of pixels/],
    ['unknown mode', { mode: 'floating' }, /window.mode must be "panel" or "popup"/],
    ['old kind field', { kind: 'panel' }, /window.kind is now window.mode/],
    ['not an object', 'popup', /./],
  ];
  for (const [what, input, message] of bad) {
    assert.throws(() => parseAppWindow(input), message, what);
  }
});

test('a manifest refuses each bad field', () => {
  const bad: readonly [string, object][] = [
    ['version 2', { ...MANIFEST, manifestVersion: 2 }],
    ['uppercase id', { ...MANIFEST, id: 'Heat' }],
    ['id with a slash', { ...MANIFEST, id: 'a/b' }],
    ['long id', { ...MANIFEST, id: 'a'.repeat(APP_LIMITS.idCharsMax + 1) }],
    ['bad version', { ...MANIFEST, version: '1.2' }],
    ['entry not html', { ...MANIFEST, entry: 'app.js' }],
    ['entry climbing', { ...MANIFEST, entry: '../index.html' }],
    ['icon not image', { ...MANIFEST, icon: 'icon.html' }],
    ['window too small', { ...MANIFEST, window: { mode: 'popup', width: 10, height: 300 } }],
    ['bad author', { ...MANIFEST, author: { github: 'not a login' } }],
    ['long author', { ...MANIFEST, author: { github: 'a'.repeat(40) } }],
    ['empty name', { ...MANIFEST, name: '   ' }],
  ];
  for (const [what, manifest] of bad) {
    assert.throws(() => parseAppManifest(manifest), Error, what);
  }
});

test('a manifest names the oldest Stacki it runs on as ">=MAJOR.MINOR.PATCH", and nothing else', () => {
  assert.equal(parseAppManifest(MANIFEST).stackiVersionMin, undefined);
  const needs = parseAppManifest({ ...MANIFEST, stacki: '>=1.1.0' });
  assert.equal(needs.stackiVersionMin, '1.1.0');
  // A parsed manifest reads back the same over IPC or HTTP.
  assert.deepEqual(parseAppManifest(JSON.parse(JSON.stringify(needs))), needs);
  for (const bad of ['1.1.0', '>1.1.0', '>=1.1', '>=1.1.0 <2.0.0', '^1.1.0', '>=1.1.0-beta', '>=01.1.0', '', 7, `>=${'1'.repeat(40)}.0.0`]) {
    assert.throws(() => parseAppManifest({ ...MANIFEST, stacki: bad }), /stacki|version|Expected/, String(bad));
  }
  assert.throws(() => parseAppManifest({ ...MANIFEST, stacki: '>=1.1.0', stackiVersionMin: '1.1.0' }), /not both/);
  assert.throws(() => parseStackiRange('>=1.1.0-rc.1'), /must be/);
  assert.throws(() => parseStackiVersionMin('1.1.0-rc.1'), /a release, not a prerelease/);
});

test('a Stacki older than an app needs says so; the same or newer, or an unknown version, does not', () => {
  assert.equal(stackiVersionProblem('1.1.0', '1.0.24'), 'Needs Stacki 1.1.0 or later. Update Stacki.');
  assert.equal(stackiVersionProblem('1.1.0', '1.1.0-beta.1'), 'Needs Stacki 1.1.0 or later. Update Stacki.');
  assert.equal(stackiVersionProblem('1.1.0', '1.1.0'), undefined);
  assert.equal(stackiVersionProblem('1.1.0', '2.0.0'), undefined);
  assert.equal(stackiVersionProblem(undefined, '0.0.1'), undefined);
  assert.equal(stackiVersionProblem('1.1.0', 'unknown'), undefined);
  assert.equal(stackiVersionMessage('1.1.0'), 'Needs Stacki 1.1.0 or later. Update Stacki.');
});

test('bundle paths refuse traversal, hidden files, odd separators and unknown types', () => {
  assert.equal(parseBundlePath('assets/app.js'), 'assets/app.js');
  for (const path of [
    '../x.js',
    'a/../b.js',
    '/abs.js',
    'a\\b.js',
    '.hidden.js',
    'a//b.js',
    'C:/x.js',
    'run.exe',
    'lib.node',
    'script.sh',
    'noext',
    '',
    'a/'.repeat(9) + 'x.js',
  ]) {
    assert.throws(() => parseBundlePath(path), Error, path);
  }
});

test('versions order numerically, a prerelease before its release', () => {
  assert.ok(compareAppVersions('1.10.0', '1.9.9') > 0);
  assert.ok(compareAppVersions('1.0.0-beta', '1.0.0') < 0);
  assert.equal(compareAppVersions('2.0.0', '2.0.0'), 0);
});

test('GitHub sources accept owner, repository and a zip asset only', () => {
  assert.deepEqual(parseGitHubSource({ owner: 'octocat', repository: 'app', asset: 'app.zip' }), {
    kind: 'github',
    owner: 'octocat',
    repository: 'app',
    asset: 'app.zip',
  });
  for (const source of [
    { owner: '-bad', repository: 'app', asset: 'app.zip' },
    { owner: 'octocat', repository: '..', asset: 'app.zip' },
    { owner: 'octocat', repository: 'app', asset: 'app.tar.gz' },
    { owner: 'octocat', repository: 'app', asset: '../app.zip' },
  ]) {
    assert.throws(() => parseGitHubSource(source));
  }
});

test('the lockfile round-trips and refuses duplicates and bad updates', () => {
  const entry = {
    id: 'heat-map',
    version: '1.2.0',
    sha256: 'a'.repeat(64),
    installedAt: '2026-11-10T00:00:00.000Z',
    source: { kind: 'github', owner: 'octocat', repository: 'app', asset: 'app.zip', tag: 'v1.2.0', account: 'octocat' },
    update: { version: '1.3.0', tag: 'v1.3.0', sha256: 'b'.repeat(64) },
  };
  const lock = parseAppsLock({ version: 1, apps: [entry] });
  assert.deepEqual(parseAppsLock(JSON.parse(serializeAppsLock(lock))), lock);
  assert.equal(lock.apps[0]?.source.kind === 'github' ? lock.apps[0].source.account : undefined, 'octocat');
  assert.throws(() => parseAppsLock({ version: 1, apps: [entry, entry] }), /twice/);
  assert.throws(() => parseAppsLock({ version: 1, apps: [{ ...entry, sha256: 'xyz' }] }));
  assert.throws(() => parseAppsLock({ version: 1, apps: [{ ...entry, update: { ...entry.update, sha256: 'short' } }] }));
  assert.throws(() => parseAppsLock({ version: 1, apps: [{ ...entry, source: { ...entry.source, account: 'not a login' } }] }));
  // A lockfile is JSON, so an older writer's null reads as absent.
  assert.equal(
    parseAppsLock(JSON.parse(JSON.stringify({ version: 1, apps: [entry] }).replace(/"update":\{[^}]*\}/, '"update":null'))).apps[0]?.update,
    undefined,
  );
});

test('releases order newest first, and the one zip is picked or the zips are offered', () => {
  const release = (tag: string, publishedAt: string, assets: readonly string[]) => ({
    tag,
    name: tag,
    publishedAt,
    prerelease: tag.includes('beta'),
    assets: assets.map((name) => ({ name, sizeBytes: 1000 })),
  });
  const ordered = orderReleases([
    release('v1', '2026-01-01T00:00:00Z', []),
    release('v3-beta', '2026-03-01T00:00:00Z', []),
    release('v2', '2026-02-01T00:00:00Z', []),
  ]);
  assert.deepEqual(
    ordered.map((entry) => entry.tag),
    ['v3-beta', 'v2', 'v1'],
  );
  assert.deepEqual(releaseAssetChoice(release('v1', '2026-01-01T00:00:00Z', ['notes.txt', 'app.zip', 'source.tar.gz'])), {
    kind: 'single',
    asset: { name: 'app.zip', sizeBytes: 1000 },
  });
  const many = releaseAssetChoice(release('v1', '2026-01-01T00:00:00Z', ['app.zip', 'app-debug.zip']));
  assert.equal(many.kind, 'choose');
  assert.equal(many.kind === 'choose' ? many.assets.length : 0, 2);
  assert.deepEqual(releaseAssetChoice(release('v1', '2026-01-01T00:00:00Z', ['source.tar.gz'])), { kind: 'none' });
  const huge = { ...release('v1', '2026-01-01T00:00:00Z', []), assets: [{ name: 'app.zip', sizeBytes: APP_LIMITS.archiveBytesMax + 1 }] };
  assert.deepEqual(releaseAssetChoice(huge), { kind: 'none' }, 'an asset past the archive bound is not offered');
});

test('a stored zip bundle reads, with its folder stripped', () => {
  const bundle = readAppBundle(writeStoredZip(bundleFiles()), inflate);
  assert.equal(bundle.manifest.id, 'heat-map');
  assert.deepEqual(
    bundle.files.map((entry) => entry.path),
    ['icon.svg', 'index.html', 'stacki-app.json'],
  );
  const nested = readAppBundle(writeStoredZip(bundleFiles().map((entry) => ({ ...entry, path: `heat-map/${entry.path}` }))), inflate);
  assert.equal(nested.manifest.id, 'heat-map');
  assert.ok(nested.files.every((entry) => !entry.path.startsWith('heat-map/')));
});

test('a bundle is refused for each unsafe or broken archive', () => {
  const traversal = writeStoredZip([...bundleFiles(), file('../escape.js', 'x')]);
  assert.throws(() => readAppBundle(traversal, inflate), /unsafe segment/);
  assert.throws(() => readAppBundle(writeStoredZip([...bundleFiles(), file('tool.exe', 'MZ')]), inflate), /not a type/);
  assert.throws(() => readAppBundle(writeStoredZip([...bundleFiles(), file('stacki-sdk.js', 'x')]), inflate), /served by Stacki/);
  assert.throws(() => readAppBundle(writeStoredZip(bundleFiles().slice(1)), inflate), /no stacki-app.json/);
  assert.throws(() => readAppBundle(writeStoredZip(bundleFiles().filter((entry) => entry.path !== 'index.html')), inflate), /entry file/);
  assert.throws(() => readAppBundle(new Uint8Array(0), inflate), /empty/);
  assert.throws(() => readAppBundle(encoder.encode('not a zip at all, just text'), inflate), /not a zip/);
  assert.throws(() => readAppBundle(new Uint8Array(APP_LIMITS.archiveBytesMax + 1), inflate), /exceeds/);
  // A flipped byte inside a file's data fails its CRC.
  const corrupt = writeStoredZip(bundleFiles());
  const at = new TextDecoder().decode(corrupt).indexOf('<svg viewBox');
  corrupt[at + 1] = 0x41;
  assert.throws(() => readAppBundle(corrupt, inflate), /checksum/);
  // A symbolic link, marked in the Unix mode bits of the central directory.
  const linked = writeStoredZip(bundleFiles());
  const view = new DataView(linked.buffer);
  const central = findCentral(linked);
  view.setUint32(central + 38, 0o120777 * 0x10000, true);
  assert.throws(() => readAppBundle(linked, inflate), /symbolic link/);
  // Encryption.
  const encrypted = writeStoredZip(bundleFiles());
  new DataView(encrypted.buffer).setUint16(findCentral(encrypted) + 8, 1, true);
  assert.throws(() => readAppBundle(encrypted, inflate), /encrypted/);
  // A file claiming more than the per-file bound.
  const big = writeStoredZip(bundleFiles());
  new DataView(big.buffer).setUint32(findCentral(big) + 24, APP_LIMITS.fileBytesMax + 1, true);
  assert.throws(() => readAppBundle(big, inflate), /exceeds/);
  // Too many files.
  const many = Array.from({ length: APP_LIMITS.filesMax + 1 }, (_, index) => file(`f${index}.txt`, 'x'));
  assert.throws(() => readAppBundle(writeStoredZip([...bundleFiles(), ...many]), inflate), /at most/);
});

test('crc32 matches the IEEE reference value', () => {
  assert.equal(crc32(encoder.encode('123456789')), 0xcbf43926);
});

test('RPC requests: app messages parse, others are ignored, bad ones throw', () => {
  assert.equal(parseAppRequest({ type: 'avb:rects' }), undefined);
  assert.equal(parseAppRequest('text'), undefined);
  assert.deepEqual(parseAppRequest({ stacki: 'app', v: 1, id: 3, method: 'selection.get' }), { id: 3, method: 'selection.get', params: undefined });
  assert.throws(() => parseAppRequest({ stacki: 'app', v: 1, id: 0, method: 'x' }), /positive/);
  assert.throws(() => parseAppRequest({ stacki: 'app', v: 2, id: 1, method: 'x' }), UnsupportedVersionError);
  assert.throws(() => parseAppRequest({ stacki: 'app', v: 1, id: 1, method: 'x'.repeat(65) }));
});

test('overlay descriptions are bounded and colours are hex only', () => {
  const box = { kind: 'box', id: 'a', anchor: { nodeId: 'n0' }, color: '#fff' };
  assert.equal(parseOverlayItems([box]).length, 1);
  assert.throws(() => parseOverlayItems([{ ...box, color: 'red; background:url(x)' }]), /hex/);
  assert.throws(() => parseOverlayItems([box, box]), /unique/);
  assert.throws(() => parseOverlayItems(Array.from({ length: 65 }, (_, index) => ({ ...box, id: `b${index}` }))), /at most 64/);
  // Every item may anchor to its own element: the anchor bound is the item bound (appsRpc.ts overlayAnchorsMax).
  assert.equal(parseOverlayItems(Array.from({ length: 64 }, (_, index) => ({ ...box, id: `b${index}`, anchor: { nodeId: `n${index}` } }))).length, 64);
  assert.throws(() => parseOverlayItems([{ kind: 'heat', id: 'h', anchor: { nodeId: 'n0' }, columns: 2, rows: 2, values: [0, 1, 2, 0] }]), /0 to 1/);
  assert.throws(() => parseOverlayItems([{ kind: 'frame', id: 'f', anchor: { nodeId: 'n0' }, path: '../x.html' }]), /own HTML/);
  const frames = [0, 1, 2].map((index) => ({ kind: 'frame', id: `f${index}`, anchor: { nodeId: 'n0' }, path: 'overlay.html' }));
  assert.throws(() => parseOverlayItems(frames), /2 frames/);
});

test('the SDK has a helper for every method, and the policy sandboxes the app and connects only to declared hosts', () => {
  const sdk = appSdkSource();
  for (const method of APP_METHOD_NAMES) {
    const [group, name] = method.split('.');
    assert.ok(sdk.includes(`"${group}"`), group);
    assert.ok(sdk.includes(`"${name}"`), name);
  }
  const policy = appContentSecurityPolicy('stacki-app://heat-map', ['api.example.com']);
  assert.match(policy, /^sandbox allow-scripts/);
  assert.doesNotMatch(policy, /allow-same-origin/);
  assert.match(policy, /connect-src stacki-app:\/\/heat-map https:\/\/api\.example\.com wss:\/\/api\.example\.com;/);
  // Remote code is never allowed: scripts, styles and fonts load from the bundle only.
  assert.match(policy, /script-src stacki-app:\/\/heat-map 'unsafe-inline' 'wasm-unsafe-eval';/);
  assert.match(policy, /style-src stacki-app:\/\/heat-map 'unsafe-inline';/);
  assert.match(policy, /font-src stacki-app:\/\/heat-map data:;/);
  // An app that declares nothing connects to nothing but its own files.
  assert.match(appContentSecurityPolicy('stacki-app://offline', []), /connect-src stacki-app:\/\/offline;/);
  assert.throws(() => appContentSecurityPolicy('x; script-src *', []));
  assert.throws(() => appContentSecurityPolicy('stacki-app://a', ['evil.com; script-src *']));
});

function findCentral(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset < bytes.length - 4; offset += 1) {
    if (view.getUint32(offset, true) === 0x02014b50) {
      return offset;
    }
  }
  throw new Error('no central directory');
}

test('app icons are square, size-capped PNG, SVG or WebP images', () => {
  const png = (width: number, height: number, padBytes = 0) => {
    const bytes = new Uint8Array(24 + padBytes);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 0x89504e47);
    view.setUint32(12, 0x49484452);
    view.setUint32(16, width);
    view.setUint32(20, height);
    return bytes;
  };
  const withIcon = (path: string, bytes: Uint8Array) =>
    writeStoredZip([file('stacki-app.json', JSON.stringify({ ...MANIFEST, icon: path })), file('index.html', '<p>'), { path, bytes }]);
  assert.equal(readAppBundle(withIcon('icon.png', png(256, 256)), inflate).manifest.icon, 'icon.png');
  assert.throws(() => readAppBundle(withIcon('icon.png', png(256, 128)), inflate), /square/);
  assert.throws(() => readAppBundle(withIcon('icon.png', png(1024, 1024)), inflate), /512/);
  assert.throws(() => readAppBundle(withIcon('icon.png', png(64, 64, APP_LIMITS.iconBytesMax)), inflate), /larger than/);
  assert.throws(() => readAppBundle(withIcon('icon.png', encoder.encode('not a png')), inflate), /not a readable/);
  assert.throws(() => readAppBundle(withIcon('icon.svg', encoder.encode('<svg/>')), inflate), /not a readable/);
  assert.throws(() => readAppBundle(withIcon('icon.svg', encoder.encode('<svg viewBox="0 0 40 20"/>')), inflate), /square/);
  const webp = new Uint8Array(30);
  webp.set(encoder.encode('RIFF'), 0);
  webp.set(encoder.encode('WEBPVP8X'), 8);
  webp.set([63, 0, 0, 63, 0, 0], 24);
  assert.equal(readAppBundle(withIcon('icon.webp', webp), inflate).manifest.icon, 'icon.webp');
  assert.throws(() => parseAppManifest({ ...MANIFEST, icon: 'icon.gif' }), /PNG, SVG or WebP/);
});

test('a typed or pasted repository names its owner and repository', () => {
  const named = { owner: 'octocat', repository: 'heat-map' };
  for (const text of [
    'octocat/heat-map',
    '  octocat/heat-map  ',
    'octocat/heat-map/',
    'github.com/octocat/heat-map',
    'www.github.com/octocat/heat-map',
    'https://github.com/octocat/heat-map',
    'http://github.com/octocat/heat-map',
    'https://github.com/octocat/heat-map.git',
    'https://github.com/octocat/heat-map/',
    'https://github.com/octocat/heat-map/releases/tag/v1.0.0',
    'https://github.com/octocat/heat-map?tab=readme',
    'https://github.com/octocat/heat-map#readme',
    'HTTPS://GitHub.com/octocat/heat-map',
  ]) {
    assert.deepEqual(parseGitHubRepositoryReference(text), named, text);
  }
  assert.deepEqual(parseGitHubRepositoryReference('my-org/app.v2_beta'), { owner: 'my-org', repository: 'app.v2_beta' });
});

test('text that is not a GitHub repository is a search, not a reference', () => {
  for (const text of [
    '',
    '   ',
    'heat-map',
    'octocat/',
    '/heat-map',
    'octocat/heat-map/extra',
    'octo cat/heat-map',
    '-octocat/heat-map',
    'octocat-/heat-map',
    'octo--cat/heat-map',
    'octo_cat/heat-map',
    'octocat/heat map',
    'octocat/..',
    'octocat/.',
    'octocat/heat%20map',
    'https://gitlab.com/octocat/heat-map',
    'https://github.com/octocat',
    'https://github.com.evil.example/octocat/heat-map',
    'ftp://github.com/octocat/heat-map',
    `${'a'.repeat(40)}/heat-map`,
    `octocat/${'r'.repeat(101)}`,
    `https://github.com/octocat/heat-map/${'x'.repeat(300)}`,
  ]) {
    assert.equal(parseGitHubRepositoryReference(text), undefined, text);
  }
  // At the bounds, not past them.
  assert.deepEqual(parseGitHubRepositoryReference(`${'a'.repeat(39)}/${'r'.repeat(100)}`), { owner: 'a'.repeat(39), repository: 'r'.repeat(100) });
});

test('a listed repository says whether it carries the stacki-app topic', () => {
  const good = { owner: 'octocat', name: 'heat-map', private: false, updatedAt: '2026-11-01T00:00:00Z', stackiApp: true, organization: false };
  assert.deepEqual(parseAppRepositories([good]), [good]);
  assert.throws(() => parseAppRepositories([{ ...good, stackiApp: undefined }]), /stacki-app topic/);
  assert.throws(() => parseAppRepositories([{ ...good, stackiApp: 'yes' }]), /stacki-app topic/);
  assert.throws(() => parseAppRepositories([{ ...good, private: undefined }]), /private/);
});

test('the rate-limit failure message reads back as its reset time, and nothing else does', () => {
  const resetAtMs = Date.parse('2026-11-10T15:00:00.000Z');
  assert.equal(rateLimitMessage(resetAtMs), 'GitHub is limiting requests until 2026-11-10T15:00:00.000Z.');
  assert.deepEqual(parseRateLimitMessage(rateLimitMessage(resetAtMs)), { resetAtMs });
  assert.deepEqual(parseRateLimitMessage(rateLimitMessage(undefined)), { resetAtMs: undefined });
  for (const message of [
    'GitHub answered 403 for this account’s repositories.',
    'GitHub is limiting requests',
    'GitHub is limiting requests until tomorrow.',
    'Note: GitHub is limiting requests.',
  ]) {
    assert.equal(parseRateLimitMessage(message), undefined, message);
  }
  assert.throws(() => rateLimitMessage(1.5), /whole millisecond time/);
  assert.throws(() => rateLimitMessage(-1), /after 1970/);
});
