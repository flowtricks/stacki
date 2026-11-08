// The entries a template page renders, read the way Desktop reads them: by running the
// page's own getStaticPaths. It is ordinary code (a collection query, an API call, a map
// over anything), so the only reliable answer is to run it, and Studio runs inside the
// project's dev server, which can. Importing the page module evaluates its module scope,
// where getStaticPaths lives, but not the component body, so nothing that needs
// Astro.params runs here. Desktop's half is the /__avb/paths route
// (electron/preview/markerConfig.ts).
import path from 'node:path';
import type { ViteDevServer } from 'vite';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { routeFor } from '../project/projectClient';
import { ENTRY_PROPS_SAMPLED_MAX, sampleEntryProps } from './entryPropsSample';
import { fillTemplateRoute, isTemplateRoute, templateEntryLabel, TEMPLATE_ENTRIES_MAX, type TemplateEntries, type TemplateEntry } from './templateRoutes';

/** A getStaticPaths that has not answered by now is not one a picker can wait for. */
const PATHS_MS_MAX = 20_000;

export function templateEntriesReader(server: ViteDevServer, root: string) {
  const pages = path.resolve(root, 'src', 'pages');
  return async (file: string): Promise<TemplateEntries> => {
    const pattern = routeFor(file);
    if (!file.startsWith('src/pages/') || !isTemplateRoute(pattern)) {
      return { entries: [], error: undefined }; // Only a page under src/pages has a route.
    }
    const absolute = path.resolve(root, file);
    assert(absolute.startsWith(pages + path.sep), 'A template is a page under src/pages');
    try {
      const loaded: Record<string, unknown> = await server.ssrLoadModule(absolute);
      const getStaticPaths = loaded['getStaticPaths'];
      if (typeof getStaticPaths !== 'function') {
        return { entries: [], error: `${path.basename(file)} has no getStaticPaths` };
      }
      const result: unknown = await withinTime(Promise.resolve(Reflect.apply(getStaticPaths, undefined, [])));
      return { entries: templateEntries(pattern, result), error: undefined };
    } catch (error: unknown) {
      return { entries: [], error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/** getStaticPaths' answer as entries: each with params, filled into the pattern. */
export function templateEntries(pattern: string, result: unknown): readonly TemplateEntry[] {
  assert(isTemplateRoute(pattern), 'Entries belong to a template route');
  const entries: TemplateEntry[] = [];
  const seen = new Set<string>();
  const items: readonly unknown[] = Array.isArray(result) ? result : [];
  for (let index = 0; index < items.length && entries.length < TEMPLATE_ENTRIES_MAX; index++) {
    const params = paramsOf(items[index]);
    if (params !== undefined) {
      const route = fillTemplateRoute(pattern, params);
      if (!seen.has(route)) {
        seen.add(route);
        const label = templateEntryLabel(pattern, params);
        // The first entries carry their props for the binding picker, as Desktop's do.
        const props = entries.length < ENTRY_PROPS_SAMPLED_MAX ? propsOf(items[index]) : undefined;
        entries.push(props === undefined ? { route, label } : { route, label, props });
      }
    }
  }
  assert(entries.length <= TEMPLATE_ENTRIES_MAX, 'Entries stay within their limit');
  return entries;
}

function propsOf(item: unknown): unknown {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const props: unknown = Reflect.get(item, 'props');
  return props === undefined ? undefined : sampleEntryProps(props, 0);
}

function paramsOf(item: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof item !== 'object' || item === null) {
    return undefined;
  }
  const params: unknown = Reflect.get(item, 'params');
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(params));
}

async function withinTime<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('getStaticPaths did not answer in time')), PATHS_MS_MAX);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
