// A page's last-rendered frontmatter values (shared/page/previewScope.ts),
// filed the way the binding picker's value samples are keyed.

import { assert } from '../../shared/core/assert';
import type { Data } from '../../shared/core/boundary';

export const SCOPE_SAMPLE_LIMITS = {
  // A value asked for again after an edit waits this long for typing to stop.
  askDelayMs: 600,
} as const;

/** `values` keyed `<file>|<name>`, as the app's value samples are stored. */
export function keyScopeSamples(file: string, values: Readonly<Record<string, Data>>): Readonly<Record<string, Data>> {
  assert(file.length > 0, 'Scope samples belong to a file');
  const keyed = Object.fromEntries(Object.entries(values).map(([name, value]) => [`${file}|${name}`, value]));
  assert(Object.keys(keyed).length === Object.keys(values).length, 'Keying keeps every sample');
  return keyed;
}

/** Every sample but `file`'s, so a value its frontmatter no longer binds goes. */
export function withoutFileSamples(samples: Readonly<Record<string, Data>>, file: string): Readonly<Record<string, Data>> {
  const prefix = `${file}|`;
  const kept = Object.fromEntries(Object.entries(samples).filter(([key]) => !key.startsWith(prefix)));
  assert(Object.keys(kept).length <= Object.keys(samples).length, 'Dropping a file only removes samples');
  return kept;
}
