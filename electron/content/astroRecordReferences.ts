// References a content config does not declare, found in the data. A site
// moved from another CMS (a Webflow export, say) often keeps a link to a
// campus as the campus record's id in a plain string field — `campus:
// z.string()`, `campuses: z.array(z.string())` — rather than through Astro's
// `reference()`. Such a field reads as a wall of ids. When every value a
// collection holds in a field is the id of a record in one other collection,
// the field is that collection's reference in all but name, so it is offered
// as a choice of that collection's entries by title, and still writes the id.
//
// A record is named by its entry id, or by an `_id` key it carries (the id the
// old CMS gave it); whichever the values use is the one written back.

import path from 'node:path';

import { assert } from '../../shared/core/assert';
import { toArray, toRecord } from '../../shared/core/record';
import {
  REMOTE_SCHEMA_LIMITS,
  type RemoteOption,
  type RemoteSchemaField,
  type RemoteType,
} from '../../shared/properties/cmsRemoteSchema';
import type { Entry } from './contentEntries';

/** One collection's entries, as the inference reads them. */
export interface RecordCollection {
  readonly name: string;
  readonly entries: readonly Entry[];
  /** Its first image field, whose picture a choice of its records shows. */
  readonly imageField?: string | undefined;
}

/**
 * The fields of collection `own`, with each undeclared reference given its
 * target's entries as options. A field that already offers options, names an
 * image, or holds values matching no single collection is returned as it was.
 */
export function withInferredReferences(
  fields: readonly RemoteSchemaField[],
  own: RecordCollection,
  collections: readonly RecordCollection[],
): readonly RemoteSchemaField[] {
  const inferred = fields.map((field) => {
    const scalar = plainString(field.type);
    if (scalar === undefined) {
      return field;
    }
    const values = fieldValues(own.entries, field.name);
    const options = values.length === 0 ? undefined : targetOptions(values, collections);
    if (options === undefined) {
      return field;
    }
    const choice = { kind: 'string' as const, options };
    const type: RemoteType = scalar === 'list' ? { kind: 'array', of: [choice] } : choice;
    return { ...field, type };
  });
  assert(inferred.length === fields.length, 'Inference changes fields, never their number');
  return inferred;
}

// A free-text string, or a list of them: the shapes an undeclared reference takes.
function plainString(type: RemoteType): 'one' | 'list' | undefined {
  const free = (member: RemoteType | undefined) =>
    member?.kind === 'string' && member.options.length === 0 && member.asset === undefined;
  if (free(type)) {
    return 'one';
  }
  if (type.kind === 'array' && type.of.length === 1 && free(type.of[0])) {
    return 'list';
  }
  return undefined;
}

// Every string the collection holds in the field, each once.
function fieldValues(entries: readonly Entry[], name: string): readonly string[] {
  const values = new Set<string>();
  for (const entry of entries) {
    const value = toRecord(entry.data)?.[name];
    const items = toArray(value) ?? [value];
    for (const item of items) {
      if (typeof item === 'string' && item.length > 0) {
        values.add(item);
      }
    }
  }
  return [...values];
}

// The one collection whose records every value names, by entry id or by `_id`, as options.
function targetOptions(
  values: readonly string[],
  collections: readonly RecordCollection[],
): readonly RemoteOption[] | undefined {
  for (const collection of collections) {
    if (collection.entries.length > REMOTE_SCHEMA_LIMITS.optionsMax) {
      continue;
    }
    for (const key of KEYS) {
      const named = new Set(collection.entries.map(key).filter(isString));
      if (values.every((value) => named.has(value))) {
        return collection.entries.flatMap((entry) => {
          const value = key(entry);
          const imageFile = entryImage(entry, collection.imageField);
          return value === undefined
            ? []
            : [{ title: entry.title, value, ...(imageFile === undefined ? {} : { imageFile }) }];
        });
      }
    }
  }
  return undefined;
}

const KEYS: readonly ((entry: Entry) => string | undefined)[] = [
  (entry) => entry.id,
  (entry) => {
    const id = toRecord(entry.data)?.['_id'];
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  },
];

/**
 * An image path as Astro resolves it, relative to the project: beside the
 * entry's file (`./`, `../`, or a bare name), or under public/ (`/`). A link
 * elsewhere, or a path that climbs out of the project, has no file here.
 */
export function projectImage(entryFile: string, value: string): string | undefined {
  const target = value.trim().split(/[?#]/)[0] ?? '';
  if (target.length === 0 || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('@')) {
    return undefined;
  }
  const joined = target.startsWith('/')
    ? path.posix.join('public', target)
    : path.posix.join(path.posix.dirname(entryFile), target);
  const file = path.posix.normalize(joined);
  if (file.startsWith('..') || path.posix.isAbsolute(file)) {
    return undefined;
  }
  assert(!file.split('/').includes('..'), 'A project image stays inside the project');
  return file;
}

/** An entry's picture: the project file its image field names, if it names one. */
export function entryImage(entry: Entry, imageField: string | undefined): string | undefined {
  const picture = imageField === undefined ? undefined : toRecord(entry.data)?.[imageField];
  return typeof picture === 'string' ? projectImage(entry.file, picture) : undefined;
}

function isString(value: string | undefined): value is string {
  return value !== undefined;
}
