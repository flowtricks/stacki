// Electron 44 requires Ventura. The updater compares Darwin kernel versions,
// so its manifest needs 22.0.0 while the app's Info.plist declares macOS 13.0.0.
import assert = require('node:assert/strict');
import fs = require('node:fs');
import { isMap, isSeq, parseDocument } from 'yaml';

const MANIFEST_BYTES_MAX = 1_048_576;

export function macUpdateMetadata(source: string): string {
  assert.ok(Buffer.byteLength(source) <= MANIFEST_BYTES_MAX, 'Update manifest exceeds limit');
  const document = parseDocument(source);
  assert.equal(document.errors.length, 0, 'Update manifest must be valid YAML');
  const version: unknown = document.get('version');
  assert.ok(typeof version === 'string', 'Update manifest needs a version');
  assert.match(version, /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/, 'Update version must be valid');
  assert.ok(version.length <= 128, 'Update version exceeds limit');
  const files = document.get('files', true);
  assert.ok(isSeq(files), 'Update manifest needs artifact files');
  assert.ok(files.items.length > 0, 'Update manifest must contain an artifact');
  assert.ok(files.items.length <= 20, 'Update manifest artifact count exceeds limit');
  // One channel serves existing universal apps and both native architectures.
  // Refuse a partial manifest rather than strand one CPU on the old release.
  const names = files.items.map((file) => macUpdateMetadataFile(file));
  for (const architecture of ['arm64', 'x64'] as const) {
    for (const extension of ['zip', 'dmg'] as const) {
      assert.ok(
        names.includes(`Stacki-${version}-${architecture}.${extension}`),
        `Update manifest needs the ${architecture} ${extension} artifact`,
      );
    }
  }
  document.set('minimumSystemVersion', '22.0.0');
  const output = document.toString();
  assert.equal(parseDocument(output).get('minimumSystemVersion'), '22.0.0');
  return output;
}

function macUpdateMetadataFile(file: unknown): string {
  assert.ok(isMap(file), 'Update artifact must be a map');
  const url: unknown = file.get('url');
  const checksum: unknown = file.get('sha512');
  const size: unknown = file.get('size');
  assert.ok(typeof url === 'string', 'Update artifact needs a URL');
  assert.ok(url.length <= 256, 'Update artifact URL exceeds limit');
  assert.ok(typeof checksum === 'string', 'Update artifact needs a checksum');
  assert.match(checksum, /^[A-Za-z0-9+/]{86}==$/, 'Update artifact needs a SHA-512 checksum');
  assert.ok(typeof size === 'number', 'Update artifact needs a size');
  assert.ok(Number.isSafeInteger(size), 'Update artifact size must be a safe integer');
  assert.ok(size > 0, 'Update artifact size must be positive');
  return url;
}

if (require.main === module) {
  const file = 'release/latest-mac.yml';
  assert.ok(fs.statSync(file).size <= MANIFEST_BYTES_MAX, 'Update manifest exceeds limit');
  fs.writeFileSync(file, macUpdateMetadata(fs.readFileSync(file, 'utf8')));
}
