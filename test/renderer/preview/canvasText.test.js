// Goal: canvas text edits preserve nested markup and bindings instead of flattening HTML.
// Method: parse real Astro sources, apply one witnessed text edit, and check exact bytes;
// exercise malformed frame contracts, ambiguous runtime DOM and collection ownership.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasTextPlans, applyCanvasText } = loadRenderer(
  'src/features/preview/canvasTextSource.ts',
);
const { canvasContentBinding } = loadRenderer('src/features/preview/canvasContentBinding.ts');
const { canvasDraftInline } = loadRenderer('src/features/props/canvasDraftInline.ts');
const { nodesToHtml, domToNodes } = loadRenderer('src/features/props/richContentModel.ts');
const { canvasTextDraft, clearCanvasTextDraft, canvasDraftValue, canvasTypedText } = loadRenderer(
  'src/ui/canvasTextDraft.ts',
);
const { parseCanvasTextOverlay, parseCanvasTextClose } = loadRenderer(
  'shared/properties/canvasTextOverlay.ts',
);
const { parseCanvasTextCatalog, parseCanvasTextEvent } = loadRenderer(
  'shared/properties/canvasText.ts',
);
const pathFor = (id) => id.replace(/^n/, '');
function plans(source) {
  const parsed = parsePage(source, { locs: true });
  assert.equal(parsed.editable, true);
  return canvasTextPlans(source, parsed.model.nodes, pathFor);
}
test('typing beside a span preserves its tag, attributes and separate text', () => {
  const source = '<p>Hello <span class="accent">world</span>!</p>';
  const edits = plans(source);
  assert.equal(edits.length, 3);
  assert.equal(
    applyCanvasText(source, edits[0], 'Goodbye '),
    '<p>Goodbye <span class="accent">world</span>!</p>',
  );
  const nested = edits.find((entry) => entry.target.value === 'world');
  assert.equal(nested.target.nested, true);
  assert.equal(
    applyCanvasText(source, nested, 'friend'),
    '<p>Hello <span class="accent">friend</span>!</p>',
  );
  assert.deepEqual(edits[0].target.siblings, ['0.1']);
});
test('typed markup and Astro expressions stay literal text', () => {
  const source = '<h1>Hello</h1>';
  const next = applyCanvasText(source, plans(source)[0], '<span>{secret}&</span>');
  assert.equal(next, '<h1>&lt;span&gt;&#123;secret&#125;&amp;&lt;/span&gt;</h1>');
  assert.equal(parsePage(next).editable, true);
});
test('component slot text keeps its component and authored children intact', () => {
  const source = '<Heading>Hello <span>world</span></Heading>';
  const edits = plans(source);
  assert.equal(edits[0].target.kind, 'component');
  assert.equal(
    applyCanvasText(source, edits[0], 'Goodbye '),
    '<Heading>Goodbye <span>world</span></Heading>',
  );
  matching('<h2 data-avb-p="0">Hello</h2>', '<Heading>Hello</Heading>', (match, targets) => {
    assert.equal(match(targets[0].target, document.querySelector('h2')).nodes[0].data, 'Hello');
  });
});
test('constant edits preserve expressions and warn about shared uses', () => {
  const source = '---\nconst title: string = "Hello";\n---\n<h1>{title}</h1><p>{title}</p>';
  const edits = plans(source);
  assert.equal(edits.length, 2);
  assert.match(edits[0].target.label, /Shared variable/);
  assert.equal(
    applyCanvasText(source, edits[0], 'Hi "there"'),
    source.replace('"Hello"', '"Hi \\"there\\""'),
  );
});
test('computed, mutable and shadowed variables are not flattened into literals', () => {
  for (const declaration of [
    'let title = "Hello";',
    'const title = makeTitle();',
    'const title = "Hello"; function another() { const title = "Other"; }',
  ]) {
    assert.equal(plans(`---\n${declaration}\n---\n<h1>{title}</h1>`).length, 0);
  }
  assert.equal(
    plans('---\nconst title = "Hello";\n---\n' + '{items.map(title => <h1>{title}</h1>)}').length,
    0,
  );
});
test('CMS identity comes from explicit getEntry ownership, never rendered text matching', () => {
  const source =
    '---\nimport { getEntry } from "astro:content";\n' +
    'const post = await getEntry("blog", "hello");\n---\n<h1>{post.data.title}</h1>';
  const node = parsePage(source, { locs: true }).model.nodes[0].children[0];
  assert.deepEqual(canvasContentBinding(source, node), {
    collection: 'blog',
    entry: 'hello',
    fields: ['title'],
  });
  assert.equal(
    canvasContentBinding(source.replace('astro:content', 'other:content'), node),
    undefined,
  );
});
test('frame contracts reject excessive text, missing protection and bad stamps', () => {
  const target = plans('<p>Hello</p>')[0].target;
  const catalog = {
    type: 'avb:text-catalog',
    session: 'one',
    file: 'src/pages/index.astro',
    checksum: 'a'.repeat(64),
    targets: [target],
  };
  assert.equal(parseCanvasTextCatalog(catalog).targets.length, 1);
  assert.throws(() => parseCanvasTextCatalog({ ...catalog, checksum: 'not-a-checksum' }));
  assert.throws(() =>
    parseCanvasTextCatalog({ ...catalog, targets: [{ ...target, kind: 'unknown' }] }),
  );
  assert.throws(() =>
    parseCanvasTextCatalog({ ...catalog, targets: [{ ...target, siblings: undefined }] }),
  );
  assert.throws(() =>
    parseCanvasTextEvent({
      type: 'avb:text-save',
      session: 'one',
      key: target.key,
      value: 'x'.repeat(10001),
    }),
  );
});
test('native editing state and close commands validate their boundary', () => {
  assert.deepEqual(
    parseCanvasTextOverlay({
      type: 'avb:text-active',
      session: 'one',
      key: '0',
    }),
    { type: 'avb:text-active', session: 'one', key: '0' },
  );
  assert.throws(() => parseCanvasTextOverlay({ type: 'avb:text-active', session: 1, key: '0' }));
  assert.throws(() => parseCanvasTextOverlay({ type: 'avb:text-active', session: 'one' }));
  assert.equal(
    parseCanvasTextClose({
      type: 'avb:text-close',
      session: 'one',
      action: 'cancel',
    }).action,
    'cancel',
  );
  assert.throws(() =>
    parseCanvasTextClose({
      type: 'avb:text-close',
      session: 'one',
      action: 'save-everything',
    }),
  );
});

