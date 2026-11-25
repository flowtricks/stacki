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
}

export type PropFieldExtras = (name: string) => PropFieldExtra | undefined;

export const PropFieldExtrasContext = createContext<PropFieldExtras | undefined>(undefined);

export function usePropFieldExtra(name: string): PropFieldExtra | undefined {
  return useContext(PropFieldExtrasContext)?.(name);
}
