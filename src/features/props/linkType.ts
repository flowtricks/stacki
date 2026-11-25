import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { ScanPage } from '../../../shared/properties/projectScan';
import { pageDisplayLabel } from '../../lib/pageName';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../shared/properties/i18n/messageRef';

// Which link-type tab an href opens on. The tab is a reading of the value, so
// it is a pure function of the value and of what the page and project hold:
// the field calls it when it opens and whenever the value changes from
// outside, never on the user's own keystrokes, so a tab the user picked stays.

export const LINK_TYPES = ['url', 'page', 'section', 'email', 'phone', 'asset'] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface LinkTypeContext {
  // The routes of the project's pages.
  readonly routes: readonly string[];
  // The ids on the current page, exactly as written.
  readonly sectionIds: readonly string[];
}

export type LinkPage = Pick<ScanPage, 'name' | 'route' | 'title'>;

export interface LinkPageOption {
  // The route, which is what the href stores.
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

// The Page tab lists pages exactly as the Pages panel does, so a page has one
// name in the app: the panel's name over the panel's route. A file name here
// would make `index` and "Home" read as two different pages.
export function linkPageOptions(pages: readonly LinkPage[], translate: Translator = ENGLISH_TRANSLATE): readonly LinkPageOption[] {
  assert(pages.length <= LIMITS.scanEntriesMax, 'linkPageOptions: page limit exceeded');
  return pages.map((page) => ({ value: page.route, label: pageDisplayLabel(page, translate), description: page.route }));
}

export function detectLinkType(text: string, context: LinkTypeContext): LinkType {
  assert(context.routes.length <= LIMITS.scanEntriesMax, 'detectLinkType: route limit exceeded');
  assert(context.sectionIds.length <= LIMITS.treeNodesMax, 'detectLinkType: section limit exceeded');
  if (text.length === 0) {
    return 'url';
  }
  if (text.startsWith('#')) {
    // A bare `#`, or a fragment no element on the page answers to, is a plain
    // URL: the Anchor tab could only show an empty choice for it. HTML ids are
    // case-sensitive, so the comparison is exact.
    if (anchorTargetExists(text, context.sectionIds)) {
      return 'section';
    }
    return 'url';
  }
  if (text.startsWith('mailto:')) {
    return 'email';
  }
  if (text.startsWith('tel:')) {
    return 'phone';
  }
  if (context.routes.includes(text)) {
    return 'page';
  }
  if (isAssetPath(text)) {
    return 'asset';
  }
  // After the asset test, so a file path never reads as a page: `/posts/hello` is an entry of `/posts/[slug]`.
  if (context.routes.some((route) => route.includes('[') && routeMatchesTemplate(text, route))) {
    return 'page';
  }
  return 'url';
}

/** The most path segments a route is compared on: deeper than any site serves. */
const ROUTE_SEGMENTS_MAX = 64;

/**
 * Whether `path` is an address of the template `pattern`: `/posts/hello` of `/posts/[slug]`. A `[name]`
 * segment takes one non-empty segment, `[...name]` one or more; every other segment must match exactly.
 */
export function routeMatchesTemplate(path: string, pattern: string): boolean {
  if (!path.startsWith('/')) {
    return false;
  }
  if (!pattern.startsWith('/')) {
    return false;
  }
  const have = path.split('/').slice(1);
  const want = pattern.split('/').slice(1);
  if (have.length > ROUTE_SEGMENTS_MAX) {
    return false;
  }
  if (want.length > ROUTE_SEGMENTS_MAX) {
    return false;
  }
  for (let index = 0; index < want.length; index += 1) {
    const segment = want[index] ?? '';
    const actual = have[index];
    if (/^\[\.\.\.[^\]]+\]$/.test(segment)) {
      // A rest segment must be last and takes the remaining segments, at least one.
      return index === want.length - 1 && have.slice(index).every((part) => part.length > 0) && actual !== undefined;
    }
    if (actual === undefined || actual.length === 0) {
      return false;
    }
    if (/^\[[^\]]+\]$/.test(segment)) {
      continue;
    }
    if (segment !== actual) {
      return false;
    }
  }
  return have.length === want.length;
}

// True when `text` is `#id` and `id` is one of the page's ids.
export function anchorTargetExists(text: string, sectionIds: readonly string[]): boolean {
  if (text.startsWith('#')) {
    const id = text.slice(1);
    if (id.length > 0) {
      return sectionIds.includes(id);
    }
    return false;
  }
  return false;
}

function isAssetPath(text: string): boolean {
  if (text.startsWith('/')) {
    return /\.[a-z0-9]+$/i.test(text);
  }
  return false;
}