test('live drafts validate strings and bounds just like final text saves', () => {
  const message = { type: 'avb:text-draft', session: 'one', key: '0.1', value: '' };
  assert.deepEqual(parseCanvasTextEvent(message), message);
  assert.equal(parseCanvasTextEvent({ ...message, value: 'x'.repeat(10000) }).value.length, 10000);
  for (const invalid of [
    { session: 42 },
    { key: undefined },
    { value: 42 },
    { value: 'x'.repeat(10001) },
  ]) {
    assert.throws(() => parseCanvasTextEvent({ ...message, ...invalid }));
  }
});

test('live Content projection preserves nested spans, bindings and its source witness', () => {
  const nodes = parsePage('<p>Hello <span class="accent">world</span>{title}</p>').model.nodes[0]
    .children;
  const original = nodesToHtml(nodes);
  const draft = {
    kind: 'text',
    session: 'one',
    projectPath: '/project',
    file: 'src/pages/index.astro',
    nodeID: nodes[0].id,
    sourceValue: nodes[0].value,
    value: 'Goodbye ',
  };
  assert.equal(canvasDraftValue(nodes[0], draft), 'Goodbye ');
  assert.equal(canvasDraftValue({ ...nodes[0], value: 'Other source' }, draft), 'Other source');
  assert.equal(
    nodesToHtml(canvasDraftInline(nodes, draft)),
    original.replace('Hello ', 'Goodbye '),
  );
  assert.equal(nodesToHtml(nodes), original);
  assert.equal(nodesToHtml(canvasDraftInline(nodes, { ...draft, sourceValue: 'stale' })), original);
  const nested = nodes[1].children[0];
  assert.match(
    nodesToHtml(
      canvasDraftInline(nodes, {
        ...draft,
        nodeID: nested.id,
        sourceValue: nested.value,
        value: 'friends',
      }),
    ),
    /<span class="accent">friends<\/span>/,
  );
  const expression = nodes[2];
  const html = nodesToHtml(
    canvasDraftInline(nodes, {
      ...draft,
      nodeID: expression.id,
      sourceValue: expression.value,
      value: '<New title>',
    }),
  );
  const document = new JSDOM(`<div>${html}</div>`).window.document;
  assert.equal(document.querySelector('.expr-chip').textContent, '<New title>');
  assert.equal(document.querySelector('.expr-chip').getAttribute('data-expr'), '{title}');
  assert.equal(domToNodes(document.querySelector('div'))[2].value, '{title}');
  canvasTextDraft.set(draft);
  clearCanvasTextDraft('different-session');
  assert.equal(canvasTextDraft.get(), draft);
  clearCanvasTextDraft('one');
  assert.equal(canvasTextDraft.get(), undefined);
});

