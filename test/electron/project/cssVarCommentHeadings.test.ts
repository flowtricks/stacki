// Goal: a comment heading in the Variables panel reads as a heading however the
// comment is written, and every edit made through that heading still lands in
// the right place in the file. The case that broke was a docblock
// (`/*`, ` * The brand purple. …`, ` */`), shown as "* The brand purple. `#9c75f7` i…".
// Methodology: each case writes a small stylesheet to a temporary project, reads
// it through the same `readVariables` the panel calls, and edits it through the
// same operations the IPC handlers call, comparing the bytes on disk. The
// heading's offsets come from the read, so a span that is off by a line fails as
// a wrong write, not a passing read.
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addSection, moveVariable, readVariables, removeSection, setSectionTitle } from '#dist/electron/project/cssVars.js';

type Model = ReturnType<typeof readVariables>;
type Block = Model['files'][number]['groups'][number]['blocks'][number];

const FILE = 'src/styles/base.css';

function project(context: TestContext, text: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-comment-headings-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.dirname(path.join(root, FILE)), { recursive: true });
  fs.writeFileSync(path.join(root, FILE), text);
  return root;
}

const read = (root: string): string => fs.readFileSync(path.join(root, FILE), 'utf8');

// The headings that are comments, in file order: the ones with a span to write to.
function headings(root: string): readonly Block[] {
  const file = readVariables(root).files.find((candidate) => candidate.rel === FILE);
  assert.ok(file, 'the stylesheet is in the panel');
  return file.groups.flatMap((group) => group.blocks.filter((block) => block.titleStart !== undefined));
}

function heading(root: string, title: string): Block & { readonly title: string; readonly titleStart: number; readonly titleEnd: number } {
  const block = headings(root).find((candidate) => candidate.title === title);
  assert.ok(block, `a heading reads ${JSON.stringify(title)}; got ${JSON.stringify(headings(root).map((candidate) => candidate.title))}`);
  const { titleStart, titleEnd } = block;
  assert.ok(titleStart !== undefined);
  assert.ok(titleEnd !== undefined);
  return { ...block, title, titleStart, titleEnd };
}

const DOCBLOCK = `:root {
  /* Surfaces */
  --surface: #111;
  --surface-raised: #1a1a1a;

  /*
   * The brand purple. \`#9c75f7\` is the base;
   * the ramp is mixed from it.
   */
  --accent: #9c75f7;
  --accent-ink: white;
}
`;

test('a docblock heading is its first sentence, with the whole comment as its description', (context) => {
  const root = project(context, DOCBLOCK);
  const brand = heading(root, 'The brand purple');
  assert.equal(DOCBLOCK.slice(brand.titleStart, brand.titleEnd), 'The brand purple');
  assert.equal(brand.description, 'The brand purple. `#9c75f7` is the base;\nthe ramp is mixed from it.');
  assert.deepEqual(
    brand.rows.map((row) => row.name),
    ['--accent', '--accent-ink'],
  );
  // A one-line comment is unchanged: the same title, the same span, nothing more to say.
  const surfaces = heading(root, 'Surfaces');
  assert.equal(DOCBLOCK.slice(surfaces.titleStart, surfaces.titleEnd), 'Surfaces');
  assert.equal(surfaces.description, undefined);
});

test('backticks in a one-line heading are kept for the view to draw as code', (context) => {
  const text = ':root {\n  /* The `--space` scale. Multiples of 4px. */\n  --space-1: 4px;\n}\n';
  const root = project(context, text);
  const block = heading(root, 'The `--space` scale');
  assert.equal(block.description, 'The `--space` scale. Multiples of 4px.');
});

test('a docblock with a blank first line takes its title from the first line with words', (context) => {
  const text = ':root {\n  /**\n   *\n   * Radii\n   */\n  --radius: 4px;\n}\n';
  const root = project(context, text);
  const block = heading(root, 'Radii');
  assert.equal(block.description, undefined);
  assert.equal(text.slice(block.titleStart, block.titleEnd), 'Radii');
});

test('renaming a docblock heading rewrites its first sentence and keeps the rest', (context) => {
  const root = project(context, DOCBLOCK);
  const brand = heading(root, 'The brand purple');
  const result = setSectionTitle(root, { file: FILE, start: brand.titleStart, end: brand.titleEnd, expect: brand.title, title: 'Accent' });
  assert.equal(result.ok, true, result.error);
  assert.equal(read(root), DOCBLOCK.replace('The brand purple.', 'Accent.'));
  assert.equal(heading(root, 'Accent').description, 'Accent. `#9c75f7` is the base;\nthe ramp is mixed from it.');
});

test('removing a docblock heading removes the whole comment and nothing else', (context) => {
  const root = project(context, DOCBLOCK);
  const brand = heading(root, 'The brand purple');
  const result = removeSection(root, { file: FILE, start: brand.titleStart, end: brand.titleEnd, expect: brand.title });
  assert.equal(result.ok, true, result.error);
  const comment = DOCBLOCK.slice(DOCBLOCK.indexOf('  /*\n'), DOCBLOCK.lastIndexOf('*/\n') + 3);
  assert.equal(read(root), DOCBLOCK.replace(comment, ''));
});

test('a heading added at a docblock heading lands above the comment, not inside it', (context) => {
  const root = project(context, DOCBLOCK);
  const brand = heading(root, 'The brand purple');
  const result = addSection(root, { file: FILE, selector: ':root', title: 'The brand purple copy', at: brand.titleStart });
  assert.equal(result.ok, true, result.error);
  assert.equal(read(root), DOCBLOCK.replace('  /*\n   * The brand', '  /* The brand purple copy */\n  /*\n   * The brand'));
  heading(root, 'The brand purple copy');
  heading(root, 'The brand purple');
});

test('a variable dropped on a docblock heading lands above the comment, not inside it', (context) => {
  const root = project(context, DOCBLOCK);
  const brand = heading(root, 'The brand purple');
  const result = moveVariable(root, { file: FILE, selector: ':root', name: '--accent-ink', at: brand.titleStart });
  assert.equal(result.ok, true, result.error);
  const expected = DOCBLOCK.replace('  --accent-ink: white;\n', '').replace('  /*\n   * The brand', '  --accent-ink: white;\n  /*\n   * The brand');
  assert.equal(read(root), expected);
  // The file still parses into the same two headings.
  assert.deepEqual(
    headings(root).map((block) => block.title),
    ['Surfaces', 'The brand purple'],
  );
});
