// Selecting an element from a panel, the way the Navigator does: the selection
// tick tells the canvas this selection came from a panel (so it scrolls the
// element into view, first copy), any picked ::before/::after is dropped, and
// the id is selected — the inspector and the canvas outline follow from it.
// The Navigator and the Audits panel's go-to both select through here, so they
// cannot drift apart.
import type { Dispatch, SetStateAction } from 'react';

export interface PanelSelectionTarget {
  readonly setNavigatorSelectionTick: Dispatch<SetStateAction<number>>;
  readonly setPseudoPick: (pick: undefined) => void;
  readonly setSelectedId: (id: string | undefined) => void;
}

export function selectFromPanel(target: PanelSelectionTarget, id: string | undefined): void {
  target.setNavigatorSelectionTick((tick) => tick + 1);
  target.setPseudoPick(undefined);
  target.setSelectedId(id);
}
