// The one rule for which comment labels a node. The Navigator folds such a
// comment into the row beneath it ("Section / Hero"), and the planner carries it
// with that node wherever the node goes: moved, removed or duplicated. Both read
// this module, so a comment the Navigator shows as a label never stays behind as
// an orphan row, and a comment it shows as a row of its own is never taken along.
//
// The rule: a comment labels the sibling written directly after it, whatever
// whitespace (a blank line included) lies between them, when that sibling is an
// element or a component. Only the one nearest comment labels; a comment above
// it is a row of its own. A comment followed by text, an expression, another
// comment, a loop or a condition, or by nothing, labels nothing and stays put.
import { assert } from '../core/assert';

/** The kinds a label can belong to. Kinds are compared as strings because the
 * Navigator's tree view types its kinds loosely; an unknown kind labels nothing. */
const LABELLED_KINDS: ReadonlySet<string> = new Set(['element', 'component']);

/** Whether a node of kind `noteKind`, written directly before a sibling of kind
 * `nodeKind` with only whitespace between them, is that sibling's label. */
export function labelsNode(noteKind: string, nodeKind: string): boolean {
  assert(noteKind.length > 0, 'labelsNode: a note has a kind');
  assert(nodeKind.length > 0, 'labelsNode: a node has a kind');
  if (noteKind === 'comment') {
    return LABELLED_KINDS.has(nodeKind);
  }
  return false;
}
