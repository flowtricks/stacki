// What a host adds to a prop's row in the Settings panel, by prop name: a control beside the {} button, and a reason
// the value cannot be changed here (the control is then greyed out and takes no input, the added control still does).
// The component canvas gives each prop that can be split into frames its own-frames toggle this way
// (src/app/shell/canvasFrameSettings.tsx); nowhere else provides one, so the rows are as they always were.
import { createContext, useContext, type ReactNode } from 'react';

export interface PropFieldExtra {
  readonly action?: ReactNode;
  readonly lockedReason?: string;
}

export type PropFieldExtras = (name: string) => PropFieldExtra | undefined;

export const PropFieldExtrasContext = createContext<PropFieldExtras | undefined>(undefined);

export function usePropFieldExtra(name: string): PropFieldExtra | undefined {
  return useContext(PropFieldExtrasContext)?.(name);
}
