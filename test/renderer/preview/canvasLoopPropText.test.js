// Goal: prop text of a component rendered inside a loop (`posts.map(post => <Card heading={post.data.title} />)`) is marked on the
// canvas like any prop text. The report: such a Card's title, date and "Read it" label had no outline at all, because the planner
// skipped every instance inside a loop and so offered the frame nothing to mark. Each bound prop of a loop instance is now a
// blocked text (reason `loop`): dashed while the instance is selected, hovered with the refused look under the pointer, named by
// a double click, in every copy of the loop and in no other instance of the same component.
// Method: the real planner reads a page with loops and checks which props get an entry and with what (positive space: an
// expression prop in a loop; negative space: literals in a loop, props the instance does not set, a branch, an instance
// outside a loop, an expression the binding reader could resolve by name). Then a JSDOM frame with the real marks module
// draws three copies of a tilted card and one unrelated card, with boxes stubbed as the bounding boxes a 3D transform gives.
const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');

const dom = new JSDOM('<body></body>');
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter']) {
  global[name] = name === 'document' ? dom.window.document : name === 'window' ? dom.window : dom.window[name];
}
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { parseCanvasTextCatalog } = loadRenderer('shared/properties/canvasText.ts');

const ROOT = '/site';
const CARD = [
  '---',
  'import Heading from "@/components/typography/Heading.astro";',
  'const { heading, date } = Astro.props;',
  '---',
  '<div class="card"><Heading><Fragment set:html={heading} /></Heading><span class="date">{date}</span></div>',
].join('\n');
const FILES = {
  '/site/src/components/item/Card.astro': CARD,
  '/site/src/components/typography/Heading.astro': '---\nconst { tag: Tag = "h2" } = Astro.props;\n---\n<Tag><slot /></Tag>',
};
const field = (name) => ({ name, type: 'string', required: false });
const COMPONENTS = [
  { name: 'Card', path: '/site/src/components/item/Card.astro', origin: { kind: 'project' }, schema: [field('heading'), field('date')] },
  { name: 'Heading', path: '/site/src/components/typography/Heading.astro', origin: { kind: 'project' }, schema: [field('tag')] },
];
const IMPORT = 'import Card from "@/components/item/Card.astro";';

const parsed = (text) => parsePage(text, { locs: true }).model;
const page = (body, frontmatter = '') => ['---', IMPORT, frontmatter, '---', body].join('\n');

async function plan(source, bound) {
  const model = parsed(source);
  const tree = createTreeIndex(model.nodes);
  const document = { file: 'src/pages/index.astro', source, nodes: model.nodes, pathFor: (id) => tree.path(id) };
  const writes = [];
  const found = await canvasPropEdits(document, {
    projectPath: ROOT,
    file: '/site/src/pages/index.astro',
    nodes: model.nodes,
    imports: model.imports,
    components: COMPONENTS,
    label: 'Component text',
    relative: (file) => file.slice(ROOT.length + 1),
    read: async (file) => (FILES[file] === undefined ? undefined : parsed(FILES[file])),
    setProp: (nodeId, prop, value) => writes.push({ nodeId, prop, value }),
    ...(bound === undefined ? {} : { bound }),
  });
  return { found, writes };
}
const propsOf = (found) => found.map((entry) => entry.target.key.split(':')[2]).sort();

test('(b) a prop bound to loop data is a blocked text of its instance, marked like any prop text', async () => {
  const { found, writes } = await plan(page('{posts.map((post) => <Card heading={post.data.title} date={post.data.date} />)}'));
  assert.deepEqual(propsOf(found), ['date', 'heading']);
  for (const entry of found) {
    assert.equal(entry.target.from, 'prop');
    assert.ok(entry.target.scope, 'the instance is named, so the frame marks it while it is selected');
    assert.equal(entry.bound.kind, 'blocked');
    assert.equal(entry.bound.reason, 'loop');
    assert.match(entry.bound.expression, /^post\.data\./);
    await assert.rejects(entry.apply('Typed'), 'a loop text is never written');
  }
  assert.deepEqual(writes, [], 'no attribute is written for text every copy prints');
});

test('the binding reader is never asked about a loop variable: `post` is no module binding', async () => {
  const asked = [];
  const bound = async (expression) => {
    asked.push(expression);
    return { value: 'From a constant', bound: { kind: 'source', expression, file: '', uses: 1 }, apply: async () => undefined };
  };
  const { found } = await plan(page('{posts.map((post) => <Card heading={post.data.title} />)}', 'const post = "global";'), bound);
  assert.deepEqual(asked, []);
  assert.equal(found[0].bound.kind, 'blocked');
});

test('negative space: literals in a loop, props left unset, branches and plain instances', async () => {
  const literal = await plan(page('{[1, 2].map(() => <Card heading="Same" />)}'));
  assert.deepEqual(literal.found, [], 'one attribute would stand for every copy');
  const unset = await plan(page('{posts.map((post) => <Card heading={post.title} />)}'));
  assert.deepEqual(propsOf(unset.found), ['heading'], 'date is not set by the instance, so nothing is blocked for it');
  const branch = await plan(page('{show && <Card heading={title} />}', 'const title = "x";'));
  assert.deepEqual(branch.found, [], 'a branch is the page’s code, as before');
  const nested = await plan(page('{posts.map((post) => post.ok && <Card heading={post.title} />)}'));
  assert.deepEqual(propsOf(nested.found), ['heading'], 'a branch inside a loop is still a loop');
  const plain = await plan(page('<Card heading="Plain" />'));
  assert.equal(plain.found[0].bound, undefined, 'outside a loop a literal is edited as before');
});

