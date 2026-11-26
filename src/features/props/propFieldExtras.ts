// What a host adds to a prop's row in the Settings panel, by prop name: a toggle beside the {} button, and a reason
// the value cannot be changed here (the control is then greyed out and takes no input, the added toggle still does).
// The component canvas gives each prop that can be split into frames its own-frames toggle this way
// (src/app/shell/canvasFrameSettings.tsx); nowhere else provides one, so the rows are as they always were.
//
// The host describes the toggle and the row draws it (PropFieldLabel.tsx PropFieldExtraAction) as the {} button is
// drawn, the same element and classes in the same place, so the two share one size, centre and hover in every state.
import { createContext, useContext, type ReactNode } from 'react';

export interface PropFieldAction {
  /** A 12px icon, the size of the {} button's. */
  readonly icon: ReactNode;
  /** The toggle's name and its tooltip: what a press does now. */
  readonly label: string;
  readonly pressed: boolean;
  /** A press is refused (a limit is reached): the toggle stays pressable and says why when pressed. */
  readonly refused: boolean;
  readonly onPress: () => void;
}

export interface PropFieldExtra {
  readonly action?: PropFieldAction;
  readonly lockedReason?: string;
  /** Where the value shown comes from when it is not simply this field's own: the label says so on hover. */
  readonly provenance?: PropFieldProvenance;
  /**
   * The several things the field edits hold different values (a canvas field over frames that differ): the field shows
   * this word where a value would be, and no choice is marked; whatever is set then goes to all of them.
   */
  readonly mixed?: string;
}

/**
 * `inherited`: nothing is set here and the label turns orange. `noted`: set here, with something to say about it.
 * `given`: nothing is set here either, but the value is the field's own as far as the person is concerned (a component
 * default): the label is marked as set. Neither `inherited` nor `given` offers Reset, since there is nothing here for it
 * to clear; the tip says where the value is set instead.
 */
export interface PropFieldProvenance {
  readonly tone: 'inherited' | 'noted' | 'given';
  readonly tip: string;
}

/** Whether a field's label offers Reset: only where something is set at the field's own level. */
export function provenanceResets(provenance: PropFieldProvenance | undefined): boolean {
  return provenance === undefined || provenance.tone === 'noted';
}

export type PropFieldExtras = (name: string) => PropFieldExtra | undefined;

export const PropFieldExtrasContext = createContext<PropFieldExtras | undefined>(undefined);

export function usePropFieldExtra(name: string): PropFieldExtra | undefined {
  return useContext(PropFieldExtrasContext)?.(name);
}
