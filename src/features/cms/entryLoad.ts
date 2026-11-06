// Where the open entry's read stands, for the one entry it names. A form is
// only checked against the entry it shows, so nothing says "required" or
// "already used" about values that belong to something else: until the read
// for THIS id has answered, the state is `loading`, which holds the last entry
// shown (or nothing, the first time) and is never `ready`. An answer naming
// another id is a read of an earlier selection, and is not taken for this one.
import { useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import type { RemoteDocument, RemoteResult } from '../../../shared/properties/cmsRemote';

export type EntryLoad =
  | { readonly kind: 'loading'; readonly id: string; readonly held: RemoteDocument | undefined }
  | { readonly kind: 'failed'; readonly id: string; readonly message: string }
  | { readonly kind: 'ready'; readonly id: string; readonly document: RemoteDocument };

/** The load `result` makes for `id`, given the load shown before it. */
export function entryLoadOf(id: string, result: RemoteResult<RemoteDocument> | undefined, previous: EntryLoad | undefined): EntryLoad {
  assert(id !== '', 'An entry is loaded by its id');
  if (result === undefined) {
    return { kind: 'loading', id, held: entryShown(previous) };
  }
  if (!result.ok) {
    return { kind: 'failed', id, message: result.message };
  }
  if (result.value.id === id) {
    return { kind: 'ready', id, document: result.value };
  }
  return { kind: 'loading', id, held: entryShown(previous) };
}

/** The document on screen in a load: the entry itself, the one held for it, or none. */
export function entryShown(load: EntryLoad | undefined): RemoteDocument | undefined {
  if (load === undefined) {
    return undefined;
  }
  switch (load.kind) {
    case 'loading':
      return load.held;
    case 'failed':
      return undefined;
    case 'ready':
      return load.document;
    default: {
      const exhaustive: never = load;
      return exhaustive;
    }
  }
}

/** The load of `id` as its reads answer, remembering what was shown across a switch. */
export function useEntryLoad(id: string, result: RemoteResult<RemoteDocument> | undefined): EntryLoad {
  const previous = useRef<EntryLoad | undefined>(undefined);
  const load = entryLoadOf(id, result, previous.current);
  previous.current = load;
  assert(load.id === id, 'A load is of the entry selected');
  return load;
}
