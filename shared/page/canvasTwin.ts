// Finding, on the page being edited, a node the inserted one will render exactly like.
//
// Why: only the server can render a component, and that takes the write, the compile and the
// render. When the page already holds an instance written the same way (the same component, the
// same props, the same children, in the same file), the server has already rendered what the new
// one will show, so the canvas copies those elements and shows the real thing at once. Anything
// less than the same source is not a twin: the canvas never shows content that differs from what
// lands. A node inside a loop is never a twin, because what its expressions read there is the
// loop's item. Pure: it only reads the tree.

import { assert } from '../core/assert';
import { LIMITS } from '../core/limits';
import type { CanvasInsertSource, CanvasInsertTreeNode } from './canvasInsert';

/** Kinds whose source text says everything they render. A loop, a condition, a style or a script does not. */
const COMPARED_KINDS: ReadonlySet<string> = new Set(['element', 'component', 'text', 'expr']);

/** The id of the first node on the page written exactly as the component `source`, outside every loop. */
export function twinOf(roots: readonly CanvasInsertTreeNode[], source: CanvasInsertSource): string | undefined {
  const wanted = signatureOf(source);
  if (wanted === undefined) {
    return undefined;
  }
  const pending: (readonly CanvasInsertTreeNode[])[] = [roots];
  for (let visited = 0; visited < pending.length; visited += 1) {
    assert(visited < LIMITS.treeNodesMax, 'twinOf: a tree stays inside its node bound');
    const list = pending[visited];
    assert(list !== undefined, 'twinOf: the visit index lies inside the queue');
    for (const node of list) {
      if (node.kind === 'component' && node.name === source.name && node.id !== undefined) {
        if (signatureOf(node) === wanted) {
          return node.id;
        }
      }
      if (node.kind !== 'map' && node.children !== undefined) {
        pending.push(node.children);
      }
    }
  }
  return undefined;
}

// A node's rendering-relevant source as one string, ids and indentation left out; undefined when
// the subtree holds a kind that cannot be compared. Walks with its own stack, so depth costs no recursion.
function signatureOf(root: CanvasInsertSource): string | undefined {
  const parts: unknown[] = [];
  const pending: (CanvasInsertSource | 'close')[] = [root];
  for (let step = 0; pending.length > 0; step += 1) {
    assert(step <= LIMITS.treeNodesMax * 2, 'signatureOf: a tree stays inside its node bound');
    const node = pending.pop();
    assert(node !== undefined, 'signatureOf: the stack is not empty');
    if (node === 'close') {
      parts.push('close');
      continue;
    }
    if (!COMPARED_KINDS.has(node.kind)) {
      return undefined;
    }
    const props = Object.entries(node.props ?? {}).map(([name, attribute]) => [name, attribute.type, attribute.value ?? '']);
    // Attribute order changes nothing, except around a spread, which overrides what came before it.
    if (props.every(([, type]) => type !== 'spread')) {
      props.sort(([left = ''], [right = '']) => left.localeCompare(right));
    }
    parts.push([node.kind, node.name ?? '', collapsed(node.value), props]);
    pending.push('close');
    const children = (node.children ?? []).filter((child) => child.kind !== 'comment' && !(child.kind === 'text' && collapsed(child.value) === ''));
    pending.push(...[...children].reverse());
  }
  return JSON.stringify(parts);
}

// Indentation is not content: runs of white space read as one, and the ends as none.
function collapsed(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim();
}
