// An `if`, and what the tree draws under it.
//
// A condition's branches are real nodes in the model — `{x ? (…) : (…)}` has a
// then and an else, and the markup for each has to live somewhere. But a THEN
// is not a place. It is what the `if` above it already said, so the row read
// "then" under "if href", indented everything inside it a level for saying
// nothing, and cost a line and a chevron on the way to the markup.
//
// So the then is never drawn. What is inside it is drawn inside the `if`, a
// level shallower. An else keeps its row: it is the one branch that says
// something the `if` doesn't, and without a row of its own there would be no
// telling which children belonged to which side.
//
// The model is untouched either way — the branch is still where a drop lands,
// still what the file writes out. This is only which rows the tree draws.

const branchNamed = (node, isElse) => {
  if (!node || node.kind !== 'cond') return null;
  const kids = Array.isArray(node.children) ? node.children : [];
  const found = kids.find((k) => k?.kind === 'branch' && (k.name === 'else') === isElse);
  return found || null;
};

/** The branch a condition renders when its test holds — never drawn as a row. */
export function thenBranch(node) {
  return branchNamed(node, false);
}

/** The branch it renders when the test doesn't, or null when there isn't one. */
export function elseBranch(node) {
  return branchNamed(node, true);
}

/** The children the tree shows under a row. */
export function rowChildren(node) {
  const then = thenBranch(node);
  if (!then) return Array.isArray(node?.children) ? node.children : [];
  // What the then holds, then the else itself — the one branch worth a row,
  // and it comes after the markup it is the alternative to.
  const otherwise = elseBranch(node);
  const kids = Array.isArray(then.children) ? then.children : [];
  return otherwise ? [...kids, otherwise] : kids;
}

/** Where a child dropped on this row actually goes. */
export function rowHost(node) {
  return thenBranch(node) || node;
}
