// Goal: text a page prints from data (`{aiCallout1.body}`) is edited on the canvas by writing the words
// back to the string literal they come from, and never anywhere else. The regression this holds: only
// a bare `const title = "x"` once worked, so `{aiCallout1.body}` could not be double-click edited.
// Method: parse real Astro pages, trace each expression through the real resolver and edit planner
// over in-memory project files, and compare the bytes written: every byte but the literal is unchanged,
// the literal keeps its quote style, and undo (writing the old bytes back) restores the file exactly.
// Refusals, the multiple-use count, loop items, the frame contracts and a frame-level double click
// (a JSDOM session over the rendered markup) are checked the same way.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const bound = loadRenderer('src/editor/boundText.ts');
const { canvasBoundEdits, boundPropReader } = loadRenderer('src/app/model/canvasBoundText.ts');
const { parseCanvasTextCatalog, parseCanvasTextEvent } = loadRenderer('shared/properties/canvasText.ts');
const { parseCanvasTextOverlay } = loadRenderer('shared/properties/canvasTextOverlay.ts');

const PAGE = 'src/pages/index.astro';
const pathFor = (id) => id.replace(/^n/, '');
const WORDS = { saved: (path, file) => `Updated ${path} in ${file}`, undo: 'Undo', sourceChanged: 'changed' };

const CONTENT = [
  'export const aiCallout1 = {',
  "  body: 'It\\'s a \"quoted\" line',",
  '  note: `back`,',
  '  list: [{ t: "first" }, { t: "second" }],',
  '} as const satisfies Callout;',
  'export const joined = "a" + "b";',
  'export const called = make("x");',
  'export const holed = `hi ${name}`;',
  'export let mutable = "m";',
  'export { aiCallout1 as renamed };',
  '',
].join('\n');

function project(files) {
  const reads = [];
  return {
    reads,
    files,
    async readModule(fromFile, spec) {
      reads.push(spec);
      const file = files[spec];
      return file === undefined ? undefined : { file: file.file, text: file.text };
    },
  };
}

const PROJECT_FILES = () => ({
  '@lib/homepage/content': { file: 'src/lib/homepage/content.ts', text: CONTENT },
  './data.json': { file: 'src/pages/data.json', text: '{"hero": {"title": "Hi \\"x\\" é"}, "cards": ["one", "two"]}' },
  './more': { file: 'src/pages/more.ts', text: "export { aiCallout1 as again } from '@lib/homepage/content';\nexport default { word: 'def' };\n" },
});

const FRONT = [
  '---',
  "import { aiCallout1, joined, called, holed, mutable, renamed } from '@lib/homepage/content';",
  "import { again } from './more';",
  "import more from './more';",
  "import data from './data.json';",
  'const local = { a: { b: "loc" } };',
  '---',
  '',
].join('\n');

async function trace(expression, files = PROJECT_FILES()) {
  const host = project(files);
  return bound.resolveBoundText({ page: { file: PAGE, text: FRONT + '<p></p>' }, readModule: host.readModule }, expression);
}

test('a path through an imported object literal finds its string, quotes included', async () => {
  const found = await trace('aiCallout1.body');
  assert.equal(found.ok, true);
  assert.equal(found.site.file, 'src/lib/homepage/content.ts');
  assert.equal(found.site.value, 'It\'s a "quoted" line');
  assert.equal(found.site.quote, "'");
  assert.equal(CONTENT.slice(found.site.start, found.site.end), found.site.raw);
});

test('every way a module exports a value is followed to the literal', async () => {
  for (const [expression, file, value] of [
    ['aiCallout1.list[1].t', 'src/lib/homepage/content.ts', 'second'],
    ['aiCallout1.note', 'src/lib/homepage/content.ts', 'back'],
    ['renamed.list[0].t', 'src/lib/homepage/content.ts', 'first'],
    ['again.list[0].t', 'src/lib/homepage/content.ts', 'first'],
    ['more.word', 'src/pages/more.ts', 'def'],
    ['local.a.b', PAGE, 'loc'],
    ['data.hero.title', 'src/pages/data.json', 'Hi "x" é'],
    ['data.cards[1]', 'src/pages/data.json', 'two'],
  ]) {
    const found = await trace(expression);
    assert.equal(found.ok, true, expression);
    assert.equal(found.site.file, file, expression);
    assert.equal(found.site.value, value, expression);
  }
});

