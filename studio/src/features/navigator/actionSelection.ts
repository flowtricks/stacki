import { selectionAfterDelete } from '../../../vendor/stacki/src/editor/treeSelection';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { flatten, parsePage, type Edit, type ParserNode, type TreeAction } from '../source/source';

// Parser IDs describe positions, so an insertion can change another person's
// selected ID too. Match surviving opening offsets through the actual source edits.
export function actionSelection(before: string, after: string, edits: readonly Edit[], action: TreeAction) {
  const previous = parsePage(before, { locs: true });
  const next = parsePage(after, { locs: true });
  if (!previous.editable || !next.editable) {
    throw new Error('The changed page could not be parsed.');
  }
  const oldNodes = flatten(previous.model.nodes);
  const newNodes = flatten(next.model.nodes);
  // Conditional branch wrappers share their source start with their first child.
  const nodesByStart = new Map(newNodes.map((node) => [`${node.kind}:${node.start}`, node]));
  const mapped = new Map<string, string>();
  for (const node of oldNodes) {
    const start = mappedOffset(node.start, edits);
    const survivor = start === undefined ? undefined : nodesByStart.get(`${node.kind}:${start}`);
    if (node.id && survivor?.id) {
      mapped.set(node.id, survivor.id);
    }
  }
  // A move relocates its node's bytes, and its label's with them (planTree.ts), so
  // the node is found by those bytes at the place they landed, not as the first new
  // node: that is the label comment, or a blank run the move's separator made.
  if (action.kind === 'move') {
    for (const [from, to] of relocatedIds(before, action.node, oldNodes, nodesByStart, edits)) {
      mapped.set(from, to);
    }
  }
  const survivingIds = new Set(mapped.values());
  const inserted = action.kind === 'move' ? '' : (newNodes.find((node) => node.id && !survivingIds.has(node.id))?.id ?? '');
  const fallback = action.kind === 'delete' ? selectionAfterDelete(parsePageModel(previous.model), action.node) : undefined;
  return (selected: string, ownAction: boolean) => {
    if (ownAction && action.kind === 'move') {
      // Whoever moves a node is working on it, wherever it lands, as on Desktop.
      return mapped.get(action.node) ?? mapped.get(selected) ?? '';
    }
    if (ownAction && action.kind !== 'delete') {
      return inserted || mapped.get(selected) || '';
    }
    if (selected === 'frontmatter' || !selected) {
      return selected;
    }
    return mapped.get(selected) ?? (fallback ? mapped.get(fallback) : undefined) ?? '';
  };
}

/** The moved node and everything inside it, old id to new: its source text found
 * once in exactly one edit's text, offset by the edits that land before that one. */
function relocatedIds(
  before: string,
  movedId: string,
  oldNodes: readonly ParserNode[],
  nodesByStart: ReadonlyMap<string, ParserNode>,
  edits: readonly Edit[],
): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  const moved = oldNodes.find((node) => node.id === movedId);
  if (moved?.start === undefined || moved.end === undefined) {
    return ids;
  }
  const original = before.slice(moved.start, moved.end);
  assert(original.length > 0, 'A moved node has source text');
  const carrying = edits.filter((edit) => {
    const at = edit.text.indexOf(original);
    return at >= 0 && edit.text.indexOf(original, at + 1) < 0;
  });
  const landing = carrying.length === 1 ? carrying[0] : undefined;
  if (landing === undefined) {
    return ids; // No single image of the node: nothing is claimed.
  }
  const shift = edits
    .filter((edit) => edit !== landing && edit.end <= landing.start)
    .reduce((total, edit) => total + edit.text.length - (edit.end - edit.start), 0);
  const delta = landing.start + shift + landing.text.indexOf(original) - moved.start;
  for (const node of oldNodes) {
    if (node.start === undefined || node.end === undefined || node.id === undefined) {
      continue;
    }
    if (moved.start <= node.start && node.end <= moved.end) {
      const survivor = nodesByStart.get(`${node.kind}:${node.start + delta}`);
      if (survivor?.id !== undefined) {
        ids.set(node.id, survivor.id);
      }
    }
  }
  assert(ids.size <= oldNodes.length, 'A move maps no more nodes than the page holds');
  return ids;
}

function mappedOffset(offset: number | undefined, edits: readonly Edit[]) {
  if (offset === undefined) {
    return undefined;
  }
  let shift = 0;
  for (const edit of edits) {
    if (edit.start <= offset && offset < edit.end) {
      return undefined;
    }
    if (edit.end <= offset) {
      shift += edit.text.length - (edit.end - edit.start);
    }
  }
  return offset + shift;
}
