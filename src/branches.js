// An `if` with nothing to choose between.
//
// A condition's branches are real nodes in the model — `{x ? (…) : (…)}` has a
// then and an else, and the markup for each has to live somewhere. But
// `{x && (…)}` has only a then, and a branch you cannot leave is not a place:
// the row said "then" under "if command", indented what was inside it, and
// asked nothing of the reader that the `if` had not already said.
//
// So a lone then is not shown. Its children are the condition's children, a
// level shallower, and the branch rows come back the moment there is an else
// to tell them apart from. The model is untouched either way — the branch is
// still where things are added, still what the file writes out — this is only
// which rows the tree draws.

/**
 * The branch a condition keeps everything in when there is no else, or null
 * when the condition's branches are worth showing (or it isn't a condition).
 */
export function soleThen(node) {
  if (!node || node.kind !== 'cond') return null;
  const kids = node.children;
  if (!Array.isArray(kids) || kids.length !== 1) return null;
  const only = kids[0];
  return only && only.kind === 'branch' && only.name !== 'else' ? only : null;
}

/** The children the tree shows under a row. */
export function rowChildren(node) {
  const only = soleThen(node);
  const kids = only ? only.children : node?.children;
  return Array.isArray(kids) ? kids : [];
}

/** Where a child dropped on this row actually goes. */
export function rowHost(node) {
  return soleThen(node) || node;
}