test('a rewrite changes only the literal, keeps its quote style and is undone by writing the old bytes', async () => {
  for (const [expression, typed, expected] of [
    ['aiCallout1.body', 'New "words" and it\'s here', "'New \"words\" and it\\'s here'"],
    ['aiCallout1.list[0].t', 'Line one\nLine two', '"Line one\\nLine two"'],
    ['aiCallout1.note', 'tick ` and ${dollar} and \\ slash', '`tick \\` and \\${dollar} and \\\\ slash`'],
  ]) {
    const found = await trace(expression);
    const next = bound.rewriteBoundText(CONTENT, found.site, typed);
    assert.equal(next, CONTENT.slice(0, found.site.start) + expected + CONTENT.slice(found.site.end), expression);
    assert.equal(bound.decodeStringLiteral(expected), typed, `${expression} reads back`);
    const again = await trace(expression, { ...PROJECT_FILES(), '@lib/homepage/content': { file: 'src/lib/homepage/content.ts', text: next } });
    assert.equal(again.site.value, typed, `${expression} traces again after the write`);
    const restored = bound.rewriteBoundText(next, again.site, found.site.value);
    assert.equal(restored, CONTENT, `${expression} undone byte for byte`);
  }
});

test('unicode, control characters and lone surrogates round trip through every quote', () => {
  for (const quote of ['"', "'", '`', 'json']) {
    for (const value of [
      'plain',
      'é — ✓ 日本語 😀',
      'tab\tand\r\nbreak',
      'nul\u0000 and   sep',
      'lone \ud800 surrogate',
      '${not a hole}',
      '\\n literal backslash n',
    ]) {
      const literal = bound.encodeStringLiteral(value, quote);
      assert.equal(bound.decodeStringLiteral(literal), value, `${quote} ${JSON.stringify(value)}`);
      if (quote === 'json') {
        assert.equal(JSON.parse(literal), value);
      }
    }
  }
  assert.equal(bound.decodeStringLiteral('"a\\u{1F600}b\\x41\\q"'), 'a😀bAq');
  assert.equal(bound.decodeStringLiteral('"bad\\1"'), undefined, 'a legacy octal escape is not read');
  assert.equal(bound.decodeStringLiteral('`has ${hole}`'), undefined);
});

test('a JSON file is rewritten with JSON escapes and double quotes', async () => {
  const files = PROJECT_FILES();
  const found = await trace('data.hero.title', files);
  const text = files['./data.json'].text;
  const next = bound.rewriteBoundText(text, found.site, 'Say "hi"\nnow');
  assert.equal(next, text.replace('"Hi \\"x\\" é"', '"Say \\"hi\\"\\nnow"'));
  assert.deepEqual(JSON.parse(next).hero, { title: 'Say "hi"\nnow' });
});

test('a value that is not one plain string is refused with the file to edit instead', async () => {
  for (const [expression, reason, file] of [
    ['joined', 'concatenation', 'src/lib/homepage/content.ts'],
    ['called', 'call', 'src/lib/homepage/content.ts'],
    ['holed', 'template', 'src/lib/homepage/content.ts'],
    ['mutable', 'mutable', 'src/lib/homepage/content.ts'],
    ['aiCallout1.list', 'not-text', 'src/lib/homepage/content.ts'],
    ['aiCallout1.nothing', 'missing', 'src/lib/homepage/content.ts'],
    ['aiCallout1.list[9].t', 'missing', 'src/lib/homepage/content.ts'],
    ['unknownThing.title', 'runtime', PAGE],
    ['Astro.props.title', 'prop', PAGE],
  ]) {
    const found = await trace(expression);
    assert.equal(found.ok, false, expression);
    assert.equal(found.block.reason, reason, expression);
    assert.equal(found.block.file, file, expression);
  }
  const split = await trace('aiCallout1.body', {
    ...PROJECT_FILES(),
    '@lib/homepage/content': { file: 'src/x.ts', text: 'export const aiCallout1 = { ...base, a: "x" };' },
  });
  assert.equal(split.block.reason, 'computed', 'a spread may supply the value');
  const code = [await trace('a + b'), await trace('format(a)'), await trace('`x ${y}`')];
  assert.deepEqual(
    code.map((entry) => entry.block.reason),
    ['concatenation', 'call', 'template'],
  );
  const package_ = await trace('aiCallout1.body', { ...PROJECT_FILES(), '@lib/homepage/content': undefined });
  assert.equal(package_.block.reason, 'unsupported');
});

