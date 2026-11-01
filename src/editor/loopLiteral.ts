// A loop over a list typed in place: `["Item 1", "Item 2"]`. The loop panel
// shows such a list as rows to edit, one per item, so someone who does not
// write code can loop over a few words without a collection behind them.
//
// Only a list of plain strings reads this way. Anything else typed in place
// (numbers, objects, a spread) stays code, so editing rows can never rewrite
// a value as something it was not.

import { assert } from '../../shared/core/assert';
import { parseExpression } from './loopSyntax';

export const LOOP_LITERAL_LIMITS = {
  itemsMax: 200,
  itemCharsMax: 500,
} as const satisfies Record<string, number>;

/** What a new custom list starts with, so the loop shows something at once. */
export const STARTER_ITEMS: readonly string[] = ['Item 1', 'Item 2', 'Item 3'];

/** The items of a typed list of strings, or undefined for any other code. */
export function literalItems(data: string): readonly string[] | undefined {
  const parsed = parseExpression(data.trim());
  if (parsed === undefined) {
    return undefined;
  }
  const node = parsed.expression;
  if (node.kind !== 'array') {
    return undefined;
  }
  if (node.items.length > LOOP_LITERAL_LIMITS.itemsMax) {
    return undefined;
  }
  const items: string[] = [];
  for (const item of node.items) {
    if (item.kind !== 'string') {
      return undefined;
    }
    items.push(item.value);
  }
  assert(items.length === node.items.length, 'Every item of a typed list is read');
  return items;
}

/** The code for a typed list: one line, each item a double-quoted string. */
export function literalCode(items: readonly string[]): string {
  assert(items.length <= LOOP_LITERAL_LIMITS.itemsMax, 'A typed list is bounded');
  for (const item of items) {
    assert(item.length <= LOOP_LITERAL_LIMITS.itemCharsMax, 'A typed item is bounded');
  }
  // JSON's string form is a JavaScript string literal, escapes and all.
  const code = `[${items.map((item) => JSON.stringify(item)).join(', ')}]`;
  assert(literalItems(code)?.length === items.length, 'A typed list reads back as written');
  return code;
}
