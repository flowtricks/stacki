import { selectionAfterDelete } from '../../../vendor/stacki/src/editor/treeSelection';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import { flatten, parsePage, type Edit, type TreeAction } from '../source/source';

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
  const survivingIds = new Set(mapped.values());
  const inserted = newNodes.find((node) => node.id && !survivingIds.has(node.id))?.id ?? '';
  const fallback = action.kind === 'delete' ? selectionAfterDelete(parsePageModel(previous.model), action.node) : undefined;
  return (selected: string, ownAction: boolean) => {
    if (ownAction && action.kind !== 'delete') {
      return inserted || mapped.get(selected) || '';
    }
    if (selected === 'frontmatter' || !selected) {
      return selected;
    }
    return mapped.get(selected) ?? (fallback ? mapped.get(fallback) : undefined) ?? '';
  };
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
