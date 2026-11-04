// The dev preview's record of each file's last-rendered frontmatter values,
// shared by the three places that touch it: the statement the marked copy of
// a file ends its frontmatter with (electron/previewServer/scopeCapture.ts),
// the dev server's value route that reads it back
// (electron/preview/markerConfig.ts, SCOPE_SOURCE), and the renderer, which
// checks that route's answer here before the binding picker uses it.

import { assert } from '../core/assert';
import { data, type Data } from '../core/boundary';
import { toRecord } from '../core/record';

/** The `Symbol.for` key the record is filed under on `globalThis`. */
export const SCOPE_STORE_KEY = 'stacki.scope';

export const PREVIEW_SCOPE_LIMITS = {
  // Files whose last render is kept. Each holds references to what its render
  // computed, so the bound is on memory the dev server keeps alive.
  filesMax: 128,
  // Names one file files and one answer samples: a page binds a handful of
  // values, and a frontmatter with more is generated code.
  namesMax: 64,
} as const;

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * The sampled values by binding name. Anything that is not a record of
 * identifiers to sampled data is no answer, an empty one, rather than an
 * error: a page the dev server cannot sample still opens, with "no sample"
 * where the values would be. A `null` value is a binding with nothing in it,
 * which is no sample either.
 */
export function parseScopeSamples(input: unknown): Readonly<Record<string, Data>> {
  const source = toRecord(input);
  if (source === undefined) {
    return {};
  }
  const out: Record<string, Data> = {};
  for (const name of Object.keys(source).slice(0, PREVIEW_SCOPE_LIMITS.namesMax)) {
    const value = source[name];
    if (!IDENTIFIER.test(name)) {
      continue;
    }
    if (value === undefined || value === null) {
      continue;
    }
    out[name] = data(value);
  }
  assert(Object.keys(out).length <= PREVIEW_SCOPE_LIMITS.namesMax, 'Scope samples are bounded by name count');
  return out;
}
