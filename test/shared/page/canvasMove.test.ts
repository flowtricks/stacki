// Goal: a reorder the canvas shows ahead of the rebuilt page renumbers every path exactly
// as the rebuilt page will, lands beside the right sibling, and declines what it cannot
// show. Method: worked examples for each shape of move (forward and back in one list, a
// node with its note, across parents, into a later sibling whose index shifts), then a
// seeded property run: random trees and random drops, where moving the tree itself must
// put every node at the path `renumberedTrail` predicts. Then the negative space: drops
// that change nothing, anchors that are not elements, scopes of other files, and the
// boundary parser's refusals.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canvasMoveNodePath,
  movedTree,
  parseCanvasMove,
  planCanvasMove,
  renumberedCanvasPath,
  renumberedTrail,
  type CanvasMove,
  type CanvasMoveNode,
} from '#dist/shared/page/canvasMove.js';
import { LIMITS } from '#dist/shared/core/limits.js';

interface TestNode {
  readonly id: string;
  readonly kind: string;
  readonly children?: readonly TestNode[];
}

const element = (id: string, children?: readonly TestNode[]): TestNode =>
  children === undefined ? { id, kind: 'element' } : { id, kind: 'element', children };
const comment = (id: string): TestNode => ({ id, kind: 'comment' });
const text = (id: string): TestNode => ({ id, kind: 'text' });

// Paths by position, as the parse numbers them.
function pathsOf(roots: readonly CanvasMoveNode[]): Map<string, string> {
  const paths = new Map<string, string>();
  const walk = (list: readonly CanvasMoveNode[], prefix: string, depth: number): void => {
    assert.ok(depth <= LIMITS.treeDepthMax, 'test trees stay shallow');
    list.forEach((node, index) => {
      const path = prefix === '' ? String(index) : `${prefix}.${index}`;
      if (node.id !== undefined) {
        paths.set(node.id, path);
      }
      walk(node.children ?? [], path, depth + 1);
    });
  };
  walk(roots, '', 0);
  return paths;
}

const plan = (roots: readonly TestNode[], id: string, parentId: string | undefined, index: number): CanvasMove | undefined => {
  const paths = pathsOf(roots);
  return planCanvasMove(roots, id, { parentId, index }, (nodeId) => paths.get(nodeId));
};

const trail = (path: string): number[] => path.split('.').map(Number);

test('a node moved forward in its list renumbers the siblings it passed', () => {
  const roots = [element('a'), element('b', [element('b0')]), element('c'), element('d'), element('e')];
  const move = plan(roots, 'b', undefined, 4);
  assert.ok(move);
  assert.deepEqual(move.anchor, { path: [4], placement: 'before' });
  assert.deepEqual(renumberedTrail([1], move), [3]);
  assert.deepEqual(renumberedTrail([1, 0], move), [3, 0]);
  assert.deepEqual(renumberedTrail([2], move), [1]);
  assert.deepEqual(renumberedTrail([3], move), [2]);
  assert.deepEqual(renumberedTrail([0], move), [0]);
  assert.deepEqual(renumberedTrail([4], move), [4]);
});

test('a node moved back to the front renumbers the siblings it passed', () => {
  const roots = [element('a'), element('b'), element('c'), element('d'), element('e')];
  const move = plan(roots, 'd', undefined, 0);
  assert.ok(move);
  assert.deepEqual(move.anchor, { path: [0], placement: 'before' });
  assert.deepEqual(
    ['0', '1', '2', '3', '4'].map((path) => renumberedTrail(trail(path), move).join('.')),
    ['1', '2', '3', '0', '4'],
  );
});

test('a node travels with the comment that labels it', () => {
  const roots = [element('a'), comment('note'), element('b'), element('c'), element('d'), element('e')];
  const move = plan(roots, 'b', undefined, 5);
  assert.ok(move);
  assert.equal(move.count, 2);
  assert.deepEqual(move.from, [1]);
  assert.deepEqual(canvasMoveNodePath(move), [2]);
  assert.deepEqual(
    ['0', '1', '2', '3', '4', '5'].map((path) => renumberedTrail(trail(path), move).join('.')),
    ['0', '3', '4', '1', '2', '5'],
  );
});

