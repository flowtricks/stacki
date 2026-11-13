// The edits the Property settings pop-up makes to a List's item fields, as pure
// functions over the fields and the default items they describe (PropertySections.tsx
// draws them). A change to the fields is a change to the default items too:
// renaming a field renames it in every item, retyping or removing one clears
// it there, since a text cannot be a switch. Fields nest (a list inside a list),
// so every edit names its field by a PATH, the index of the field at each level,
// and reaches the matching values by the field names above it: the default
// items of a nested list are the value of that field in each item above.
//
// Pure, so the rules are pinned by tests without a renderer.

import { assert } from '../../../shared/core/assert';
import {
  fieldNameProblem,
  fieldsOf,
  ITEM_FIELD_LIMITS,
  retypedField,
  withNestedFields,
  type ItemFieldDeclaration,
  type ItemFieldKind,
} from '../../editor/itemFields';
import { arrayItems, arrayText, nestedItems, type Item } from './arrayValue';
import { blankItemOf, renamedItemField } from './listItemShape';

/** A List's item fields and its default items, which change together. */
export interface ListShape {
  readonly fields: readonly ItemFieldDeclaration[];
  /** The default items as array code, `[{ title: "One" }]`. */
  readonly itemsText: string;
}

/** Where a field is: the index of its row at each level, from the item's own fields down. */
export type FieldPath = readonly number[];

/** The field at `path`, or undefined when no row is there. */
export function fieldAtPath(fields: readonly ItemFieldDeclaration[], path: FieldPath): ItemFieldDeclaration | undefined {
  assert(path.length <= ITEM_FIELD_LIMITS.depthMax, 'fieldAtPath: a path is as deep as the fields nest');
  let level = fields;
  let found: ItemFieldDeclaration | undefined;
  for (const index of path) {
    found = level[index];
    if (found === undefined) {
      return undefined;
    }
    level = fieldsOf(found);
  }
  return found;
}

/** `field`, then `field2`: a name no sibling has. */
export function freeFieldName(siblings: readonly ItemFieldDeclaration[]): string {
  for (let suffix = 1; suffix <= ITEM_FIELD_LIMITS.fieldsPerLevelMax + 1; suffix++) {
    // i18n-ignore: a starting identifier written into the user's code, like any name they type.
    const name = suffix === 1 ? 'field' : `field${suffix}`;
    if (!siblings.some((field) => field.name === name)) {
      return name;
    }
  }
  assert(false, 'freeFieldName: a free name is found within the field bound');
  return 'field';
}

/** The shape with a text field added under the fields at `parent` (the item's own for []). */
export function addedField(shape: ListShape, parent: FieldPath): ListShape {
  const fields = withSiblings(shape.fields, parent, 1, (siblings) => [...siblings, { name: freeFieldName(siblings), kind: 'text' }]);
  // The items need nothing: a missing field is added blank where an item is shown.
  return { fields, itemsText: shape.itemsText };
}

/**
 * The shape with the field at `path` named `name`. `key` is the name the items
 * hold it under now, which is the field's own unless that is no name yet (a
 * name being retyped), where the items keep the last real one.
 */
export function renamedFieldAt(shape: ListShape, path: FieldPath, name: string, key: string): ListShape {
  return editedAt(shape, path, {
    field: (field) => ({ ...field, name }),
    // A name that is no name yet leaves the items under the last real one.
    items: (items) => (fieldNameProblem(name) === undefined ? renamedItemField(items, key, name) : items),
  });
}

/** The shape with the field at `path` of a new kind, cleared in the items. */
export function retypedFieldAt(shape: ListShape, path: FieldPath, kind: ItemFieldKind): ListShape {
  const field = fieldAtPath(shape.fields, path);
  assert(field !== undefined, 'retypedFieldAt: the retyped field exists');
  const next = retypedField(field, kind);
  return editedAt(shape, path, {
    field: () => next,
    items: (items) => items.map((item) => withBlankField(item, next)),
  });
}

/** The shape without the field at `path`, and without its value in the items. */
export function removedFieldAt(shape: ListShape, path: FieldPath): ListShape {
  const field = fieldAtPath(shape.fields, path);
  assert(field !== undefined, 'removedFieldAt: the removed field exists');
  const index = path.at(-1);
  assert(index !== undefined, 'removedFieldAt: a path names a row');
  return editedAt(shape, path, {
    field: undefined,
    items: (items) => items.map((item) => (item.fields === undefined ? item : { fields: item.fields.filter((own) => own.key !== field.name) })),
  });
}

