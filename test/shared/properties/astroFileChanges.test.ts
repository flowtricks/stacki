// Goal: only bounded, project-relative Astro changes cross the notification boundary.
// Method: parse valid events and malformed inputs, then compare inventories and burst summaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASTRO_FILES_MAX, astroChangeMessages, diffAstroFiles, parseAstroFileChanges } from '#dist/shared/properties/astroFileChanges.js';

const added = { kind: 'added', file: 'src/components/Hero.astro' } as const;

test('Astro changes validate kinds, paths, and collection bounds', () => {
  assert.deepEqual(parseAstroFileChanges([added]), [added]);
  for (const input of [
    undefined,
    {},
    [undefined],
    [{ ...added, kind: 'changed' }],
    [{ ...added, file: '/private/Hero.astro' }],
    [{ ...added, file: 'src/../Hero.astro' }],
    [{ ...added, file: 'src/Hero.ts' }],
    [{ ...added, file: 'src/a\\Hero.astro' }],
    [{ ...added, file: 'src/\0.astro' }],
    Array(ASTRO_FILES_MAX * 2 + 1).fill(added),
  ]) {
    assert.throws(() => parseAstroFileChanges(input));
  }
});

test('Inventories ignore edits and report both sides of a rename', () => {
  const before = new Set(['src/pages/index.astro', added.file]);
  assert.deepEqual(diffAstroFiles(before, before), []);
  const after = new Set(['src/pages/index.astro', 'src/components/Header.astro']);
  assert.deepEqual(diffAstroFiles(before, after), [
    { kind: 'removed', file: added.file },
    { kind: 'added', file: 'src/components/Header.astro' },
  ]);
  assert.throws(
    () => diffAstroFiles(new Set(Array.from({ length: ASTRO_FILES_MAX + 1 }, (_, index) => String(index))), after),
    /Previous Astro inventory exceeds limit/,
  );
});

test('Small changes name files and bursts summarize every operation', () => {
  assert.deepEqual(astroChangeMessages([added]), ['Added src/components/Hero.astro']);
  const changes = parseAstroFileChanges(
    Array.from({ length: 8 }, (_, index) => ({
      kind: index < 4 ? 'added' : 'removed',
      file: `src/File${index}.astro`,
    })),
  );
  const messages = astroChangeMessages(changes);
  assert.equal(messages.length, 2);
  assert.match(messages[0] ?? '', /Added 4 Astro files/);
  assert.match(messages[1] ?? '', /Removed 4 Astro files/);
});
