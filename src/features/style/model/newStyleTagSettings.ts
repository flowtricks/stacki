// The project's new-style locations as the Style panel's writers read them.
//
// The setting lives in `.stacki/styles.json` (shared/properties/newStyleLocations.ts) and is read
// asynchronously; the panel's writers are synchronous, so the last value read is held here, the
// way host.ts holds the app state. Until a read lands, and in a project that never wrote the
// section, it is Stacki's default: a `<style is:global>` tag holding just the rules, for a page and
// for a component. The Settings page publishes a change here as it saves it, so the next write
// already uses it. The project's stylesheets are held beside it, because a chosen file is honoured
// only while it exists (newStyleLocations.ts effectiveLocation).

import {
  DEFAULT_NEW_STYLE_LOCATIONS,
  effectiveLocation,
  fileRuleWrappers,
  sameNewStyleLocations,
  type NewStyleLocation,
  type NewStyleLocations,
  type NewStyleScope,
} from '../../../../shared/properties/newStyleLocations';
import { templateFrame, type NewStyleTagSettings, type TemplateFrame, type TemplateWrapper } from '../../../../shared/properties/newStyleTag';
import { getHost } from './host';

let current: NewStyleLocations = DEFAULT_NEW_STYLE_LOCATIONS;
const listeners = new Set<() => void>();

export function getNewStyleLocations(): NewStyleLocations {
  return current;
}

export function publishNewStyleLocations(next: NewStyleLocations): void {
  if (sameNewStyleLocations(next, current)) {
    return;
  }
  current = next;
  for (const listener of listeners) {
    listener();
  }
}

export function onNewStyleLocations(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The scope the open file writes in: a component file is `component`, anything else `page`. */
export function openStyleScope(): NewStyleScope {
  return getHost().openFileKind === 'component' ? 'component' : 'page';
}

/** The location of a scope; the open file's scope when none is named. */
export function getNewStyleLocation(scope: NewStyleScope = openStyleScope()): NewStyleLocation {
  return current[scope];
}

/** What a `<style>` tag created in `scope` starts with (the scope's tag default, whatever place is chosen). */
export function getNewStyleTagSettings(scope: NewStyleScope = openStyleScope()): NewStyleTagSettings {
  return current[scope].tag;
}

/**
 * The project-relative stylesheet new styles of `scope` go to, or undefined for a style tag. The
 * chosen file counts only while it is among the project's stylesheets (`rels`), so a writer never
 * targets a path it did not find.
 */
export function newStyleFileOf(scope: NewStyleScope, rels: readonly string[]): string | undefined {
  const place = effectiveLocation(current[scope], rels);
  return place.kind === 'file' ? place.path : undefined;
}

/** The template's frame; the stored template always parses (the file parser refuses one that does not), so a failure is a bug. */
export function newStyleTagFrame(settings: NewStyleTagSettings = getNewStyleTagSettings()): TemplateFrame {
  const result = templateFrame(settings.content);
  if (!result.ok) {
    throw new Error(`Assertion failed: the stored new style tag template parses (${result.error.code})`);
  }
  return result.frame;
}

/**
 * The blocks a first rule written into `source` goes inside. A `<style>` tag follows its scope's
 * template. A stylesheet follows its own layers or marker only when it is the file the open scope
 * chose; every other stylesheet gets no wrapper, so it is written exactly as before the choice
 * existed. `code` is what the source holds now.
 */
export function newRuleWrappers(source: { readonly origin: { readonly kind: string }; readonly label: string }, code: string): readonly TemplateWrapper[] {
  if (source.origin.kind === 'node') {
    return newStyleTagFrame().wrappers;
  }
  if (source.origin.kind !== 'file') {
    return [];
  }
  const chosen = newStyleFileOf(
    openStyleScope(),
    getHost().files.map((file) => file.rel),
  );
  return chosen !== undefined && chosen === source.label ? fileRuleWrappers(code) : [];
}
