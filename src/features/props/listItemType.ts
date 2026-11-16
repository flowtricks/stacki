// What each item of a plain list is, and which control draws it.
//
// `widths: number[]` is a list of numbers, and its rows should be number
// fields, as a number prop is, not text rows that happen to hold digits. The
// kind comes from the prop's declared type (the scan's `itemKind`); a list
// that declares nothing is read from its literal items instead: all numbers is
// a number list, all words a text list, all yes/no a switch list. Items that
// are code (bound to data) say nothing about the kind, since a bound number
// and a bound word are both just a value. Anything mixed has no one kind and
// each item is then drawn as what it itself is.
//
// One small mapping, `controlOfItemKind`, turns a kind into the control and
// the schema type the row's field is drawn with, so the rows, the icon at their
// left and the blank an Add item makes can never disagree. Pure, so the table
// is pinned by tests without a renderer.

import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { PropField, PropItemKind } from '../../../shared/properties/propSchema';
import { itemHoldsCode, type Item } from './arrayValue';
import { itemFieldDefinition, type ItemShapeField } from './listItemShape';
import type { FieldDefinition } from './propRules';

/** What a list's items are: one kind of plain value, objects, or no single kind. */
export type ListItemKind = PropItemKind | 'object' | 'mixed';

/** The kind of a list's items, as its prop declares them, with the words and bounds that kind carries. */
export interface DeclaredItemType {
  readonly kind: PropItemKind;
  /** A choice's words. */
  readonly options?: readonly string[] | undefined;
  /** Whether those words are numbers, written without quotes. */
  readonly numeric?: boolean | undefined;
  readonly min?: number | undefined;
  readonly max?: number | undefined;
  readonly step?: number | undefined;
}

/** The control a kind of item is drawn with, by the schema type its field has. */
export interface ItemControl {
  readonly control: 'text' | 'number' | 'toggle' | 'dropdown' | 'fields' | 'generic';
  /** The schema type the row's icon and field have: `number` for the `#` icon. */
  readonly fieldType: 'string' | 'number' | 'boolean' | 'enum' | 'other';
}

/** The item type a prop field declares, or undefined when it declares none. */
export function declaredItemTypeOf(field: Pick<PropField, 'itemKind' | 'options' | 'numeric' | 'min' | 'max' | 'step'>): DeclaredItemType | undefined {
  if (field.itemKind === undefined) {
    return undefined;
  }
  return { kind: field.itemKind, options: field.options, numeric: field.numeric, min: field.min, max: field.max, step: field.step };
}

/** What one scalar item is by its own value: a number, a yes/no, or words. Code is as unknown as it can be: words. */
export function kindOfItem(item: Item): PropItemKind {
  if (item.fields !== undefined) {
    return 'text';
  }
  if (item.quote !== undefined) {
    return 'text';
  }
  if (item.text === 'true' || item.text === 'false') {
    return 'switch';
  }
  return itemHoldsCode(item) ? 'text' : 'number';
}

/**
 * The kind of a list's items. A declared type wins; a declared object shape
 * says objects; otherwise the literal items say, and bound ones abstain.
 */
export function listItemKindOf(declared: DeclaredItemType | undefined, items: readonly Item[], shape: readonly ItemShapeField[] | undefined): ListItemKind {
  assert(items.length <= LIMITS.scanEntriesMax, 'listItemKindOf: the items are bounded');
  if (declared !== undefined) {
    return declared.kind;
  }
  if (shape !== undefined && shape.length > 0) {
    return 'object';
  }
  let objects = 0;
  const kinds = new Set<PropItemKind>();
  for (const item of items) {
    if (item.fields !== undefined) {
      objects += 1;
    } else if (!itemHoldsCode(item)) {
      kinds.add(kindOfItem(item));
    }
  }
  if (objects > 0) {
    return objects === items.length ? 'object' : 'mixed';
  }
  const [only] = kinds;
  return kinds.size === 1 && only !== undefined ? only : 'mixed';
}

/** The control and field type for a kind of item. `mixed` is drawn by each item's own kind, so it has no control of its own. */
export function controlOfItemKind(kind: ListItemKind): ItemControl {
  switch (kind) {
    case 'text':
      return { control: 'text', fieldType: 'string' };
    case 'number':
      return { control: 'number', fieldType: 'number' };
    case 'switch':
      return { control: 'toggle', fieldType: 'boolean' };
    case 'choice':
      return { control: 'dropdown', fieldType: 'enum' };
    case 'object':
      return { control: 'fields', fieldType: 'other' };
    case 'mixed':
      return { control: 'generic', fieldType: 'other' };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The field a scalar row is drawn with: the kind's control, with the declared choices and bounds. */
export function itemRowField(kind: PropItemKind, name: string, declared: DeclaredItemType | undefined): FieldDefinition {
  assert(name.length > 0, 'itemRowField: a row field is named');
  const base = itemFieldDefinition(name, itemRowDeclaration(kind, name, declared));
  if (kind === 'choice') {
    return declared?.numeric === true ? { ...base, numeric: true } : base;
  }
  if (kind !== 'number') {
    return base;
  }
  return {
    ...base,
    ...(declared?.min === undefined ? {} : { min: declared.min }),
    ...(declared?.max === undefined ? {} : { max: declared.max }),
    ...(declared?.step === undefined ? {} : { step: declared.step }),
  };
}

/** The item Add item makes: each kind's blank, a number at its lowest bound. */
export function defaultItemOf(kind: ListItemKind, declared: DeclaredItemType | undefined, quote: string): Item {
  assert(quote === '"' || quote === "'" || quote === '`', 'defaultItemOf: a quote is one');
  switch (kind) {
    case 'number': {
      // Zero, brought inside the bounds the type declares.
      const start = Math.min(declared?.max ?? Number.POSITIVE_INFINITY, Math.max(declared?.min ?? Number.NEGATIVE_INFINITY, 0));
      assert(Number.isFinite(start), 'defaultItemOf: a number item starts at a finite number');
      return { text: String(start), quote: undefined };
    }
    case 'switch':
      return { text: 'false', quote: undefined };
    case 'choice':
      return { text: declared?.options?.[0] ?? '', quote };
    case 'text':
    case 'object':
    case 'mixed':
      return { text: '', quote };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

/** The declaration a scalar row's value is written through (listItemShape.ts itemFieldOf). */
export function itemRowDeclaration(kind: PropItemKind, name: string, declared: DeclaredItemType | undefined): ItemShapeField {
  switch (kind) {
    case 'text':
      return { name, kind: 'text' };
    case 'number':
      return { name, kind: 'number' };
    case 'switch':
      return { name, kind: 'switch' };
    case 'choice':
      return { name, kind: 'option', options: declared?.options ?? [] };
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}
