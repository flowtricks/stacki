// Goal: rich text and line breaks never lose or rewrite markup. The rich text editor opens only content it can give
// back unchanged in meaning, everything else shows as code; a code edit changes only the bytes between the tags; and
// words typed with breaks on the canvas are saved as `<br>` or as split paragraphs, inline formatting split with them.
// Method: decide the view for known-good rich text and each known-bad shape (components, expressions, comments,
// directives, unknown tags and attributes); convert editor HTML to nodes; rewrite an element's inner source against
// stale and self-closing cases; split real parsed pages' inline content in JSDOM; read which texts of a page get which
// Enter from component settings; check the frame contract's `breaks` and the line-end space a save drops.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { rendersHtml } = require('#dist/electron/parse/astroComponentApi.js');
const content = loadRenderer('src/features/props/richTextContent.ts');
const format = loadRenderer('src/app/model/canvasTextFormat.ts');
const canvasText = loadRenderer('shared/properties/canvasText.ts');

function withDocument(run) {
  const dom = new JSDOM('<!doctype html><body></body>');
  const saved = { document: global.document, window: global.window, Node: global.Node };
  Object.assign(global, { document: dom.window.document, window: dom.window, Node: dom.window.Node });
  try {
    return run(dom.window.document);
  } finally {
    Object.assign(global, saved);
  }
}

test('plain rich text opens in the editor, byte for byte', () => {
  withDocument((document) => {
    const html =
      '\n  <h2 class="title">Hello</h2>\n  <p>Body <strong>bold</strong> <a href="/x">link</a><br></p>\n  <ul><li>One</li></ul><img src="/a.png" alt="A"><video src="/v.mp4" controls></video>\n';
    assert.deepEqual(content.richTextView(html, document), { view: 'rich', html });
    assert.deepEqual(content.richTextView(undefined, document), { view: 'rich', html: '' });
  });
});

test('content the editor cannot give back opens as code, with the reason', () => {
  withDocument((document) => {
    const cases = [
      ['<p>{title}</p>', 'expression'],
      ['<p class={x}>a</p>', 'expression'],
      ['<Card>a</Card>', 'component'],
      ['<Icons.Star />', 'component'],
      ['<!-- note --><p>a</p>', 'markup'],
      ['<p set:html={x} />', 'expression'],
      ['<p class:list="a">a</p>', 'markup'],
      ['<slot />', 'markup'],
      ['<script>1</script>', 'markup'],
      ['<custom-el>a</custom-el>', 'markup'],
      ['<p onclick="x()">a</p>', 'markup'],
      ['<a href="javascript:alert(1)">a</a>', 'markup'],
      ['<p style="color:red">a</p>', 'markup'],
      ['<>a</>', 'markup'],
    ];
    for (const [source, reason] of cases) {
      assert.deepEqual(content.richTextView(source, document), { view: 'code', reason }, source);
    }
    assert.deepEqual(content.richTextView('x'.repeat(content.RICH_TEXT_SOURCE_CHARS_MAX + 1), document), { view: 'code', reason: 'size' });
  });
});

test('editor HTML becomes the nodes the panel writes, void tags closed', () => {
  withDocument((document) => {
    const nodes = content.richTextNodes('<p>a<br>b</p><hr><img src="/i.png" alt=""><video src="/v.mp4" controls=""></video>', document);
    assert.deepEqual(nodes, [
      {
        kind: 'element',
        name: 'p',
        props: {},
        children: [
          { kind: 'text', value: 'a' },
          { kind: 'element', name: 'br', props: {}, children: undefined },
          { kind: 'text', value: 'b' },
        ],
      },
      { kind: 'element', name: 'hr', props: {}, children: undefined },
      { kind: 'element', name: 'img', props: { src: { type: 'string', value: '/i.png' }, alt: { type: 'bare' } }, children: undefined },
      { kind: 'element', name: 'video', props: { src: { type: 'string', value: '/v.mp4' }, controls: { type: 'bare' } }, children: [] },
    ]);
  });
});

test('code writes only the bytes between the tags, and refuses a stale view', () => {
  const element = '<RichText class="a">\n  <p>Old</p>\n</RichText>';
  assert.equal(content.withInnerSource(element, { name: 'RichText', inner: '\n  <p>Old</p>\n' }, '<Card />'), '<RichText class="a"><Card /></RichText>');
  assert.equal(content.withInnerSource(element, { name: 'RichText', inner: '<p>Other</p>' }, 'x'), undefined);
  assert.equal(content.withInnerSource('<RichText />', { name: 'RichText', inner: '' }, '<p>a</p>'), '<RichText><p>a</p></RichText>');
  assert.equal(content.withInnerSource('<RichText />', { name: 'RichText', inner: '' }, ''), '<RichText />');
  assert.equal(content.withInnerSource('<RichText />', { name: 'RichText', inner: 'a' }, 'b'), undefined);
  assert.throws(() => content.withInnerSource(element, { name: '', inner: '' }, 'x'), /A tag with content has a name/);
});