test('a node moved into another parent renumbers both lists', () => {
  const roots = [element('p', [element('p0'), element('p1'), element('p2')]), element('q'), element('r', [element('r0'), element('r1', [element('r10')])])];
  const move = plan(roots, 'p1', 'r', 0);
  assert.ok(move);
  assert.deepEqual(renumberedTrail([0, 1], move), [2, 0]);
  assert.deepEqual(renumberedTrail([0, 2], move), [0, 1]);
  assert.deepEqual(renumberedTrail([2, 0], move), [2, 1]);
  assert.deepEqual(renumberedTrail([2, 1, 0], move), [2, 2, 0]);
  assert.deepEqual(renumberedTrail([1], move), [1]);
});

test('leaving the root list for a later parent shifts that parent too', () => {
  const roots = [element('a'), element('b'), element('c'), element('d', [element('d0')])];
  const move = plan(roots, 'b', 'd', 0);
  assert.ok(move);
  assert.deepEqual(move.parent, [3]);
  assert.deepEqual(renumberedTrail([1], move), [2, 0]);
  assert.deepEqual(renumberedTrail([3, 0], move), [2, 1]);
  assert.deepEqual(renumberedTrail([3], move), [2]);
  assert.deepEqual(renumberedTrail([2], move), [1]);
});

