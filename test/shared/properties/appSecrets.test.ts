// Goal: the secret scan (shared/properties/appSecrets.ts) finds every kind of
// key docs/apps.md lists, masks each one in its excerpt, refuses past its
// bounds instead of passing, skips only the lines a manifest's
// `secretsAllowlist` names by file and SHA-256 and the manifest's declared
// setting placeholders, and passes clean files. The wire parser refuses a scan
// that is not one of its three shapes.
// Method: one line per pattern, built from pieces so this file holds no
// literal key; real SHA-256 for the line hashes; bound cases one past each limit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import {
  APP_SECRET_LIMITS,
  isScannedFile,
  matchSecretLine,
  parseAppSecretScan,
  parseSecretsAllowlist,
  scanAppSecrets,
} from '#dist/shared/properties/appSecrets.js';
import { parseAppManifest, parseBundlePath } from '#dist/shared/properties/apps.js';

const lineSha256 = (line: string) => createHash('sha256').update(line, 'utf8').digest('hex');
const options = { allowlist: [], placeholders: [], lineSha256 };
const letters = (count: number) => 'aB3'.repeat(count).slice(0, count);

// Each rule with a line that holds one of its keys.
const CASES: readonly (readonly [string, string])[] = [
  ['sk-key', `const key = "${'sk-'}${letters(40)}";`],
  ['stripe-key', `stripe(${'"sk_'}live_${letters(24)}")`],
  ['stripe-key', `stripe(${'"rk_'}test_${letters(24)}")`],
  ['github-token', `token: ${'ghp'}_${letters(36)}`],
  ['github-token', `token: ${'gho'}_${letters(36)}`],
  ['github-pat', `${'github'}_pat_${letters(30)}`],
  ['aws-access-key', `aws = ${'AKIA'}${'ABCDEFGHIJKLMNOP'}`],
  ['google-api-key', `maps(${'AIza'}${letters(35)})`],
  ['slack-token', `slack ${'xoxb'}-${letters(20)}`],
  ['slack-webhook', `post('${'https://hooks.slack.com'}/services/${letters(30)}')`],
  ['private-key', `${'-----BEGIN'} RSA PRIVATE KEY-----`],
  ['jwt', `auth ${'eyJ'}${letters(12)}.${'eyJ'}${letters(12)}.${letters(16)}`],
  ['assigned-secret', `const apiToken = "${'0123456789abcdef'.repeat(3)}";`],
];

test('every pattern is found, with its rule, file and line', () => {
  for (const [rule, line] of CASES) {
    const scan = scanAppSecrets([{ path: 'app.js', text: `// first\n${line}\n` }], options);
    assert.equal(scan.kind, 'found', `${rule}: ${line}`);
    if (scan.kind === 'found') {
      assert.equal(scan.findings[0]?.rule, rule, line);
      assert.equal(scan.findings[0]?.file, 'app.js');
      assert.equal(scan.findings[0]?.line, 2);
      assert.equal(scan.findings[0]?.lineSha256, lineSha256(line));
    }
  }
});

test('an excerpt keeps the first four characters of a match and masks the rest', () => {
  const key = `${'sk-'}${letters(40)}`;
  const scan = scanAppSecrets([{ path: 'app.js', text: `const key = "${key}";` }], options);
  assert.equal(scan.kind, 'found');
  if (scan.kind === 'found') {
    const excerpt = scan.findings[0]?.excerpt ?? '';
    assert.ok(excerpt.includes('sk-a'), excerpt);
    assert.ok(!excerpt.includes(key), 'The whole key never shows');
    assert.ok(!excerpt.includes(letters(10)), 'No long run of the key shows');
    assert.ok(/\*{4,}/.test(excerpt), excerpt);
  }
});

test('clean files pass, and only text types are scanned', () => {
  const scan = scanAppSecrets(
    [
      { path: 'index.html', text: '<script src="stacki-sdk.js"></script>' },
      { path: 'app.js', text: 'const settings = await stacki.settings.get();\nconst sk = "sk-short";' },
    ],
    options,
  );
  assert.deepEqual(scan, { kind: 'clean', filesScanned: 2 });
  assert.equal(isScannedFile('app.js'), true);
  assert.equal(isScannedFile('icon.svg'), true);
  assert.equal(isScannedFile('icon.png'), false);
});

test('an allowlisted line is skipped only in the file it names', () => {
  const line = `const fixture = "${'sk-'}${letters(40)}";`;
  const allowlist = [{ file: 'test/fixture.js', lineSha256: lineSha256(line) }];
  assert.equal(scanAppSecrets([{ path: 'test/fixture.js', text: line }], { ...options, allowlist }).kind, 'clean');
  assert.equal(scanAppSecrets([{ path: 'app.js', text: line }], { ...options, allowlist }).kind, 'found');
  // The same file with a changed line is scanned again.
  assert.equal(scanAppSecrets([{ path: 'test/fixture.js', text: `${line} ` }], { ...options, allowlist }).kind, 'found');
});

test('a declared setting placeholder is not a finding', () => {
  const placeholder = `${'sk-'}${letters(24)}`;
  const manifest = `{ "placeholder": "${placeholder}" }`;
  assert.equal(scanAppSecrets([{ path: 'stacki-app.json', text: manifest }], { ...options, placeholders: [placeholder] }).kind, 'clean');
  assert.equal(scanAppSecrets([{ path: 'stacki-app.json', text: manifest }], options).kind, 'found');
});

