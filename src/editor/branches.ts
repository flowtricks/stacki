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

export interface BranchTree {
  readonly kind: string;
  readonly name?: string;
  readonly children?: readonly this[] | undefined;
}

const branchNamed = <Node extends BranchTree>(node: Node | undefined, name: 'then' | 'else'): Node | undefined => {
  if (!node || node.kind !== 'cond') {
    return undefined;
  }
  const kids = node.children ?? [];
  const found = kids.find((kid) => {
    return kid?.kind === 'branch' && (kid.name === 'else') === (name === 'else');
  });
  return found || undefined;
};

/** The branch a condition renders when its test holds — never drawn as a row. */
export function thenBranch<Node extends BranchTree>(node: Node | undefined): Node | undefined {
  return branchNamed(node, 'then');
}

/** The branch it renders when the test doesn't, or undefined when there isn't one. */
export function elseBranch<Node extends BranchTree>(node: Node | undefined): Node | undefined {
  return branchNamed(node, 'else');
}

/** The children the tree shows under a row. */
export function rowChildren<Node extends BranchTree>(node: Node | undefined): readonly Node[] {
  const then = thenBranch(node);
  if (!then) {
    return node?.children ?? [];
  }
  // What the then holds, then the else itself — the one branch worth a row,
  // and it comes after the markup it is the alternative to.
  const otherwise = elseBranch(node);
  const kids = then.children ?? [];
  return otherwise ? [...kids, otherwise] : kids;
}

/** Where a child dropped on this row actually goes. */
export function rowHost<Node extends BranchTree>(node: Node | undefined): Node | undefined {
  return thenBranch(node) || node;
}
