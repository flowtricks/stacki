// What the Style panel last learned about which of an instance's chips are the
// component's (green), kept for the session.
//
// A component instance's chips are green for the classes its component writes, which
// needs the component file's text (componentMarkup.ts), read asynchronously. The file
// is dropped from its cache whenever the project reports a style change, so the same
// instance is briefly "unknown" again after every save. Drawing it neutral meanwhile
// made the chips flash grey and then colour. Instead the last settled answer is held
// here, per component file, and used while a fresh one is read; the read only
// refines it. A selector never seen before has no memory and is drawn in the colour
// its text alone decides (selectorKind), which is a true first paint, not a placeholder.

import { assert } from '../../../../shared/core/assert';

/** At most this many components are remembered; the oldest is dropped past it. */
export const PROVENANCE_SCOPES_MAX = 64;

/** At most this many green selectors are held per component. A component has a handful of classes. */
export const PROVENANCE_CHIPS_MAX = 256;

const green = new Map<string, Set<string>>();

/** The selector keys last settled green for a component, or undefined when it was never settled. */
export function rememberedGreenChips(scope: string): ReadonlySet<string> | undefined {
  assert(scope.length > 0, 'rememberedGreenChips: a scope is never empty');
  return green.get(scope);
}

/**
 * Holds a settled answer: `greenKeys` are green now, `plainKeys` were seen and are not.
 * Earlier answers for other chips of the same component are kept, so a second instance
 * does not erase what the first taught.
 */
export function rememberChipProvenance(scope: string, answer: { readonly greenKeys: readonly string[]; readonly plainKeys: readonly string[] }): void {
  assert(scope.length > 0, 'rememberChipProvenance: a scope is never empty');
  const held = green.get(scope) ?? new Set<string>();
  for (const key of answer.plainKeys) {
    held.delete(key);
  }
  for (const key of answer.greenKeys) {
    if (held.size < PROVENANCE_CHIPS_MAX) {
      held.add(key);
    }
  }
  // Re-inserted so the Map's first key is always the least recently settled scope.
  green.delete(scope);
  green.set(scope, held);
  if (green.size > PROVENANCE_SCOPES_MAX) {
    const oldest = green.keys().next().value;
    if (oldest !== undefined) {
      green.delete(oldest);
    }
  }
  assert(green.size <= PROVENANCE_SCOPES_MAX, 'rememberChipProvenance: bounded by PROVENANCE_SCOPES_MAX');
  assert(held.size <= PROVENANCE_CHIPS_MAX, 'rememberChipProvenance: bounded by PROVENANCE_CHIPS_MAX');
}

/** Forgets everything; tests. */
export function forgetChipProvenance(): void {
  green.clear();
}
