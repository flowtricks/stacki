// What the canvas tells a person about text printed from data: while they type in
// it, which source their words are written to, and while they only point at it,
// that a double click would. Held outside React, as the format bar's state is
// (canvasTextSelection.ts): it changes with the editor's focus and only the cue
// and the Settings hint read it.
//
// Nothing here writes. The words go to the source only when the editor commits
// (canvasBoundText.ts); this is the sentence beside that, so a data edit is never
// a surprise.

import { createLiveValue } from './liveValue';

/** A bound text's source, as every surface that names it reads it. */
export interface CanvasSourceTarget {
  /** The binding as the page writes it: `aiCallout1.body`. */
  readonly expression: string;
  /** The project-relative file whose literal the words are written to: `src/lib/homepage/content.ts`. `''` is the page being edited. */
  readonly file: string;
  /** Places on this page that print the same literal: editing changes all of them. 1 for text printed once. */
  readonly uses: number;
}

/** The cue over the text being edited: its source, and where the text is in the window. */
export interface CanvasSourceCueState extends CanvasSourceTarget {
  readonly session: string;
  /** The editing element's box in window pixels: left, top, width, height. */
  readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
}

/** Set while a bound text is open for typing; undefined otherwise. */
export const canvasSourceCue = createLiveValue<CanvasSourceCueState | undefined>(undefined);

export function clearCanvasSourceCue(session: string): void {
  if (canvasSourceCue.get()?.session === session) {
    canvasSourceCue.set(undefined);
  }
}

/** The hint over a bound text the pointer is on, before any double click: the same box and source as the cue. */
export const canvasSourceHover = createLiveValue<CanvasSourceCueState | undefined>(undefined);

/** Where the words typed in a text that is not a plain literal stop: the file the person edits instead. */
export interface CanvasSourceBlocked {
  readonly expression: string;
  readonly file: string;
  readonly reason:
    'call' | 'computed' | 'concatenation' | 'template' | 'mutable' | 'prop' | 'missing' | 'ambiguous' | 'unsupported' | 'unreadable' | 'not-text';
}
