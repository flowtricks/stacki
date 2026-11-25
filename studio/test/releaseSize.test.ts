// Goal: a Studio release that installed Desktop and Studio clients cannot download never ships
// again. 1.4.18's release file was 32,255,496 bytes; every client up to 1.4.17 refuses more than
// 32,000,000 (RELEASE_BYTES_MAX), and the content-only count in parseRelease (31.3 MB) passed
// because JSON escaping adds about 3%, so `astro-studio update` and Desktop setup both failed.
// Method: build the release in memory from the assembled tree, exactly as `release:bundle` does,
// and hold its serialized bytes a megabyte, and its file count fifty files, under the fixed
// limits installed clients enforce (32,000,000 bytes, 3,000 files); then check that stripping
// vendored comments keeps directives, keeps the code identical, and refuses what it must not touch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { buildRelease, RELEASE_FILES_TARGET, RELEASE_SERIALIZED_BYTES_TARGET, serializeRelease } from '../scripts/releaseBundle';
import { stripReleaseComments } from '../scripts/releaseComments';
import { parseRelease, RELEASE_BYTES_MAX, RELEASE_FILES_MAX } from '../src/features/updates/release';

const studio = fileURLToPath(new URL('../', import.meta.url));

test('the release file stays a megabyte under what installed clients accept', async () => {
  const release = await buildRelease(studio);
  const text = serializeRelease(release);
  const bytes = Buffer.byteLength(text, 'utf8');
  assert.equal(RELEASE_BYTES_MAX, 32_000_000, 'Installed clients hold this bound; raising it here does not reach them');
  assert.ok(
    bytes <= RELEASE_SERIALIZED_BYTES_TARGET,
    `Studio release is ${bytes} bytes, over the ${RELEASE_SERIALIZED_BYTES_TARGET} target (installed clients refuse ${RELEASE_BYTES_MAX})`,
  );
  assert.equal(RELEASE_FILES_MAX, 3000, 'Installed clients hold this bound; raising it here does not reach them');
  assert.ok(
    release.files.length <= RELEASE_FILES_TARGET,
    `Studio release has ${release.files.length} files, over the ${RELEASE_FILES_TARGET} target (installed clients refuse ${RELEASE_FILES_MAX}); ` +
      'drop vendored files Studio does not import from scripts/shared-source.json',
  );
  // The parser an installed client runs reads the written file back unchanged.
  const parsed = parseRelease(JSON.parse(text));
  assert.equal(parsed.files.length, release.files.length);
  assert.equal(parsed.version, release.version);
  // Studio's own sources keep their comments; only the generated vendor tree loses them.
  const own = release.files.find((file) => file.path === 'scripts/releaseComments.ts');
  assert.ok(own?.content.includes('// Why this exists'));
});

test('the serialized size, not the content size, is held to the limit', () => {
  const content = '"\n'.repeat(Math.ceil(RELEASE_BYTES_MAX / 4) + 1);
  const release = { format: 1, version: '1.0.0', files: [{ path: 'README.md', content }] } as const;
  assert.ok(Buffer.byteLength(content) < RELEASE_BYTES_MAX, 'The content alone fits');
  assert.throws(() => serializeRelease(release), /installed Desktop and Studio refuse more than 32000000/);
});

test('vendored comments go, directives and code stay', () => {
  const source = [
    '// A prose comment on its own line.',
    "import { a } from './a'; // Why a.",
    '/** Documentation. */',
    'export function f(): number {',
    '  // @ts-expect-error The test needs the wrong type.',
    "  const x: number = 'y';",
    '  /* eslint-disable-next-line no-console */',
    '  const pattern = /\\/\\/ not a comment/;',
    '  const template = `// also not a comment ${a}`;',
    '  return /*#__PURE__*/ x + pattern.source.length + template.length;',
    '}',
    '',
  ].join('\n');
  const stripped = stripReleaseComments('vendor/stacki/shared/example.ts', source);
  assert.doesNotMatch(stripped, /prose comment|Why a|Documentation/);
  assert.match(stripped, /@ts-expect-error/);
  assert.match(stripped, /eslint-disable-next-line/);
  assert.match(stripped, /#__PURE__/);
  assert.match(stripped, /\/\\\/\\\/ not a comment\//);
  assert.match(stripped, /`\/\/ also not a comment \$\{a\}`/);
  assert.match(stripped, /^import \{ a \} from '\.\/a';\n/);
});

test('JSX text that looks like a comment is kept', () => {
  const source = 'export const view = <p>// shown {/* hidden */} text</p>;\n';
  const stripped = stripReleaseComments('vendor/stacki/src/view.tsx', source);
  assert.match(stripped, /<p>\/\/ shown \{\} text<\/p>/);
});

test('only vendored TypeScript sources are stripped', () => {
  assert.throws(
    () => stripReleaseComments('src/app/main.tsx', '// Kept.\n'),
    /Assertion failed: Only vendored TypeScript sources lose comments: src\/app\/main\.tsx/,
  );
  assert.throws(() => stripReleaseComments('vendor/stacki/src/types.d.ts', '/// <reference types="vite/client" />\n'), /Assertion failed/);
  assert.throws(() => stripReleaseComments('vendor/stacki/electron/content/workers/introspect.mjs', '// Kept.\n'), /Assertion failed/);
});