test('every node lands where renumbering says, over random trees and drops', () => {
  // mulberry32: integer arithmetic only, so the sequence is the same on every run.
  let seed = 7;
  const random = (limit: number): number => {
    seed = (seed + 0x6d2b79f5) | 0;
    let mixed = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return Math.floor((((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296) * limit);
  };
  let shown = 0;
  for (let run = 0; run < 1_000; run++) {
    let made = 0;
    const tree = (depth: number): TestNode[] => {
      assert.ok(depth <= LIMITS.treeDepthMax, 'test trees stay shallow');
      return Array.from({ length: 1 + random(4) }, () => {
        made += 1;
        const id = `n${made}`;
        const kind = random(6) === 0 ? 'comment' : 'element';
        return kind === 'comment' || depth > 2 || random(2) === 0 ? { id, kind } : element(id, tree(depth + 1));
      });
    };
    const roots = tree(0);
    const before = pathsOf(roots);
    const ids = [...before.keys()];
    const nodeId = ids[random(ids.length)] ?? 'n1';
    // A drop lands in a list: the root's, or a node that has children.
    const parents = [undefined, ...ids.filter((id) => (findNode(roots, id)?.children?.length ?? 0) > 0)];
    const parentId = parents[random(parents.length)];
    const parentPath = parentId === undefined ? undefined : before.get(parentId);
    const siblings = parentId === undefined ? roots.length : (findNode(roots, parentId)?.children?.length ?? 0);
    const move = plan(roots, nodeId, parentId, random(siblings + 1));
    if (move === undefined) {
      continue;
    }
    shown += 1;
    const moved = movedTree(roots, move, (node, children) => ({ ...node, children }));
    assert.ok(moved, `run ${run}: the tree moves`);
    const after = pathsOf(moved);
    assert.equal(after.size, before.size, `run ${run}: nothing is added or dropped`);
    for (const [id, path] of before) {
      assert.equal(renumberedTrail(trail(path), move).join('.'), after.get(id), `run ${run}: ${id} at ${path}, into ${parentPath ?? 'root'}`);
    }
    assert.equal(after.get(nodeId), renumberedTrail(canvasMoveNodePath(move), move).join('.'), `run ${run}: the node itself`);
  }
  assert.ok(shown > 300, 'Most random drops are shown moves');
});

function findNode(list: readonly TestNode[], id: string, depth = 0): TestNode | undefined {
  assert.ok(depth <= LIMITS.treeDepthMax, 'test trees stay shallow');
  for (const node of list) {
    if (node.id === id) {
      return node;
    }
    const inside = findNode(node.children ?? [], id, depth + 1);
    if (inside !== undefined) {
      return inside;
    }
  }
  return undefined;
}

test('a drop where the node already is changes nothing', () => {
  const roots = [element('a'), comment('note'), element('b'), element('c')];
  assert.equal(plan(roots, 'b', undefined, 1), undefined, 'above its note');
  assert.equal(plan(roots, 'b', undefined, 2), undefined, 'between its note and itself');
  assert.equal(plan(roots, 'b', undefined, 3), undefined, 'just after itself');
  assert.ok(plan(roots, 'b', undefined, 4), 'past its next sibling');
});

test('the anchor skips comments and refuses text beside the gap', () => {
  const roots = [element('a'), text('words'), element('b'), comment('loose'), element('c')];
  const pastComment = plan(roots, 'a', undefined, 3);
  assert.deepEqual(pastComment?.anchor, { path: [4], placement: 'before' }, 'a comment renders nothing to stand beside');
  assert.deepEqual(plan(roots, 'c', undefined, 1)?.anchor, { path: [0], placement: 'after' }, 'text after the gap: stand after the element before it');
  const between = [element('a'), text('t0'), text('t1'), element('b')];
  assert.equal(plan(between, 'a', undefined, 2), undefined, 'text on both sides of the gap: the render places it');
  const end = plan(roots, 'a', undefined, 5);
  assert.deepEqual(end?.anchor, { path: [4], placement: 'after' }, 'the end of a list stands after its last element');
});

test('a text node, a drop into itself, or a missing path is left to the rebuilt page', () => {
  const roots = [element('a', [element('a0')]), text('t'), element('b')];
  assert.equal(plan(roots, 't', undefined, 3), undefined, 'text has no element to move');
  assert.equal(plan(roots, 'a', 'a0', 0), undefined, 'into its own child');
  assert.equal(
    planCanvasMove(roots, 'a', { parentId: undefined, index: 3 }, () => undefined),
    undefined,
    'no canvas path',
  );
});

test('a scoped move renumbers only its own file', () => {
  const roots = [element('a'), element('b')];
  const paths = new Map([
    ['a', 'src/components/Card.astro|0'],
    ['b', 'src/components/Card.astro|1'],
  ]);
  const move = planCanvasMove(roots, 'b', { parentId: undefined, index: 0 }, (id) => paths.get(id));
  assert.ok(move);
  assert.equal(move.scope, 'src/components/Card.astro|');
  assert.equal(renumberedCanvasPath('src/components/Card.astro|0', move), 'src/components/Card.astro|1');
  assert.equal(renumberedCanvasPath('src/components/Card.astro|1.2', move), 'src/components/Card.astro|0.2');
  assert.equal(renumberedCanvasPath('0', move), '0', 'the page is another file');
  assert.equal(renumberedCanvasPath('src/components/Other.astro|0', move), 'src/components/Other.astro|0');
  const page = plan(roots, 'b', undefined, 0);
  assert.ok(page);
  assert.equal(renumberedCanvasPath('src/components/Card.astro|0', page), 'src/components/Card.astro|0', 'a page move leaves component paths');
  assert.equal(renumberedCanvasPath('1::before', page), '1::before', 'only node paths renumber');
});

test('the boundary parser accepts a planned move and refuses malformed ones', () => {
  const roots = [element('a'), element('b'), element('c')];
  const move = plan(roots, 'a', undefined, 3);
  assert.ok(move);
  assert.deepEqual(parseCanvasMove(JSON.parse(JSON.stringify(move))), move);
  const bad: readonly unknown[] = [
    undefined,
    'move',
    { ...move, scope: 'no-bar' },
    { ...move, count: 3 },
    { ...move, count: 0 },
    { ...move, index: -1 },
    { ...move, index: 1.5 },
    { ...move, from: [] },
    { ...move, from: ['0'] },
    { ...move, parent: [0], from: [0] },
    { ...move, anchor: { path: [1], placement: 'inside' } },
    { ...move, anchor: { path: [], placement: 'before' } },
    { ...move, from: Array.from({ length: 65 }, () => 0) },
  ];
  for (const input of bad) {
    assert.equal(parseCanvasMove(input), undefined, JSON.stringify(input));
  }
});
