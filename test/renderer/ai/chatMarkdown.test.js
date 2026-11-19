// Goal: the AI panel reads an agent's Markdown into the right blocks. Tables keep their header, alignment and
// width, lists nest and carry task boxes, quotes hold blocks, an open fence is code, links open only on the web,
// HTML is never interpreted, a numbered list is read as quick replies, and every bound (characters, depth, rows,
// columns) holds on hostile input.
// Method: bundle the pure parser with esbuild and compare its blocks with what a person would draw from the text,
// then feed it generated nesting and size to prove it neither throws nor runs past its bounds.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const { parseChatMarkdown, parseInline, parseQuickReplies, quickReplyText, splitRow, isSafeLink, MARKDOWN_LIMITS, QUICK_REPLIES_MAX } = loadRenderer(
  'src/features/ai/markdown/chatMarkdown.ts',
);

const LIMITS = MARKDOWN_LIMITS;
const plain = (nodes, depth = 0) => {
  if (depth > LIMITS.depthMax) {
    throw new Error('inline nesting passed its bound');
  }
  return nodes.map((node) => (node.kind === 'text' || node.kind === 'code' ? node.text : plain(node.children, depth + 1))).join('');
};

test('a GFM table keeps its header, alignment and body, and pads or cuts rows to the header width', () => {
  const [table] = parseChatMarkdown('| Area | Features | Count |\n|:---|:---:|---:|\n| Roles | `roles.json` | 3 |\n| Short |\n| A | B | C | D |');
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.align, ['start', 'center', 'end']);
  assert.deepEqual(table.header.map(plain), ['Area', 'Features', 'Count']);
  assert.equal(table.rows.length, 3);
  assert.deepEqual(table.rows[0].map(plain), ['Roles', 'roles.json', '3']);
  assert.deepEqual(table.rows[1].map(plain), ['Short', '', '']);
  assert.deepEqual(table.rows[2].map(plain), ['A', 'B', 'C']);
  assert.equal(table.rows[0][1][0].kind, 'code');
});

test('a table without outer pipes parses, an escaped pipe stays in its cell, and a mismatched delimiter is plain text', () => {
  const [table] = parseChatMarkdown('a | b\n--- | ---\n1 \\| 2 | 3');
  assert.equal(table.kind, 'table');
  assert.deepEqual(table.rows[0].map(plain), ['1 | 2', '3']);
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b']);
  const [text] = parseChatMarkdown('a | b | c\n--- | ---');
  assert.equal(text.kind, 'paragraph');
});

test('a table ends at a blank line and a paragraph may follow it', () => {
  const blocks = parseChatMarkdown('| a |\n|---|\n| 1 |\n\nafter');
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['table', 'paragraph'],
  );
});

test('lists nest, number from their start, and carry task boxes', () => {
  const [list] = parseChatMarkdown('3. three\n4. four\n   - nested a\n   - nested b\n5. five');
  assert.equal(list.kind, 'list');
  assert.equal(list.ordered, true);
  assert.equal(list.start, 3);
  assert.equal(list.items.length, 3);
  const nested = list.items[1].blocks.find((block) => block.kind === 'list');
  assert.equal(nested.ordered, false);
  assert.equal(nested.items.length, 2);
  const [tasks] = parseChatMarkdown('- [x] done\n- [ ] open\n- plain');
  assert.deepEqual(
    tasks.items.map((item) => item.task),
    ['checked', 'unchecked', undefined],
  );
  assert.equal(plain(tasks.items[0].blocks[0].inline), 'done');
});

test('a list may follow a line of text with no blank line, but "2." in a sentence does not start one', () => {
  assert.deepEqual(
    parseChatMarkdown('Steps:\n- one\n- two').map((block) => block.kind),
    ['paragraph', 'list'],
  );
  assert.deepEqual(
    parseChatMarkdown('see item\n2. below').map((block) => block.kind),
    ['paragraph'],
  );
});

test('headings keep their level, quotes hold blocks, rules are rules', () => {
  const blocks = parseChatMarkdown('# One\n\n###### Six\n\n> quoted\n> - item\n\n---\n\n* * *');
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['heading', 'heading', 'quote', 'rule', 'rule'],
  );
  assert.deepEqual([blocks[0].level, blocks[1].level], [1, 6]);
  assert.deepEqual(
    blocks[2].blocks.map((block) => block.kind),
    ['paragraph', 'list'],
  );
});

test('a fenced block keeps its language and text, and a fence still open is code to the end of the text', () => {
  const [closed] = parseChatMarkdown('```ts\nconst a = 1;\n```');
  assert.deepEqual({ kind: closed.kind, language: closed.language, text: closed.text }, { kind: 'code', language: 'ts', text: 'const a = 1;' });
  const [open] = parseChatMarkdown('```json\n{ "a":');
  assert.deepEqual({ kind: open.kind, language: open.language, text: open.text }, { kind: 'code', language: 'json', text: '{ "a":' });
  const [tilde] = parseChatMarkdown('~~~\n```\n~~~');
  assert.equal(tilde.text, '```');
});

