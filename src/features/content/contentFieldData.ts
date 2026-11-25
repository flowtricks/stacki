// The data behind the content fields: a blank value for each kind of field,
// leaving a key out of a record, and the reference targets a collection
// offers, cached per collection (ContentFields.tsx).

import { useEffect, useState } from 'react';
import type { Data, DataRecord } from '../../../shared/core/boundary';
import { data } from '../../../shared/core/boundary';
import { assert } from '../../../shared/core/assert';
import type { FieldDescriptor } from './contentSchema';
import { readContentTargets } from './contentViewBridge';

export const TARGET_CACHE_MAX = 128;
export type Target = { readonly id: string; readonly title: string };
export const targetCache = new Map<string, readonly Target[]>();
// A nullable field can hold the data value null: the key stays in the entry's
// file, with no value. It is the entry's data, not the app's absence.
// eslint-disable-next-line stacki/no-null -- YAML and JSON null is entry data written to the file.
export const NULL_DATA: Data = null;

export function isPlainObject(value: unknown): value is DataRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function fieldKey(field: FieldDescriptor): string {
  assert(typeof field.key === 'string', 'Nested content field requires a key');
  assert(field.key.length > 0, 'Nested content field key must not be empty');
  return field.key;
}

export function blankFor(field: FieldDescriptor | undefined): Data {
  if (!field) {
    return '';
  }
  if ('default' in field) {
    return data(field.default);
  }
  switch (field.control) {
    case 'boolean':
      return false;
    case 'number':
      return field.constraints.min ?? 0;
    case 'enum':
      return data(field.options?.[0] ?? '');
    case 'tags':
    case 'references':
    case 'list':
      return [];
    case 'record':
      return {};
    case 'object':
      return blankObject(field.fields ?? []);
    case 'union':
      return blankUnion(field);
    case 'unknown':
    case 'image':
    case 'reference':
    case 'date':
    case 'const':
    case 'markdown':
    case 'code':
    case 'url':
    case 'email':
    case 'longtext':
    case 'text':
      return '';
  }
}

export function blankObject(fields: readonly FieldDescriptor[]): DataRecord {
  return Object.fromEntries(fields.filter((field) => field.required).map((field) => [fieldKey(field), blankFor(field)]));
}

export function blankUnion(field: FieldDescriptor): DataRecord {
  const member = field.members?.[0];
  if (!member) {
    return {};
  }
  const discriminator = field.discriminator;
  return {
    ...(discriminator ? { [discriminator]: data(member.value) } : {}),
    ...blankObject(member.fields),
  };
}

export function omitField(object: DataRecord, key: string): DataRecord {
  return Object.fromEntries(Object.entries(object).filter(([entryKey]) => entryKey !== key));
}

export function cacheTargets(key: string, targets: readonly Target[]): void {
  if (targetCache.size >= TARGET_CACHE_MAX) {
    const oldest = targetCache.keys().next().value;
    if (typeof oldest === 'string') {
      targetCache.delete(oldest);
    }
  }
  targetCache.set(key, targets);
}

export function useTargets(projectPath: string, name: string | undefined) {
  const key = name ? `${projectPath}:${name}` : '';
  const [targets, setTargets] = useState<readonly Target[] | undefined>(() => targetCache.get(key));
  useEffect(() => {
    if (!name) {
      setTargets([]);
      return;
    }
    const cached = targetCache.get(key);
    if (cached) {
      setTargets(cached);
      return;
    }
    let active = true;
    void readContentTargets(projectPath, name).then((result) => {
      const next = result.ok ? result.value : [];
      cacheTargets(key, next);
      if (active) {
        setTargets(next);
      }
    });
    return () => {
      active = false;
    };
  }, [key, name, projectPath]);
  return targets;
}