test('a scan past a bound refuses rather than passing', () => {
  const tooMany = Array.from({ length: APP_SECRET_LIMITS.filesMax + 1 }, (_, index) => ({ path: `f${index}.js`, text: '' }));
  assert.equal(scanAppSecrets(tooMany, options).kind, 'too-large');
  const big = 'x'.repeat(APP_SECRET_LIMITS.fileBytesMax + 1);
  assert.equal(scanAppSecrets([{ path: 'big.js', text: big }], options).kind, 'too-large');
  const parts = Array.from({ length: 5 }, (_, index) => ({ path: `p${index}.js`, text: 'y'.repeat(APP_SECRET_LIMITS.fileBytesMax) }));
  assert.equal(scanAppSecrets(parts, options).kind, 'too-large');
  const allowlist = Array.from({ length: APP_SECRET_LIMITS.allowlistMax + 1 }, () => ({ file: 'a.js', lineSha256: 'a'.repeat(64) }));
  assert.equal(scanAppSecrets([], { ...options, allowlist }).kind, 'too-large');
});

test('findings stop at their bound and the scan says it stopped', () => {
  const key = `token: ${'ghp'}_${letters(36)}`;
  const text = Array.from({ length: APP_SECRET_LIMITS.findingsMax + 5 }, () => key).join('\n');
  const scan = scanAppSecrets([{ path: 'keys.js', text }], options);
  assert.equal(scan.kind, 'found');
  if (scan.kind === 'found') {
    assert.equal(scan.findings.length, APP_SECRET_LIMITS.findingsMax);
    assert.equal(scan.truncated, true);
  }
});

test('overlapping matches on one line are one finding', () => {
  assert.equal(matchSecretLine(`x = "${'sk_'}live_${letters(30)}"`).length, 1);
});

test('the manifest allowlist is bounded, hashed and pathed', () => {
  assert.deepEqual(parseSecretsAllowlist(undefined, parseBundlePath), []);
  assert.throws(() => parseSecretsAllowlist({}, parseBundlePath), /is a list/);
  assert.throws(() => parseSecretsAllowlist([{ file: 'a.js', lineSha256: 'nope' }], parseBundlePath), /SHA-256/);
  assert.throws(() => parseSecretsAllowlist([{ file: '../a.js', lineSha256: 'a'.repeat(64) }], parseBundlePath), /unsafe/);
  const tooMany = Array.from({ length: APP_SECRET_LIMITS.allowlistMax + 1 }, () => ({ file: 'a.js', lineSha256: 'a'.repeat(64) }));
  assert.throws(() => parseSecretsAllowlist(tooMany, parseBundlePath), /at most/);
  const manifest = parseAppManifest({
    manifestVersion: 1,
    id: 'heat-map',
    name: 'Heat map',
    version: '1.0.0',
    entry: 'index.html',
    secretsAllowlist: [{ file: 'test/fixture.js', lineSha256: 'b'.repeat(64) }],
  });
  assert.deepEqual(manifest.secretsAllowlist, [{ file: 'test/fixture.js', lineSha256: 'b'.repeat(64) }]);
});

test('a scan on the wire is one of its three shapes', () => {
  assert.deepEqual(parseAppSecretScan({ kind: 'clean', filesScanned: 3 }), { kind: 'clean', filesScanned: 3 });
  assert.throws(() => parseAppSecretScan({ kind: 'found', findings: [], truncated: false, filesScanned: 1 }), /1 to 50/);
  assert.throws(() => parseAppSecretScan({ kind: 'passed' }), /clean, found or too-large/);
  const finding = { file: 'app.js', line: 2, rule: 'jwt', excerpt: 'eyJa****', lineSha256: 'c'.repeat(64) };
  assert.equal(parseAppSecretScan({ kind: 'found', findings: [finding], truncated: false, filesScanned: 1 }).kind, 'found');
  assert.throws(() => parseAppSecretScan({ kind: 'found', findings: [{ ...finding, rule: 'other' }], truncated: false, filesScanned: 1 }), /known rule/);
});

test('a long minified line scans in linear time', () => {
  // A bundle's minified script is one long line; a pattern that backtracks over it would hang the scan.
  const line = 'var a=b.c(d,e);'.repeat(Math.floor(APP_SECRET_LIMITS.fileBytesMax / 16));
  const startedMs = Date.now();
  assert.equal(scanAppSecrets([{ path: 'bundle.js', text: line }], options).kind, 'clean');
  assert.ok(Date.now() - startedMs < 5_000, `scanned in ${Date.now() - startedMs} ms`);
});

test('a 5 MiB run of name keywords scans in linear time', () => {
  // One run that repeats a keyword: without the 64-character name caps, the
  // assigned-secret pattern rescans the run from every keyword in it.
  const sizeBytes = APP_SECRET_LIMITS.fileBytesMax;
  const line = 'key'.repeat(Math.ceil(sizeBytes / 3)).slice(0, sizeBytes);
  assert.equal(line.length, sizeBytes);
  const startedMs = performance.now();
  const matches = matchSecretLine(line);
  const elapsedMs = performance.now() - startedMs;
  assert.deepEqual(matches, []);
  assert.ok(elapsedMs < 200, `scanned in ${Math.round(elapsedMs)} ms`);
});

test('a name past 64 characters either side of its keyword is not matched', () => {
  const value = `"${letters(40)}"`;
  const within = `${'a'.repeat(64)}Key${'b'.repeat(64)} = ${value}`;
  assert.deepEqual(
    matchSecretLine(within).map((match) => match.rule),
    ['assigned-secret'],
  );
  assert.deepEqual(matchSecretLine(`${'a'.repeat(65)}Key = ${value}`), []);
  assert.deepEqual(matchSecretLine(`apiKey${'b'.repeat(65)} = ${value}`), []);
});
