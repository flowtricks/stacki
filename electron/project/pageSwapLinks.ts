// The links of a homepage swap: `/` becomes the other page's route and that route becomes `/`, in one pass over
// each file so no link is swapped twice (a second pass would swap it back). Literal links only, never project
// JavaScript interpreted: the same contexts a page rename rewrites (pageRenameLinks.ts) — attributes, Markdown
// destinations, sitemap locations and string literals — with one difference. A bare `'/'` string is everywhere in
// code (`split('/')`, `endsWith('/')`), so it is read as the homepage only where a key names a link
// (`href: '/'`, `"url": "/"`, `to="/"`); anywhere else it is left alone.
import { assert } from '../../shared/core/assert';
import { pageURLPath } from '../../shared/properties/pageRename';

export interface SwapRoutes {
  /** The route that leaves `/` and the one that arrives: the other page's route, `/about`. */
  readonly other: string;
  /** The site's `base` (astro.config), without a trailing slash; '' when the site sits at the root. */
  readonly base: string;
  /** `always` when astro.config asks for trailing slashes, so the old homepage's links read `/about/`. */
  readonly trailing: 'always' | 'as-written';
  /** Site origins a link may name absolutely (astro.config `site`, the publish settings). */
  readonly origins: readonly string[];
}

export interface SwapLinkContext {
  readonly routes: SwapRoutes;
  /** The file, relative to the project root, with forward slashes. */
  readonly file: string;
  /** For the two pages that move, their route before and after: relative links in them are resolved against it. */
  readonly owner: { readonly before: string; readonly after: string } | undefined;
}

export interface SwapLinkResult {
  readonly text: string;
  readonly links: number;
}

