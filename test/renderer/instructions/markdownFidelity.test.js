// Goal: an instructions file opened in the rich text editor and closed without an
// edit is byte-identical, whatever it holds: GitHub tables, nested and task lists,
// HTML blocks, reference links, trailing whitespace, CRLF line endings and
// frontmatter. An edit rewrites only what it touched: one table cell's row, one
// ticked box, one paragraph, one frontmatter value; every other byte stays.
// The save session never asks to write an unedited file, reloads an outside
// change when nothing is unsaved, and turns one that meets unsaved edits into a
// conflict that merges when the changes do not overlap.
// Method: bundle the reader, the writer, the editor's HTML projection and the
// panel's pure modules with esbuild and run them in a JSDOM document, as the
// existing rich text test does. An "edit" changes the DOM as the editor would,
// passes it through the projection HtmlField emits, and writes it back.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/instructions-fidelity.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export * from './src/ui/markdownBlocks';
      export * from './src/ui/markdownWrite';
      export { editableHTML } from './src/ui/htmlFieldModel';
      export { splitFrontmatter } from './shared/properties/instructions';
      export * as fields from './src/features/instructions/frontmatterFields';
      export * as session from './src/features/instructions/documentSession';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const md = require(output);
const { document } = new JSDOM('<!doctype html>').window;

// The editor as InstructionsView runs it: frontmatter split off, the body in MarkdownField with GFM on.
function open(source) {
  const split = md.splitFrontmatter(source);
  const parsed = md.parseMarkdown(split.body, { extensions: 'gfm' });
  const projection = md.editableHTML(md.markdownHTML(parsed), document);
  const host = document.createElement('div');
  host.innerHTML = projection.html;
  return { split, parsed, projection, host };
}

function write(editor) {
  const emitted = md.editableHTML(editor.host.innerHTML, document).html;
  return editor.split.raw + md.markdownFromHTML(emitted, editor.parsed, document);
}

const CORPUS = {
  'tables.md': [
    '# Tables',
    '',
    '| Name | Kind | Size |',
    '|:-----|:----:|-----:|',
    '| `a\\|b` | **bold** | 1 |',
    '| [link](https://example.com) | _em_ |  2  |',
    '',
    'Header only:',
    '',
    'a | b',
    '--|--',
    '',
    'Ragged rows stay as written:',
    '',
    '| x | y |',
    '|---|---|',
    '| 1 |',
    '',
  ].join('\n'),
  'lists.md': [
    '- one',
    '  - nested *star*',
    '    1. deep',
    '    2. deeper',
    '- [ ] open task',
    '- [x] done task',
    '  continued',
    '',
    '* loose',
    '',
    '* list',
    '',
    '3) starts at three',
    '4) next',
    '',
  ].join('\n'),
  'html.md': [
    '<div align="center">',
    '  <img src="logo.png">',
    '</div>',
    '',
    '<!-- a comment',
    'over lines -->',
    '',
    '<details><summary>More</summary>',
    '',
    'Inside.',
    '',
    '</details>',
    '',
  ].join('\n'),
  'references.md': ['See [the guide][guide] and [Other].', '', '[guide]: https://example.com/guide "Guide"', '[other]: <https://example.com/o>', ''].join('\n'),
  'whitespace.md': [
    'Trailing spaces  ',
    'hard break above.\t',
    '',
    '',
    '',
    'Three blank lines above.   ',
    '',
    '    indented code',
    '',
    '```ts title="x.ts"',
    'const a = 1;   ',
    '```',
    '',
    '~~~',
    'tilde',
    '~~~',
    'no final newline',
  ].join('\n'),
  'crlf.md':
    '---\r\nname: crlf\r\ndescription: "Windows: lines"\r\n---\r\n\r\n# Heading\r\n\r\n- [ ] task\r\n- item\r\n\r\n| a | b |\r\n|---|---|\r\n| 1 | 2 |\r\n\r\n> quote\r\n> more\r\n',
  'frontmatter.md': [
    '---',
    '# a comment',
    'name: skill-name   ',
    "description: 'It''s quoted'",
    'tags:',
    '  - a',
    '  - b',
    '---',
    '',
    'Body with *emphasis* and __strong__ and ~~strike~~.',
    '',
    'Setext',
    '======',
    '',
    '***',
    '',
  ].join('\n'),
  'empty.md': '',
  'only-frontmatter.md': '---\nname: x\ndescription: y\n---\n',
  'unicode.md': '# Ünïcödé 🎉\n\nEmoji 👍🏽 and CJK 漢字, & entities &amp; &#169;.\n\n| ✓ | ✗ |\n|---|---|\n| 是 | 否 |\n',
};