/** The shape with the choices of the Option field at `path`; an item holding a choice that is gone holds the first. */
export function optionsAtPath(shape: ListShape, path: FieldPath, options: readonly string[]): ListShape {
  const field = fieldAtPath(shape.fields, path);
  assert(field !== undefined, 'optionsAtPath: the field exists');
  assert(field.kind === 'option', 'optionsAtPath: only an Option has choices');
  const first = options[0];
  return editedAt(shape, path, {
    field: () => ({ ...field, options }),
    items: (items) =>
      items.map((item) =>
        item.fields === undefined
          ? item
          : {
              fields: item.fields.map((own) => (own.key === field.name && first !== undefined && !options.includes(own.text) ? { ...own, text: first } : own)),
            },
      ),
  });
}

interface Edit {
  /** The field's replacement; undefined removes its row. */
  readonly field: ((field: ItemFieldDeclaration) => ItemFieldDeclaration) | undefined;
  /** The items of the level the field sits on, edited. */
  readonly items: (items: readonly Item[]) => readonly Item[];
}

// The field edited at `path`, and the default items edited at the level it sits on.
function editedAt(shape: ListShape, path: FieldPath, edit: Edit): ListShape {
  const index = path.at(-1);
  assert(index !== undefined, 'editedAt: a path names a row');
  const parent = path.slice(0, -1);
  const ancestors = ancestorNames(shape.fields, parent);
  const fields = withSiblings(shape.fields, parent, 1, (siblings) => {
    const { field } = edit;
    return field === undefined ? siblings.filter((_, at) => at !== index) : siblings.map((sibling, at) => (at === index ? field(sibling) : sibling));
  });
  return { fields, itemsText: itemsEditedAt(shape.itemsText, ancestors, edit.items) };
}

// The sibling list at `parent`, edited; the fields above it are rebuilt around it.
function withSiblings(
  fields: readonly ItemFieldDeclaration[],
  parent: FieldPath,
  depth: number,
  edit: (siblings: readonly ItemFieldDeclaration[]) => readonly ItemFieldDeclaration[],
): readonly ItemFieldDeclaration[] {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'withSiblings: the fields nest within their bound');
  const [head, ...rest] = parent;
  if (head === undefined) {
    return edit(fields);
  }
  return fields.map((field, at) => (at === head ? withNestedFields(field, withSiblings(fieldsOf(field), rest, depth + 1, edit)) : field));
}

// The names of the fields above `parent`, outermost first: where the items are found.
function ancestorNames(fields: readonly ItemFieldDeclaration[], parent: FieldPath): readonly string[] {
  const names: string[] = [];
  let level = fields;
  for (const index of parent) {
    const field = level[index];
    assert(field !== undefined, 'ancestorNames: every ancestor exists');
    names.push(field.name);
    level = fieldsOf(field);
  }
  return names;
}

// The default items, with the items at the level `ancestors` leads to edited.
// Items this cannot read (code, a bound field) are left as written.
function itemsEditedAt(itemsText: string, ancestors: readonly string[], edit: (items: readonly Item[]) => readonly Item[]): string {
  const items = arrayItems(itemsText);
  if (items === undefined) {
    return itemsText;
  }
  const edited = editedItems(items, ancestors, 1, edit);
  // An edit that changed nothing keeps the text as it was written.
  return edited === items ? itemsText : arrayText(edited);
}

function editedItems(items: readonly Item[], ancestors: readonly string[], depth: number, edit: (items: readonly Item[]) => readonly Item[]): readonly Item[] {
  assert(depth <= ITEM_FIELD_LIMITS.walkDepthMax, 'editedItems: the items nest within their bound');
  const [name, ...rest] = ancestors;
  if (name === undefined) {
    return edit(items);
  }
  return items.map((item) => {
    if (item.fields === undefined) {
      return item;
    }
    return {
      fields: item.fields.map((field) => {
        const nested = field.key === name && field.quote === undefined ? nestedItems(field.text) : undefined;
        if (nested === undefined) {
          return field;
        }
        const inner = arrayText(editedItems(nested, rest, depth + 1, edit));
        // A nested list is the array as written; a group is the one object inside it.
        return { ...field, text: field.text.trim().startsWith('[') ? inner : inner.slice(1, -1) };
      }),
    };
  });
}

// The item with `field` set back to blank in its new kind.
function withBlankField(item: Item, field: ItemFieldDeclaration): Item {
  if (item.fields === undefined) {
    return item;
  }
  const blank = blankItemOf([field], '"').fields?.[0];
  assert(blank !== undefined, 'withBlankField: a blank item has the field');
  return { fields: item.fields.map((own) => (own.key === field.name ? { ...blank, keyQuote: own.keyQuote } : own)) };
}