function matching(html, source, run) {
  const dom = new JSDOM(html);
  const { window } = dom;
  for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
    global[name] =
      name === 'document' ? window.document : name === 'window' ? window : window[name];
  }
  const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');
  try {
    run(matchCanvasText, plans(source));
  } finally {
    dom.window.close();
  }
}
test('split animation wrappers can map to a single unchanged source text segment', () => {
  matching(
    '<h1 data-avb-p="0"><span>Hel</span><span>lo</span></h1>',
    '<h1>Hello</h1>',
    (match, targets) => {
      const result = match(targets[0].target, document.querySelector('span'));
      assert.equal(result.nodes.map((node) => node.data).join(''), 'Hello');
    },
  );
});
test('runtime text changes, duplicates and lost authored spans refuse fallback editing', () => {
  for (const html of [
    '<h1 data-avb-p="0"><span>Different</span></h1>',
    '<h1 data-avb-p="0">Hello<button>separator</button>Hello</h1>',
  ]) {
    matching(html, '<h1>Hello</h1>', (match, targets) => {
      assert.equal(match(targets[0].target, document.querySelector('h1')), undefined);
    });
  }
  matching(
    '<p data-avb-p="0">Hello</p>',
    '<p>Hello<span>protected</span></p>',
    (match, targets) => {
      assert.equal(match(targets[0].target, document.querySelector('p')), undefined);
    },
  );
});
test('clicking a protected child never edits a surrounding text segment', () => {
  matching(
    '<p data-avb-p="0">Hello <span data-avb-p="0.1">world</span></p>',
    '<p>Hello <span>world</span></p>',
    (match, targets) => {
      const span = document.querySelector('span');
      assert.equal(match(targets[0].target, span), undefined);
      const inner = targets.find((entry) => entry.target.value === 'world');
      assert.equal(match(inner.target, span).nodes[0].data, 'world');
    },
  );
});
test('component slot fallback crosses internal wrappers but preserves caller spans', () => {
  matching(
    '<div data-avb-p="0"><p data-avb-p="Eyebrow.astro|0.1">Hello</p></div>',
    '<Eyebrow>Hello</Eyebrow>',
    (match, targets) => {
      assert.equal(match(targets[0].target, document.querySelector('p')).nodes[0].data, 'Hello');
    },
  );
  matching(
    '<a data-avb-p="0"><span data-avb-p="Button.astro|0.1">Hello ' +
      '<span data-avb-p="0.1">world</span></span></a>',
    '<Button>Hello <span>world</span></Button>',
    (match, targets) => {
      assert.equal(match(targets[0].target, document.querySelector('a')).nodes[0].data, 'Hello ');
      assert.equal(
        match(targets[0].target, document.querySelector('[data-avb-p="0.1"]')),
        undefined,
      );
    },
  );
});

test('slot text passed through a wrapper matches inside the innermost instance element', () => {
  // A slider instance (0) tags its section and the section's container; its slot
  // text sits in a heading beside card text the component renders itself.
  const html =
    '<section data-avb-p="0 Section.astro|0"><div data-avb-p="0 Section.astro|0.0">' +
    '<h2 data-avb-p="Slider.astro|0.0">Hello</h2>' +
    '<p data-avb-p="Slider.astro|0.1">Card</p></div></section>';
  matching(html, '<Slider>Hello</Slider>', (match, targets) => {
    const result = match(targets[0].target, document.querySelector('h2'));
    assert.equal(result.nodes[0].data, 'Hello');
    assert.equal(result.element, document.querySelector('h2'), 'the words own the box');
    assert.equal(match(targets[0].target, document.querySelector('p')), undefined, 'not the card');
  });
  matching(html.replace('Card', 'Hello'), '<Slider>Hello</Slider>', (match, targets) => {
    assert.equal(
      match(targets[0].target, document.querySelector('section')),
      undefined,
      'the same words twice, clicked from outside both, stay ambiguous',
    );
  });
});

