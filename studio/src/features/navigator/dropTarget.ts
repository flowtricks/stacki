import type { DropLocation } from '../../../vendor/stacki/src/features/structure/structureModel';
import { flatten, type ParserNode } from '../source/source';

export function dropTarget(nodes: readonly ParserNode[], location: DropLocation) {
  const parent = location.parentId ? flatten(nodes).find((node) => node.id === location.parentId) : undefined;
  const siblings = parent ? (parent.children ?? []) : nodes;
  const next = siblings[location.index];
  if (next?.id) {
    return { target: next.id, placement: 'before' as const };
  }
  const last = siblings.at(-1);
  if (last?.id) {
    return { target: last.id, placement: 'after' as const };
  }
  if (parent?.id) {
    return { target: parent.id, placement: 'inside' as const };
  }
  return { target: '', placement: 'after' as const };
}
