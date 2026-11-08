import { createContext } from 'react';

export interface PropPreview {
  readonly prepare: (prop: string, values: readonly (string | number | undefined)[]) => void;
  readonly hover: (value: string | number | undefined) => void;
  readonly cancel: () => void;
  readonly commit: () => void;
  /**
   * A value being written right now (a number field's arrow key, a typed number):
   * shown on the canvas at once, ahead of its write, and dropped once edits pause so
   * the written rendering takes over. Optional: a panel without a live canvas render
   * leaves the write to show itself.
   */
  readonly live?: (prop: string, value: string | number) => void;
}
export const PropPreviewContext = createContext<PropPreview | undefined>(undefined);