test('inline: code, strong, emphasis, strike, escapes, and snake_case stays text', () => {
  const nodes = parseInline('a **b _c_** `d` ~~e~~ \\*f\\* snake_case_name', 0);
  assert.deepEqual(
    nodes.map((node) => node.kind),
    ['text', 'strong', 'text', 'code', 'text', 'strike', 'text'],
  );
  assert.equal(plain(nodes), 'a b c d e *f* snake_case_name');
  assert.equal(nodes[1].children[1].kind, 'emphasis');
  assert.equal(plain(parseInline('2 * 3 * 4', 0)), '2 * 3 * 4');
});

test('links open only on the web: http, https and mailto become links, a script or file target is plain text, bare URLs link', () => {
  const [web] = parseInline('[docs](https://example.com/a)', 0);
  assert.deepEqual({ kind: web.kind, href: web.href }, { kind: 'link', href: 'https://example.com/a' });
  assert.equal(
    parseInline('[x](javascript:alert(1))', 0).some((node) => node.kind === 'link'),
    false,
  );
  assert.equal(
    parseInline('[x](file:///etc/passwd)', 0).some((node) => node.kind === 'link'),
    false,
  );
  const bare = parseInline('see https://example.com/x, then', 0);
  assert.equal(bare[1].href, 'https://example.com/x');
  assert.equal(isSafeLink('data:text/html,hi'), false);
  assert.equal(isSafeLink('mailto:a@b.co'), true);
});

test('HTML in a reply is text, never a node', () => {
  const blocks = parseChatMarkdown('<img src=x onerror=alert(1)>\n\n<script>alert(1)</script>');
  assert.deepEqual(
    blocks.map((block) => block.kind),
    ['paragraph', 'paragraph'],
  );
  assert.equal(plain(blocks[0].inline), '<img src=x onerror=alert(1)>');
});

test('numbered options are quick replies only when the whole block is a gapless list from 1', () => {
  const replies = parseQuickReplies('1. Do X\n2. Do Y\n3. Leave it');
  assert.deepEqual(replies.map(quickReplyText), ['1. Do X', '2. Do Y', '3. Leave it']);
  assert.equal(parseQuickReplies('1) One\n2) Two')?.length, 2);
  assert.equal(parseQuickReplies('1. Only one'), undefined);
  assert.equal(parseQuickReplies('1. A\n3. B'), undefined);
  assert.equal(parseQuickReplies('2. A\n3. B'), undefined);
  assert.equal(parseQuickReplies('1. A\nplain line'), undefined);
  assert.equal(parseQuickReplies('- a\n- b'), undefined);
  assert.equal(parseQuickReplies(Array.from({ length: QUICK_REPLIES_MAX + 1 }, (_, index) => `${index + 1}. x`).join('\n')), undefined);
  assert.equal(parseQuickReplies(`1. ${'x'.repeat(200)}\n2. b`), undefined);
});

test('the bounds hold: text past the limit is cut, nesting past the depth bound is text, rows and columns are capped', () => {
  const long = parseChatMarkdown('a'.repeat(MARKDOWN_LIMITS.charsMax + 5000));
  assert.equal(plain(long[0].inline).length, MARKDOWN_LIMITS.charsMax);
  let depth = 0;
  // Walk the quotes by iteration: the parser's own depth is what is under test.
  let level = parseChatMarkdown(`${'> '.repeat(40)}deep`);
  for (; level.length > 0 && level[0].kind === 'quote' && depth <= MARKDOWN_LIMITS.depthMax + 2; depth++) {
    level = level[0].blocks;
  }
  assert.ok(depth <= MARKDOWN_LIMITS.depthMax, `nesting stopped at ${depth}`);
  const wide = `${Array.from({ length: 60 }, (_, index) => `c${index}`).join('|')}\n${Array.from({ length: 60 }, () => '---').join('|')}`;
  const rows = Array.from({ length: MARKDOWN_LIMITS.tableRowsMax + 50 }, () => 'x|y').join('\n');
  const [wideTable] = parseChatMarkdown(wide);
  assert.equal(wideTable.header.length, MARKDOWN_LIMITS.tableColumnsMax);
  const [tall] = parseChatMarkdown(`a|b\n-|-\n${rows}`);
  assert.equal(tall.rows.length, MARKDOWN_LIMITS.tableRowsMax);
  const items = parseChatMarkdown(Array.from({ length: MARKDOWN_LIMITS.listItemsMax + 20 }, () => '- x').join('\n'));
  assert.ok(items[0].items.length <= MARKDOWN_LIMITS.listItemsMax);
});

test('any text parses: random mixes of markup characters never throw and always make progress', () => {
  let seed = 12345;
  const next = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed;
  };
  const pieces = [
    '*',
    '_',
    '`',
    '```',
    '|',
    '-',
    '> ',
    '1. ',
    '- ',
    '# ',
    '[',
    ']',
    '(',
    ')',
    '\n',
    '\n\n',
    '  ',
    'a',
    'https://x.io',
    '~~',
    '\\',
    ':---:',
    '[x] ',
  ];
  for (let round = 0; round < 400; round++) {
    const text = Array.from({ length: 1 + (next() % 60) }, () => pieces[next() % pieces.length]).join('');
    assert.doesNotThrow(() => parseChatMarkdown(text), JSON.stringify(text));
  }
});
