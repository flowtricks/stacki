// Whether the pointer is on a ::before or ::after rather than on the element
// that draws it.
//
// The browser hit-tests a pseudo-element as its host: elementFromPoint over an
// icon drawn by `::before` returns the element, so the canvas cannot tell the
// two apart from the target alone. It measures the pseudo-elements of the few
// elements under the pointer instead (framePseudo.ts) and asks this module,
// which is pure: boxes in, decision out, so the rule is tested without a page.
//
// The rule: candidates come innermost first, and the first whose pseudo box
// holds the point wins. A pseudo box is a layer drawn over its host's own
// content, so inside it the pseudo-element is what the person is pointing at;
// outside every pseudo box the element itself is. Within one element ::after
// wins over ::before, because it is painted later and so sits on top.

import { assert } from '../../shared/core/assert';
import { type PseudoLayer } from '../../shared/page/pseudoPath';
import { type Box } from './frameBasics';

/** At most this many elements under the pointer have their pseudo-elements tested. */
export const PSEUDO_CANDIDATES_MAX = 8;

/** The boxes one element's ::before and ::after draw, in viewport pixels; undefined where it draws none. */
export interface PseudoBoxes {
  readonly before: Box | undefined;
  readonly after: Box | undefined;
}

/** Which candidate's pseudo-element holds the point, by its index in the candidate list. */
export interface PseudoHit {
  readonly index: number;
  readonly pseudo: PseudoLayer;
}

/** The pseudo-element under the point (x, y), or undefined when the point is on the elements themselves. */
export function pseudoAt(x: number, y: number, candidates: readonly PseudoBoxes[]): PseudoHit | undefined {
  assert(Number.isFinite(x), 'pseudoAt: x is a finite number');
  assert(Number.isFinite(y), 'pseudoAt: y is a finite number');
  assert(candidates.length <= PSEUDO_CANDIDATES_MAX, 'pseudoAt: candidates are capped');
  for (let index = 0; index < candidates.length; index++) {
    const candidate = candidates[index];
    assert(candidate !== undefined, 'pseudoAt: the index is inside the list');
    if (candidate.after !== undefined && boxHolds(candidate.after, x, y)) {
      return { index, pseudo: 'after' };
    }
    if (candidate.before !== undefined && boxHolds(candidate.before, x, y)) {
      return { index, pseudo: 'before' };
    }
  }
  return undefined;
}

/** A box measured relative to its host, placed back at the host's current position. */
export function boxAt(offset: Box, hostLeft: number, hostTop: number): Box {
  assert(offset.left <= offset.right, 'boxAt: the offset box is not inverted horizontally');
  assert(offset.top <= offset.bottom, 'boxAt: the offset box is not inverted vertically');
  return { left: offset.left + hostLeft, top: offset.top + hostTop, right: offset.right + hostLeft, bottom: offset.bottom + hostTop };
}

// Edges count: the outline is drawn on the boundary. A box with no area draws
// nothing to point at, so it holds no point.
export function boxHolds(box: Box, x: number, y: number): boolean {
  if (box.right <= box.left) {
    return false;
  }
  if (box.bottom <= box.top) {
    return false;
  }
  if (x < box.left) {
    return false;
  }
  if (x > box.right) {
    return false;
  }
  if (y < box.top) {
    return false;
  }
  return y <= box.bottom;
}

/**
 * Whether a pseudo-element is offered on the canvas at all: never with `pointer-events: none`, and inside a component only with text.
 * Detail: Inside a component's markup a ::before or ::after is the
 * component's own decoration (an icon, an underline, a stretched overlay): outlining it only names CSS the page cannot
 * change from here and covers the instance, so it is offered only when it renders text. On a plain element it always is.
 */
export function pseudoOffered(options: { readonly inComponent: boolean; readonly content: string; readonly pointerEvents: string }): boolean {
  const { inComponent, content, pointerEvents } = options;
  assert(typeof content === 'string', 'pseudoOffered: content is a string');
  // The computed value already carries inheritance from the host. A pseudo-element the pointer passes through is nothing to pick,
  // text or not: the click belongs to what is beneath it.
  if (pointerEvents === 'none') {
    return false;
  }
  return inComponent ? pseudoRendersText(content) : true;
}

/** Whether a computed `content` renders text: a quoted string with a visible character, or attr(), counter() or counters(). */
export function pseudoRendersText(content: string): boolean {
  // A url() names an image, whose quoted address is not text.
  const bare = content.replace(/url\((?:[^)"']|"[^"]*"|'[^']*')*\)/g, '');
  const strings = bare.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g) ?? [];
  const text = strings.map((part) => part.slice(1, -1).replace(/\\(.)/g, '$1')).join('');
  if (text.trim() !== '') {
    return true;
  }
  return /\b(?:attr|counters?)\(/.test(bare);
}
