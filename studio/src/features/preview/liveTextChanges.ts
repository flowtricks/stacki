import { assert } from '../../../vendor/stacki/shared/core/assert';
import { MAX_SOURCE } from '../../shared/validation';
import { flatten, type ParserNode } from '../source/source';

export interface TextSnapshot {
  readonly source: string;
  readonly nodes: readonly ParserNode[];
}

// Paths identify positions, not persistent nodes. Two reordered Button instances
// can have the same tree shape while their props and labels belong together.
// Only bypass Astro when every byte outside literal text regions is unchanged.
export function hasOnlyLiteralTextChanges(before: TextSnapshot, after: TextSnapshot): boolean {
  assert(before.source.length <= MAX_SOURCE, 'Live text: previous source stays bounded');
  assert(after.source.length <= MAX_SOURCE, 'Live text: next source stays bounded');
  const oldTexts = flatten(before.nodes).filter((node) => node.kind === 'text');
  const newTexts = flatten(after.nodes).filter((node) => node.kind === 'text');
  if (oldTexts.length !== newTexts.length) {
    return false;
  }
  let oldEnd = 0;
  let newEnd = 0;
  for (let index = 0; index < oldTexts.length; index++) {
    const oldNode = oldTexts[index];
    const newNode = newTexts[index];
    if (!oldNode || !newNode || oldNode.id !== newNode.id) {
      return false;
    }
    if (!hasRange(oldNode, oldEnd, before.source.length)) {
      return false;
    }
    if (!hasRange(newNode, newEnd, after.source.length)) {
      return false;
    }
    if (before.source.slice(oldEnd, oldNode.start) !== after.source.slice(newEnd, newNode.start)) {
      return false;
    }
    oldEnd = oldNode.end;
    newEnd = newNode.end;
  }
  return before.source.slice(oldEnd) === after.source.slice(newEnd);
}

function hasRange(
  node: ParserNode,
  previousEnd: number,
  length: number,
): node is ParserNode & { readonly start: number; readonly end: number } {
  return (
    typeof node.start === 'number' &&
    typeof node.end === 'number' &&
    Number.isSafeInteger(node.start) &&
    Number.isSafeInteger(node.end) &&
    node.start >= previousEnd &&
    node.end >= node.start &&
    node.end <= length
  );
}