test('every file in the corpus opens editable and closes byte for byte', () => {
  for (const [name, source] of Object.entries(CORPUS)) {
    const editor = open(source);
    assert.equal(editor.projection.restricted, false, `${name}: the editor never locks a Markdown body`);
    assert.equal(editor.split.raw + md.printDocument(editor.parsed), source, `${name}: blocks partition the file`);
    assert.equal(write(editor), source, `${name}: a no-op is byte-identical`);
  }
});

test("the repository's own instructions files round-trip too", () => {
  const files = ['AGENTS.md', 'CLAUDE.md', 'README.md', 'docs/contracts.md', 'docs/enforcement.md'].filter((file) => fs.existsSync(repoPath(file)));
  assert.ok(files.length >= 3);
  for (const file of files) {
    const source = fs.readFileSync(repoPath(file), 'utf8');
    assert.equal(write(open(source)), source, file);
  }
});

test('GitHub tables and task items are shown, not kept; a ragged table is kept', () => {
  const tables = open(CORPUS['tables.md']);
  const kinds = tables.parsed.blocks.map((placed) => placed.block.kind);
  assert.deepEqual(kinds, ['heading', 'table', 'paragraph', 'table', 'paragraph', 'kept']);
  assert.equal(tables.host.querySelectorAll('table').length, 2);
  assert.equal(tables.host.querySelector('th.align-center')?.textContent, 'Kind');
  const lists = open(CORPUS['lists.md']);
  assert.deepEqual(
    [...lists.host.querySelectorAll('li.task')].map((item) => [item.className, item.textContent.trim()]),
    [
      ['task', 'open task'],
      ['task done', 'done task\ncontinued'],
    ],
  );
  // The CMS reads CommonMark, as it always has: no tables, no boxes.
  const commonmark = md.parseMarkdown(CORPUS['tables.md']);
  assert.equal(commonmark.blocks.filter((placed) => placed.block.kind === 'table').length, 0);
});

test('editing one cell rewrites its row only', () => {
  const editor = open(CORPUS['tables.md']);
  const cells = editor.host.querySelectorAll('table')[0].querySelectorAll('td');
  cells[5].textContent = '2 | 3';
  const result = write(editor);
  const expected = CORPUS['tables.md'].replace('| [link](https://example.com) | _em_ |  2  |', '| [link](https://example.com) | _em_ | 2 \\| 3 |');
  assert.equal(result, expected);
});

test('ticking a box flips that box and nothing else, in a CRLF file too', () => {
  const editor = open(CORPUS['lists.md']);
  editor.host.querySelector('li.task').classList.add('done');
  assert.equal(write(editor), CORPUS['lists.md'].replace('- [ ] open task', '- [x] open task'));
  const crlf = open(CORPUS['crlf.md']);
  crlf.host.querySelector('li.task').classList.add('done');
  assert.equal(write(crlf), CORPUS['crlf.md'].replace('- [ ] task', '- [x] task'));
});

test('editing a paragraph keeps every other block, gap and line ending', () => {
  const editor = open(CORPUS['crlf.md']);
  editor.host.querySelector('blockquote p').textContent = 'changed';
  assert.equal(write(editor), CORPUS['crlf.md'].replace('> quote\r\n> more\r\n', '> changed\r\n'));
  const whitespace = open(CORPUS['whitespace.md']);
  const paragraphs = whitespace.host.querySelectorAll('p');
  paragraphs[1].textContent = 'Edited.';
  assert.equal(write(whitespace), CORPUS['whitespace.md'].replace('Three blank lines above.   ', 'Edited.'));
});

test('a new task typed into a list is written with its box', () => {
  const editor = open('- [ ] one\n');
  const item = document.createElement('li');
  item.className = 'task';
  item.textContent = 'two';
  editor.host.querySelector('ul').append(item);
  assert.equal(write(editor), '- [ ] one\n- [ ] two\n');
});

