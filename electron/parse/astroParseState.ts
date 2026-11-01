// The template parser's shared state: the bail that stops a parse the
// editor cannot represent, the bounds every parse runs within, the shapes a
// tag parse returns, and the branch nodes of conditional markup.

import { LIMITS } from '../../shared/core/limits';
import type { ParserNode, BranchNode, ParseBail, ParsedTemplate } from './astroParserTypes';
import { makeId, required } from './astroAttrs';
import { findMatchingParen } from './astroScan';

// A branch spans its side of the conditional as written, whitespace trimmed:
// `( <p/> )` after the `?`, or the markup after the `&&`.
export function makeBranch(name: 'then' | 'else', children: ParserNode[], raw: string, base: number | undefined): BranchNode {
  const branch: BranchNode = { id: makeId(), kind: 'branch', name, children };
  if (base !== undefined) {
    const start = base + (raw.length - raw.trimStart().length);
    branch.start = start;
    branch.end = Math.max(start, base + raw.trimEnd().length);
  }
  return branch;
}

// Whether a branch renders markup, as opposed to a value.
export const branchIsMarkup = (kids: readonly ParserNode[] | undefined) => (kids || []).some((kid) => kid.kind !== 'expr' && kid.kind !== 'text');

// The other side of a conditional whose one side is markup: a plain value, as
// an expression child.
//
// `{href ? (<a …>{heading}</a>) : (heading)}` — the LinkCard pattern — used to
// be code in the navigator, whole, because one of its branches was a bare name
// rather than a tag. Which meant a conditional around an anchor read as a wall
// of JSX, and neither the anchor nor the fallback could be selected.
//
// Written with braces, like every other expression node: it lands in JSX
// context on the canvas (inside the branch's Fragment). The writer takes them
// off again for the file, where a branch's parens are JS.
export function exprBranch(raw: string, base: number | undefined = undefined): ParserNode[] | undefined {
  const text = String(raw);
  let expression = text.trimStart();
  let at = base === undefined ? undefined : base + (text.length - expression.length);
  expression = expression.trimEnd();
  while (expression.startsWith('(') && findMatchingParen(expression, 0) === expression.length - 1) {
    const inner = expression.slice(1, -1);
    const trimmed = inner.trimStart();
    if (at !== undefined) {
      at += 1 + (inner.length - trimmed.length);
    }
    expression = trimmed.trimEnd();
  }
  // Markup that failed to parse is not a value — sending it back as an opaque
  // expression would hide a real bail behind a node that looks fine.
  if (!expression || expression.startsWith('<')) {
    return undefined;
  }
  const node: ParserNode = { id: makeId(), kind: 'expr', value: `{${expression}}` };
  if (at !== undefined) {
    node.start = at;
    node.end = at + expression.length;
  }
  return [node];
}

// What made the last parse give up, so the code-view banner can name the
// construct and point at it instead of listing everything it might have been.
// parseTemplate recurses into children, and the innermost frame is the one that
// actually found the problem — so only the first bail of a run is kept, and
// parsePage clears it before starting.
export const parseState: {
  lastBail: ParseBail | undefined;
  depth: number;
  nodes: number;
  conditions: number;
} = {
  lastBail: undefined,
  depth: 0,
  nodes: 0,
  conditions: 0,
};
export function bail(nodes: ParserNode[], template: string, at: number, what: string): ParsedTemplate {
  if (!parseState.lastBail) {
    parseState.lastBail = { what, near: template.slice(at, at + 60) };
  }
  return { nodes, clean: false };
}

export function resetParseBail(): void {
  parseState.lastBail = undefined;
}

export type TemplateTagResult =
  | { readonly kind: 'tag'; readonly node: ParserNode; readonly end: number }
  | { readonly kind: 'bail'; readonly what: string }
  | { readonly kind: 'child-bail' };

export function parseTemplateAt(node: ParserNode, base: number | undefined, from: number, to: number): ParserNode {
  if (base === undefined) {
    return node;
  }
  return { ...node, start: base + from, end: base + to };
}

export interface TemplateTagOpen {
  readonly template: string;
  readonly lt: number;
  readonly base: number | undefined;
  readonly name: string;
  readonly attrs: string;
  readonly afterOpen: number;
  readonly shorthand: boolean;
  readonly kind: 'component' | 'element';
}

// Conditional branch wrappers and inserted inline spaces count as real nodes,
// even though they do not advance the source scanner's emission counter.
export function parseTemplateWithinBounds(nodes: readonly ParserNode[]): boolean {
  if (nodes.length > LIMITS.treeNodesMax) {
    return false;
  }
  const pending = nodes.map((node) => ({ node, depth: 0 }));
  for (let index = 0; index < pending.length; index++) {
    const entry = required(pending[index], 'Template traversal index is in bounds');
    if (entry.depth > LIMITS.treeDepthMax) {
      return false;
    }
    if (entry.node.children) {
      if (pending.length + entry.node.children.length > LIMITS.treeNodesMax) {
        return false;
      }
      for (const node of entry.node.children) {
        pending.push({ node, depth: entry.depth + 1 });
      }
    }
  }
  return true;
}
