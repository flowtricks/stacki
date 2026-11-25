// Goal: code written into a frontmatter that holds only imports prints AFTER the imports, never
// above them. JavaScript hoists imports, so the wrong order still ran, but it read backwards and
// a person editing the block could not tell what came from where (found pasting a loop's
// `const statsEntries = await getCollection(...)` into a page with two imports).
// Method: read real frontmatter text with readFrontmatter, add code the way a paste or a loop
// source does (a new extraFrontmatter), write it back with writeFrontmatter, and pin the text,
// including the negative space: an existing code block keeps its imports where they were.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFrontmatter, writeFrontmatter } from '#dist/shared/page/frontmatterSource.js';

const IMPORTS = "import Layout from '../layouts/Layout.astro';\nimport { getCollection } from 'astro:content';\n";

test('a statement added to an imports-only block lands after the last import', () => {
  const read = readFrontmatter(IMPORTS);
  const written = writeFrontmatter({ ...read, extraFrontmatter: "const statsEntries = await getCollection('stats');" });
  assert.equal(written, `${IMPORTS}const statsEntries = await getCollection('stats');`);
});

test('several statements keep their order after the imports', () => {
  const read = readFrontmatter(IMPORTS);
  const written = writeFrontmatter({ ...read, extraFrontmatter: 'const a = 1;\nconst b = a + 1;' });
  assert.ok(written.indexOf('import { getCollection }') < written.indexOf('const a = 1;'));
  assert.ok(written.indexOf('const a = 1;') < written.indexOf('const b = a + 1;'));
});

test('a block that already had code keeps imports where it read them', () => {
  const source = "const before = 1;\nimport Layout from '../layouts/Layout.astro';\nconst after = 2;\n";
  const read = readFrontmatter(source);
  const written = writeFrontmatter({ ...read, extraFrontmatter: `${read.extraFrontmatter.trimEnd()}\nconst added = 3;` });
  assert.ok(written.indexOf('const before = 1;') < written.indexOf('import Layout'));
  assert.ok(written.indexOf('import Layout') < written.indexOf('const added = 3;'));
});

test('an unchanged block writes back byte for byte', () => {
  const read = readFrontmatter(IMPORTS);
  assert.equal(writeFrontmatter(read), IMPORTS);
});
