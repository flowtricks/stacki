import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { treeBudget, type TreeView } from './treeView';
// Tree questions the navigator and the editor both ask, kept apart from both
// so they can be reasoned about (and tested) on their own: which nodes get a
// row, and where the selection goes when one of them is deleted.

// Children the Content field fully covers: plain text and simple {expr}
// interpolations (single braces, no JSX). These get no navigator rows.
export function isContentOnlyChild(child: TreeView): boolean {
  return child.kind === 'text' || (child.kind === 'expr' && /^\{[^{}]*\}$/.test(child.value ?? '') && !(child.value ?? '').includes('<'));
}

/**
 * Whether the tree leaves a node's children to the Content field instead of
 * drawing rows for them.
 *
 * Only where there IS a Content field: an element or a component can be given
 * its words in the panel, which is why showing them twice is noise. A branch
 * cannot — its panel says what the branch is for and nothing else — so an
 * `else` holding `{heading}` drew as an empty row, with the value it renders
 * reachable from nowhere at all. Same for a condition and a loop.
 */
export function hidesChildRows(node: TreeView | undefined, kids: readonly TreeView[]): boolean {
  const covered = node?.kind === 'element' || node?.kind === 'component';
  return covered && kids.length > 0 && kids.every(isContentOnlyChild);
}

// Tags the serializer keeps on one line with the words around them.
const INLINE_TAGS = new Set(['strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br', 'small', 'mark', 'u', 's']);

// Whether a child list is written out as a single inline run. The serializer
// puts no markers inside one — each marker's own newlines would render as a
// space, which would move the words — so the page reports nothing about what
// is in there, and "this rendered nothing" is a question that can't be asked
// of it. Mirrors isInlineRun in the parser; the two have to agree, or a node
// nobody ever marked reads as a node that produced nothing.
export function isInlineRun(nodes: readonly TreeView[] | undefined): boolean {
  return isInlineRunWalk(nodes, 0, treeBudget());
}

function isInlineRunWalk(nodes: readonly TreeView[] | undefined, depth: number, visit: (depth: number) => void): boolean {
  assert(depth <= LIMITS.treeDepthMax, 'Tree traversal exceeds depth limit');
  if (!nodes?.length) {
    return false;
  }
  return nodes.every((node) => {
    visit(depth);
    if (isContentOnlyChild(node)) {
      return true;
    }
    if (node.kind !== 'element') {
      return false;
    }
    if (!INLINE_TAGS.has(String(node.name).toLowerCase())) {
      return false;
    }
    if (!node.children?.length) {
      return true;
    }
    return isInlineRunWalk(node.children, depth + 1, visit);
  });
}

// The comment sitting directly above `index` in its own sibling list — the
// note the navigator folds into that node's row. Moves and deletes carry it
// along: the two read as one row, so leaving it behind would silently re-attach
// someone else's note to whatever ends up next.
export function noteIndexAbove(list: readonly TreeView[], index: number): number {
  const previous = index > 0 ? list[index - 1] : undefined;
  return previous && previous.kind === 'comment' ? index - 1 : -1;
}

// Node plus the list it sits in and the node holding that list.
export function findWithParent(nodes: readonly TreeView[], id: string, parent?: TreeView): FoundNode | undefined {
  return findWithParentWalk(nodes, id, parent, 0, treeBudget());
}

interface FoundNode {
  readonly node: TreeView;
  readonly parent: TreeView | undefined;
  readonly siblings: readonly TreeView[];
  readonly index: number;
}
function findWithParentWalk(
  nodes: readonly TreeView[],
  id: string,
  parent: TreeView | undefined,
  depth: number,
  visit: (depth: number) => void,
): FoundNode | undefined {
  assert(depth <= LIMITS.treeDepthMax, 'Tree traversal exceeds depth limit');
  for (const [i, node] of nodes.entries()) {
    visit(depth);
    if (node.id === id) {
      return { node, parent, siblings: nodes, index: i };
    }
    if (node.children !== undefined) {
      const found = findWithParentWalk(node.children, id, node, depth + 1, visit);
      if (found) {
        return found;
      }
    }
  }
  return undefined;
}

// Where the selection lands when a node is deleted: the row below it, else the
// row above, else the parent. Deleting shouldn't drop you back to nothing —
// you're usually working in one part of the tree and about to act again, and
// the list carries on downward from the hole. Reckoned in navigator rows, not
// raw nodes: a comment folded into the row beneath it isn't somewhere the
// selection can go.
export function selectionAfterDelete(model: { readonly nodes: readonly TreeView[] }, nodeId: string): string | undefined {
  const found = findWithParent(model.nodes, nodeId);
  if (!found) {
    return undefined;
  }
  const { parent, siblings, index } = found;
  const gone = new Set([index]);
  const noteAt = noteIndexAbove(siblings, index); // the node's own note goes too
  if (noteAt !== -1) {
    gone.add(noteAt);
  }
  const rest = siblings.filter((_, i) => !gone.has(i));
  if (!rest.length) {
    return parent ? parent.id : undefined;
  }
  // Children that are all text or simple {expr} render no rows at all, so the
  // nearest thing to select is what held them.
  if (rest.every(isContentOnlyChild)) {
    return parent ? parent.id : undefined;
  }
  // Where the hole is, in the surviving list.
  const at = siblings.slice(0, index).filter((_, i) => !gone.has(i)).length;
  // Rows the selection can't land on: a comment folded into the row beneath
  // it, and the text and {expr} the Content field covers — including the
  // spaces that hold an inline run apart, which are text nodes like any other.
  const folded = (i: number): boolean => {
    const node = rest[i];
    assert(node !== undefined, 'Selection index must name a surviving node');
    return isContentOnlyChild(node) || (node.kind === 'comment' && (rest[i + 1]?.kind === 'element' || rest[i + 1]?.kind === 'component'));
  };
  for (let i = at; i < rest.length; i++) {
    if (!folded(i)) {
      return rest[i]?.id ?? undefined;
    }
  }
  for (let i = at - 1; i >= 0; i--) {
    if (!folded(i)) {
      return rest[i]?.id ?? undefined;
    }
  }
  return parent ? parent.id : undefined;
}

// A note is often written as a divider — `--------------- CTA` — which is a
// rule drawn in front of a label. The label is the part worth reading, so it
// is the part shown in the navigator and in the comments box.
//
// Nothing is thrown away: the rule is put back when the note is written, and
// kept to the same overall width, so a column of dividers stays lined up as
// labels of different lengths are typed into it.
const RULE = /^\s*([-=*_])\1{2,}\s*/;
const RULE_END = /\s*([-=*_])\1{2,}\s*$/;

export function noteText(raw: unknown): string {
  const full = String(raw ?? '').trim();
  const label = full.replace(RULE, '').replace(RULE_END, '').trim();
  // A rule with no label is decoration rather than a note. Shown as it is,
  // because showing nothing would invite clearing a field that looks empty and
  // taking the divider with it.
  return label || full;
}

export function noteValue(previous: unknown, text: unknown): string | undefined {
  const body = String(text ?? '').trim();
  if (!body) {
    return undefined;
  } // the caller removes the node
  const full = String(previous ?? '').trim();
  const lead = full.match(RULE);
  if (!lead) {
    return ` ${body} `;
  }
  const rule = lead[1];
  assert(rule !== undefined, 'Divider pattern must capture its character');
  const width = Math.max(3, full.length - body.length - 1);
  return ` ${rule.repeat(width)} ${body} `;
}
