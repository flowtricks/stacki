// The words selected in the open canvas text editor, and what the formatting
// bar over them can do. Held outside React (a live value) because it changes
// on every drag of the selection and only the bar reads it.
//
// The bar and its formatting are the Settings Content field's (the app layer
// joins the two features); this module only says what crosses between them.

import { createLiveValue } from '../../ui/liveValue';

export type CanvasFormatCommand = 'bold' | 'italic' | 'superscript' | 'subscript';
export type CanvasFormatWrap = 'code' | 'span';

export type CanvasFormatAction =
  | { readonly kind: 'exec'; readonly command: CanvasFormatCommand }
  | { readonly kind: 'wrap'; readonly tag: CanvasFormatWrap }
  | { readonly kind: 'link'; readonly url: string };

/** Which buttons are lit: the formats the selected words already have. */
export interface CanvasFormatState {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly superscript?: boolean;
  readonly subscript?: boolean;
  readonly code?: boolean;
  readonly span?: boolean;
  readonly link?: boolean;
}

export interface CanvasTextSelectionState {
  readonly session: string;
  /** Where the selection is in the window: its horizontal middle, top and bottom. */
  readonly bubble: { readonly x: number; readonly top: number; readonly bottom: number };
  readonly states: CanvasFormatState;
  /** Bold, italic, superscript, subscript, code or span: applied at once. */
  readonly press: (action: Exclude<CanvasFormatAction, { readonly kind: 'link' }>) => void;
  /** Ends typing so the URL field can take focus, keeping what was typed. */
  readonly beginLink: () => void;
  /** The URL, or undefined to leave the words unlinked and save the typing. */
  readonly endLink: (url: string | undefined) => void;
}

export const canvasTextSelection = createLiveValue<CanvasTextSelectionState | undefined>(undefined);

export function clearCanvasTextSelection(session: string): void {
  if (canvasTextSelection.get()?.session === session) {
    canvasTextSelection.set(undefined);
  }
}
