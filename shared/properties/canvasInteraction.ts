import { LIMITS } from '../core/limits';
// A canvas stays an editor surface while its pointer switches between selecting and using the site.
export type CanvasInteraction = 'select' | 'interact';

export function parseCanvasInteraction(input: unknown): CanvasInteraction | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:interaction') {
    return undefined;
  }
  if ('mode' in input && (input.mode === 'select' || input.mode === 'interact')) {
    return input.mode;
  }
  return undefined;
}

export function parseCanvasNavigation(input: unknown): string | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:navigated') {
    return undefined;
  }
  if (!('path' in input) || typeof input.path !== 'string') {
    return undefined;
  }
  const path = input.path;
  if (path.length > 4000 || !path.startsWith('/') || path.startsWith('//')) {
    return undefined;
  }
  if (/[\\\x00-\x20]/.test(path)) {
    return undefined;
  }
  return path;
}

// A frame announces it is unloading, so the host can drop outlines drawn for a
// document that is going away and notice when the next one is not the site's.
export function parseCanvasLeaving(input: unknown): boolean {
  if (typeof input !== 'object' || input === null) {
    return false;
  }
  return 'type' in input && input.type === 'avb:leaving';
}

/** The site's own pages, as the host tells a canvas frame: what a same-origin link may navigate to. */
export interface CanvasSitePages {
  /** The path the frame's pages are served under: '' at the site root, `/demo/site` in the static demo. */
  readonly base: string;
  /** Each page's route, `[param]` and `[...rest]` segments included. */
  readonly routes: readonly string[];
}

const SITE_PATH_CHARS_MAX = 1000;

export function parseCanvasSitePages(input: unknown): CanvasSitePages | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  if (!('type' in input) || input.type !== 'avb:site-pages') {
    return undefined;
  }
  if (!('base' in input) || !('routes' in input) || !Array.isArray(input.routes)) {
    return undefined;
  }
  const base = input.base;
  if (typeof base !== 'string' || base.length > SITE_PATH_CHARS_MAX || (base !== '' && !sitePath(base))) {
    return undefined;
  }
  const values: readonly unknown[] = input.routes;
  if (values.length > LIMITS.scanEntriesMax) {
    return undefined;
  }
  const routes: string[] = [];
  for (const route of values) {
    if (typeof route !== 'string' || !sitePath(route)) {
      return undefined;
    }
    routes.push(route);
  }
  return { base, routes };
}

function sitePath(value: string): boolean {
  if (value.length > SITE_PATH_CHARS_MAX || !value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  return !/[\\\x00-\x20]/.test(value);
}

/**
 * Whether a pathname the frame would load is one of the site's pages. The base
 * comes off first; `[param]` matches one segment and `[...rest]` any number,
 * as Astro routes them. Trailing slashes are not significant.
 */
export function isCanvasSitePage(pathname: string, pages: CanvasSitePages): boolean {
  const relative = pages.base !== '' && (pathname === pages.base || pathname.startsWith(`${pages.base}/`)) ? pathname.slice(pages.base.length) : pathname;
  const path = trimSlash(relative);
  for (const route of pages.routes.slice(0, LIMITS.scanEntriesMax)) {
    if (routePattern(trimSlash(route)).test(path)) {
      return true;
    }
  }
  return false;
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '') || '/';
}

function routePattern(route: string): RegExp {
  const segments = route.split('/').map((segment) => {
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      return '.*';
    }
    // A segment may mix text and parameters (`post-[id]`).
    return segment
      .split(/(\[[^\]]+\])/)
      .map((part) => (/^\[[^\]]+\]$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
  });
  return new RegExp(`^${segments.join('/')}$`.replace('/.*$', '(?:/.*)?$'));
}
