// What the page last said about the custom properties of one element, kept so the variable picker
// opens on it at once and swaps in the fresh answer in place (stale-while-revalidate): rows are
// never reordered or replaced by a different text while the question is asked again.
//
// An answer carries two things per name: the computed value on that element (the swatch, the kind
// and the validity filter judge it) and the winning declaration as written (the row's text), found
// by tracing the property up the element's parents (electron/preload/frameAuthoredStyles.ts).
// The cache is small and is forgotten when a new page announces itself, since its answers are
// another document's.

import { onCanvasReady } from '../../../editor/canvasQuery';
import type { WinningDeclarationText } from '../../../../shared/properties/winningDeclaration';

export interface DefinedAnswer {
  /** Computed value by custom property name (`--brand`); names the element does not define are absent. */
  readonly names: ReadonlyMap<string, string>;
  /** The winning declaration by name, as written; names the page could not trace are absent. */
  readonly winning: ReadonlyMap<string, WinningDeclarationText>;
  /** The custom properties declared in scope of the element (its rules' and its parents'), nearest declaration of each. */
  readonly scoped: ReadonlyMap<string, WinningDeclarationText>;
}

// Elements kept; the picker asks about one at a time, so a handful is every recent selection.
const ANSWERS_MAX = 16;
const ANSWERS = new Map<string, DefinedAnswer>();

export function cachedAnswer(key: string): DefinedAnswer | undefined {
  return ANSWERS.get(key);
}

export function rememberAnswer(key: string, answer: DefinedAnswer): void {
  // Most recently used goes last, so the eviction drops the one used longest ago.
  ANSWERS.delete(key);
  ANSWERS.set(key, answer);
  for (const oldest of ANSWERS.keys()) {
    if (ANSWERS.size <= ANSWERS_MAX) {
      break;
    }
    ANSWERS.delete(oldest);
  }
}

export function forgetDefinedAnswers(): void {
  ANSWERS.clear();
}

onCanvasReady(forgetDefinedAnswers);
