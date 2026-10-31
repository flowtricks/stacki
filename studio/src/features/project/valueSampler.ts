// What a page's own call to one of its imports returns — a CMS query,
// `const pastors = await getCampusPastors()` — for the binding picker. Studio
// runs inside the project's dev server, so it runs the call the way the page
// does on every render: the project module resolved as the page imports it,
// and the one export called with no arguments. Only modules under src/ are
// reachable, and only an export that takes no arguments, so nothing runs that
// a render would not. The desktop app answers the same question through its
// dev server's /__avb/value route (electron/preview/markerConfig.ts).

import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { assert } from '../../../vendor/stacki/shared/core/assert';

// What crosses the wire is a sample, not the data, bounded as the desktop
// app's: long strings clipped, long lists cut short, deep nesting stopped.
const STRING_CHARS_MAX = 160;
const ITEMS_MAX = 8;
const DEPTH_MAX = 6;
const KEYS_MAX = 64;
// A call that has not answered by now is not one a picker can wait for.
const CALL_MS_MAX = 10_000;
const EXPORT_NAME = /^[A-Za-z_$][\w$]*$/;

export interface ValueRequest {
  /** The page or component, project-relative, whose import is called. */
  readonly file: string;
  /** The import as the file writes it: `@/sanity/queries.ts`. */
  readonly spec: string;
  /** The export called: `getCampusPastors`. */
  readonly name: string;
}

export function valueSampler(server: ViteDevServer, root: string) {
  const source = path.resolve(root, 'src');
  return async (request: ValueRequest): Promise<{ readonly value: unknown }> => {
    if (!EXPORT_NAME.test(request.name)) {
      throw new Error('Not an export name');
    }
    const importer = path.resolve(root, request.file);
    if (!importer.startsWith(source + path.sep)) {
      throw new Error('Only a file under src/ can be sampled from');
    }
    const resolved = await server.pluginContainer.resolveId(request.spec, importer, { ssr: true });
    const id = resolved?.id.split('?')[0];
    if (!id || !path.resolve(id).startsWith(source + path.sep)) {
      throw new Error('Only a project module under src/ can be sampled');
    }
    const loaded: Record<string, unknown> = await server.ssrLoadModule(id);
    const call = loaded[request.name];
    if (!takesNothing(call)) {
      throw new Error('Not an export the page calls with no arguments');
    }
    return { value: sample(await withinTime(Promise.resolve(call()))) };
  };
}

// A function declaring no parameters: the page calls it with none.
function takesNothing(value: unknown): value is () => unknown {
  return typeof value === 'function' && value.length === 0;
}

async function withinTime(answer: Promise<unknown>): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('The call took too long')), CALL_MS_MAX);
  });
  try {
    return await Promise.race([answer, late]);
  } finally {
    clearTimeout(timer);
  }
}

// The same sample the desktop app's endpoint takes (PATHS_ENDPOINT): dates
// tagged, depth and length stopped with a marker, functions and symbols left out.
function sample(value: unknown, depth = 0): unknown {
  assert(depth <= DEPTH_MAX, 'Samples stop at their depth bound');
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string') {
    return value.length > STRING_CHARS_MAX ? `${value.slice(0, STRING_CHARS_MAX)}…` : value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value !== 'object') {
    return undefined;
  }
  if (value instanceof Date) {
    return { __stacki: 'date', value: isNaN(value.getTime()) ? null : value.toISOString() };
  }
  if (depth === DEPTH_MAX) {
    return { __stacki: 'deep' };
  }
  if (Array.isArray(value)) {
    const items: unknown[] = value
      .slice(0, ITEMS_MAX)
      .map((item) => sample(item, depth + 1) ?? null);
    return value.length > ITEMS_MAX
      ? [...items, { __stacki: 'more', count: value.length - ITEMS_MAX }]
      : items;
  }
  const fields: [string, unknown][] = [];
  for (const [key, field] of Object.entries(value).slice(0, KEYS_MAX)) {
    const shown = sample(field, depth + 1);
    if (shown !== undefined) {
      fields.push([key, shown]);
    }
  }
  return Object.fromEntries(fields);
}
