// A loop over a list typed in place: `["Item 1", "Item 2"]`. The loop panel
// shows such a list as rows to edit, one per item, so someone who does not
// write code can loop over a few words without a collection behind them.
//
// Only a list of plain strings reads this way. Anything else typed in place
// (numbers, objects, a spread) stays code, so editing rows can never rewrite
// a value as something it was not.

import { assert } from '../../shared/core/assert';
import { isFieldPath, ITEM_FIELD, type LoopFieldKind } from './loopQuery';
import { parseExpression, parseFrontmatter, type Js } from './loopSyntax';

export const LOOP_LITERAL_LIMITS = {
  itemsMax: 200,
  itemCharsMax: 500,
  // The fields read off a written-out list's objects: a card's few keys, never hundreds.
  fieldsMax: 64,
} as const satisfies Record<string, number>;

/** A field the items of a written-out list hold, as their values say it. */
export interface WrittenField {
  readonly path: string;
  readonly kind: LoopFieldKind;
}

/**
 * The fields the items of a list written out in a frontmatter constant hold
 * (`const plans = [{ title: "Pro", price: 9 }]`), read off the values as they
 * are written, or undefined when `name` holds no list written out. Items that
 * are plain values (`["Free", "Open"]`) are their own field, ITEM_FIELD, so a
 * filter compares the text and a sort orders by it.
 *
 * A key whose values disagree on their kind is `other`, which a filter can
 * still test for being set; it is never guessed as one kind or the other.
 */
export function writtenListFields(frontmatter: string, name: string): readonly WrittenField[] | undefined {
  const init = parseFrontmatter(frontmatter).declarations.get(name)?.init;
  const list = init?.kind === 'await' ? init.value : init;
  if (list?.kind !== 'array') {
    return undefined;
  }
  const kinds = new Map<string, LoopFieldKind>();
  const note = (path: string, kind: LoopFieldKind): void => {
    const known = kinds.get(path);
    if (known === undefined && kinds.size < LOOP_LITERAL_LIMITS.fieldsMax) {
      kinds.set(path, kind);
    } else if (known !== undefined && known !== kind) {
      kinds.set(path, 'other');
    }
  };
  for (const item of list.items.slice(0, LOOP_LITERAL_LIMITS.itemsMax)) {
    if (item.kind === 'object') {
      for (const entry of item.entries) {
        // A key the item-itself field is named by would read as the item.
        if (entry.key !== undefined && isFieldPath(entry.key) && !entry.key.includes('.') && entry.key !== ITEM_FIELD) {
          note(entry.key, writtenKind(entry.value));
        }
      }
    } else if (item.kind === 'string' || item.kind === 'number' || item.kind === 'boolean') {
      note(ITEM_FIELD, writtenKind(item));
    }
  }
  const fields = [...kinds].map(([path, kind]) => ({ path, kind }));
  assert(fields.length <= LOOP_LITERAL_LIMITS.fieldsMax, 'A written-out list’s fields are bounded');
  assert(
    fields.every((field) => isFieldPath(field.path)),
    'A written-out list’s fields are paths a filter can name',
  );
  return fields;
}

// What a written value is, as filtering and sorting it cares.
function writtenKind(value: Js): LoopFieldKind {
  switch (value.kind) {
    case 'string':
      return 'text';
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'list';
    case 'object':
    case 'function':
    case 'name':
    case 'member':
    case 'index':
    case 'call':
    case 'new':
    case 'await':
    case 'null':
    case 'unary':
    case 'binary':
    case 'conditional':
    case 'other':
      // A value code computes, or one no filter compares: only set or not.
      return 'other';
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

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
