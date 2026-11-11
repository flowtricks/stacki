// Attributes Stacki writes into markup for itself, never for the author.
//
// An app's `node.key` keeps a durable handle on an element as one
// `data-stacki-key` attribute (src/features/apps/nodeKeys.ts). It is markup the
// person never wrote and should never have to read, so every user-facing
// attribute list (the Settings tab's Attributes, an instance's fields, the
// selector chips, the element tip) leaves it out. Hiding is a view rule only:
// the attribute stays in the node's props, so an edit to any other attribute,
// and every whole-list write, carries it through untouched.
//
// Desktop and Studio both read this module, so a future internal attribute is
// added here once and disappears from every list together.
import { assert } from './assert';

/** The attribute `node.key` writes: the one durable handle Stacki puts in markup, and only when an app asks. */
export const NODE_KEY_ATTRIBUTE = 'data-stacki-key';

/** Every attribute Stacki owns. Add a name here to hide it from every attribute list. */
export const INTERNAL_ATTRIBUTES: ReadonlySet<string> = new Set([NODE_KEY_ATTRIBUTE]);

/** Whether `name` is an attribute Stacki writes for itself, which no attribute list shows. */
export function isInternalAttribute(name: string): boolean {
  assert(typeof name === 'string', 'isInternalAttribute: the name is a string');
  return INTERNAL_ATTRIBUTES.has(name.toLowerCase());
}

/** The names a person sees: `names` in order, without Stacki's own. */
export function visibleAttributeNames(names: readonly string[]): readonly string[] {
  const visible = names.filter((name) => !isInternalAttribute(name));
  assert(visible.length <= names.length, 'visibleAttributeNames: filtering only removes');
  return visible;
}
