// Plain facts about connected-CMS fields and values that every editor shares:
// a field's display name, whether a value holds anything, and new item keys.
import { assert } from '../../../shared/core/assert';
import {
  REMOTE_SCHEMA_LIMITS,
  remoteList,
  remoteObject,
  type RemoteSchemaField,
  type RemoteValue,
} from '../../../shared/properties/cmsRemoteSchema';
import { labelize } from './cmsSchema';

export function fieldTitle(field: Pick<RemoteSchemaField, 'name' | 'title'>): string {
  return field.title || labelize(field.name);
}

/** Whether a value holds nothing a person entered: absent, blank, an empty list, a bare slug. */
export function isEmptyValue(value: RemoteValue | undefined, depth = 0): boolean {
  // Values are parsed to this depth at the boundary, so the walk never goes deeper.
  assert(depth <= REMOTE_SCHEMA_LIMITS.valueDepthMax, 'An emptiness check follows the value bound');
  if (value === undefined) {
    return true;
  }
  if (typeof value === 'string') {
    return value.trim() === '';
  }
  if (typeof value !== 'object') {
    return false;
  }
  const list = remoteList(value);
  if (list !== undefined) {
    return list.length === 0;
  }
  // A reference holds its target in `_ref`: pointing somewhere is a value.
  const object = remoteObject(value) ?? {};
  if (typeof object['_ref'] === 'string' && object['_ref'] !== '') {
    return false;
  }
  const own = Object.entries(object).filter(([key]) => !key.startsWith('_'));
  return own.every(([, entry]) => isEmptyValue(entry, depth + 1));
}

/** A new array item key, as Sanity Studio makes them: short and random. */
export function remoteKey(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
}
