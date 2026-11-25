// Goal: a Markdown entry that starts with an empty frontmatter block (`---`
// straight over `---`, which is what the CMS writes for a new entry) keeps one
// block as fields are written into it. The frontmatter pattern wanted a line
// break before the closing fence, so the empty block read as body: the first
// field written grew a second block above it, and every new or duplicated
// entry kept `---\n---` in its body for good.
// Method: the format module case by case (empty block read as empty data, its
// body untouched, LF and CRLF, edits that write nothing), then writeEntry on a
// temporary collection exactly as the CMS creates and fills an entry.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const frontmatter = require('#dist/electron/content/formats/markdownEntry.js');
const { listEntries, writeEntry } = require('#dist/electron/content/contentEntries.js');

test('an empty frontmatter block reads as empty data, not as body', () => {
  const parsed = frontmatter.parse('---\n---\n');
  assert.deepEqual(parsed.data, {});
  assert.equal(parsed.frontmatter, '');
  assert.equal(parsed.body, '');
  const withBody = frontmatter.parse('---\n---\nHello\n');
  assert.equal(withBody.body, 'Hello\n', 'the body after it is the body');
  assert.equal(frontmatter.parse('---\r\n---\r\nHi').body, 'Hi', 'CRLF too');
  assert.equal(frontmatter.parse('No frontmatter\n').data, undefined, 'a file without one still has none');
  assert.equal(frontmatter.parse('---\ntitle: A\n---\nBody').data.title, 'A', 'a full block reads as before');
});

test('writing into an empty block fills that block, with one fence pair', () => {
  const written = frontmatter.applyEdits('---\n---\n', [{ path: ['number'], value: '5' }]);
  assert.equal(written, '---\nnumber: "5"\n---\n');
  assert.equal((written.match(/^---$/gm) ?? []).length, 2, 'exactly one block');
  const crlf = frontmatter.applyEdits('---\r\n---\r\nBody', [{ path: ['a'], value: 'x' }]);
  assert.equal(crlf, '---\r\na: x\r\n---\r\nBody', 'the file keeps its own line breaks');
  assert.equal(frontmatter.applyEdits('---\n---\n', []), '---\n---\n', 'no edits change nothing');
  assert.equal(frontmatter.applyEdits('---\n---\nOld', [], { body: 'New' }), '---\n---\nNew', 'a body edit keeps the empty block');
});

test('a new entry filled field by field has one frontmatter and an empty body', (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-empty-frontmatter-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/content/stats'), { recursive: true });
  const file = path.join(root, 'src/content/stats/untitled.md');
  fs.writeFileSync(file, '---\n---\n'); // The CMS's starter for a new entry.
  const collection = { name: 'stats', loader: { kind: 'glob', base: './src/content/stats', pattern: '**/*.md' }, schema: undefined };
  const entry = () => listEntries(root, collection).entries.find((each) => each.id === 'untitled');
  for (const [field, value] of [
    ['number', '80%'],
    ['heading', 'Uptime (copy)'],
    ['text', 'weather permitting'],
  ]) {
    writeEntry(root, entry(), [{ path: [field], value }]);
  }
  writeEntry(root, entry(), [], { body: '' }); // A duplicate copies the empty body too.
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text, '---\nnumber: 80%\nheading: Uptime (copy)\ntext: weather permitting\n---\n');
  assert.equal(frontmatter.parse(text).body, '', 'no stray fences in the body');
});
