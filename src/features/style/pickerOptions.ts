// The variable picker's view options. Grouping is remembered between sessions in localStorage;
// "show all" is not, so nobody lands in an unfiltered list by accident.
//
// The stored value is a boundary: it is parsed, never trusted. Anything other than the two spellings
// this file writes (missing, corrupt, from another version) reads as the default, and a storage that
// is unavailable or throws is the default too, never an error.

import { useEffect, useState } from 'react';

/** The localStorage key for "Group variables". */
export const GROUPED_STORAGE_KEY = 'stacki.variablePicker.grouped';

/** Grouped by default: the panel's own structure is what people know. */
export const GROUPED_DEFAULT = true;

/** The part of Storage this file uses, so a test can hand in a stand-in. */
export interface PickerStorage {
  getItem(key: string): string | undefined;
  setItem(key: string, value: string): void;
}

/** `'1'` is on and `'0'` is off; anything else is not a setting this file wrote. */
export function parseGrouped(raw: string | undefined): boolean | undefined {
  if (raw === '1') {
    return true;
  }
  if (raw === '0') {
    return false;
  }
  return undefined;
}

function defaultStorage(): PickerStorage | undefined {
  try {
    if (typeof localStorage === 'undefined') {
      return undefined;
    }
    const platform = localStorage;
    // The platform answers absence with null; this file's one spelling of absence is undefined.
    return { getItem: (key) => platform.getItem(key) ?? undefined, setItem: (key, value) => platform.setItem(key, value) };
  } catch {
    return undefined;
  }
}

/** The remembered grouping, read synchronously so the first render is already right. */
export function readGrouped(storage: PickerStorage | undefined = defaultStorage()): boolean {
  if (storage === undefined) {
    return GROUPED_DEFAULT;
  }
  try {
    return parseGrouped(storage.getItem(GROUPED_STORAGE_KEY)) ?? GROUPED_DEFAULT;
  } catch {
    return GROUPED_DEFAULT;
  }
}

/** Remember the grouping; a storage that refuses is ignored (the choice then lasts the session). */
export function writeGrouped({ grouped, storage = defaultStorage() }: { readonly grouped: boolean; readonly storage?: PickerStorage | undefined }): void {
  if (storage === undefined) {
    return;
  }
  try {
    storage.setItem(GROUPED_STORAGE_KEY, grouped ? '1' : '0');
  } catch {
    // Storage full or blocked: nothing to do but keep the choice for now.
  }
}

/** The grouping setting, kept in step with other open pickers and windows through the storage event. */
export function useGrouped(): readonly [boolean, (change: { readonly grouped: boolean }) => void] {
  const [grouped, setGrouped] = useState(() => readGrouped());
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === GROUPED_STORAGE_KEY) {
        setGrouped(parseGrouped(event.newValue ?? undefined) ?? GROUPED_DEFAULT);
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const set = (change: { readonly grouped: boolean }): void => {
    setGrouped(change.grouped);
    writeGrouped(change);
  };
  return [grouped, set];
}
