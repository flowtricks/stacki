import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Translator } from '../../../shared/properties/i18n/messageRef';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { DropdownOption } from '../../ui/Dropdown';
import { pageDisplayLabel } from '../../lib/pageName';
import { linkPageOptions, routeMatchesTemplate, type LinkPage } from './linkType';

// What the link field's Page tab lists for a template page (`/posts/[slug]`).
//
// A template is one file that renders a page per CMS entry, so linking to "the template" would write
// a pattern, not an address. The tab lists the entries instead: one row each, titled, over the
// concrete route the href stores, grouped under the template's name. The entries are the ones the
// canvas's own picker shows: the host asks the dev server to run the template's getStaticPaths (or
// reads EmDash for a page that declares none), so there is one source of entries, not two.
//
// This module is the pure half: it turns a host's answer into rows and holds the bounds. Nothing in
// it reads or writes the project; choosing a row only changes the href the caller commits.

/**
 * Where a Page-tab row comes from: a page file of its own (`page`), or a CMS template that renders it
 * per entry (`cms`). The menu draws the page icon or the CMS icon from it, so the two read apart.
 */
export type LinkChoiceSource = 'page' | 'cms';
/** One Page-tab row: a menu option that also says where its page comes from. */
export type LinkChoice = DropdownOption<string> & { readonly source: LinkChoiceSource };

/**
 * The most entry rows one template lists. Past it the group says how many more exist: a menu of
 * thousands is not a menu, and the host's list is capped for the same reason. Local to this feature:
 * shared/core/limits.ts changes only with a human's approval.
 */
export const LINK_ENTRIES_PER_TEMPLATE_MAX = 2_000;
/** The most entry rows across every template, so the menu's option count stays inside `scanEntriesMax` with the pages. */
export const LINK_ENTRIES_TOTAL_MAX = 8_000;
/** The most template pages whose entries are asked for at once. */
export const LINK_TEMPLATES_MAX = 200;
/** The most rows the menu draws at once; the rest are reached by typing (Dropdown's `rowsMax`). */
export const LINK_ROWS_DRAWN_MAX = 100;
/** Longer than any route a site serves. */
const ROUTE_CHARS_MAX = 2_048;
/** Longer than any title a row can show. */
const TITLE_CHARS_MAX = 200;
/** The most keys of an entry's props searched for a title. */
const PROP_KEYS_MAX = 8;

export interface LinkEntry {
  /** The concrete route the href stores: `/posts/my-first-post`. */
  readonly route: string;
  /** What the row is called: the entry's title when its props carry one, else its params' values. */
  readonly title: string;
}

export type LinkTemplateState =
  | { readonly kind: 'loading' }
  // `omitted` counts the entries left off by the per-template cap.
  | { readonly kind: 'ready'; readonly entries: readonly LinkEntry[]; readonly omitted: number }
  // The host could not resolve the template's entries: no dev server, a failing getStaticPaths.
  | { readonly kind: 'unavailable' };

export type LinkTemplateResolved = Exclude<LinkTemplateState, { readonly kind: 'loading' }>;

/** Asks the host for one template's entries, by the template's route. It never rejects: a failure is `unavailable`. */
export type LinkEntryLoader = (route: string) => Promise<LinkTemplateResolved>;

/** The shape of a host's answer (Desktop's `page:dynamicPaths`, Studio's page entries) that this module reads. */
export interface LinkPathsAnswer {
  readonly entries: ReadonlyArray<{ readonly route: string; readonly label: string; readonly props?: unknown }>;
  readonly error?: string | undefined;
}

/**
 * Turns a host's answer for `pattern` into the template's state. An entry whose route is not a
 * concrete address of this template (still a pattern, not a path, of another route, a duplicate)
 * is dropped rather than offered as a link that would not work.
 */
export function linkEntriesFromAnswer(pattern: string, answer: LinkPathsAnswer): LinkTemplateResolved {
  assert(pattern.includes('['), 'linkEntriesFromAnswer: the pattern is a template route');
  assert(answer.entries.length <= LIMITS.scanEntriesMax, 'linkEntriesFromAnswer: entry limit exceeded');
  const seen = new Set<string>();
  const entries: LinkEntry[] = [];
  let omitted = 0;
  for (const entry of answer.entries) {
    if (!isConcreteRoute(entry.route, pattern) || seen.has(entry.route)) {
      continue;
    }
    seen.add(entry.route);
    if (entries.length >= LINK_ENTRIES_PER_TEMPLATE_MAX) {
      omitted += 1;
      continue;
    }
    const title = entryTitle(entry.props) ?? entry.label.trim();
    entries.push({ route: entry.route, title: (title.length > 0 ? title : entry.route).slice(0, TITLE_CHARS_MAX) });
  }
  if (entries.length === 0) {
    // An answer with an error, or with nothing usable, resolves nothing: the template stays a template row.
    return { kind: 'unavailable' };
  }
  assert(entries.length <= LINK_ENTRIES_PER_TEMPLATE_MAX, 'linkEntriesFromAnswer: the cap holds');
  return { kind: 'ready', entries, omitted };
}

