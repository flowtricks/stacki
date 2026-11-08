// Goal: a Markdown entry's body opens in the rich text editor as formatted text and
// is written back as Markdown that keeps every byte the person did not touch. Real
// documentation pages (copied from the marketing site into test/fixtures/markdown-docs)
// must open without locking the editor, write back unchanged when nothing is edited,
// rewrite only the paragraph that is edited, keep their fenced code exactly, and show
// as kept-as-written only the blocks the editor cannot model (tables, HTML, MDX).
// Method: the reader (markdownBlocks.ts), the writer (markdownWrite.ts) and the editor's
// own HTML projection (htmlFieldModel.ts) are bundled and run in a JSDOM document. An
// "edit" changes the DOM the way the editor would and passes its HTML through the same
// projection HtmlField emits, then the writer turns it back into Markdown, which is
// compared byte for byte with what the change should be.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildSync } = require('esbuild');
const { JSDOM } = require('jsdom');
const { ROOT, repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/markdown-rich-text.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: {
    contents: `export * from './src/ui/markdownBlocks';
      export * from './src/ui/markdownWrite';
      export { editableHTML } from './src/ui/htmlFieldModel';
      export { parse as parseEntry } from './electron/content/formats/markdownEntry';`,
    resolveDir: ROOT,
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
const markdown = require(output);
const { document } = new JSDOM('<!doctype html>').window;

const FIXTURES = repoPath('test/fixtures/markdown-docs');
const fixtures = fs
  .readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.md'))
  .sort()
  .map((name) => ({ name, body: markdown.parseEntry(fs.readFileSync(path.join(FIXTURES, name), 'utf8')).body }));

// The editor as HtmlField runs it: the projection it shows, and the HTML it emits.
function open(body) {
  const document_ = markdown.parseMarkdown(body);
  const projection = markdown.editableHTML(markdown.markdownHTML(document_), document);
  const host = document.createElement('div');
  host.innerHTML = projection.html;
  return { parsed: document_, projection, host };
}

function write(editor) {
  const emitted = markdown.editableHTML(editor.host.innerHTML, document).html;
  return markdown.markdownFromHTML(emitted, editor.parsed, document);
}

function fixture(name) {
  const found = fixtures.find((each) => each.name === name);
  assert.ok(found, name);
  return found.body;
}

test('the fixtures are the real documentation pages', () => {
  assert.ok(fixtures.length >= 6);
  for (const { name, body } of fixtures) {
    assert.ok(body.length > 500, `${name} has a body`);
  }
});

test('every page opens editable and writes back byte for byte when nothing changes', () => {
  for (const { name, body } of fixtures) {
    const editor = open(body);
    assert.equal(editor.projection.restricted, false, `${name}: the editor never locks a Markdown body`);
    assert.equal(markdown.printDocument(editor.parsed), body, `${name}: blocks partition the body`);
    assert.equal(write(editor), body, `${name}: a no-op is byte-identical`);
  }
});

test('Markdown becomes the editor’s formatting, not raw text in one paragraph', () => {
  const editor = open(fixture('loops-and-conditions.md'));
  const host = editor.host;
  assert.deepEqual(
    [...host.querySelectorAll('h2')].map((heading) => heading.textContent),
    ['Loops', 'Conditions', 'When the code wins'],
  );
  assert.equal(host.querySelector('strong')?.textContent, 'Loop');
  assert.equal(host.querySelector('a')?.getAttribute('href'), '/docs/binding-data');
  assert.equal(host.querySelectorAll('pre > code.language-astro').length, 2);
  assert.ok(!host.textContent.includes('## Loops'), 'no Markdown syntax shows as text');
  assert.ok(!host.textContent.includes('```'), 'no fence shows as text');
  assert.equal(host.querySelectorAll('.stacki-markdown-kept').length, 0, 'nothing on this page is kept as written');
});

test('editing one paragraph rewrites that paragraph and nothing else', () => {
  const body = fixture('loops-and-conditions.md');
  const editor = open(body);
  const paragraph = editor.host.querySelectorAll('p')[1];
  const strong = paragraph.querySelector('strong');
  strong.textContent = 'Loop block';
  const result = write(editor);
  const before = [
    'Insert **Loop** from the palette. Its Data field takes whatever can be looped:',
    'a collection query, a prop, an array on `Astro.props`, chosen from the same',
    '[data picker](/docs/binding-data) the prop fields use, filtered to things that',
    'can be iterated.',
  ].join('\n');
  assert.ok(body.includes(before));
  const after = result.slice(body.indexOf(before), result.length - (body.length - body.indexOf(before) - before.length));
  assert.equal(result.replace(after, before), body, 'everything outside the paragraph is unchanged');
  assert.match(after, /^Insert \*\*Loop block\*\* from the palette\./);
  assert.ok(after.includes('[data picker](/docs/binding-data)'), 'the link keeps its spelling');
  assert.ok(after.includes('`Astro.props`'), 'inline code is kept');
  for (const line of after.split('\n')) {
    assert.ok(line.length <= 80, `wrapped as the page wraps: ${line}`);
  }
});

test('fenced code blocks survive edits around them and inside them', () => {
  const body = fixture('loops-and-conditions.md');
  const fences = body.match(/```astro\n[\s\S]*?\n```/g);
  assert.equal(fences.length, 2);
  const editor = open(body);
  editor.host.querySelector('p').textContent = 'A loop and a condition are nodes.';
  const around = write(editor);
  for (const fence of fences) {
    assert.ok(around.includes(fence), 'an untouched fence is byte-identical');
  }
  const code = editor.host.querySelectorAll('pre code')[1];
  code.textContent = '{featured && <Badge>New</Badge>}';
  const inside = write(editor);
  assert.ok(inside.includes('```astro\n{featured && <Badge>New</Badge>}\n```'), 'an edited fence keeps its language and fence');
  assert.ok(inside.includes(fences[0]), 'the other fence is untouched');
});

test('an edited fence keeps its full info string and outgrows backticks inside it', () => {
  const body = 'Text.\n\n```astro title="Card.astro"\n<Card />\n```\n';
  const editor = open(body);
  editor.host.querySelector('code').textContent = 'Use ``` fences';
  assert.equal(write(editor), 'Text.\n\n````astro title="Card.astro"\nUse ``` fences\n````\n');
});

test('only blocks the editor cannot model are kept as written, and the text around them still edits', () => {
  const body = fixture('breakpoints.md');
  const editor = open(body);
  const kept = [...editor.host.querySelectorAll('.stacki-markdown-kept')];
  const tables = editor.parsed.blocks.filter((placed) => placed.block.source.startsWith('|'));
  assert.ok(tables.length >= 3);
  assert.equal(kept.length, tables.length, 'the tables, and only the tables, are kept');
  for (const block of kept) {
    assert.match(block.textContent, /^\|/);
  }
  assert.equal(editor.projection.restricted, false, 'the editor stays unlocked around them');
  const heading = editor.host.querySelector('h2');
  heading.textContent = `${heading.textContent} (renamed)`;
  const result = write(editor);
  for (const placed of tables) {
    assert.ok(result.includes(placed.block.source), 'a table is written back as it was');
  }
  assert.equal(result.split('\n').length, body.split('\n').length, 'one heading changed, no lines moved');
});

test('inline HTML the editor shows (kbd) round-trips, and markup it cannot show is kept per block', () => {
  const body = fixture('canvas.md');
  const editor = open(body);
  assert.ok(editor.host.querySelector('kbd'), 'kbd shows as itself');
  const withKbd = [...editor.host.querySelectorAll('p')].find((paragraph) => paragraph.querySelector('kbd'));
  withKbd.append(document.createTextNode(' Added.'));
  const result = write(editor);
  assert.match(result, /<kbd>Esc<\/kbd>/);
  assert.ok(result.includes(' Added.'));
  const shortcuts = open(fixture('keyboard-shortcuts.md'));
  const span = [...shortcuts.host.querySelectorAll('.stacki-markdown-kept')].find((block) => block.textContent.startsWith('<span'));
  assert.ok(span, 'a span with attributes is kept as written');
  assert.equal(shortcuts.projection.restricted, false);
});

test('editing one list item keeps every other item’s lines', () => {
  const body = fixture('git-and-github.md');
  const editor = open(body);
  const list = [...editor.host.querySelectorAll('ul')].find((each) => each.textContent.includes('Commit first'));
  const item = [...list.children].find((each) => each.textContent.startsWith('Commit first'));
  item.querySelector('strong').textContent = 'Commit before switching';
  const result = write(editor);
  assert.ok(result.includes('- **Leave them on `<branch>`** sets the work aside against the branch it was\n  written on. Nothing is committed.'));
  const edited = '- **Commit before switching** commits to the branch you are on and then\n  switches.';
  assert.ok(result.includes(edited), 'the edited item wraps inside the page’s width, under its marker');
  assert.equal(result.replace(edited, '- **Commit first** commits to the branch you are on and then switches.'), body);
});

test('blocks added, removed and moved leave the others byte-identical', () => {
  const body = 'Intro with _emphasis_.\n\n* one\n* two\n\n---\n\nLast.\n';
  const editor = open(body);
  const added = document.createElement('p');
  added.innerHTML = 'New <em>words</em> and <strong>more</strong> here';
  editor.host.insertBefore(added, editor.host.querySelector('hr'));
  assert.equal(write(editor), 'Intro with _emphasis_.\n\n* one\n* two\n\nNew _words_ and **more** here\n\n---\n\nLast.\n');
  editor.host.querySelector('hr').remove();
  assert.equal(write(editor), 'Intro with _emphasis_.\n\n* one\n* two\n\nNew _words_ and **more** here\n\nLast.\n');
  const item = document.createElement('li');
  item.textContent = 'three';
  editor.host.querySelector('ul').append(item);
  assert.match(write(editor), /\* one\n\* two\n\* three\n/);
});

test('MDX imports, components and HTML blocks are kept as their own blocks', () => {
  const body = 'import Card from "../Card.astro";\n\nBefore.\n\n<Card title="Hi" />\n\n<div class="note">\nHTML\n</div>\n\nAfter.\n';
  const editor = open(body);
  const kept = [...editor.host.querySelectorAll('.stacki-markdown-kept')].map((block) => block.textContent);
  assert.deepEqual(kept, ['import Card from "../Card.astro";', '<Card title="Hi" />', '<div class="note">\nHTML\n</div>']);
  assert.equal(editor.projection.restricted, false);
  editor.host.querySelectorAll('p')[1].textContent = 'After, edited.';
  assert.equal(write(editor), body.replace('After.', 'After, edited.'));
});

test('a kept block edited as source is written as typed', () => {
  const body = '| a | b |\n| - | - |\n| 1 | 2 |\n';
  const editor = open(body);
  editor.host.querySelector('pre').textContent = '| a | b |\n| - | - |\n| 3 | 4 |';
  assert.equal(write(editor), '| a | b |\n| - | - |\n| 3 | 4 |\n');
});

test('text typed into the editor is escaped so it stays text', () => {
  const editor = open('Plain.\n');
  editor.host.querySelector('p').textContent = '# not a heading, *not emphasis*, snake_case, <b> and [brackets]';
  assert.equal(write(editor), '\\# not a heading, \\*not emphasis\\*, snake_case, \\<b> and \\[brackets\\]\n');
  editor.host.querySelector('p').textContent = '1. not a list';
  assert.equal(write(editor), '1\\. not a list\n');
});

test('relative and reference links keep the spelling the body wrote', () => {
  const body = 'See [one](other-page) and [two][docs].\n\n[docs]: https://example.com/docs\n';
  const editor = open(body);
  const links = [...editor.host.querySelectorAll('a')];
  assert.equal(links[0].getAttribute('href'), './other-page', 'the editor shows a relative link it can follow');
  links[0].textContent = 'first';
  assert.equal(write(editor), 'See [first](other-page) and [two][docs].\n\n[docs]: https://example.com/docs\n');
});

test('a link to another scheme keeps its paragraph as written instead of dropping the link', () => {
  const editor = open('Click [me](javascript:alert(1)).\n\nNext.\n');
  assert.equal(editor.host.querySelectorAll('.stacki-markdown-kept').length, 1);
  assert.equal(editor.projection.restricted, false);
});

test('an empty body opens empty and a first paragraph gets a final newline', () => {
  const editor = open('');
  assert.equal(editor.host.innerHTML, '');
  editor.host.innerHTML = '<p>Hello <strong>there</strong></p>';
  assert.equal(write(editor), 'Hello **there**\n');
  editor.host.innerHTML = '<p><br></p>';
  assert.equal(write(editor), '');
});

// A paragraph rewrapped reads the same: line breaks in text outside code are spaces.
function softBreaksAsSpaces(html) {
  const template = document.createElement('template');
  template.innerHTML = html;
  const walker = document.createTreeWalker(template.content, 4);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!node.parentElement?.closest('pre')) {
      node.data = node.data.replace(/\s*\n\s*/g, ' ');
    }
  }
  return template.innerHTML;
}

test('every page written fresh from the editor’s HTML reads back as the same formatting', () => {
  const synthetic = [
    'Setext title\n===',
    '1. one\n2. two\n   - nested *em*\n   - and `code`\n\n   loose para\n3. three',
    '> quoted **strong** and\n> a [link](https://example.com "Title")\n>\n> - inside',
    'Hard  \nbreak and back\\\nslash, <https://example.com>, ![alt](/pic.png) and in_word_underscores.',
    '    indented code\n    more',
    '~~~css\na { color: red; }\n~~~',
  ].join('\n\n');
  for (const { name, body } of [...fixtures, { name: 'synthetic', body: `${synthetic}\n` }]) {
    const editor = open(body);
    // No block to copy: every block is printed from the DOM, as an edit would print it.
    const fresh = markdown.markdownFromHTML(editor.projection.html, { ...editor.parsed, lead: '', blocks: [], trail: '' }, document);
    const again = softBreaksAsSpaces(markdown.markdownHTML(markdown.parseMarkdown(fresh)));
    assert.equal(again, softBreaksAsSpaces(editor.projection.html), `${name}: printing keeps what the editor showed`);
  }
});