test('frontmatter fields edit one line and keep the rest of the file', () => {
  const source = CORPUS['frontmatter.md'];
  assert.equal(md.fields.frontmatterView(source).kind, 'text', 'a list in the frontmatter shows it as YAML');
  const simple = CORPUS['crlf.md'];
  const view = md.fields.frontmatterView(simple);
  assert.equal(view.kind, 'fields');
  assert.deepEqual(
    view.fields.map((field) => [field.key, field.value]),
    [
      ['name', 'crlf'],
      ['description', 'Windows: lines'],
    ],
  );
  const renamed = md.fields.withFieldValue(simple, view.fields[0], { value: 'renamed' });
  assert.equal(renamed, simple.replace('name: crlf\r\n', 'name: renamed\r\n'));
  const described = md.fields.withFieldValue(simple, view.fields[1], { value: 'Has "quotes"' });
  assert.equal(described, simple.replace('description: "Windows: lines"', 'description: "Has \\"quotes\\""'));
  const quoted = "---\nname: 'single'\n---\nbody";
  const single = md.fields.frontmatterView(quoted);
  assert.equal(md.fields.withFieldValue(quoted, single.fields[0], { value: 'still single' }), "---\nname: 'still single'\n---\nbody");
  assert.equal(md.fields.withFrontmatterYaml(source, 'name: x\n'), source.replace(/^---\n[\s\S]*?\n---\n/, '---\nname: x\n---\n'));
  assert.equal(md.fields.frontmatterView('no frontmatter').kind, 'none');
  // Each key is the CMS field its YAML reads as; a quoted value is text whatever it spells.
  const typed = '---\nname: x\ndraft: false\norder: 3\nupdated: 2024-05-01\nversion: "2"\n---\n';
  const typedView = md.fields.frontmatterView(typed);
  assert.deepEqual(
    typedView.fields.map((field) => [field.key, field.kind]),
    [
      ['name', 'string'],
      ['draft', 'boolean'],
      ['order', 'number'],
      ['updated', 'date'],
      ['version', 'string'],
    ],
  );
  const [, draft, order, updated, version] = typedView.fields;
  assert.equal(md.fields.withFieldValue(typed, draft, { value: true }), typed.replace('draft: false', 'draft: true'), 'a switch writes YAML true');
  assert.equal(md.fields.withFieldValue(typed, order, { value: 10 }), typed.replace('order: 3', 'order: 10'));
  assert.equal(md.fields.withFieldValue(typed, updated, { value: '2025-01-02' }), typed.replace('2024-05-01', '2025-01-02'), 'a date stays plain');
  assert.equal(md.fields.withFieldValue(typed, version, { value: '3' }), typed.replace('version: "2"', 'version: "3"'), 'quoted text stays quoted');
  const wrapped = md.fields.withFieldValue(typed, typedView.fields[0], { value: 'two\nlines' });
  assert.equal(wrapped, typed.replace('name: x', 'name: two lines'), 'text is saved as one YAML line');
});

test('the save session writes only edits, reloads outside changes and merges what does not overlap', () => {
  const { session } = md;
  const opened = session.openSession('AGENTS.md', 'a\nb\nc\n');
  assert.equal(session.shouldSave(opened), false, 'an unedited file never saves');
  assert.equal(session.shouldSave(session.edited(opened, 'a\nb\nc\n')), false, 'typing back to the base is no edit');
  const reloaded = session.changedOnDisk(opened, 'a\nB\nc\n');
  assert.equal(reloaded.draft, 'a\nB\nc\n', 'nothing unsaved: an outside change reloads');
  assert.equal(reloaded.conflict, undefined);
  const mine = session.edited(opened, 'A\nb\nc\n');
  const clash = session.changedOnDisk(mine, 'a\nb\nC\n');
  assert.equal(clash.draft, 'A\nb\nc\n', 'unsaved edits are kept');
  assert.deepEqual(clash.conflict, { theirs: 'a\nb\nC\n', merged: 'A\nb\nC\n' });
  assert.equal(session.shouldSave(clash), false, 'a conflict waits for the person');
  const merged = session.resolved(clash, 'merge');
  assert.equal(merged.draft, 'A\nb\nC\n');
  assert.equal(merged.base, 'a\nb\nC\n', 'the merge saves over what the disk holds');
  assert.equal(session.shouldSave(merged), true);
  const overlap = session.changedOnDisk(mine, 'X\nb\nc\n');
  assert.equal(overlap.conflict.merged, undefined, 'changes to the same line cannot merge');
  assert.throws(() => session.resolved(overlap, 'merge'), /Merge is offered only when both sides merge/);
  assert.equal(session.resolved(overlap, 'theirs').draft, 'X\nb\nc\n');
  assert.equal(session.resolved(overlap, 'mine').draft, 'A\nb\nc\n');
  assert.equal(session.changedOnDisk(mine, 'A\nb\nc\n').base, 'A\nb\nc\n', 'the disk catching up is no conflict');
  assert.throws(() => session.resolved(opened, 'theirs'), /Only a conflict is resolved/);
});
