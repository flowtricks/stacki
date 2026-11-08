// Goal: the reorder the canvas and the Navigator show before the server answers is the
// reorder the server writes. Every path the canvas renumbers must name, in the source the
// server's planner produces, the same node it named before; the Navigator's moved tree
// must be that source's tree; and the touch drag's own decisions (hold or scroll, how
// fast the list scrolls at its edge) hold their bounds.
// Method: a page whose every element carries a unique id, moved by the drops the
// Navigator makes (forward, back, with a labelling comment, into another parent and out
// of one), each planned twice: by the canvas (planCanvasMove over the parse) and by the
// server (dropTarget then structuralEdits, then a fresh parse). Then the pure touch
// helpers at and around their thresholds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { dropTarget } from '../src/features/navigator/dropTarget';
import { pathFor } from '../src/features/project/previewSelection';
import { structuralEdits } from '../src/features/source/sourceOperations';
import { applyEdits, flatten, parsePage, type ParserNode } from '../src/features/source/source';
import { movedTree, planCanvasMove, renumberedCanvasPath } from '../vendor/stacki/shared/page/canvasMove';
import { TOUCH_TREE, autoScrollStep, pressOutcome } from '../src/features/navigator/useTouchTree';

const FILE = 'src/pages/index.astro';
const SOURCE = `<main id="main">
  <h1 id="title">Title</h1>
  <!-- Lead -->
  <p id="lead">Lead</p>
  <section id="box">
    <p id="inner">Inner</p>
    <span id="tail">Tail</span>
  </section>
  <footer id="foot">Foot</footer>
</main>
<aside id="side"><b id="bold">B</b></aside>
`;

function nodesOf(source: string): readonly ParserNode[] {
  const parsed = parsePage(source, { locs: true });
  assert.ok(parsed.editable, 'the page parses');
  return parsed.model.nodes;
}

function idOf(node: ParserNode): string | undefined {
  const value = node.props?.['id'];
  return value?.type === 'string' ? value.value : undefined;
}

// Each element's canvas path, by the id it carries.
function pathsById(nodes: readonly ParserNode[]): Map<string, string> {
  const paths = new Map<string, string>();
  for (const node of flatten(nodes)) {
    const id = idOf(node);
    if (id !== undefined && node.id !== undefined) {
      paths.set(id, pathFor(node.id));
    }
  }
  return paths;
}

function nodeIdOf(nodes: readonly ParserNode[], id: string): string {
  const node = flatten(nodes).find((candidate) => idOf(candidate) === id);
  assert.ok(node?.id, `#${id} is in the page`);
  return node.id;
}

// What the order check reads of a node; the Navigator's moved copy keeps the rest.
interface LooseNode {
  readonly kind: string;
  readonly value?: string | undefined;
  readonly props?: ParserNode['props'];
  readonly children?: readonly LooseNode[] | undefined;
}

// Every node in document order, by kind and id (or text), iteratively.
function order(roots: readonly LooseNode[]): string[] {
  const out: string[] = [];
  const pending: LooseNode[] = [...roots].reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    assert.ok(visited < 10_000, 'the test page is small');
    const node = pending.pop();
    if (node === undefined) {
      break;
    }
    const id = node.props?.['id'];
    out.push(`${node.kind}:${id?.type === 'string' ? id.value : (node.value?.trim() ?? '')}`);
    pending.push(...[...(node.children ?? [])].reverse());
  }
  return out;
}

const DROPS = [
  { moved: 'title', parent: 'main', index: 5, what: 'forward past its siblings' },
  { moved: 'foot', parent: 'main', index: 0, what: 'back to the front' },
  { moved: 'lead', parent: 'main', index: 0, what: 'with the comment that labels it' },
  { moved: 'lead', parent: 'box', index: 1, what: 'into another parent' },
  { moved: 'inner', parent: 'main', index: 5, what: 'out of its parent, after it' },
  { moved: 'bold', parent: 'main', index: 1, what: 'into an earlier tree' },
  { moved: 'title', parent: undefined, index: 2, what: 'to the root list' },
] as const;

for (const drop of DROPS) {
  test(`a drop ${drop.what} renumbers the canvas as the server writes it`, () => {
    const nodes = nodesOf(SOURCE);
    const location = { parentId: drop.parent === undefined ? undefined : nodeIdOf(nodes, drop.parent), index: drop.index };
    const nodeId = nodeIdOf(nodes, drop.moved);
    const move = planCanvasMove(nodes, nodeId, location, pathFor);
    assert.ok(move, 'the canvas can show this move');
    const action = { kind: 'move' as const, node: nodeId, ...dropTarget(nodes, location) };
    const written = applyEdits(SOURCE, structuralEdits(SOURCE, action, FILE));
    const after = pathsById(nodesOf(written));
    for (const [id, path] of pathsById(nodes)) {
      assert.equal(renumberedCanvasPath(path, move), after.get(id), `#${id} at ${path}`);
    }
    const loose: readonly LooseNode[] = nodes;
    const shown = movedTree(loose, move, (node, children) => ({ ...node, children }));
    assert.ok(shown, 'the Navigator can show this move');
    assert.deepEqual(order(shown), order(nodesOf(written)), 'the Navigator shows the order the server writes');
  });
}

test('a press held still is a hold; travel past the slop is the list scrolling', () => {
  const start = { x: 100, y: 200 };
  assert.equal(pressOutcome(start, { x: 100 + TOUCH_TREE.slopPx, y: 200 }), 'holding');
  assert.equal(pressOutcome(start, { x: 100, y: 200 + TOUCH_TREE.slopPx + 1 }), 'scrolling');
  assert.equal(pressOutcome(start, { x: 106, y: 206 }), 'scrolling', 'diagonal travel counts');
  assert.throws(() => pressOutcome(start, { x: Number.NaN, y: 0 }), /the finger has a position/);
});

test('the list scrolls only near its edges, faster the closer the finger, never past its cap', () => {
  const list = { top: 100, bottom: 700 };
  assert.equal(autoScrollStep({ ...list, y: 400 }), 0, 'the middle stays still');
  assert.equal(autoScrollStep({ ...list, y: 100 + TOUCH_TREE.edgePx }), 0, 'the band edge is still');
  assert.ok(autoScrollStep({ ...list, y: 110 }) < 0, 'near the top scrolls up');
  assert.ok(autoScrollStep({ ...list, y: 690 }) > 0, 'near the bottom scrolls down');
  assert.ok(Math.abs(autoScrollStep({ ...list, y: 101 })) > Math.abs(autoScrollStep({ ...list, y: 140 })), 'deeper is faster');
  assert.equal(autoScrollStep({ ...list, y: 0 }), -TOUCH_TREE.scrollPxPerFrameMax, 'past the edge is the cap');
  assert.equal(autoScrollStep({ ...list, y: 900 }), TOUCH_TREE.scrollPxPerFrameMax);
  assert.equal(autoScrollStep({ top: 100, bottom: 101, y: 100 }), 0, 'a list too short for a band never scrolls');
  assert.throws(() => autoScrollStep({ top: 200, bottom: 100, y: 150 }), /top above its bottom/);
});