test('a rewrite refuses a file that no longer holds the literal it traced', async () => {
  const found = await trace('aiCallout1.body');
  assert.equal(bound.rewriteBoundText(CONTENT.replace("'It\\'s", "'Edited"), found.site, 'x'), undefined);
});

// A page, its files and the host a canvas edit writes through.
async function edits(page, files = PROJECT_FILES(), host = {}) {
  const parsed = parsePage(page, { locs: true });
  assert.equal(parsed.editable, true);
  const writes = [];
  const applied = [];
  const document = {
    file: PAGE,
    projectPath: '/project',
    source: page,
    nodes: parsed.model.nodes,
    pathFor,
    apply: async (source, position) => applied.push({ source, position }),
    report: () => {},
    loadContent: async () => [],
  };
  const reading = project(files);
  const result = await canvasBoundEdits(
    document,
    {
      readModule: reading.readModule,
      readFile: async (file) => files[Object.keys(files).find((key) => files[key] !== undefined && files[key].file === file)]?.text,
      writeModule: async (write) => {
        writes.push(write);
        files[Object.keys(files).find((key) => files[key].file === write.file)].text = write.after;
      },
      undo: async () => {},
      ...host,
    },
    WORDS,
  );
  return { result, writes, applied, document };
}

test('text printed from an imported object is an edit that writes that module, with its source named', async () => {
  const { result, writes } = await edits(FRONT + '<p>{aiCallout1.body}</p>');
  assert.equal(result.length, 1);
  assert.deepEqual(result[0].bound, { kind: 'source', expression: 'aiCallout1.body', file: 'src/lib/homepage/content.ts', uses: 1 });
  assert.equal(result[0].target.value, 'It\'s a "quoted" line');
  await result[0].apply('Fresh words');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].before, CONTENT);
  assert.equal(writes[0].after, CONTENT.replace("'It\\'s a \"quoted\" line'", "'Fresh words'"));
});

test('text from the page frontmatter is one edit of the page, a single history step', async () => {
  const page = FRONT + '<h1>{local.a.b}</h1>';
  const { result, applied, writes } = await edits(page);
  assert.equal(result[0].bound.file, '', 'the page itself');
  await result[0].apply('Local words');
  assert.equal(writes.length, 0);
  assert.equal(applied.length, 1);
  assert.equal(applied[0].source, page.replace('"loc"', '"Local words"'));
});

test('a JSON value is edited in the JSON file', async () => {
  const { result, writes } = await edits(FRONT + '<h2>{data.hero.title}</h2>');
  assert.equal(result[0].bound.file, 'src/pages/data.json');
  await result[0].apply('Hello');
  assert.equal(JSON.parse(writes[0].after).hero.title, 'Hello');
  assert.equal(writes[0].before.replace('Hi \\"x\\" é', 'Hello'), writes[0].after);
});

test('the same literal used twice says so, and one write updates every use', async () => {
  const { result, writes } = await edits(FRONT + '<p>{aiCallout1.note}</p><footer>{aiCallout1.note}</footer><b>{aiCallout1.list[0].t}</b>');
  assert.deepEqual(
    result.map((edit) => edit.bound.uses),
    [2, 2, 1],
  );
  await result[0].apply('shared');
  assert.equal(writes.length, 1, 'the source is written once');
});

test('unchanged words write nothing', async () => {
  const { result, writes, applied } = await edits(FRONT + '<p>{aiCallout1.note}</p>');
  await result[0].apply('  back ');
  assert.equal(writes.length + applied.length, 0);
});

test('text that is computed is listed as blocked with the reason, and offers no write', async () => {
  const { result } = await edits(FRONT + '<p>{joined}</p><p>{called}</p><p>{holed}</p><p>{mutable}</p><p>{unknownThing.title}</p>');
  assert.deepEqual(
    result.map((edit) => [edit.bound.kind, edit.bound.reason]),
    [
      ['blocked', 'concatenation'],
      ['blocked', 'call'],
      ['blocked', 'template'],
      ['blocked', 'mutable'],
      ['blocked', 'runtime'],
    ],
    'a runtime value is refused by name too: no text is ever left silent',
  );
  assert.equal(result[0].bound.file, 'src/lib/homepage/content.ts');
  await assert.rejects(result[0].apply('x'));
});

test('a host that cannot write beside the page shows the text as not editable', async () => {
  const { result } = await edits(FRONT + '<p>{aiCallout1.note}</p>', PROJECT_FILES(), { writeModule: undefined });
  assert.equal(result[0].bound.kind, 'blocked');
});

