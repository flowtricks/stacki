// Goal: Stacki Apps' `node.insert` in Studio becomes the quick insert's own
// structural action, at the selection or at the place the app named, and a place
// that cannot hold the node (or a tag Studio's insert contract lacks) is refused
// with the reason instead of inserting somewhere else.
// Method: planStudioInsert (src/features/apps/studioAppInsert.ts) over a small
// page's text, with the node ids the parser gives it; the actions are compared
// whole, since they are exactly what the shared document sends to the server.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { insertedNodeId, planStudioInsert } from '../src/features/apps/studioAppInsert';
import { actionSelection } from '../src/features/navigator/actionSelection';
import { applyEdits, flatten, parsePage } from '../src/features/source/source';
import { structuralEdits } from '../src/features/source/sourceOperations';

const TEXT = '---\n---\n<section><h1>Title</h1></section>\n<p>Copy</p>\n';
const card = { file: 'src/components/Card.astro', name: 'Card', fields: [], slots: [] };
const project = { components: [card] };

function ids(): { readonly section: string; readonly heading: string; readonly paragraph: string } {
  const parsed = parsePage(TEXT, { locs: true });
  assert.ok(parsed.editable);
  const [section, paragraph] = parsed.model.nodes.filter((node) => node.kind === 'element');
  const heading = section?.children?.[0];
  assert.ok(section?.id !== undefined && heading?.id !== undefined && paragraph?.id !== undefined);
  return { section: section.id, heading: heading.id, paragraph: paragraph.id };
}

const page = (selected = '') => ({ file: 'src/pages/index.astro', text: TEXT, selected });
const div = { kind: 'element', tag: 'div', attributes: {} } as const;

test('an element goes in at a named place as the quick insert’s action', () => {
  const { section, heading, paragraph } = ids();
  assert.deepEqual(planStudioInsert(page(), project, { item: div, place: { kind: 'before', anchor: paragraph } }), {
    kind: 'action',
    action: { kind: 'insert-content', target: paragraph, placement: 'before', content: { type: 'element', tag: 'div' } },
  });
  assert.deepEqual(planStudioInsert(page(), project, { item: div, place: { kind: 'inside', anchor: section, index: 0 } }), {
    kind: 'action',
    action: { kind: 'insert-content', target: heading, placement: 'before', content: { type: 'element', tag: 'div' } },
  });
  assert.deepEqual(planStudioInsert(page(), project, { item: div, place: { kind: 'inside', anchor: section, index: undefined } }), {
    kind: 'action',
    action: { kind: 'insert-content', target: heading, placement: 'after', content: { type: 'element', tag: 'div' } },
  });
});

test('a component goes in at the selection, as a palette pick does', () => {
  const { paragraph } = ids();
  const plan = planStudioInsert(page(paragraph), project, { item: { kind: 'component', name: 'Card', props: {} }, place: { kind: 'selection' } });
  assert.equal(plan.kind, 'action');
  assert.equal(plan.action.kind, 'insert');
  assert.deepEqual(plan.action, {
    kind: 'insert',
    // The palette's rule: a selection that can hold the node takes it, last.
    target: `${paragraph}.0`,
    placement: 'after',
    name: 'Card',
    importPath: '../components/Card.astro',
    paired: false,
  });
});

test('a place that cannot hold the node, an unknown anchor and a tag Studio lacks are refused', () => {
  const { section, paragraph } = ids();
  const refused = (plan: ReturnType<typeof planStudioInsert>): string => (plan.kind === 'refused' ? plan.reason : '');
  assert.match(
    refused(planStudioInsert(page(), project, { item: div, place: { kind: 'inside', anchor: paragraph, index: undefined } })),
    /cannot hold a <div>/,
  );
  assert.match(refused(planStudioInsert(page(), project, { item: div, place: { kind: 'after', anchor: 'n99' } })), /No element has that id/);
  assert.match(refused(planStudioInsert(page(), project, { item: div, place: { kind: 'inside', anchor: section, index: 5 } })), /past the anchor/);
  const custom = { kind: 'element', tag: 'my-widget', attributes: {} } as const;
  assert.match(refused(planStudioInsert(page(), project, { item: custom, place: { kind: 'selection' } })), /Stacki Desktop/);
  const missing = { kind: 'component', name: 'Nope', props: {} } as const;
  assert.match(refused(planStudioInsert(page(), project, { item: missing, place: { kind: 'selection' } })), /no component named Nope/);
});

// The server's own pipeline (rooms.ts applyAction): the action's edits, then the selection it
// gives the client that sent it. The id node.insert answers is that selection, checked.
function inserted(item: Parameters<typeof planStudioInsert>[2]['item'], place: Parameters<typeof planStudioInsert>[2]['place']) {
  const plan = planStudioInsert(page(), project, { item, place });
  assert.equal(plan.kind, 'action');
  const edits = structuralEdits(TEXT, plan.action, 'src/pages/index.astro');
  const after = applyEdits(TEXT, edits);
  const selected = actionSelection(TEXT, after, edits, plan.action)('', true);
  const parsed = parsePage(after, { locs: true });
  assert.ok(parsed.editable);
  return { nodeId: insertedNodeId(after, selected, item), nodes: flatten(parsed.model.nodes) };
}

test('the id an insert answers names the new node on the changed page', () => {
  const { section, paragraph } = ids();
  const p = { kind: 'element', tag: 'p', attributes: {} } as const;
  const atIndex = inserted(p, { kind: 'inside', anchor: section, index: 0 });
  assert.equal(atIndex.nodeId, `${section}.0`, 'inside, at index 0: the section’s first child');
  assert.equal(atIndex.nodes.find((node) => node.id === atIndex.nodeId)?.name, 'p');
  const before = inserted(div, { kind: 'before', anchor: paragraph });
  const node = before.nodes.find((candidate) => candidate.id === before.nodeId);
  assert.equal(node?.name, 'div');
  assert.ok(node?.children?.length === 0 || node?.children === undefined, 'the new, empty div, not the paragraph that moved along');
  // A selection that is not what was inserted is no id at all.
  assert.equal(insertedNodeId(TEXT, paragraph, div), undefined);
  assert.equal(insertedNodeId(TEXT, '', div), undefined);
});
