import type { CmsField, FieldType } from './cmsSchema';
import { CMS_FIELD_TYPES, inferType } from './cmsSchema';
import { toArray } from '../../../shared/core/record';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS, dictionary, text } from '../../../shared/core/boundary';

export type DeclaredTypes = Readonly<Record<string, FieldType>>;
const STRUCTURAL: readonly FieldType[] = ['object', 'objects', 'list', 'boolean', 'number'];

export function parseDeclaredTypes(input: unknown): DeclaredTypes {
  return dictionary((value) => {
    const name = text(value);
    const type = CMS_FIELD_TYPES.find((candidate) => candidate === name);
    if (type === undefined) {
      throw new Error('Unknown CMS field type');
    }
    return type;
  })(input);
}

export function withDeclaredTypes(
  fields: readonly CmsField[],
  declared: DeclaredTypes | undefined,
  path: readonly string[],
): readonly CmsField[] {
  assert(fields.length <= BOUNDARY_LIMITS.itemsMax, 'CMS fields: count limit exceeded');
  assert(path.length <= BOUNDARY_LIMITS.depthMax, 'CMS fields: path limit exceeded');
  if (!declared) {
    return fields;
  }
  return fields.map((field) => {
    const chosen = declared[[...path, field.key].join('.')];
    if (!chosen) {
      return field;
    }
    if (field.type === 'list' && chosen === 'objects') {
      // A new repeater holds no entries yet, and `[]` reads as a list; the
      // declaration is the only record of what it was made to hold.
      return { ...field, type: chosen };
    }
    if (STRUCTURAL.includes(field.type)) {
      return field;
    }
    return { ...field, type: chosen };
  });
}

// A declared textual role survives odd literal values; a structural change must
// select the matching control so an object cannot be overwritten by a text input.
export function bestType(collectionType: FieldType, value: unknown): FieldType {
  const own = inferType(value);
  if (own === 'empty') {
    return collectionType;
  }
  if (own === 'list' && collectionType === 'objects' && toArray(value)?.length === 0) {
    // An empty array fits either array control; the collection's type decides.
    return collectionType;
  }
  if (STRUCTURAL.includes(own)) {
    return own;
  }
  if (STRUCTURAL.includes(collectionType)) {
    return own;
  }
  if (collectionType === 'image') {
    return collectionType;
  }
  if (collectionType === 'date') {
    return collectionType;
  }
  return collectionType === 'longtext' ? 'longtext' : own;
}
