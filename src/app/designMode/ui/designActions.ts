// The actions of Design mode that need the host (the open project, the AI panel, the toasts), handed to the
// canvas, the frame titles and the inspector through one context.
import { createContext, useContext } from 'react';
import type { FrameId } from '../model/designTypes';

export interface DesignActions {
  readonly sendToAi: (frame: FrameId) => void;
  readonly copyImage: (frame: FrameId) => void;
  readonly exportImage: (frame: FrameId) => void;
  readonly freshFrame: () => void;
  readonly toast: (message: string, kind: 'info' | 'success' | 'warning' | 'error') => void;
  /** Widths the project's breakpoints name, widest first, for the frame width menu. */
  readonly widths: readonly { readonly label: string; readonly widthPx: number }[];
  /** The project's components, for the component tool and the props panel. */
  readonly components: readonly DesignComponent[];
  /** Whatever the host is busy with (a capture, a hand-off), for the top bar to show. */
  readonly busy: string | undefined;
}

export interface DesignComponent {
  readonly name: string;
  readonly path: string;
  readonly fields: readonly DesignPropField[];
}

/** A component prop as the props panel offers it. */
export interface DesignPropField {
  readonly name: string;
  readonly kind: 'choice' | 'boolean' | 'number' | 'text' | 'other';
  readonly options: readonly string[];
  readonly defaultValue: string | number | boolean | undefined;
  readonly doc: string | undefined;
}

const missing = (): never => {
  throw new Error('Assertion failed: Design mode actions are used inside the Design mode host');
};

export const DesignActionsContext = createContext<DesignActions>({
  sendToAi: missing,
  copyImage: missing,
  exportImage: missing,
  freshFrame: missing,
  toast: missing,
  widths: [],
  components: [],
  busy: undefined,
});

export function useDesignActions(): DesignActions {
  return useContext(DesignActionsContext);
}
