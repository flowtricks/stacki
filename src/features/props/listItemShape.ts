// What each field of a list's items is, for the list editor (ListField.tsx):
// a text box, a number, an on/off switch, an image or a link.
//
// A component that declares its list (`items?: readonly { title: string;
// on: boolean }[]`) says so through the prop schema's item shape, and its
// fields take their kinds from their types: a number is a Number, a boolean a
// Switch, and a string a Text unless its name says it holds an image or a link
// (fieldNames.ts), the same rule the panel uses for every other prop. A list
// with no declared shape is read from its values instead: a bare `true` is a
// switch, a bare number a number. A new item is made from the shape, so a list
// that starts empty still adds an item with every field the component reads.
// Pure, so the rules are pinned by tests without a renderer.

import { assert } from '../../../shared/core/assert';
import { isLinkName, isMediaName } from '../../editor/fieldNames';
import type { ItemFieldKind, ListItemValues } from '../../editor/listPropType';
import { LIST_LIMITS } from '../../editor/listPropType';
import type { Item, ItemField } from './arrayValue';

/** One field of a list's items, as the editor draws it. */
export interface ItemShapeField {
  readonly name: string;
  readonly kind: ItemFieldKind;
}

/** A declared item shape (the prop schema's `{ name, type }` members) as the editor's fields. */
export function itemShapeOf(
  shape: readonly { readonly name: string; readonly type?: string | undefined }[] | undefined,
): readonly ItemShapeField[] | undefined {
  if (shape === undefined || shape.length === 0) {
    return undefined;
  }
  assert(shape.length <= LIST_LIMITS.fieldsMax * 4, 'itemShapeOf: a shape is bounded');
  const out = shape.map((field) => ({ name: field.name, kind: declaredKind(field.name, field.type) }));
  assert(out.length === shape.length, 'itemShapeOf: every member is a field');
  return out;
}

function declaredKind(name: string, type: string | undefined): ItemFieldKind {
  if (type === 'number') {
    return 'number';
  }
  if (type === 'boolean') {
    return 'switch';
  }
  return namedKind(name);
}

// A string field's kind, by its name.
function namedKind(name: string): ItemFieldKind {
  if (isMediaName(name)) {
    return 'image';
  }
  return isLinkName(name) ? 'link' : 'text';
}

/** What one field of an item is: its declared kind, else what its value and name say. */
export function itemFieldKind(field: ItemField, shape: readonly ItemShapeField[] | undefined): ItemFieldKind {
  const declared = shape?.find((entry) => entry.name === field.key);
  if (declared !== undefined) {
    return declared.kind;
  }
  if (field.quote === undefined) {
    return field.text === 'true' || field.text === 'false' ? 'switch' : 'number';
  }
  return namedKind(field.key);
}

/** An item with nothing in it yet: each field empty, a number 0 and a switch off. */
export function blankItemOf(shape: readonly ItemShapeField[], quote: string): Item {
  assert(shape.length > 0, 'blankItemOf: an item has a field');
  assert(quote === '"' || quote === "'" || quote === '`', 'blankItemOf: a quote is one');
  return { fields: shape.map((field) => blankField(field, quote)) };
}

function blankField(field: ItemShapeField, quote: string): ItemField {
  switch (field.kind) {
    case 'number':
      return { key: field.name, keyQuote: undefined, text: '0', quote: undefined };
    case 'switch':
      return { key: field.name, keyQuote: undefined, text: 'false', quote: undefined };
    case 'text':
    case 'image':
    case 'link':
      return { key: field.name, keyQuote: undefined, text: '', quote };
    default: {
      const exhaustive: never = field.kind;
      return exhaustive;
    }
  }
}

/**
 * The item with every declared field, in the declared order: a field it lacks
 * is added blank, and one the shape does not name is kept after them, since a
 * value the editor cannot place is still the file's.
 */
export function conformedItem(item: Item, shape: readonly ItemShapeField[] | undefined, quote: string): Item {
  if (shape === undefined || shape.length === 0 || item.fields === undefined) {
    return item;
  }
  const own = item.fields;
  const declared = shape.map((entry) => own.find((field) => field.key === entry.name) ?? blankField(entry, quote));
  const extra = own.filter((field) => !shape.some((entry) => entry.name === field.key));
  const out: Item = { fields: [...declared, ...extra] };
  assert(out.fields.length >= own.length, 'conformedItem: no field is dropped');
  return out;
}

/** Each item's fields as the values the List property's default is written from. */
export function itemValuesOf(items: readonly Item[]): readonly ListItemValues[] {
  assert(items.length <= LIST_LIMITS.itemsMax * 4, 'itemValuesOf: the items are bounded');
  return items.map((item) => Object.fromEntries((item.fields ?? []).map((field) => [field.key, field.text])));
}

/** The items with field `from` renamed `to`, so renaming a field in the form keeps what its items hold. */
export function renamedItemField(items: readonly Item[], from: string, to: string): readonly Item[] {
  if (from === to) {
    return items;
  }
  return items.map((item) => (item.fields === undefined ? item : { fields: item.fields.map((field) => (field.key === from ? { ...field, key: to } : field)) }));
}