const LINK_KEY_BEFORE = /(?:\b(?:href|url|link|to|path|permalink|canonical)\s*[:=]\s*\{?\s*|["'](?:href|url|link|to|path|permalink|canonical)["']\s*:\s*)$/i;
const CONTEXT_CHARS = 48;
const SOURCE_CHARS_MAX = 5_000_000;
const LINK_CHARS_MAX = 32_768;

/**
 * One left-to-right scan of four alternatives, each match handled once:
 *   1 2 3  an `href`/`action` attribute with a quoted value
 *   4 5    any other string literal (code files only)
 *   6      a Markdown destination `](…)`
 *   7      an unquoted `href=`/`src=`/`action=` value
 *   8      a sitemap `<loc>`
 */
const SCANNER_CODE =
  /(\b(?:href|action)\s*=\s*)(["'])([^"'\r\n]*)\2|(["'`])((?:\\[\s\S]|(?!\4)[^\\])*)\4|\]\(\s*([^\s<>"'`)]+)|\b(?:href|src|action)=([^\s<>"'`)]+)|<loc>([^\s<]+)/g;
const SCANNER_PROSE = /(\b(?:href|action)\s*=\s*)(["'])([^"'\r\n]*)\2|()()\]\(\s*([^\s<>"'`)]+)|\b(?:href|src|action)=([^\s<>"'`)]+)|<loc>([^\s<]+)/g;

export function swapPageLinks(source: string, context: SwapLinkContext): SwapLinkResult {
  assert(source.length <= SOURCE_CHARS_MAX, 'Swap links: source size is bounded');
  assert(context.routes.other !== '/', 'Swap links: the other route is not the homepage');
  assert(context.routes.origins.length <= 32, 'Swap links: origin count is bounded');
  // Prose files hold apostrophes, which a string-literal reading would pair across whole paragraphs.
  const prose = /\.(md|markdown|txt)$/i.test(context.file);
  const scanner = new RegExp((prose ? SCANNER_PROSE : SCANNER_CODE).source, 'g');
  let links = 0;
  const text = source.replace(scanner, (...groups: readonly unknown[]) => {
    const match = String(groups[0]);
    const offset = typeof groups[9] === 'number' ? groups[9] : 0;
    const swapped = swapMatch(match, groups, offset, source, context);
    if (swapped !== match) {
      links += 1;
    }
    return swapped;
  });
  assert(links >= 0, 'Swap links: a count is never negative');
  return { text, links };
}

function swapMatch(match: string, groups: readonly unknown[], offset: number, source: string, context: SwapLinkContext): string {
  const piece = (index: number): string | undefined => (typeof groups[index] === 'string' ? groups[index] : undefined);
  const attribute = piece(3);
  if (attribute !== undefined) {
    return (piece(1) ?? '') + (piece(2) ?? '') + swapLink(attribute, context, { kind: 'link' }) + (piece(2) ?? '');
  }
  const literal = piece(5);
  if (literal !== undefined && piece(4) !== undefined && piece(4) !== '') {
    const quote = piece(4) ?? '';
    const before = source.slice(Math.max(0, offset - CONTEXT_CHARS), offset);
    const keyed = LINK_KEY_BEFORE.test(before);
    const escaped = literal.includes('\\/');
    const plain = escaped ? literal.replace(/\\\//g, '/') : literal;
    const next = swapLink(plain, context, { kind: keyed ? 'link' : 'string' });
    return quote + (escaped ? next.replace(/\//g, '\\/') : next) + quote;
  }
  const destination = piece(6);
  if (destination !== undefined) {
    return match.slice(0, match.length - destination.length) + swapLink(destination, context, { kind: 'link' });
  }
  const unquoted = piece(7);
  if (unquoted !== undefined) {
    return match.slice(0, match.length - unquoted.length) + swapLink(unquoted, context, { kind: 'link' });
  }
  const location = piece(8);
  if (location !== undefined) {
    return '<loc>' + swapLink(location, context, { kind: 'link' });
  }
  return match;
}

/** Where a value sits: a link context, where `/` is the homepage, or a bare string, where only the other route is. */
type ValueKind = { readonly kind: 'link' | 'string' };

export function swapLink(value: string, context: SwapLinkContext, where: ValueKind): string {
  if (value.length === 0 || value.length > LINK_CHARS_MAX || /[\s]/.test(value)) {
    return value;
  }
  const absolute = /^(https?:\/\/[^/?#]+)(\/[^]*)?$/.exec(value);
  if (absolute) {
    const origin = absolute[1] ?? '';
    const suffix = absolute[2];
    if (suffix === undefined || !context.routes.origins.includes(origin)) {
      return value;
    }
    // A full address of this site is a link wherever it is written: nothing else looks like one.
    return origin + swapPath(suffix, context.routes, 'link');
  }
  if (value.startsWith('//')) {
    return value;
  }
  if (value.startsWith('/')) {
    return swapPath(value, context.routes, where.kind);
  }
  return swapRelative(value, context, where);
}

// A relative link in one of the two moving pages points somewhere from where the page was; once it moves, it is
// written as the root-relative link it meant, the way a page rename does.
function swapRelative(value: string, context: SwapLinkContext, where: ValueKind): string {
  const owner = context.owner;
  if (owner === undefined || where.kind !== 'link') {
    return value;
  }
  if (value.startsWith('#') || value.startsWith('?') || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('{')) {
    return value;
  }
  if (/\.(astro|mdx?|[cm]?[jt]sx?|css|json|svg|png|jpe?g|webp|gif|avif)(?:[?#]|$)/i.test(value)) {
    return value;
  }
  const base = 'https://stacki.invalid' + context.routes.base + (owner.before === '/' ? '/' : owner.before);
  const resolved = new URL(value, base);
  const meant = resolved.pathname + resolved.search + resolved.hash;
  return swapPath(meant, context.routes, 'link');
}

function swapPath(value: string, routes: SwapRoutes, kind: 'link' | 'string'): string {
  const boundary = value.search(/[?#]/);
  const pathname = boundary < 0 ? value : value.slice(0, boundary);
  const suffix = boundary < 0 ? '' : value.slice(boundary);
  const inside = withinBase(pathname, routes.base);
  if (inside === undefined) {
    return value;
  }
  if (inside === '/') {
    if (kind === 'string') {
      // A bare '/' in code is a path separator far more often than the homepage.
      return value;
    }
    const target = routes.other + (routes.trailing === 'always' ? '/' : '');
    return routes.base + target + suffix;
  }
  const trimmed = inside.endsWith('/') ? inside.slice(0, -1) : inside;
  if (trimmed === routes.other) {
    return (routes.base === '' ? '/' : routes.base + '/') + suffix;
  }
  return value;
}

// The path below the site's base, or undefined for a path outside it (another app on the same host).
function withinBase(pathname: string, base: string): string | undefined {
  if (base === '') {
    return pathname;
  }
  if (pathname === base) {
    return '/';
  }
  if (pathname.startsWith(base + '/')) {
    return pathname.slice(base.length);
  }
  return undefined;
}

/** The route a page file answers at, for the owner context: `/` for the homepage. */
export function ownerRoute(page: string): string {
  return pageURLPath(page);
}
