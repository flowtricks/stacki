// The canvas path of a node's ::before or ::after. The navigator lists them as
// layers of their own, and their outlines are measured by the canvas like any
// tracked path: `0.2.1::before` is the ::before of the node at `0.2.1`. Node
// paths never contain a colon, so the suffix cannot be mistaken for one.

import { assert } from '../core/assert';

/** A pseudo-element the navigator shows as a layer. */
export type PseudoLayer = 'before' | 'after';

/** The canvas path of `pseudo` on the node at `nodePath`. */
export function pseudoPath(nodePath: string, pseudo: PseudoLayer): string {
  assert(nodePath.length > 0, 'pseudoPath: a pseudo-element belongs to a node');
  assert(!nodePath.includes('::'), 'pseudoPath: the node path is not already a pseudo path');
  const path = `${nodePath}::${pseudo}`;
  assert(splitPseudoPath(path)?.nodePath === nodePath, 'pseudoPath: the path reads back');
  return path;
}

/** The node and pseudo-element a pseudo path names, or undefined for a node's own path. */
export function splitPseudoPath(path: string): { readonly nodePath: string; readonly pseudo: PseudoLayer } | undefined {
  const match = /^(.+)::(before|after)$/.exec(path);
  if (match === null) {
    return undefined;
  }
  const nodePath = match[1] ?? '';
  const pseudo = match[2] === 'before' ? 'before' : 'after';
  assert(nodePath.length > 0, 'splitPseudoPath: the node path is not empty');
  return { nodePath, pseudo };
}