test('a file changed since the page was traced is never overwritten', async () => {
  const files = PROJECT_FILES();
  const { result } = await edits(FRONT + '<p>{aiCallout1.note}</p>', files);
  files['@lib/homepage/content'].text = CONTENT.replace('`back`', '`changed elsewhere`');
  await assert.rejects(result[0].apply('mine'), /changed/);
});

test('each item of a loop over a list literal is its own edit, by the item the words come from', async () => {
  const page = '---\nconst cards = [{ title: "Alpha" }, { title: \'Beta\' }, { title: "Gamma" }];\n---\n' + '{cards.map((card) => (<h3>{card.title}</h3>))}';
  const { result, applied } = await edits(page);
  assert.deepEqual(
    result.map((edit) => edit.target.value),
    ['Alpha', 'Beta', 'Gamma'],
  );
  assert.deepEqual(
    result.map((edit) => edit.bound.expression),
    ['cards[0].title', 'cards[1].title', 'cards[2].title'],
  );
  assert.equal(new Set(result.map((edit) => edit.target.key)).size, 3, 'keys tell the items apart');
  await result[1].apply('Second');
  assert.equal(applied[0].source, page.replace("'Beta'", "'Second'"));
});

test('loop items spelled alike are not edited: the canvas could not tell which was meant', async () => {
  const page = '---\nconst cards = [{ title: "Same" }, { title: "Same" }, { title: "Other" }];\n---\n' + '{cards.map((card) => (<h3>{card.title}</h3>))}';
  const { result } = await edits(page);
  assert.deepEqual(
    result.filter((edit) => edit.bound.kind === 'source').map((edit) => edit.target.value),
    ['Other'],
  );
  assert.equal(result.find((edit) => edit.bound.kind === 'blocked').bound.reason, 'duplicate', 'the repeated items say why');
});

test('a loop over an imported list edits the right module item, nested loops included', async () => {
  const files = {
    '@lib/cards': {
      file: 'src/lib/cards.ts',
      text: 'export const groups = [{ name: "G1", cards: [{ t: "a1" }, { t: "a2" }] }, { name: "G2", cards: [{ t: "b1" }] }];\n',
    },
  };
  const page =
    "---\nimport { groups } from '@lib/cards';\n---\n" +
    '{groups.map((group) => (<section><h2>{group.name}</h2>{group.cards.map((card) => (<p>{card.t}</p>))}</section>))}';
  const { result, writes } = await edits(page, files);
  assert.deepEqual(
    result.map((edit) => edit.target.value),
    ['G1', 'G2', 'a1', 'a2', 'b1'],
  );
  const last = result.find((edit) => edit.target.value === 'b1');
  assert.equal(last.bound.expression, 'groups[1].cards[0].t');
  await last.apply('B-one');
  assert.equal(writes[0].after, files['@lib/cards'].text.replace('"b1"', '"B-one"'));
});

test('a loop over a computed list, and the same words in every pass, are refused by name', async () => {
  const page = '---\nconst cards = load();\nconst label = "Same";\n---\n{cards.map((card) => (<h3>{card.title}</h3>))}{[1, 2].map((n) => (<i>{label}</i>))}';
  const { result } = await edits(page);
  assert.deepEqual(
    result.map((edit) => [edit.bound.kind, edit.bound.reason]),
    [['blocked', 'call']],
  );
});

test('contracts: a blocked list, a refusal with its key and the editing box are bounded and parsed', () => {
  const catalog = { type: 'avb:text-catalog', session: 's', file: PAGE, checksum: 'a'.repeat(64), targets: [] };
  assert.deepEqual(parseCanvasTextCatalog({ ...catalog, blocked: [{ key: '0.1', path: '0.1' }] }).blocked, [{ key: '0.1', path: '0.1' }]);
  assert.equal(parseCanvasTextCatalog(catalog).blocked, undefined);
  assert.throws(() => parseCanvasTextCatalog({ ...catalog, blocked: Array.from({ length: 201 }, (_, index) => ({ key: `${index}`, path: `${index}` })) }));
  assert.throws(() => parseCanvasTextCatalog({ ...catalog, blocked: [{ key: 1, path: '0' }] }));
  assert.deepEqual(parseCanvasTextEvent({ type: 'avb:text-refused', message: 'm', reason: 'source-blocked', key: '0.1' }).key, '0.1');
  assert.equal(parseCanvasTextEvent({ type: 'avb:text-refused', message: 'm', reason: 'invented' }).reason, undefined);
  const active = { type: 'avb:text-active', session: 's', key: '0', rect: { x: 1, y: 2, w: 3, h: 4 } };
  assert.deepEqual(parseCanvasTextOverlay(active).rect, active.rect);
  assert.equal(parseCanvasTextOverlay({ ...active, rect: undefined }).rect, undefined);
  assert.throws(() => parseCanvasTextOverlay({ ...active, rect: { x: 1, y: 2, w: -3, h: 4 } }));
  assert.throws(() => parseCanvasTextOverlay({ ...active, rect: { x: 1, y: 2, w: 3 } }));
});

