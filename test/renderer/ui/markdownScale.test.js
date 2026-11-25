// Goal: the Markdown editor reads a body of any length block by block. It used to
// keep a body past a million characters or fifty thousand lines as one opaque
// block; now every block of a long document is a block of its own, the document
// prints back byte for byte, and the read grows in proportion to the text.
// Method: bodies are generated in memory at sizes a fixed cap would have refused
// (past 50,000 lines and 1,000,000 characters) and read with parseMarkdown. The
// block count, the byte-for-byte print and the time ratio between a body and one
// four times as long are asserted; the time is printed through measureOperation.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');
const { measureOperation, scaleMegabytes } = loadRenderer('test/helpers/scaleFixtures.ts');
const markdown = loadRenderer('src/ui/markdownBlocks.ts');

function body(blockCount) {
  const parts = [];
  for (let index = 0; index < blockCount; index++) {
    parts.push(
      index % 50 === 0
        ? `# Heading ${index}\n`
        : index % 7 === 0
          ? `- item *${index}*\n- second [link](https://example.com/${index})\n`
          : `Paragraph ${index} with **bold** text and \`code\`.\n`,
    );
  }
  return parts.join('\n');
}

test('a body past the old caps is read into one block per paragraph, list and heading', async () => {
  const blockCount = Math.floor(scaleMegabytes() * 8_000);
  const text = body(blockCount);
  assert.ok(text.length > 1_000_000, 'the body is past the old character cap');
  assert.ok(text.split('\n').length > 50_000, 'the body is past the old line cap');
  const read = await measureOperation('markdown-parse', `${text.length} chars, ${blockCount} blocks`, async () => markdown.parseMarkdown(text));
  assert.equal(read.value.blocks.length, blockCount);
  assert.equal(markdown.printDocument(read.value), text, 'the document prints back byte for byte');
});

test('reading grows in proportion to the text, not faster', async () => {
  const small = body(20_000);
  const large = body(80_000);
  const first = await measureOperation('markdown-parse-small', `${small.length} chars`, async () => markdown.parseMarkdown(small));
  const second = await measureOperation('markdown-parse-large', `${large.length} chars`, async () => markdown.parseMarkdown(large));
  // Four times the text: a quadratic read would take sixteen times as long.
  assert.ok(second.wallMs < Math.max(first.wallMs, 20) * 10, `${first.wallMs} ms became ${second.wallMs} ms`);
});
