// Which view a condition opens in, and whether the {} toggle may go back to
// the controls: the pure decision behind the `{}` on every conditions editor
// (the template if, the Value conditions dialog, the class list). Code the
// controls cannot show always opens as code, with a note, and the controls
// never rewrite it; code they can show opens as controls, and stays code once
// the person chose code (as a prop field does), until they ask for the controls.
// Pure, so each case is pinned by a table of inputs.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr } from '../../../shared/page/pageNode';

export type ConditionView = 'visual' | 'code';

/** Why the controls cannot take the code: it says more than they can draw. */
export type ConditionViewRefusal = 'complex';

export interface ConditionViewInput {
  /** The condition's code as it is now. */
  readonly source: string;
  /** Whether the controls can show `source` and write it back unchanged. */
  readonly readable: (source: string) => boolean;
  /** What the person chose with the toggle; undefined until they do. */
  readonly chosen: ConditionView | undefined;
}

export interface ConditionViewDecision {
  readonly view: ConditionView;
  /** The note shown above the code when it opened as code on its own. */
  readonly note: ConditionViewRefusal | undefined;
  /** Why the switch to the controls is disabled, or undefined when it is offered. */
  readonly visualRefusal: ConditionViewRefusal | undefined;
}

export function decideConditionView(input: ConditionViewInput): ConditionViewDecision {
  assert(input.source.length <= LIMITS.attrCharsMax, 'decideConditionView: source limit exceeded');
  if (input.readable(input.source)) {
    return { view: input.chosen === 'code' ? 'code' : 'visual', note: undefined, visualRefusal: undefined };
  }
  // Never the controls: they would have to rewrite what they cannot draw.
  return { view: 'code', note: 'complex', visualRefusal: 'complex' };
}

/** The decision while the controls are showing: nothing to explain. */
export const CONTROLS_DECISION: ConditionViewDecision = { view: 'visual', note: undefined, visualRefusal: undefined };

/** What closing an editor that was left on code writes: nothing when the code is the field's own or blank, else the code as the attribute. */
export type AppliedCode = { readonly kind: 'unchanged' } | { readonly kind: 'write'; readonly value: Attr };

export function appliedCode(code: string, before: Attr | undefined): AppliedCode {
  assert(code.length <= LIMITS.attrCharsMax, 'appliedCode: code limit exceeded');
  const text = code.trim();
  // Blank code never clears a field: clearing is the unlink button's job, which says so.
  if (text === '' || (before?.type === 'expr' && before.value.trim() === text)) {
    return { kind: 'unchanged' };
  }
  return { kind: 'write', value: { type: 'expr', value: text } };
}