// The frame's side: a JSDOM page rendered as the preview renders it, the real session and hit test.
async function frame(html, run) {
  const dom = new JSDOM(`<!doctype html><body>${html}</body>`, { pretendToBeVisual: true });
  const { window } = dom;
  for (const name of ['HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter', 'AbortController', 'InputEvent', 'getComputedStyle']) {
    global[name] = window[name];
  }
  global.window = window;
  global.document = window.document;
  global.location = window.location;
  global.CSSStyleSheet = class {
    replaceSync() {}
  };
  window.Range.prototype.getBoundingClientRect = () => new window.DOMRect(0, 0, 10, 10);
  window.document.adoptedStyleSheets = [];
  window.document.caretRangeFromPoint = () => undefined;
  const entry = loadRenderer('test/helpers/frameTextEntry.js');
  const { createCanvasTextSession } = loadRenderer('electron/preload/frameTextSession.ts');
  const { matchCanvasText } = loadRenderer('electron/preload/frameTextMatch.ts');
  try {
    await run({ window, entry, createCanvasTextSession, matchCanvasText });
  } finally {
    window.close();
  }
}

test('frame: a double click on bound text opens its editor, and the save it posts is an edit of the source, not of the markup', async () => {
  const { result, writes, applied } = await edits(FRONT + '<p>{aiCallout1.note}</p>');
  const targets = result.map((edit) => edit.target);
  await frame('<p data-avb-p="0">back</p>', ({ window, entry, createCanvasTextSession, matchCanvasText }) => {
    const holder = window.document.querySelector('p');
    const catalog = { type: 'avb:text-catalog', session: 'one', file: PAGE, checksum: 'a'.repeat(64), targets };
    const hit = entry.findTextHit(catalog, { target: holder, clientX: 0, clientY: 0 });
    assert.equal(hit.target.key, targets[0].key, 'the double click lands on the bound text');
    const posted = [];
    const canvas = createCanvasTextSession((message) => posted.push(message));
    canvas.receive(catalog);
    canvas.open(hit.target, matchCanvasText(hit.target, holder), { clientX: 0, clientY: 0 });
    const active = posted.find((message) => message.type === 'avb:text-active');
    assert.equal(active.key, targets[0].key);
    assert.ok(active.rect, 'the box the source cue is anchored to');
    // What the editor does with the frame's save: the plan found by the key.
    const save = { type: 'avb:text-save', session: 'one', key: active.key, value: 'forward' };
    const plan = result.find((edit) => edit.target.key === save.key);
    return plan.apply(save.value).then(() => {
      assert.equal(applied.length, 0, 'the page markup is not edited');
      assert.equal(writes[0].after.includes('note: `forward`'), true);
    });
  });
});

test('frame: a double click on blocked text is refused by name instead of doing nothing', async () => {
  const { result } = await edits(FRONT + '<p>{joined}</p>');
  const blocked = result.filter((edit) => edit.bound.kind === 'blocked').map((edit) => ({ key: edit.target.key, path: edit.target.path }));
  assert.equal(blocked.length, 1);
  await frame('<!--avb-s:0--><p data-avb-p="0">ab</p><!--avb-e:0--><div id="away">x</div>', ({ window, entry }) => {
    entry.regions.set(blocked[0].path, [[window.document.querySelector('p').firstChild]]);
    const catalog = { type: 'avb:text-catalog', session: 's', file: PAGE, checksum: 'a'.repeat(64), targets: [], blocked };
    const posted = [];
    const click = (target) => {
      const event = new window.MouseEvent('dblclick', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'target', { value: target });
      entry.refuseBlockedText(catalog, event, (message) => posted.push(message));
      return event;
    };
    assert.equal(click(window.document.getElementById('away')).defaultPrevented, false, 'other elements are not refused');
    assert.equal(posted.length, 0);
    assert.equal(click(window.document.querySelector('p')).defaultPrevented, true);
    assert.deepEqual([posted[0].type, posted[0].reason, posted[0].key], ['avb:text-refused', 'source-blocked', blocked[0].key]);
  });
});