test('the blocked list carries the instance, bounded and parsed', () => {
  const base = { type: 'avb:text-catalog', session: 's', file: 'f', checksum: 'a'.repeat(64), targets: [] };
  assert.equal(parseCanvasTextCatalog({ ...base, blocked: [{ key: 'k', path: 'p', scope: '0.1' }] }).blocked[0].scope, '0.1');
  assert.equal(parseCanvasTextCatalog({ ...base, blocked: [{ key: 'k', path: 'p' }] }).blocked[0].scope, undefined);
  assert.throws(() => parseCanvasTextCatalog({ ...base, blocked: [{ key: 'k', path: 'p', scope: 1 }] }));
});

// The page the frame draws: three copies of one loop instance (path 0.2.0) inside a tilted wrapper, whose boxes are the bounding
// boxes a 3D transform gives, and an unrelated Card (0.3) of the same component.
const copy = (index, top) =>
  `<div data-avb-p="Card.astro|0 0.2.0" data-box="0,${top},300,200">` +
  `<h3 data-avb-p="Heading.astro|0 Card.astro|0.0" data-box="10,${top + 10},280,40">Title ${index}</h3>` +
  `<span data-avb-p="Card.astro|0.1" data-box="10,${top + 60},120,24">Date ${index}</span></div>`;
const FRAME =
  `<div style="transform: perspective(800px) rotateX(10deg)">${copy(1, 0)}${copy(2, 300)}${copy(3, 600)}</div>` +
  '<div data-avb-p="Card.astro|0 0.3" data-box="400,0,300,200"><h3 data-avb-p="Heading.astro|0 Card.astro|0.0" data-box="410,10,280,40">Other</h3>' +
  '<span data-avb-p="Card.astro|0.1" data-box="410,60,120,24">Other date</span></div>';

const frame = new JSDOM(`<body>${FRAME}</body>`);
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment']) {
  global[name] = name === 'document' ? frame.window.document : name === 'window' ? frame.window : frame.window[name];
}
global.NodeFilter = frame.window.NodeFilter;
global.location = frame.window.location;
global.CSSStyleSheet = class {
  replaceSync() {}
};
frame.window.document.adoptedStyleSheets = [];
global.requestAnimationFrame = (run) => {
  run(0);
  return 0;
};
const boxOf = (element) => {
  const [left, top, width, height] = (element.getAttribute('data-box') ?? '0,0,0,0').split(',').map(Number);
  return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top };
};
frame.window.Element.prototype.getBoundingClientRect = function box() {
  return boxOf(this);
};
document.elementFromPoint = (x, y) => {
  const inside = [...document.querySelectorAll('[data-box]')].filter((element) => {
    const box = boxOf(element);
    return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
  });
  return inside.at(-1) ?? undefined;
};

const { installTextMarks, regions } = loadRenderer('test/helpers/frameTextEntry.js');
const headings = [...document.querySelectorAll('h3')];
const dates = [...document.querySelectorAll('span')];
regions.set(
  'Card.astro|0.0',
  headings.map((element) => [element.firstChild]),
);
regions.set(
  'Card.astro|0.1',
  dates.map((element) => [element.firstChild]),
);
let focus = new Set();
const posted = [];
const CATALOG = {
  type: 'avb:text-catalog',
  session: 's',
  file: 'f',
  checksum: 'c',
  targets: [],
  blocked: [
    { key: 'prop:n:heading:Card.astro|0.0', path: 'Card.astro|0.0', scope: '0.2.0' },
    { key: 'prop:n:date:Card.astro|0.1', path: 'Card.astro|0.1', scope: '0.2.0' },
  ],
};
const redraw = installTextMarks({
  catalog: () => CATALOG,
  editing: () => undefined,
  editingElement: () => undefined,
  focus: () => focus,
  visible: () => true,
  post: (message) => posted.push(message),
});
const layer = () => document.querySelector('[data-avb-text-marks]');
const move = (x, y) => window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));

test('(c, d) with the loop instance selected every copy’s bound texts are dashed, the unrelated Card’s are not', () => {
  focus = new Set(['0.2.0']);
  redraw();
  assert.equal(layer().children.length, 6, 'two texts in each of three copies');
  const lefts = [...layer().children].map((mark) => mark.style.top);
  assert.ok(lefts.includes('310px') && lefts.includes('610px'), 'the boxes are the transformed bounding boxes');
  assert.ok(![...layer().children].some((mark) => mark.style.left === '410px'), 'another instance of the component keeps no mark');
  assert.match(layer().children[0].style.border, /dashed/);
});

test('negative space: nothing selected, or another instance selected, draws no dashed mark', () => {
  for (const selected of [new Set(), new Set(['0.3']), new Set(['0.2'])]) {
    focus = selected;
    redraw();
    assert.equal(layer().children.length, 0, [...selected].join() || 'no selection');
  }
});

test('hovering a copy’s title reports the refused look in the component green path, and the dash gives way to it', () => {
  focus = new Set(['0.2.0']);
  move(50, 320);
  const hover = posted.at(-1).hover;
  assert.deepEqual([hover.kind, hover.x, hover.y, hover.w, hover.h], ['refused', 10, 310, 280, 40]);
  assert.equal(layer().children.length, 5, 'the hovered text is drawn by the app, the other five stay dashed');
});

test('hovering the unrelated Card’s title reports nothing', () => {
  focus = new Set();
  move(500, 20);
  assert.equal(posted.at(-1).hover, undefined);
});