test('native text operations preserve spans and refuse external mutations', () => {
  const source = '<h1>Hello <span>world</span> again</h1>';
  matching(source, source, (matchText, targets) => {
    const root = document.querySelector('h1');
    const span = root.querySelector('span');
    const target = targets.find((plan) => plan.target.value === 'Hello ').target;
    // This fixture uses source paths just like the preload's marker fallback.
    root.setAttribute('data-avb-p', target.parent);
    span.setAttribute('data-avb-p', target.siblings[0]);
    const match = matchText(target, root);
    assert.ok(match);
    const { createTextBuffer } = loadRenderer('electron/preload/frameTextBuffer.ts');
    const drafts = [];
    const buffer = createTextBuffer(root, match.nodes, (value) => drafts.push(value));
    assert.ok(buffer);
    assert.throws(() => createTextBuffer(root, []), /requires a matched text node/);
    assert.throws(() => buffer.replace({ start: -1, end: 0 }, ''), /must not be negative/);
    buffer.replace({ start: 2, end: 2 }, 'X');
    assert.equal(root.textContent, 'HeXllo world again');
    assert.equal(root.querySelector('span'), span);
    buffer.history('undo');
    assert.equal(root.textContent, 'Hello world again');
    buffer.history('redo');
    assert.equal(root.textContent, 'HeXllo world again');
    buffer.replace({ start: 0, end: 0 }, 'x'.repeat(10001));
    assert.equal(root.textContent, 'HeXllo world again');
    assert.equal(buffer.restore(), true);
    match.nodes[0].data = 'External ';
    buffer.replace({ start: 0, end: 1 }, 'Unsafe');
    assert.equal(root.textContent, 'External world again');
    assert.equal(buffer.restore(), false);
    assert.deepEqual(drafts, ['HeXllo ', 'Hello ', 'HeXllo ']);
  });
});

test('native composition cannot introduce elements or remove authored children', () => {
  const source = '<p>Text</p>';
  matching(source, source, (matchText, targets) => {
    const root = document.querySelector('p');
    root.setAttribute('data-avb-p', targets[0].target.parent);
    const match = matchText(targets[0].target, root);
    const { createTextBuffer } = loadRenderer('electron/preload/frameTextBuffer.ts');
    const buffer = createTextBuffer(root, match.nodes);
    const original = root.firstChild;
    root.replaceChildren(document.createElement('br'));
    assert.equal(buffer.composition(), false);
    buffer.rollbackNative();
    assert.equal(root.firstChild, original);
    assert.equal(root.textContent, 'Text');
    assert.equal(buffer.restore(), true);
  });
});

test('typed text drops the template whitespace around a component slot', () => {
  // A Heading renders its slot inside indented template markup, so the one text
  // node the editor holds starts and ends with line breaks the source never had.
  const rendered = '\n        \n        Find hope. Live with purpose\n        \n      ';
  assert.equal(
    canvasTypedText('Find hope. Live with purpose!', rendered),
    'Find hope. Live with purpose',
  );
  assert.equal(
    canvasTypedText(' Spaced ', '\n  Spaced out \n'),
    ' Spaced out ',
    'source edges kept',
  );
  assert.equal(canvasTypedText('Words', '\n   \n'), '', 'deleting every word leaves nothing');
  assert.equal(
    canvasTypedText('Words', '\u00a0Words'),
    '\u00a0Words',
    'U+00A0 is a word character',
  );
  const draft = {
    kind: 'text',
    session: 's',
    projectPath: '/p',
    file: 'src/pages/index.astro',
    nodeID: 'n1',
    sourceValue: 'Find hope!',
    value: '\n      Find hope\n    ',
  };
  assert.equal(canvasDraftValue({ id: 'n1', value: 'Find hope!' }, draft), 'Find hope');
});
