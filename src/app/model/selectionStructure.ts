// What the selection means to the actions that change the page's structure:
// Delete, Cut, Copy, Duplicate, Wrap and Make component. A ::before or ::after row
// selects its element, with the pick saying which layer (see PseudoPick), so the
// selected id alone reads as the element and every one of these would take the
// element with it. A pseudo-element is drawn by CSS and has no markup of its own
// to remove, copy, wrap or move, so none of them acts while one is the selection.
// The keyboard, and through it the canvas, the element menu and the Components
// panel all ask here, so they cannot disagree.

import { assert } from '../../../shared/core/assert';
import type { PseudoLayer } from '../../../shared/page/pseudoPath';
import type { PseudoPick } from '../appTypes';

/** The ::before or ::after that is the selection, if one is. A pick held for another node is not. */
export function selectedPseudo(selectionId: string | undefined, pick: PseudoPick | undefined): PseudoLayer | undefined {
  if (pick === undefined) {
    return undefined;
  }
  assert(pick.nodeId.length > 0, 'selectedPseudo: a pseudo-element belongs to a node');
  return pick.nodeId === selectionId ? pick.pseudo : undefined;
}

/** The node a structural action may change for this selection, or undefined when it may change nothing. */
export function structuralSelection(selectionId: string | undefined, pick: PseudoPick | undefined): string | undefined {
  if (selectionId === undefined || selectionId.length === 0) {
    return undefined;
  }
  // The frontmatter is selectable, but it is the page's code, not one of its nodes.
  if (selectionId === 'frontmatter') {
    return undefined;
  }
  return selectedPseudo(selectionId, pick) === undefined ? selectionId : undefined;
}