test('line breaks replace typed newlines inside nested inline markup', () => {
  const children = [
    { kind: 'text', value: 'A ' },
    { kind: 'element', name: 'strong', props: {}, children: [{ kind: 'text', value: 'b\nc' }] },
  ];
  assert.deepEqual(format.withLineBreaks(children, [1, 0]), [
    { kind: 'text', value: 'A ' },
    {
      kind: 'element',
      name: 'strong',
      props: {},
      children: [
        { kind: 'text', value: 'b' },
        { kind: 'element', name: 'br', props: {}, children: undefined },
        { kind: 'text', value: 'c' },
      ],
    },
  ]);
  // A break at the end leaves the <br> and no empty text.
  assert.deepEqual(format.withLineBreaks([{ kind: 'text', value: 'end\n' }], [0]), [
    { kind: 'text', value: 'end' },
    { kind: 'element', name: 'br', props: {}, children: undefined },
  ]);
});

test('Enter in rich text splits a paragraph and its inline formatting', () => {
  const children = [
    { kind: 'text', value: 'One ' },
    { kind: 'element', name: 'em', props: {}, children: [{ kind: 'text', value: 'two\nthree\n' }] },
    { kind: 'text', value: ' four' },
  ];
  const blocks = format.paragraphsOf(children, [1, 0]);
  assert.deepEqual(blocks, [
    [
      { kind: 'text', value: 'One ' },
      { kind: 'element', name: 'em', props: {}, children: [{ kind: 'text', value: 'two' }] },
    ],
    [{ kind: 'element', name: 'em', props: {}, children: [{ kind: 'text', value: 'three' }] }],
    [{ kind: 'text', value: ' four' }],
  ]);
  assert.throws(() => format.splitInlineAt(children, [0, 0], 1), /A trail passes through elements/);
});

test('the page writes a split paragraph over the rich text slot, siblings kept', () => {
  withDocument(() => {
    const parsed = parsePage('---\nimport RichText from "../components/RichText.astro";\n---\n<RichText><h2>Title</h2><p>Hello world</p></RichText>\n', {
      locs: true,
    });
    assert.equal(parsed.editable, true);
    const nodes = parsed.model.nodes;
    const instance = nodes.find((node) => node.kind === 'component');
    const paragraph = instance.children.find((node) => node.name === 'p');
    const text = paragraph.children[0];
    let written;
    const formatter = format.canvasTextFormatter(nodes, (id, children) => {
      written = { id, children };
    });
    assert.equal(formatter.breaks(text.id, 'rich', 'Hello\nworld'), true);
    assert.equal(written.id, instance.id);
    assert.deepEqual(
      written.children.map((node) => [node.name, node.children.map((child) => child.value)]),
      [
        ['h2', ['Title']],
        ['p', ['Hello']],
        ['p', ['world']],
      ],
    );
    // A heading goes on as a paragraph.
    const heading = instance.children.find((node) => node.name === 'h2').children[0];
    assert.equal(formatter.breaks(heading.id, 'rich', 'Ti\ntle'), true);
    assert.deepEqual(
      written.children.slice(0, 2).map((node) => node.name),
      ['h2', 'p'],
    );
  });
});

test('a page reads which texts Enter breaks from its components’ settings, rich only for plain content', () => {
  withDocument(() => {
    const parsed = parsePage(
      '---\nimport P from "../components/P.astro";\nimport R from "../components/R.astro";\n---\n<P>Words <b>bold</b></P>\n<R><p>Rich</p><ul><li>Item</li></ul></R>\n<R><p>{x}</p></R>\n<div>Plain</div>\n',
      { locs: true },
    );
    const nodes = parsed.model.nodes;
    const settings = (node) => (node.name === 'P' ? { lineBreaks: true } : { richText: true });
    const byText = new Map();
    const stack = [...nodes];
    while (stack.length) {
      const node = stack.pop();
      if (node.kind === 'text') {
        byText.set(node.id, node.value.trim());
      }
      stack.push(...(node.children ?? []));
    }
    const breaks = format.canvasTextBreaksOf(nodes, (id) => id, settings);
    const kinds = Object.fromEntries([...breaks].map(([id, kind]) => [byText.get(id), kind]));
    const instance = nodes.find((node) => node.kind === 'component' && node.name === 'R');
    assert.deepEqual(kinds, {
      Words: { breaks: 'line' },
      bold: { breaks: 'line' },
      Rich: { breaks: 'rich', richRoot: instance.id },
      Item: { breaks: 'rich', richRoot: instance.id },
    });
    const unset = format.canvasTextBreaksOf(
      nodes,
      (id) => id,
      () => ({}),
    );
    assert.deepEqual(
      [...unset.keys()].map((id) => byText.get(id)),
      ['Rich'],
      "settings off: only a plain <p>'s words take a break, as every <p> does",
    );
  });
});

