// Fields typed by name, for a list whose items Stacki cannot see: an array an
// import or a prop holds without a type, the result of a call, a path into
// data of unknown shape. Nothing says what its items hold, so the person
// names a field (`title`, `author.name`, or `card.title` with the loop's item
// name) and what it holds, and the same filter and sort rows work as for a
// typed list. The typed field is only a name and a kind; the code written
// from it is checked like any other field's.

import { assert } from '../../../shared/core/assert';
import { isFieldPath, ITEM_FIELD, type LoopFieldKind, type LoopQuery, type LoopSort, type LoopTestCondition } from '../../editor/loopQuery';
import { titled, type CatalogField } from './loopCatalog';

/** What a typed field can hold: the kinds a person can say without a schema. */
export const TYPED_KINDS = ['text', 'number', 'date', 'boolean'] as const satisfies readonly LoopFieldKind[];
export type TypedKind = (typeof TYPED_KINDS)[number];

const TYPED_FIELDS_MAX = 16;

export type TypedPath = { readonly ok: true; readonly path: string } | { readonly ok: false };

/**
 * The field path typed text names. The loop's own item name leads the path when
 * it is written the way the code reads it (`card.title`), and alone it is the
 * item itself, for a list of plain values.
 */
export function typedPathOf(text: string, item: string | undefined): TypedPath {
  const trimmed = text.trim();
  if (item !== undefined && trimmed === item) {
    return { ok: true, path: ITEM_FIELD };
  }
  const path = item !== undefined && trimmed.startsWith(`${item}.`) ? trimmed.slice(item.length + 1) : trimmed;
  return isFieldPath(path) ? { ok: true, path } : { ok: false };
}

export function typedField(path: string, kind: TypedKind): CatalogField {
  assert(isFieldPath(path) || path === ITEM_FIELD, 'A typed field names a path');
  return { path, title: titled(path), kind, options: [], references: [] };
}

/** What a condition says its field holds, which is all that is known of a field nobody described. */
export function kindOfCondition(condition: LoopTestCondition): TypedKind {
  const operator = condition.operator;
  switch (operator) {
    case 'greater':
    case 'less':
    case 'atLeast':
    case 'atMost':
      return 'number';
    case 'before':
    case 'after':
    case 'inPast':
    case 'inFuture':
      return 'date';
    case 'isTrue':
    case 'isFalse':
      return 'boolean';
    case 'is':
    case 'isNot':
      return 'value' in condition && typeof condition.value !== 'string' && condition.value.kind === 'number' ? 'number' : 'text';
    case 'contains':
    case 'has':
    case 'isSet':
    case 'isEmpty':
      return 'text';
    default: {
      const exhaustive: never = operator;
      return exhaustive;
    }
  }
}

function kindOfSort(sort: LoopSort): TypedKind {
  switch (sort.order) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'boolean':
      return 'boolean';
    case 'text':
    case 'natural':
    case 'length':
    case 'count':
    case 'fileSize':
      return 'text';
    default: {
      const exhaustive: never = sort.order;
      return exhaustive;
    }
  }
}

/**
 * The fields a list's filters and sort keys name that its known fields do not:
 * a field typed before, or written by hand in code, shows as a field and edits
 * as one. Bounded, and only for a list, whose items nothing else describes.
 */
export function withTypedFields(fields: readonly CatalogField[] | undefined, query: LoopQuery): readonly CatalogField[] | undefined {
  if (query.source.kind !== 'list') {
    return fields;
  }
  const known = fields ?? [];
  const added = new Map<string, CatalogField>();
  const note = (path: string, kind: TypedKind): void => {
    if (!known.some((field) => field.path === path) && !added.has(path) && added.size < TYPED_FIELDS_MAX) {
      added.set(path, typedField(path, kind));
    }
  };
  for (const condition of query.conditions) {
    if (condition.kind === 'test') {
      note(condition.field, kindOfCondition(condition));
    }
  }
  for (const sort of query.sorts) {
    note(sort.field, kindOfSort(sort));
  }
  return added.size === 0 ? fields : [...known, ...added.values()];
}