function isConcreteRoute(route: string, pattern: string): boolean {
  if (route.length === 0) {
    return false;
  }
  if (route.length > ROUTE_CHARS_MAX) {
    return false;
  }
  if (!route.startsWith('/')) {
    return false;
  }
  if (route.includes('[')) {
    return false;
  }
  if (/[\s?#]/.test(route)) {
    return false;
  }
  return routeMatchesTemplate(route, pattern);
}

/** An entry's title, read from the usual places its props hold one; undefined when none is a non-empty string. */
export function entryTitle(props: unknown): string | undefined {
  const own = titleIn(props);
  if (own !== undefined) {
    return own;
  }
  if (typeof props !== 'object' || props === null || Array.isArray(props)) {
    return undefined;
  }
  // `getStaticPaths` usually passes one object (`post`, `entry`): look one level down.
  for (const key of Object.keys(props).slice(0, PROP_KEYS_MAX)) {
    const nested = titleIn(Reflect.get(props, key));
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function titleIn(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const direct = nonEmptyText(Reflect.get(value, 'title')) ?? nonEmptyText(Reflect.get(value, 'name'));
  if (direct !== undefined) {
    return direct;
  }
  const data: unknown = Reflect.get(value, 'data');
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    return nonEmptyText(Reflect.get(data, 'title')) ?? nonEmptyText(Reflect.get(data, 'name'));
  }
  return undefined;
}

function nonEmptyText(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * The Page tab's rows. Static pages come first, as they always did; each template then follows as a
 * group of its entries. A template with no resolved entries stays one row of its own (muted note),
 * and a template still loading draws no rows yet: the menu paints the pages at once and shows
 * skeleton rows for the rest. `current` is the href as written: a concrete address of a template
 * that its entries do not list (not loaded yet, or removed since) still shows, so the field never
 * claims nothing is chosen.
 */
export function linkChoices(
  pages: readonly LinkPage[],
  states: ReadonlyMap<string, LinkTemplateState>,
  current: string,
  translate: Translator = ENGLISH_TRANSLATE,
): readonly LinkChoice[] {
  assert(pages.length <= LIMITS.scanEntriesMax, 'linkChoices: page limit exceeded');
  const templates = pages.filter((page) => isTemplatePage(page));
  assert(templates.length <= pages.length, 'linkChoices: templates are a subset of pages');
  const rows: LinkChoice[] = linkPageOptions(
    pages.filter((page) => !isTemplatePage(page)),
    translate,
  ).map((option) => ({ value: option.value, label: option.label, description: option.description, keywords: option.value, source: 'page' }));
  let entryRows = 0;
  for (const page of templates) {
    const group = pageDisplayLabel(page, translate);
    const state = states.get(page.route);
    if (state?.kind === 'ready') {
      entryRows += appendEntries(rows, group, state, entryRows);
    } else if (state?.kind === 'loading') {
      appendCurrent(rows, group, page.route, current);
    } else {
      rows.push(templateRow(page, group, translate));
    }
  }
  assert(rows.length <= LIMITS.scanEntriesMax, 'linkChoices: row limit exceeded');
  return rows;
}

function appendEntries(rows: LinkChoice[], group: string, state: Extract<LinkTemplateState, { readonly kind: 'ready' }>, alreadyListed: number): number {
  const room = Math.max(0, LINK_ENTRIES_TOTAL_MAX - alreadyListed);
  const shown = state.entries.slice(0, room);
  for (const entry of shown) {
    rows.push({ value: entry.route, label: entry.title, description: entry.route, group, keywords: entry.route, source: 'cms' });
  }
  assert(shown.length <= room, 'appendEntries: the total cap holds');
  return shown.length;
}

// While a template's entries load, the href already written to one of them still shows as the chosen row.
function appendCurrent(rows: LinkChoice[], group: string, pattern: string, current: string): void {
  if (routeMatchesTemplate(current, pattern)) {
    rows.push({ value: current, label: current, description: current, group, keywords: current, source: 'cms' });
  }
}

function templateRow(page: LinkPage, group: string, translate: Translator): LinkChoice {
  return {
    value: page.route,
    label: group,
    description: page.route,
    hint: translate('props.link.templateUnresolved'),
    keywords: page.route,
    source: 'cms',
  };
}

/** Whether a page is a template: its route is a pattern, not an address. */
export function isTemplatePage(page: Pick<LinkPage, 'route'>): boolean {
  return page.route.includes('[');
}

/** The entries of the template at `route` that still need asking for, in page order, within the bound. */
export function templatesToLoad(pages: readonly LinkPage[]): readonly string[] {
  const routes = pages.filter((page) => isTemplatePage(page)).map((page) => page.route);
  assert(routes.length <= LINK_TEMPLATES_MAX || pages.length > 0, 'templatesToLoad: routes come from the pages');
  return routes.slice(0, LINK_TEMPLATES_MAX);
}
