// Goal: the component:classUsage wire shapes accept what the dialog asks and main answers, and refuse each
// malformed or out-of-bound variant.
// Method: a known-good question and answer, then one known-bad case per rule (types, emptiness, whitespace,
// duplicates, absolute paths, and each bound), and the channel's payload parser around them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { CLASS_USAGE_LIMITS, parseClassUsageNames, parseClassUsageReply } from '#dist/shared/properties/classUsage.js';

test('names: distinct, non-empty classes without whitespace, within the bound', () => {
  assert.deepEqual(parseClassUsageNames(['card', 'u-text-center', 'md:flex']), ['card', 'u-text-center', 'md:flex']);
  assert.deepEqual(parseClassUsageNames([]), []);
  for (const bad of [undefined, 'card', [''], ['a b'], ['card', 'card'], [3], ['x'.repeat(CLASS_USAGE_LIMITS.classCharsMax + 1)]]) {
    assert.throws(() => parseClassUsageNames(bad));
  }
  const many = Array.from({ length: CLASS_USAGE_LIMITS.classesMax + 1 }, (_, index) => `c${index}`);
  assert.throws(() => parseClassUsageNames(many), /too many classes/);
});

test('reply: one entry per class, relative files, at most filesPerClassMax each', () => {
  const reply = {
    classes: [
      { name: 'card', files: [] },
      { name: 'u-center', files: ['src/pages/about.astro'] },
    ],
  };
  assert.deepEqual(parseClassUsageReply(reply), reply);
  assert.throws(() => parseClassUsageReply({}));
  assert.throws(() => parseClassUsageReply({ classes: [{ name: 'card' }] }));
  assert.throws(() => parseClassUsageReply({ classes: [{ name: 'card', files: ['/etc/passwd'] }] }), /relative to the project/);
  assert.throws(() => parseClassUsageReply({ classes: [{ name: 'card', files: [''] }] }));
  assert.throws(
    () =>
      parseClassUsageReply({
        classes: [
          { name: 'card', files: [] },
          { name: 'card', files: [] },
        ],
      }),
    /answered twice/,
  );
  const files = Array.from({ length: CLASS_USAGE_LIMITS.filesPerClassMax + 1 }, (_, index) => `src/${index}.astro`);
  assert.throws(() => parseClassUsageReply({ classes: [{ name: 'card', files }] }), /too many files/);
});

test('channel: the payload names the project, the page and the classes', () => {
  const payload = { projectPath: '/site', pagePath: '/site/src/pages/index.astro', classes: ['card'] };
  assert.deepEqual(parseIpcPayload('component:classUsage', payload), payload);
  assert.throws(() => parseIpcPayload('component:classUsage', { projectPath: '/site', classes: ['card'] }));
  assert.throws(() => parseIpcPayload('component:classUsage', { ...payload, classes: ['card', 'card'] }));
});
