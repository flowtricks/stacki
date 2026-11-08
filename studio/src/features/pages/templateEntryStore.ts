// Which entry of a template page the canvas shows. A template (`[...slug].astro`) has a
// route pattern, not an address, so the canvas renders one of its entries; the editor
// edits the template, and the entry only changes the data it renders with. Desktop keeps
// the same choice in its app state (`dynamicPaths` and `dynamicIndex`, src/app/state).
//
// The choice is read in three places that do not share React state: the canvas (which
// address to load), the title bar's picker, and the page address the demo keeps in step.
// So it lives here, in one store: one entry list and one chosen route per template file.
import { useEffect, useSyncExternalStore } from 'react';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { request, routeFor } from '../project/projectClient';
import { isTemplateRoute, parseTemplateEntries, type TemplateEntries } from './templateRoutes';

/** More templates than a project has pages: the store holds one record per template file. */
const TEMPLATES_MAX = 2_000;

export type TemplateEntriesState = { readonly kind: 'loading' } | { readonly kind: 'ready'; readonly value: TemplateEntries };

const entriesByFile = new Map<string, TemplateEntriesState>();
const chosenByFile = new Map<string, string>();
// One read per template at a time: the canvas and the address both ask when a template opens.
const reading = new Set<string>();
const listeners = new Set<() => void>();
let revision = 0;

function changed(): void {
  assert(revision < Number.MAX_SAFE_INTEGER, 'The store revision stays a safe integer');
  revision += 1;
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a page file is a template, whose canvas shows one of its entries. */
export function isTemplateFile(file: string): boolean {
  return file.startsWith('src/pages/') && isTemplateRoute(routeFor(file));
}

/** Shows `route` for the template `file`. An address, a canvas link or the picker chose it. */
export function chooseTemplateEntry(file: string, route: string): void {
  assert(isTemplateFile(file), 'Only a template has entries to choose');
  assert(route.startsWith('/'), 'An entry route is a site path');
  if (chosenByFile.get(file) === route) {
    return;
  }
  assert(chosenByFile.size < TEMPLATES_MAX || chosenByFile.has(file), 'The store holds one choice per template');
  chosenByFile.set(file, route);
  changed();
}

/**
 * The route the canvas loads for a page file: its own route, or the chosen entry's when it
 * is a template. Undefined while a template has no entry to show yet.
 */
export function canvasRouteFor(file: string): string | undefined {
  return isTemplateFile(file) ? chosenByFile.get(file) : routeFor(file);
}

/** `canvasRouteFor`, kept current, and the template's entries read when it opens. */
export function useCanvasRoute(file: string, enabled = true): string | undefined {
  useSyncExternalStore(subscribe, () => revision);
  useEffect(() => {
    if (enabled && isTemplateFile(file)) {
      loadTemplateEntries(file);
    }
  }, [file, enabled]);
  return canvasRouteFor(file);
}

/** The template's entries and the chosen one, for the title bar's picker. */
export function useTemplateEntries(file: string): { readonly state: TemplateEntriesState; readonly route: string | undefined } | undefined {
  useSyncExternalStore(subscribe, () => revision);
  if (!isTemplateFile(file)) {
    return undefined;
  }
  return { state: entriesByFile.get(file) ?? { kind: 'loading' }, route: chosenByFile.get(file) };
}

/**
 * Reads the template's entries again (getStaticPaths may have changed), keeping the chosen
 * entry when it is still one of them and showing the first one otherwise, as Desktop does.
 */
export function loadTemplateEntries(file: string): void {
  assert(isTemplateFile(file), 'Only a template has entries to read');
  if (!entriesByFile.has(file)) {
    assert(entriesByFile.size < TEMPLATES_MAX, 'The store holds one entry list per template');
    entriesByFile.set(file, { kind: 'loading' });
    changed();
  }
  if (reading.has(file)) {
    return;
  }
  reading.add(file);
  void request('/studio/api/page-entries?page=' + encodeURIComponent(file))
    .then(parseTemplateEntries)
    .catch((error: unknown): TemplateEntries => ({ entries: [], error: error instanceof Error ? error.message : String(error) }))
    .then((value) => {
      reading.delete(file);
      settleTemplateEntries(file, value);
    });
}

/** Stores a template's entries and makes sure the canvas has one of them to show. */
export function settleTemplateEntries(file: string, value: TemplateEntries): void {
  assert(isTemplateFile(file), 'Only a template has entries');
  entriesByFile.set(file, { kind: 'ready', value });
  const chosen = chosenByFile.get(file);
  const first = value.entries[0];
  if (first !== undefined && !value.entries.some((entry) => entry.route === chosen)) {
    chosenByFile.set(file, first.route);
  }
  changed();
}

/**
 * The props of the entry the canvas shows, sampled, for the binding picker: a template's
 * data is its entry's Astro.props (`doc` and its fields), as Desktop reads it from
 * `dynamicPaths[dynamicIndex].props`. Undefined for a file that is not a template, or
 * before its entries arrive.
 */
export function useTemplateEntryProps(file: string): unknown {
  const template = useTemplateEntries(file);
  if (template === undefined || template.state.kind === 'loading') {
    return undefined;
  }
  return template.state.value.entries.find((entry) => entry.route === template.route)?.props;
}
