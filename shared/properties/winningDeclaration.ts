// The declaration of a custom property that wins for one rendered element, as the canvas reports it.
//
// The picker shows each variable's value as written for the selected element (`var(--brand)`), not the
// browser's computed value. The canvas traces the property up the element's parents and answers, per
// name, the winning declaration's own text and where it was written (electron/preload/frameAuthoredStyles.ts).
// The reply crosses from the page, so it is parsed and bounded here before the picker trusts it.

import { count, object, optional, text } from '../core/boundary';
import { LIMITS } from '../core/limits';

export const parseWinningDeclaration = object({
  /** The declaration's value text, whitespace-normalized, never resolved. */
  expression: text,
  /** The rule's selector list, or `style` for an inline declaration. */
  selector: text,
  /** The stylesheet's file, when it has one. */
  file: optional(text),
  /** Parents up to the declaring element; 0 is the element itself. */
  depth: count,
  /** The declaring element's label. */
  ancestor: text,
});
export type WinningDeclarationText = ReturnType<typeof parseWinningDeclaration>;

/** Names one canvas question may ask about; more are not asked (the picker lists them with their stylesheet text). */
export const WINNING_NAMES_MAX = 512;

/** Runs of whitespace compare equal: the one spelling used to tell whether two expressions say the same. */
export function sameExpression(first: string, second: string): boolean {
  assertBounded(first);
  assertBounded(second);
  return first.replace(/\s+/g, ' ').trim() === second.replace(/\s+/g, ' ').trim();
}

function assertBounded(value: string): void {
  if (value.length > LIMITS.attrCharsMax) {
    throw new Error('sameExpression: the expression exceeds the attribute limit');
  }
}
