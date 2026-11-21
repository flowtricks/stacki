// Goal: a quick-insert pick shows on the canvas the moment it is made, as Desktop's palette does,
// and the stand-in agrees with what the server writes. Method: plan real picks over a real page
// parse, then apply the planned action with the server's own edit code and check that the node the
// stand-in names is the one the written page has at that place. Negative space: picks the canvas
// cannot predict get no stand-in, and a page that does not parse or an unknown component plans nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { planQuickInsert } from '../src/features/components/quickInsertPlan';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, parsePage, type ParserNode } from '../src/features/source/source';
import type { Project } from '../src/features/project/projectClient';

const source = '<main><h1>Title</h1><p>Body</p></main>\n';
const card: Project['components'][number] = { file: 'src/components/Card.astro', name: 'Card', fields: [], slots: [] };

function writtenNodeAt(after: string, trail: readonly number[]): ParserNode | undefined {
  const parsed = parsePage(after);
  assert.ok(parsed.editable, 'The written page parses');
  let list: readonly ParserNode[] = parsed.model.nodes;
  let node: ParserNode | undefined;
  for (const step of trail) {
    node = list[step];
    assert.ok(node, 'The stand-in names a place the written page has');
    list = 'children' in node && node.children !== undefined ? node.children : [];
  }
  return node;
}

for (const tag of ['div', 'p', 'h2', 'section']) {
  test(`a picked <${tag}> has a stand-in at the place the server writes it`, () => {
    const plan = planQuickInsert({ source, file: 'src/pages/index.astro', selected: 'n0.0', components: [], item: { type: 'element', tag } });
    assert.ok(plan, 'An editable page plans the pick');
    assert.ok(plan.standIn, 'A plain element is shown before the write');
    assert.equal(plan.standIn.node.kind, 'element');
    assert.equal(plan.standIn.node.kind === 'element' ? plan.standIn.node.tag : '', tag);
    const after = applyEdits(source, structuralEdits(source, plan.action, 'src/pages/index.astro'));
    const written = writtenNodeAt(after, [...plan.standIn.parent, plan.standIn.index]);
    assert.equal(written?.kind, 'element');
    assert.equal(written !== undefined && 'name' in written ? written.name : '', tag);
  });
}

test('a picked component stands in as its labelled block', () => {
  const plan = planQuickInsert({
    source,
    file: 'src/pages/index.astro',
    selected: 'n0',
    components: [card],
    item: { type: 'component', name: 'Card', path: card.file },
  });
  assert.ok(plan?.standIn);
  assert.deepEqual(plan.standIn.node, { kind: 'component', name: 'Card' });
  assert.equal(plan.action.kind, 'insert');
});

test('picks the canvas cannot predict write without a stand-in', () => {
  for (const type of ['text', 'comment', 'expr', 'map', 'cond', 'style', 'script'] as const) {
    const plan = planQuickInsert({ source, file: 'src/pages/index.astro', selected: 'n0.1', components: [], item: { type } });
    assert.ok(plan, `${type} still plans its write`);
    assert.equal(plan.standIn, undefined, `${type} has no stand-in`);
  }
});

test('an unknown component or a page that does not parse plans nothing', () => {
  assert.equal(
    planQuickInsert({ source, file: 'src/pages/index.astro', selected: 'n0', components: [], item: { type: 'component', name: 'Missing' } }),
    undefined,
  );
  assert.equal(
    planQuickInsert({ source: '<main><p>unclosed', file: 'src/pages/index.astro', selected: '', components: [], item: { type: 'element', tag: 'div' } }),
    undefined,
  );
});

test('an unknown element is refused at the boundary', () => {
  assert.throws(
    () => planQuickInsert({ source, file: 'src/pages/index.astro', selected: 'n0', components: [], item: { type: 'element', tag: 'not-a-tag' } }),
    /Invalid HTML element/,
  );
});
