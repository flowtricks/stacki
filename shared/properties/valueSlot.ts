// Is a variable's value valid WHERE it would go? A variable is offered for a field only when
// its computed value, put into the field's expression at the insertion point (the slot), keeps
// the declaration valid. `width` takes `1rem` but not `1.5`; `calc(2rem * [slot])` takes `1.5`
// but not `1rem`; `color` refuses `10%` while `color-mix(in srgb, red [slot], transparent 90%)`
// accepts it. The browser's own grammar decides (`CSS.supports`, injected here so this module
// is pure and testable), not a table of guesses.
//
// Layers, in order:
//   1. a custom property accepts anything, so every variable is offered;
//   2. the engine: `supports(property, expression with the candidate in the slot)`;
//   3. the user's curated narrowing (propertyValueAccepts.ts: font-weight in steps of 50, ...)
//      ANDed on top, only when the slot is the whole value, never inside calc() and the like.
// Read-only: nothing here edits a stylesheet.

import { assert } from '../core/assert';
import { valuePredicateFor } from './propertyValueAccepts';

/** Marks the insertion point in an expression: a NUL cannot appear in CSS a person typed. */
export const SLOT_MARK = '\u0000';

/** What is written either side of the insertion point. */
export interface ValueSlot {
  readonly before: string;
  readonly after: string;
}

/** The engine's verdict on a whole declaration value. */
export type Supports = (property: string, value: string) => boolean;

export const VALUE_SLOT_LIMITS = {
  /** Candidates asked of the engine in one filtering pass; the rest are offered unasked. */
  checksPerPassMax: 2_000,
  /** Verdicts remembered across passes; the oldest is dropped first. */
  cacheEntriesMax: 4_096,
  /** An expression longer than this is not asked about (the slot is treated as the whole value). */
  expressionCharsMax: 8_192,
} as const;

/** The slot in an expression carrying one SLOT_MARK, or undefined when it carries none. */
export function slotOfMarked(marked: string): ValueSlot | undefined {
  const index = marked.indexOf(SLOT_MARK);
  if (index < 0) {
    return undefined;
  }
  assert(marked.indexOf(SLOT_MARK, index + 1) < 0, 'slotOfMarked: one insertion point');
  return { before: marked.slice(0, index), after: marked.slice(index + 1) };
}

/** Is the slot the whole value (nothing around it but space and `!important`)? */
export function isWholeSlot(slot: ValueSlot | undefined): boolean {
  if (slot === undefined) {
    return true;
  }
  return slot.before.trim() === '' && /^\s*(?:!\s*important)?\s*$/i.test(slot.after);
}

/** Would `computed`, put in `slot`, be valid for `property`? Pure given `supports`. */
export function slotAccepts(property: string | undefined, slot: ValueSlot | undefined, computed: string | undefined, supports: Supports): boolean {
  if (property === undefined || property.startsWith('--')) {
    return true;
  }
  if (computed === undefined || computed.trim() === '') {
    return false;
  }
  const value = computed.trim();
  if (isWholeSlot(slot)) {
    if (!supports(property, value)) {
      return false;
    }
    const curated = valuePredicateFor(property);
    return curated === undefined ? true : curated(value);
  }
  assert(slot !== undefined, 'slotAccepts: a partial slot exists');
  const expression = slot.before + value + slot.after;
  if (expression.length > VALUE_SLOT_LIMITS.expressionCharsMax) {
    return supports(property, value);
  }
  return supports(property, expression);
}

/** A verdict memory with a stated bound: the oldest entry goes when it is full. */
export class VerdictCache {
  readonly #entries = new Map<string, boolean>();
  readonly #max: number;
  constructor(max: number = VALUE_SLOT_LIMITS.cacheEntriesMax) {
    assert(Number.isSafeInteger(max), 'VerdictCache: the bound is a positive whole number');
    assert(max >= 1, 'VerdictCache: the bound is a positive whole number');
    this.#max = max;
  }
  get size(): number {
    return this.#entries.size;
  }
  /** The remembered verdict for `key`, or the result of `compute`, remembered. */
  verdict(key: string, compute: () => boolean): boolean {
    const known = this.#entries.get(key);
    if (known !== undefined) {
      return known;
    }
    const fresh = compute();
    if (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done !== true) {
        this.#entries.delete(oldest.value);
      }
    }
    this.#entries.set(key, fresh);
    assert(this.#entries.size <= this.#max, 'VerdictCache: stays within its bound');
    return fresh;
  }
  clear(): void {
    this.#entries.clear();
  }
}

/** A variable to judge: what it computes to here (undefined when that cannot be worked out), and whether it must stay listed. */
export interface SlotCandidate<T> {
  readonly item: T;
  readonly computed: string | undefined;
  readonly keep: boolean;
}

/**
 * The candidates that fit, in order. Rows marked `keep` (the applied variable) always stay. A
 * context that is itself broken (half typed) would hide everything, so when nothing passes in the
 * slot the property-level check is used instead: the list is never empty because of the
 * surroundings. At most checksPerPassMax candidates are asked; later ones are offered unasked.
 */
export function filterBySlot<T>(
  candidates: readonly SlotCandidate<T>[],
  property: string | undefined,
  slot: ValueSlot | undefined,
  supports: Supports,
  cache: VerdictCache,
): readonly T[] {
  // Each pass answers the candidates that stay and how many passed on their own merit; the
  // applied variable stays regardless, but it too says whether the surroundings admit anything.
  const judge = (activeSlot: ValueSlot | undefined): { readonly items: readonly T[]; readonly passed: number } => {
    let asked = 0;
    let passed = 0;
    const items: T[] = [];
    for (const candidate of candidates) {
      if (asked >= VALUE_SLOT_LIMITS.checksPerPassMax && !candidate.keep) {
        items.push(candidate.item);
        passed += 1;
        continue;
      }
      asked += 1;
      const key = `${property ?? ''}\u0001${activeSlot?.before ?? ''}\u0001${activeSlot?.after ?? ''}\u0001${candidate.computed ?? ''}`;
      const fits = cache.verdict(key, () => slotAccepts(property, activeSlot, candidate.computed, supports));
      if (candidate.keep || fits) {
        items.push(candidate.item);
      }
      if (fits) {
        passed += 1;
      }
    }
    return { items, passed };
  };
  const inSlot = judge(slot);
  if (candidates.length > 0 && inSlot.passed === 0 && !isWholeSlot(slot)) {
    return judge(undefined).items;
  }
  return inSlot.items;
}
