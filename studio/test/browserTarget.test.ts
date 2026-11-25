// Goal: the editor's stylesheet works in Safari on macOS, iPhone and iPad. Safari still
// ignores an unprefixed `user-select`, so a build that writes no prefixes leaves every
// unselectable panel, rail and handle open to native text selection on a drag or a long
// press. Method: run the client's own build options over a stylesheet that uses each
// property WebKit needs prefixed, and check the prefixed and standard forms both survive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { STUDIO_BROWSER_TARGET, studioClientOptions } from '../scripts/studioClientBuild';

test('the client build names a Safari it supports', () => {
  assert.deepEqual(studioClientOptions.target, [...STUDIO_BROWSER_TARGET]);
  assert.ok(
    STUDIO_BROWSER_TARGET.some((entry) => /^safari\d/.test(entry)),
    'A Safari entry is what makes esbuild write -webkit- prefixes',
  );
});

test('the client build writes the prefixes WebKit needs and keeps the standard forms', async () => {
  const source = '.handle{user-select:none;backdrop-filter:blur(4px)}.field{user-select:text}';
  const { code } = await transform(source, { loader: 'css', minify: true, target: [...STUDIO_BROWSER_TARGET] });
  assert.match(code, /-webkit-user-select:none;user-select:none/);
  assert.match(code, /-webkit-user-select:text;user-select:text/);
  assert.match(code, /-webkit-backdrop-filter:blur\(4px\);backdrop-filter:blur\(4px\)/);
});

test('without a target esbuild writes no prefix, which is the failure this guards', async () => {
  const { code } = await transform('.handle{user-select:none}', { loader: 'css', minify: true });
  assert.doesNotMatch(code, /-webkit-user-select/);
});
