// The cascade, ranked as the CSS Cascade specification ranks it, and the reason each loser loses.
//
// One declaration beats another by the first of these steps that tells them apart (CSS
// Cascade 5, section 6.1, author origin only: the panel reads the project's own CSS):
//   1. Importance: every `!important` declaration beats every normal one.
//   2. Element-attached: the `style` attribute beats any rule of the same importance.
//   3. Layers: among normal declarations an unlayered one beats a layered one and a later
//      layer beats an earlier one; important declarations REVERSE this (an earlier layer
//      beats a later one, and a layered one beats an unlayered one).
//   4. Specificity.
//   5. Source order: the later declaration wins.
// A declaration whose condition (`@media`, `@supports`, `@container`) does not hold right now
// is not in the cascade at all: it ranks after every one that is.
//
// Why a pure module: the panel names a winner, and a winner that the browser disagrees with
// is a lie. This module is the one place the order is written down; the browser's own answer
// (shared/properties/cascadeOrigin.ts) is checked against it in test/electron/preload.

import { compareLayerPositions, type LayerPosition } from './cascadeLayers';
import { compareSpecificity } from './selectorParse';
import type { Specificity } from './styleTypes';

/** What the cascade needs to rank one declaration. */
export type CascadeCandidate = {
  readonly important: boolean;
  /** Written in the element's `style` attribute. */
  readonly inline?: boolean;
  /** Its layer's position, absent when the declaration is unlayered. */
  readonly layer?: LayerPosition | undefined;
  readonly specificity: Specificity;
  /** Document order, ascending: the later declaration wins a tie. */
  readonly order: number;
  /** False when its `@media`, `@supports` or `@container` condition does not hold now. */
  readonly applies?: boolean;
};

/** The step at which a declaration lost to the winner, in the order the steps are taken. */
export type LossKind = 'condition' | 'importance' | 'inline' | 'layer' | 'specificity' | 'order' | 'other';

// `other` is never derived here: it marks a declaration the page's own cascade passed over for a
// reason the panel's reading of the files does not explain (model/cascadeTruth.ts).
export const LOSS_KINDS: readonly LossKind[] = ['condition', 'importance', 'inline', 'layer', 'specificity', 'order', 'other'];

// Positive when `left` has the higher layer precedence; the pair shares one importance, which
// decides whether later layers win (normal) or lose (important).
function layerPrecedence(left: CascadeCandidate, right: CascadeCandidate): number {
  const important = left.important;
  if (left.layer === undefined && right.layer === undefined) {
    return 0;
  }
  if (left.layer === undefined) {
    return important ? -1 : 1;
  }
  if (right.layer === undefined) {
    return important ? 1 : -1;
  }
  const later = compareLayerPositions(left.layer, right.layer);
  return important ? -later : later;
}

/** The step that decides `left` against `right`, and which of them it favors (-1 left, 1 right); undefined on an exact tie. */
function decidingStep(left: CascadeCandidate, right: CascadeCandidate): { readonly kind: Exclude<LossKind, 'other'>; readonly favors: -1 | 1 } | undefined {
  const leftApplies = left.applies !== false;
  const rightApplies = right.applies !== false;
  if (leftApplies !== rightApplies) {
    return { kind: 'condition', favors: leftApplies ? -1 : 1 };
  }
  if (left.important !== right.important) {
    return { kind: 'importance', favors: left.important ? -1 : 1 };
  }
  const leftInline = left.inline === true;
  const rightInline = right.inline === true;
  if (leftInline !== rightInline) {
    return { kind: 'inline', favors: leftInline ? -1 : 1 };
  }
  const layer = layerPrecedence(left, right);
  if (layer !== 0) {
    return { kind: 'layer', favors: layer > 0 ? -1 : 1 };
  }
  const specificity = compareSpecificity(left.specificity, right.specificity);
  if (specificity !== 0) {
    return { kind: 'specificity', favors: specificity > 0 ? -1 : 1 };
  }
  if (left.order !== right.order) {
    return { kind: 'order', favors: left.order > right.order ? -1 : 1 };
  }
  return undefined;
}

/** Negative when `left` wins over `right`, positive when `right` wins, zero on an exact tie. */
export function compareCandidates(left: CascadeCandidate, right: CascadeCandidate): number {
  return decidingStep(left, right)?.favors ?? 0;
}

/** Why `loser` does not win against `winner`: the first step that tells them apart. */
export function explainLoss(loser: CascadeCandidate, winner: CascadeCandidate): LossKind | undefined {
  const step = decidingStep(loser, winner);
  // The loser favored by the deciding step is no loser: nothing to explain.
  if (step === undefined || step.favors === -1) {
    return undefined;
  }
  return step.kind;
}

/** The candidates, winner first. Stable: an exact tie keeps the order it came in. */
export function rankCandidates<Candidate extends CascadeCandidate>(candidates: readonly Candidate[]): Candidate[] {
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort((left, right) => compareCandidates(left.candidate, right.candidate) || left.index - right.index)
    .map((entry) => entry.candidate);
}
