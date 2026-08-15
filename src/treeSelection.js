// Tree questions the navigator and the editor both ask, kept apart from both
// so they can be reasoned about (and tested) on their own: which nodes get a
// row, and where the selection goes when one of them is deleted.

// Children the Content field fully covers: plain text and simple {expr}
// interpolations (single braces, no JSX). These get no navigator rows.
export function isContentOnlyChild(c) {
  return (
    c.kind === 'text' ||
    (c.kind === 'expr' && /^\{[^{}]*\}$/.test(c.value) && !c.value.includes('<'))
  );
}

// The comment sitting directly above `index` in its own sibling list — the
// note the navigator folds into that node's row. Moves and deletes carry it
// along: the two read as one row, so leaving it behind would silently re-attach
// someone else's note to whatever ends up next.
export function noteIndexAbove(list, index) {
  const prev = index > 0 ? list[index - 1] : null;
  return prev && prev.kind === 'comment' ? index - 1 : -1;
}

// Node plus the list it sits in and the node holding that list.
export function findWithParent(nodes, id, parent = null) {
  for (const [i, n] of nodes.entries()) {
    if (n.id === id) return { node: n, parent, siblings: nodes, index: i };
    if (Array.isArray(n.children)) {
      const found = findWithParent(n.children, id, n);
      if (found) return found;
    }
  }
  return null;
}

// Where the selection lands when a node is deleted: the row below it, else the
// row above, else the parent. Deleting shouldn't drop you back to nothing —
// you're usually working in one part of the tree and about to act again, and
// the list carries on downward from the hole. Reckoned in navigator rows, not
// raw nodes: a comment folded into the row beneath it isn't somewhere the
// selection can go.
export function selectionAfterDelete(model, nodeId) {
  const found = findWithParent(model.nodes, nodeId);
  if (!found) return null;
  const { parent, siblings, index } = found;
  const gone = new Set([index]);
  const noteAt = noteIndexAbove(siblings, index); // the node's own note goes too
  if (noteAt !== -1) gone.add(noteAt);
  const rest = siblings.filter((_, i) => !gone.has(i));
  if (!rest.length) return parent ? parent.id : null;
  // Children that are all text or simple {expr} render no rows at all, so the
  // nearest thing to select is what held them.
  if (rest.every(isContentOnlyChild)) return parent ? parent.id : null;
  // Where the hole is, in the surviving list.
  const at = siblings.slice(0, index).filter((_, i) => !gone.has(i)).length;
  const folded = (i) =>
    rest[i].kind === 'comment' &&
    rest[i + 1] &&
    (rest[i + 1].kind === 'element' || rest[i + 1].kind === 'component');
  for (let i = at; i < rest.length; i++) if (!folded(i)) return rest[i].id;
  for (let i = at - 1; i >= 0; i--) if (!folded(i)) return rest[i].id;
  return parent ? parent.id : null;
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

export function noteText(raw) {
  const full = String(raw ?? '').trim();
  const label = full.replace(RULE, '').replace(RULE_END, '').trim();
  // A rule with no label is decoration rather than a note. Shown as it is,
  // because showing nothing would invite clearing a field that looks empty and
  // taking the divider with it.
  return label || full;
}

export function noteValue(previous, text) {
  const body = String(text ?? '').trim();
  if (!body) return null; // the caller removes the node
  const full = String(previous ?? '').trim();
  const lead = full.match(RULE);
  if (!lead) return ` ${body} `;
  const rule = lead[1];
  const width = Math.max(3, full.length - body.length - 1);
  return ` ${rule.repeat(width)} ${body} `;
}