test('a prop the page binds (`body={aiCallout1.body}`) is followed to the string the component prints', async () => {
  const files = PROJECT_FILES();
  const { document } = await edits(FRONT + '<Card body={aiCallout1.body} />', files);
  const writes = [];
  const host = {
    readModule: project(files).readModule,
    readFile: async () => CONTENT,
    writeModule: async (write) => writes.push(write),
  };
  const read = boundPropReader(document, host, WORDS);
  const followed = await read('{aiCallout1.body}');
  assert.equal(followed.value, 'It\'s a "quoted" line');
  assert.deepEqual(followed.bound, { kind: 'source', expression: 'aiCallout1.body', file: 'src/lib/homepage/content.ts', uses: 1 });
  await followed.apply('From the card');
  assert.equal(writes[0].after.includes("body: 'From the card'"), true);
  assert.equal(await read('joined'), undefined, 'a joined value leads to no string to write');
  assert.equal(await read('compute(1)'), undefined);
});

// The shape of a real site: the page destructures its data from an awaited call to a function in another
// module, which picks its content by a literal argument and spreads a namespace import.
const CALLED = {
  '@lib/content': { file: 'src/lib/content/index.ts', text: 'export { getPage } from "./pages";\n' },
  './pages': {
    file: 'src/lib/content/pages.ts',
    text: [
      'import * as homeContent from "@lib/homepage/content";',
      'import * as otherContent from "@lib/other";',
      'export async function getPage(id: "home"): Promise<typeof homeContent>;',
      'export async function getPage(id: "other"): Promise<typeof otherContent>;',
      'export async function getPage(id: "home" | "other") {',
      '  if (id === "home") {',
      '    const document = await load(id);',
      '    return { ...homeContent, document };',
      '  }',
      '  return { ...otherContent, title: "Other" };',
      '}',
      '',
    ].join('\n'),
  },
  '@lib/homepage/content': {
    file: 'src/lib/homepage/content.ts',
    text: 'export const aiCallout1 = {\n  body: "Webflow’s platform — for humans & machines.",\n};\nexport const title = "Home";\n',
  },
  '@lib/other': { file: 'src/lib/other.ts', text: 'export const aiCallout1 = { body: "Not this one" };\n' },
};
const CALLED_PAGE = (call) =>
  `---\nimport { getPage } from "@lib/content";\nconst { aiCallout1, title, document } = await ${call};\n---\n<p>{aiCallout1.body}</p>`;

test('data destructured from an awaited call is followed into the function, by its literal argument', async () => {
  const { result, writes } = await edits(CALLED_PAGE('getPage("home")'), CALLED);
  assert.deepEqual(result[0].bound, { kind: 'source', expression: 'aiCallout1.body', file: 'src/lib/homepage/content.ts', uses: 1 });
  assert.equal(result[0].target.value, 'Webflow’s platform — for humans & machines.');
  await result[0].apply('Edited ’ words');
  assert.equal(writes[0].after.includes('body: "Edited ’ words"'), true);
  const other = await edits(CALLED_PAGE('getPage("other")'), CALLED);
  assert.equal(other.result[0].bound.file, 'src/lib/other.ts', 'the other argument reads the other module');
});

test('a call that cannot say which return it takes is refused, not guessed', async () => {
  const { result } = await edits(CALLED_PAGE('getPage(which)'), CALLED);
  assert.equal(result[0].bound.kind, 'blocked');
  assert.equal(result[0].bound.reason, 'ambiguous');
});

test('a namespace import is a module, not a default export', async () => {
  const files = { '@lib/n': { file: 'src/lib/n.ts', text: 'export const hero = { t: "Namespaced" };\nexport default { t: "Default" };\n' } };
  const { result } = await edits('---\nimport * as ns from "@lib/n";\nconst { hero } = ns;\n---\n<h1>{hero.t}</h1><h2>{ns.hero.t}</h2>', files);
  assert.deepEqual(
    result.map((edit) => edit.target.value),
    ['Namespaced', 'Namespaced'],
  );
});
