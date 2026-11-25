// A template page is a dynamic route (`src/pages/docs/[...slug].astro`): one file that
// renders a page per entry its getStaticPaths returns. Its route is a pattern, so the
// canvas shows one entry at a time, and the editor edits the template the entries share.
// This module is the routes' arithmetic and the wire contract for a template's entries,
// shared by the server (templateEntriesServer.ts), the client (templateEntryStore.ts),
// the bake (bakeTemplates.ts) and the static demo. It runs in Node and in the browser.
//
// Desktop answers the same question through its dev server's /__avb/paths route
// (electron/preview/markerConfig.ts, electron/handlers/pageHandlers.ts); the label and
// the filled route are the ones Desktop's picker shows (src/app/DynamicPicker.tsx).
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { parseEntryProps } from './entryPropsSample';

/** More entries than any picker is useful for; a template past it lists the first ones. */
export const TEMPLATE_ENTRIES_MAX = 500;
/** Longer than any route or label a site has. */
const TEMPLATE_TEXT_MAX = 1_000;
/** Deeper than any route a site serves. */
const ROUTE_SEGMENTS_MAX = 64;

export interface TemplateEntry {
  /** The concrete route this entry renders at: `/docs/introduction`. */
  readonly route: string;
  /** What the picker shows: the params' values, as Desktop shows them. */
  readonly label: string;
  /**
   * A sample of the entry's props (its Astro.props, from getStaticPaths), which the
   * binding picker reads as the template's data: `doc.data.title` and its value.
   */
  readonly props?: unknown;
}

export interface TemplateEntries {
  readonly entries: readonly TemplateEntry[];
  /** Why the entries could not be read; the picker shows it instead of the list. */
  readonly error: string | undefined;
}

/** Whether a route is a pattern (`/docs/[...slug]`) rather than one page's address. */
export function isTemplateRoute(route: string): boolean {
  return route.includes('[');
}

/** The params a concrete path fills a pattern with, or undefined when it does not match. */
export function matchTemplateRoute(pattern: string, path: string): Readonly<Record<string, string>> | undefined {
  assert(pattern.startsWith('/'), 'A route pattern is a site path');
  assert(path.startsWith('/'), 'A matched route is a site path');
  const names: string[] = [];
  const segments = trimSlash(pattern).split('/');
  if (segments.length > ROUTE_SEGMENTS_MAX) {
    return undefined;
  }
  const source = segments.map((segment) => {
    const rest = /^\[\.\.\.([^\]]+)\]$/.exec(segment);
    if (rest !== null) {
      names.push(rest[1] ?? '');
      return '(?:/(.*))?';
    }
    // A segment may mix text and parameters (`post-[id]`).
    const parts = segment.split(/(\[[^\]]+\])/).map((part) => {
      const param = /^\[([^\]]+)\]$/.exec(part);
      if (param === null) {
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
      names.push(param[1] ?? '');
      return '([^/]+)';
    });
    return segment === '' ? '' : `/${parts.join('')}`;
  });
  const match = new RegExp(`^${source.join('')}$`).exec(trimSlash(path) === '/' ? '' : trimSlash(path));
  if (match === null) {
    return undefined;
  }
  const params: Record<string, string> = {};
  names.forEach((name, index) => {
    const value = match[index + 1];
    if (value !== undefined && value !== '') {
      params[name] = decodeSegments(value);
    }
  });
  return params;
}

/** The picker's label for an entry: its params' values, as Desktop's picker shows them. */
export function templateEntryLabel(pattern: string, params: Readonly<Record<string, unknown>>): string {
  const label = Object.values(params)
    .filter((value) => value !== undefined && value !== null)
    .map(String)
    .join(' / ');
  return (label || pattern).slice(0, TEMPLATE_TEXT_MAX);
}

/**
 * A pattern filled in with one entry's params: `/posts/[slug]` + `{ slug: 'a' }` is
 * `/posts/a`. A rest param holds a run of segments, and a missing one collapses. The
 * same rule as Desktop's `fillRoute` (electron/documents/pageRequests.ts).
 */
export function fillTemplateRoute(pattern: string, params: Readonly<Record<string, unknown>>): string {
  assert(pattern.startsWith('/'), 'A route pattern is a site path');
  const filled = pattern.replace(/\[(\.\.\.)?([^\]]+)\]/g, (_match: string, _rest: string | undefined, name: string) => {
    const value = params[name];
    if (value === undefined || value === null) {
      return '';
    }
    return String(value)
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
  });
  const route = filled.replace(/\/{2,}/g, '/').replace(/(.)\/$/, '$1');
  assert(route.startsWith('/'), 'A filled route is a site path');
  return route;
}

/** The page file a route opens, and the entry it stands for when that file is a template. */
export function pageForRoute(
  files: readonly string[],
  route: string,
  routeFor: (file: string) => string,
): { readonly file: string; readonly entry: string | undefined } | undefined {
  const target = trimSlash(route);
  const exact = files.find((file) => trimSlash(routeFor(file)) === target);
  if (exact !== undefined) {
    return { file: exact, entry: undefined };
  }
  // The most specific template wins, as Astro ranks them: fewer rest params, then more text.
  const templates = files
    .filter((file) => isTemplateRoute(routeFor(file)) && matchTemplateRoute(routeFor(file), target) !== undefined)
    .sort((a, b) => templateRank(routeFor(a)) - templateRank(routeFor(b)));
  const file = templates[0];
  return file === undefined ? undefined : { file, entry: target };
}

/** The wire answer for a template's entries, checked and bounded. */
export function parseTemplateEntries(input: unknown): TemplateEntries {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Template entries: expected an object');
  }
  const entries: unknown = Reflect.get(input, 'entries');
  const error: unknown = Reflect.get(input, 'error');
  if (!Array.isArray(entries)) {
    throw new Error('Template entries: expected a list');
  }
  if (entries.length > TEMPLATE_ENTRIES_MAX) {
    throw new Error('Template entries: the list exceeds its limit');
  }
  return {
    entries: entries.map((entry: unknown) => parseTemplateEntry(entry)),
    error: typeof error === 'string' && error.length > 0 ? error.slice(0, TEMPLATE_TEXT_MAX) : undefined,
  };
}

function parseTemplateEntry(input: unknown): TemplateEntry {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Template entry: expected an object');
  }
  const route: unknown = Reflect.get(input, 'route');
  const label: unknown = Reflect.get(input, 'label');
  if (typeof route !== 'string' || !route.startsWith('/') || route.startsWith('//') || route.length > TEMPLATE_TEXT_MAX) {
    throw new Error('Template entry: expected a site route');
  }
  if (isTemplateRoute(route)) {
    throw new Error('Template entry: expected a concrete route, not a pattern');
  }
  if (typeof label !== 'string' || label.length > TEMPLATE_TEXT_MAX) {
    throw new Error('Template entry: expected a label');
  }
  const props = parseEntryProps(Reflect.get(input, 'props'));
  return props === undefined ? { route, label } : { route, label, props };
}

function templateRank(pattern: string): number {
  const rests = (pattern.match(/\[\.\.\./g) ?? []).length;
  const params = (pattern.match(/\[/g) ?? []).length;
  return rests * 10_000 + params * 100 - pattern.replace(/\[[^\]]*\]/g, '').length;
}

function decodeSegments(value: string): string {
  try {
    return value
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/');
  } catch {
    return value; // A malformed escape is kept as the address wrote it.
  }
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}
