// Which styled selector an element starts on, before anyone picks one.
//
// A component-library element such as `<h2 class="heading heading--2 u-text-center
// u-text-balance">` has no plain class rule: its component styles are written
// `:where(.heading)` (zero specificity, so a utility can override them), and the
// only plain class rules are utilities. Choosing the "first class with styles"
// landed on `.u-text-center`, a rule that styles every centred thing on the site,
// when `:where(.heading)` is the element's own selector.
//
// The order, first match wins, among the selectors styled for this element:
//   1. a regular class selector (`.hero`), in the element's class order;
//   2. the component's `:where(.base)`: the first class in element order, a modifier
//      (`.heading--2`, `.card__title`) only when its base has no rule;
//   3. the element's tag selector (`h2`).
// A utility class (`u-` prefix, the Lumos convention this app's projects use) never
// takes part in 1 or 2. Pure: it reads selector text and writes nothing.

import { assert } from '../../../../shared/core/assert';

/** A utility class: `u-text-center`. Utilities restyle many elements, so none is anyone's default. */
export function isUtilityClassName(name: string): boolean {
  return name.startsWith('u-');
}

// BEM-style modifier or element: `heading--2`, `card__title`.
function isModifierClassName(name: string): boolean {
  return name.includes('--') || name.includes('__');
}

const PLAIN_CLASS = /^\.([\w-]+)$/;
const WHERE_CLASS = /^:where\(\.([\w-]+)\)$/;

interface DefaultInput {
  /** The selectors styled for the element in the current context. */
  readonly styled: readonly string[];
  /** The element's classes, in element order. */
  readonly classes: readonly string[];
  readonly tag: string | undefined;
}

/** The selector text to start on, or undefined when none of the three applies. */
export function defaultSelectorPick(input: DefaultInput): string | undefined {
  const { styled, classes, tag } = input;
  assert(styled.length >= 0, 'defaultSelectorPick: a list of selectors');
  const regular = classes.filter((name) => !isUtilityClassName(name));
  for (const name of regular) {
    const found = styled.find((text) => PLAIN_CLASS.exec(text)?.[1] === name);
    if (found !== undefined) {
      return found;
    }
  }
  const ranked = regular
    .map((name, index) => ({ name, index, modifier: isModifierClassName(name) }))
    .sort((left, right) => Number(left.modifier) - Number(right.modifier) || left.index - right.index);
  for (const entry of ranked) {
    const found = styled.find((text) => WHERE_CLASS.exec(text)?.[1] === entry.name);
    if (found !== undefined) {
      return found;
    }
  }
  if (tag !== undefined) {
    return styled.find((text) => text === tag);
  }
  return undefined;
}
