// Goal: dragging an element into a loop in the Navigator moves its bytes into
// the loop's callback through the real edit engine, at every drop position the
// Navigator offers, and never ends in the "couldn't apply this edit" notice.
// The pages are the stats section the Loop settings wrote on a real project:
// an empty loop (`=> (null)`), which a first drop used to fail on, then a loop
// returning one card, then one returning two sibling cards (supported since
// 1.0.1). A loop whose callback is code (separate return sites) is refused by
// the Navigator's own drop rules before any request is made.
// Method: mount the app over a temporary Astro page, call the Navigator's
// onMoveNode with the DropLocation each drop position produces (a gap inside
// the loop, the loop's row, the item's row), let the save land, and compare
// the bytes on disk; then undo and check the page is restored exactly.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { gesture, mountApp, undo } = require('../../helpers/appGestures.js');
const { navigatorHostsDrop } = require('../../helpers/rendererModule')('src/features/structure/navigatorDrop.ts');

const FRONTMATTER = ['---', "import { getCollection } from 'astro:content';", "const statsEntries = await getCollection('stats'); // stacki:query", '---'];

const CARD = [
  '      <div class="stat_card_wrap" role="listitem">',
  '        <div class="stat_card_number text-style-h3">61.4%</div>',
  '        <h3 class="stat_card_heading text-style-h6">Uptime</h3>',
  '      </div>',
];

const ITEM = [
  '        <div class="stat_card_wrap" role="listitem">',
  '          <div class="stat_card_number text-style-h3">{item.data.number}</div>',
  '        </div>',
];

const SECOND = ['        <p class="stat_card_text">{item.data.text}</p>'];

// The section as pigeon's index.astro holds it: the loop first, then the
// static card the user drags.
function page(loopBody) {
  return [
    ...FRONTMATTER,
    '<section class="stat_wrap divider">',
    '  <div class="stat_contain container centered wide">',
    '    <div class="stat_layout" role="list">',
    '      {',
    '      statsEntries.map((item) => (',
    ...loopBody,
    '      ))',
    '    }',
    ...CARD,
    '    </div>',
    '  </div>',
    '</section>',
    '',
  ].join('\n');
}

// The same page once the card is in the loop: the card's own bytes, every
// line as it was written, between `=> (` and `))`.
function moved(loopBody) {
  return [
    ...FRONTMATTER,
    '<section class="stat_wrap divider">',
    '  <div class="stat_contain container centered wide">',
    '    <div class="stat_layout" role="list">',
    '      {',
    '      statsEntries.map((item) => (',
    ...loopBody,
    '      ))',
    '    }',
    '    </div>',
    '  </div>',
    '</section>',
    '',
  ].join('\n');
}

const cardText = CARD.join('\n').trimStart();

async function mounted(context, source, build) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-loop-drop-'));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src/pages'), { recursive: true });
  const file = path.join(root, 'src/pages/index.astro');
  fs.writeFileSync(file, source);
  const scan = { pages: [{ name: 'index.astro', path: file, route: '/' }], components: [], layouts: [], pageFolders: [] };
  const app = await mountApp(root, { scan }, build);
  context.after(app.unmount);
  return { app, disk: () => fs.readFileSync(file, 'utf8') };
}

// The stats layout's children as the Navigator lists them.
function layoutNodes() {
  const section = __panels.StructurePanel.pageState.model.nodes.find((node) => node.name === 'section');
  const contain = section.children.find((node) => node.name === 'div');
  const layout = contain.children.find((node) => node.name === 'div');
  const loop = layout.children.find((node) => node.kind === 'map');
  assert.ok(loop, 'the layout holds the loop');
  return { loop, card: layout.children.find((node) => node.name === 'div') };
}

const refused = () => document.body.textContent.includes('couldn’t apply this edit');