test('the frame contract carries what Enter types, and a save drops the line-end space', () => {
  const target = { kind: 'element', key: 'k', path: '0', parent: '0', value: 'a', label: 'p', nested: false, tag: 'p', siblings: [] };
  const catalog = (extra) =>
    canvasText.parseCanvasTextCatalog({ type: 'avb:text-catalog', session: 's', file: 'f', checksum: 'a'.repeat(64), targets: [{ ...target, ...extra }] });
  assert.equal(catalog({ breaks: 'line' }).targets[0].breaks, 'line');
  assert.equal(catalog({ breaks: 'rich' }).targets[0].breaks, 'rich');
  assert.equal('breaks' in catalog({}).targets[0], false);
  assert.throws(() => catalog({ breaks: 'paragraph' }), /what Enter types/);
  assert.throws(() => catalog({ breaks: true }), /what Enter types/);
  assert.equal(canvasText.canvasTextWithoutLineEnds(`a\n${canvasText.CANVAS_LINE_END}`), 'a\n');
  assert.equal(canvasText.canvasTextWithoutLineEnds(`a\n${canvasText.CANVAS_LINE_END}b\nc`), 'a\nb\nc');
});

test('set:html in a template, not in a comment or the frontmatter, qualifies a component', () => {
  assert.equal(rendersHtml('---\nconst { html } = Astro.props;\n---\n<div set:html={html} />'), true);
  assert.equal(rendersHtml('---\nconst s = "set:html={x}";\n---\n<div />'), false);
  assert.equal(rendersHtml('<!-- <div set:html={x} /> --><div />'), false);
  assert.equal(rendersHtml('<div><slot /></div>'), false);
});

test('the bytes between the tags are read past quoted and braced `>`, and refused when the text is not one element', () => {
  assert.equal(content.innerSourceOf('<RichText title="a > b" data={x > 1}>\n  <p>a</p>\n</RichText>'), '\n  <p>a</p>\n');
  assert.equal(content.innerSourceOf('<RichText />'), '');
  assert.equal(content.innerSourceOf('text'), undefined);
  assert.equal(content.innerSourceOf('<RichText'), undefined);
});

test('children stand for rich text only while they are plain markup', () => {
  const text = (value) => ({ kind: 'text', value });
  const element = (name, children, props = {}) => ({ kind: 'element', name, props, children });
  assert.equal(
    content.plainChildrenHTML([element('p', [text('a & b')], { class: { type: 'string', value: 'x"y' } }), element('br', undefined)]),
    '<p class="x&quot;y">a & b</p><br>',
  );
  assert.equal(content.plainChildrenHTML(undefined), '');
  assert.equal(content.plainChildrenHTML([element('p', [{ kind: 'expr', value: '{x}' }])]), undefined);
  assert.equal(content.plainChildrenHTML([{ kind: 'component', name: 'Card', children: [] }]), undefined);
  assert.equal(content.plainChildrenHTML([element('p', [], { class: { type: 'expr', value: 'x' } })]), undefined);
  assert.equal(content.plainChildrenHTML([{ kind: 'comment', value: 'x' }]), undefined);
});

test('a plain <p> takes line breaks by default, written over the paragraph and never over the layout around it', () => {
  withDocument(() => {
    const parsed = parsePage(
      '---\nimport Layout from "../layouts/Layout.astro";\n---\n<Layout>\n  <p class="lead">A <strong>bold</strong> word<br />Next</p>\n  <h2>Heading</h2>\n</Layout>\n',
      { locs: true },
    );
    const nodes = parsed.model.nodes;
    const layout = nodes.find((node) => node.kind === 'component');
    const paragraph = layout.children.find((node) => node.name === 'p');
    const heading = layout.children.find((node) => node.name === 'h2');
    const breaks = format.canvasTextBreaksOf(
      nodes,
      (id) => id,
      () => ({}),
    );
    const first = paragraph.children[0];
    const bold = paragraph.children[1].children[0];
    assert.deepEqual(breaks.get(first.id), { breaks: 'line' });
    assert.deepEqual(breaks.get(bold.id), { breaks: 'line' }, 'words inside inline markup too');
    assert.equal(breaks.get(heading.children[0].id), undefined, 'a heading keeps Enter finishing');
    let written;
    const formatter = format.canvasTextFormatter(nodes, (id, children) => {
      written = { id, children };
      return true;
    });
    const owner = formatter.contentOwner(first.id, 'line');
    const opened = [formatter.content(owner)];
    assert.equal(formatter.richText(owner, 'A <strong>bold</strong> word', opened), 'written');
    assert.equal(written.id, paragraph.id, 'the paragraph, not the layout');
    assert.deepEqual(
      written.children.map((node) => node.name ?? node.value),
      ['A ', 'strong', ' word'],
    );
    written = undefined;
    assert.equal(formatter.richText(owner, '<p>A</p><p>B</p>', opened), 'refused', 'blocks are never written into a line of words');
    assert.equal(written, undefined);
  });
});
