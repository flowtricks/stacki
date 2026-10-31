// Goal: Sanity rich text survives a round trip through Stacki's rich text field — paragraphs,
// headings, lists, bold, italic and links come back as the same Portable Text, and members the
// HTML cannot show (an image block) are kept rather than lost on save.
// Method: Portable Text shaped like a real document is turned into HTML and read back in JSDOM
// with a counting key maker, so keys are predictable; then edited HTML is read on its own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { portableTextHTML, htmlPortableText } = loadRenderer('src/features/cms/portableText.ts');

const { document } = new JSDOM('').window;
function keys() {
  let count = 0;
  return () => `k${(count += 1)}`;
}

const TEXT = [
  {
    _type: 'block',
    _key: 'a',
    style: 'normal',
    markDefs: [{ _type: 'link', _key: 'l1', href: 'https://thechurch.fm' }],
    children: [
      { _type: 'span', _key: 's1', text: 'Come ', marks: [] },
      { _type: 'span', _key: 's2', text: 'as you are', marks: ['strong'] },
      { _type: 'span', _key: 's3', text: ' & visit', marks: ['l1'] },
    ],
  },
  {
    _type: 'block',
    _key: 'b',
    style: 'h2',
    markDefs: [],
    children: [{ _type: 'span', text: 'Times', marks: ['em'] }],
  },
  {
    _type: 'block',
    _key: 'c',
    style: 'normal',
    listItem: 'bullet',
    level: 1,
    markDefs: [],
    children: [{ _type: 'span', text: 'Sunday', marks: [] }],
  },
  {
    _type: 'block',
    _key: 'd',
    style: 'normal',
    listItem: 'bullet',
    level: 1,
    markDefs: [],
    children: [{ _type: 'span', text: 'Wednesday', marks: [] }],
  },
  { _type: 'image', _key: 'img', asset: { _type: 'reference', _ref: 'image-1' } },
];

test('Portable Text becomes HTML, with lists gathered and text escaped', () => {
  assert.equal(
    portableTextHTML(TEXT),
    '<p>Come <strong>as you are</strong><a href="https://thechurch.fm"> &amp; visit</a></p>' +
      '<h2><em>Times</em></h2><ul><li>Sunday</li><li>Wednesday</li></ul>',
  );
  assert.equal(portableTextHTML(undefined), '');
});

test('the HTML reads back as the same blocks, marks and links, keeping the image', () => {
  const back = htmlPortableText(portableTextHTML(TEXT), TEXT, { document, key: keys() });
  const link = back[0].markDefs[0]._key;
  const shape = back.map((block) => [
    block._type,
    block.style,
    block.listItem,
    (block.children ?? []).map((child) => [child.text, child.marks.join('+')]),
  ]);
  assert.deepEqual(shape, [
    [
      'block',
      'normal',
      undefined,
      [
        ['Come ', ''],
        ['as you are', 'strong'],
        [' & visit', link],
      ],
    ],
    ['block', 'h2', undefined, [['Times', 'em']]],
    ['block', 'normal', 'bullet', [['Sunday', '']]],
    ['block', 'normal', 'bullet', [['Wednesday', '']]],
    ['image', undefined, undefined, []],
  ]);
  assert.deepEqual(back[0].markDefs, [{ _type: 'link', _key: link, href: 'https://thechurch.fm' }]);
  assert.equal(back[4]._key, 'img', 'the image block is kept as it was');
});

test('loose text becomes a paragraph; numbered lists and line breaks are kept', () => {
  const back = htmlPortableText('Hello<ol><li>One<br>two</li></ol>', undefined, {
    document,
    key: keys(),
  });
  assert.equal(back.length, 2);
  assert.equal(back[0].children[0].text, 'Hello');
  assert.equal(back[1].listItem, 'number');
  assert.deepEqual(
    back[1].children.map((child) => child.text),
    ['One', '\n', 'two'],
  );
  const empty = htmlPortableText('<p></p>', undefined, { document, key: keys() });
  assert.equal(empty[0].children[0].text, '', 'an emptied paragraph keeps one empty span');
});