// One drop: the location the Navigator computes, the bytes it must leave, and
// Undo back to the page as written.
async function drop(context, { source, build, place, expected }) {
  const { app, disk } = await mounted(context, source, build);
  const { loop, card } = layoutNodes();
  assert.ok(card, 'the layout holds the static card');
  assert.equal(navigatorHostsDrop(loop), true, 'the Navigator offers drops into this loop');
  await gesture(app, () => __panels.StructurePanel.onMoveNode(card.id, place(loop)));
  assert.equal(refused(), false, 'the drop applies without an editor-error notice');
  assert.deepEqual(app.calls.edits, ['move-node'], 'the move is planned as a relocation, never a whole-page save');
  assert.equal(disk(), expected);
  const after = layoutNodes();
  assert.equal(after.card, undefined, 'the static card left the layout');
  assert.ok(
    after.loop.children.some((node) => node.name === 'div'),
    'the loop now holds a card',
  );
  await undo(app);
  assert.equal(disk(), source, 'Undo restores the page as written');
}

// The rows a drop into a loop can land on: the gaps inside its callback (the
// first and last), its own row, which appends, and its item's row.
const intoRow = (loop) => ({ parentId: loop.id, index: loop.children.length });
const firstGap = (loop) => ({ parentId: loop.id, index: 0 });
const lastGap = (loop) => ({ parentId: loop.id, index: loop.children.length });

const siblings = [...ITEM, ...SECOND];
const intoItem = ITEM.slice(0, 2).concat([`          ${cardText}`], ITEM.slice(2));
const itemRow = (loop) => {
  const item = loop.children.find((node) => node.name === 'div');
  return { parentId: item.id, index: item.children.length };
};
const middleGap = (loop) => ({ parentId: loop.id, index: loop.children.findIndex((node) => node.name === 'p') });

// Each case mounts its own app: one mounted app per test, as the other
// gesture suites do, so each test's cleanup unmounts the app it made.
const CASES = [
  { name: 'an empty loop: the dragged element becomes its item', body: ['        null'], place: intoRow, expected: [`        ${cardText}`] },
  { name: 'a loop of one element: before its item', body: ITEM, place: firstGap, expected: [`        ${cardText}`, ...ITEM] },
  { name: 'a loop of one element: after its item', body: ITEM, place: lastGap, expected: [...ITEM, `        ${cardText}`] },
  { name: 'a loop of one element: onto the loop row', body: ITEM, place: intoRow, expected: [...ITEM, `        ${cardText}`] },
  { name: 'a loop of one element: onto its item row, inside the item', body: ITEM, place: itemRow, expected: intoItem },
  { name: 'a loop of sibling elements: before them', body: siblings, place: firstGap, expected: [`        ${cardText}`, ...siblings] },
  { name: 'a loop of sibling elements: between them', body: siblings, place: middleGap, expected: [...ITEM, `        ${cardText}`, ...SECOND] },
  { name: 'a loop of sibling elements: onto the loop row', body: siblings, place: intoRow, expected: [...siblings, `        ${cardText}`] },
];

for (const [index, entry] of CASES.entries()) {
  test(`drop into ${entry.name}`, async (context) => {
    await drop(context, { source: page(entry.body), build: `navigator-loop-drop-${index}`, place: entry.place, expected: moved(entry.expected) });
  });
}

test('the Navigator offers no drop inside a loop whose callback is code', () => {
  // A block body returns each root from its own site (bodyParts); drops go
  // inside its elements. A loop written as markup, empty or not, takes them.
  const callback = {
    kind: 'map',
    id: 'n0',
    head: 'items.map((item) => {',
    bodyParts: ['{ return (', '); }'],
    children: [{ kind: 'element', id: 'n0.0', name: 'li', children: [] }],
  };
  assert.equal(navigatorHostsDrop(callback), false);
  assert.equal(navigatorHostsDrop(callback.children[0]), true, 'its elements still take drops');
  assert.equal(navigatorHostsDrop({ kind: 'map', id: 'n1', head: 'items.map((item) => (', children: [] }), true);
  assert.equal(navigatorHostsDrop({ kind: 'text', id: 'n2', value: 'x' }), false);
});
