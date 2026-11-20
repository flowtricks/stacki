// Where a style goes when the Style panel creates one: the `newStyleLocations` section of
// `.stacki/styles.json`. Two scopes, because a page and a component are written differently:
//
// - `page`: a style created while a page is open.
// - `component`: a style created while a component is open, and the style tag a component made by
//   "Create component" starts with.
//
// Each scope chooses ONE of two places:
//
// - `tag`: a `<style>` tag in the open file, started from the scope's own default content
//   (newStyleTag.ts: attributes and template). This is what every project did before the choice
//   existed.
// - `file`: an existing stylesheet of the project, named by its project-relative path. The new rule
//   is appended to that file (placement below). The scope's tag default is kept beside it: it is
//   what a new tag starts with if the person switches back, and what is used while the file is
//   missing, so a missing file never makes a style unwritable and Stacki never writes to a path it
//   did not find.
//
// File shape (versioned, hand-readable):
//
//   "newStyleLocations": {
//     "version": 1,
//     "page":      { "use": "tag", "tag": { "version": 2, "attributes": "is:global", "content": "..." } },
//     "component": { "use": "file", "file": "src/styles/components.css", "tag": { "version": 2, "attributes": "is:global" } }
//   }
//
// Migration: a project that only holds the older single `newStyleTag` section reads as that tag for
// BOTH scopes (`locationsOfLegacy`), so nothing changes until a person changes a setting. The first
// save writes this section and mirrors the page's tag into `newStyleTag`, so an older Stacki that
// does not know this section still reads a sensible template.
//
// Placement in a file (`fileRuleWrappers`), one place so Desktop, Studio and the tests agree:
//
// 1. A `/* stacki:rules */` marker in the file names where rules go: the wrapper chain it sits in.
// 2. Without a marker, a file whose LAST top-level construct is an `@layer` block takes new rules
//    inside that block, after what it holds. Only `@layer`: a stylesheet that ends in an `@media`
//    or `@supports` block holds responsive overrides, and a base rule written inside it would
//    silently become conditional.
// 3. Anything else (no layer, an empty file, a file that is not balanced CSS) appends at the top level.
//
// Stacki never wraps, moves or rewrites a rule a person wrote; it only adds one.
import { assert } from '../core/assert';
import { record, text } from '../core/boundary';
import {
  DEFAULT_NEW_STYLE_TAG,
  NEW_STYLE_TAG_RULES_TOKEN,
  newStyleTagDocument,
  parseNewStyleTag,
  sameNewStyleTag,
  templateFrame,
  type NewStyleTagSettings,
  type TemplateWrapper,
} from './newStyleTag';

export const NEW_STYLE_LOCATION_LIMITS = {
  /** Characters in one project-relative stylesheet path. */
  pathCharsMax: 512,
  /** Folder levels in one stylesheet path; deeper paths are not project stylesheets. */
  pathSegmentsMax: 32,
} as const satisfies Record<string, number>;

/** The two places a style can be created from. */
export const NEW_STYLE_SCOPES = ['page', 'component'] as const;
export type NewStyleScope = (typeof NEW_STYLE_SCOPES)[number];

/** Where a scope's new styles go. `tag` always holds the default a `<style>` tag starts with. */
export type NewStyleLocation =
  { readonly kind: 'tag'; readonly tag: NewStyleTagSettings } | { readonly kind: 'file'; readonly path: string; readonly tag: NewStyleTagSettings };

export interface NewStyleLocations {
  readonly page: NewStyleLocation;
  readonly component: NewStyleLocation;
}

/** What every project gets until it says otherwise: a style tag for both scopes, as before the choice existed. */
export const DEFAULT_NEW_STYLE_LOCATIONS: NewStyleLocations = {
  page: { kind: 'tag', tag: DEFAULT_NEW_STYLE_TAG },
  component: { kind: 'tag', tag: DEFAULT_NEW_STYLE_TAG },
};

/** The older single template read as both scopes. */
export function locationsOfLegacy(tag: NewStyleTagSettings): NewStyleLocations {
  return { page: { kind: 'tag', tag }, component: { kind: 'tag', tag } };
}

/** A location with another place, keeping its tag default. */
export function withFile(location: NewStyleLocation, path: string): NewStyleLocation {
  return { kind: 'file', path, tag: location.tag };
}

export function withTag(location: NewStyleLocation): NewStyleLocation {
  return { kind: 'tag', tag: location.tag };
}

export function withTagSettings(location: NewStyleLocation, tag: NewStyleTagSettings): NewStyleLocation {
  return location.kind === 'file' ? { kind: 'file', path: location.path, tag } : { kind: 'tag', tag };
}

const STYLESHEET_EXTENSION = /\.(css|scss|sass|less)$/i;

/**
 * Whether `value` is a project-relative stylesheet path: posix separators, no leading slash or
 * drive, no empty, `.` or `..` step, a stylesheet extension, and within the stated bounds.
 */
export function isStylesheetPath(value: string): boolean {
  if (value.length === 0 || value.length > NEW_STYLE_LOCATION_LIMITS.pathCharsMax) {
    return false;
  }
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/.test(value)) {
    return false;
  }
  if (!STYLESHEET_EXTENSION.test(value)) {
    return false;
  }
  const segments = value.split('/');
  if (segments.length > NEW_STYLE_LOCATION_LIMITS.pathSegmentsMax) {
    return false;
  }
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

/** The scope's location parsed from a section; throws, with a reason, on a shape the file may not hold. */
export function parseNewStyleLocations(input: unknown): NewStyleLocations {
  const value = record(input);
  if (value['version'] !== 1) {
    throw new Error('Unsupported newStyleLocations version');
  }
  return { page: parseLocation(value['page'], 'page'), component: parseLocation(value['component'], 'component') };
}

function parseLocation(input: unknown, scope: NewStyleScope): NewStyleLocation {
  // A scope the file does not mention keeps Stacki's default.
  if (input === undefined) {
    return DEFAULT_NEW_STYLE_LOCATIONS[scope];
  }
  const value = record(input);
  const tag = value['tag'] === undefined ? DEFAULT_NEW_STYLE_TAG : parseNewStyleTag(value['tag']);
  const use = value['use'] === undefined ? 'tag' : text(value['use']);
  if (use === 'tag') {
    if (value['file'] !== undefined) {
      throw new Error(`newStyleLocations.${scope}.file: only written when use is "file"`);
    }
    return { kind: 'tag', tag };
  }
  if (use !== 'file') {
    throw new Error(`newStyleLocations.${scope}.use: expected "tag" or "file"`);
  }
  const path = text(value['file']);
  if (!isStylesheetPath(path)) {
    throw new Error(`newStyleLocations.${scope}.file: expected a project-relative stylesheet path such as src/styles/global.css`);
  }
  return { kind: 'file', path, tag };
}

/** The section as the file holds it. */
export function newStyleLocationsDocument(locations: NewStyleLocations): Record<string, unknown> {
  const document = { version: 1, page: locationDocument(locations.page), component: locationDocument(locations.component) };
  assert(sameNewStyleLocations(parseNewStyleLocations(document), locations), 'newStyleLocationsDocument: the section reads back');
  return document;
}

function locationDocument(location: NewStyleLocation): Record<string, unknown> {
  const tag = newStyleTagDocument(location.tag);
  return location.kind === 'file' ? { use: 'file', file: location.path, tag } : { use: 'tag', tag };
}

export function sameNewStyleLocation(left: NewStyleLocation, right: NewStyleLocation): boolean {
  if (!sameNewStyleTag(left.tag, right.tag)) {
    return false;
  }
  if (left.kind === 'file') {
    return right.kind === 'file' && right.path === left.path;
  }
  return right.kind === 'tag';
}

export function sameNewStyleLocations(left: NewStyleLocations, right: NewStyleLocations): boolean {
  return sameNewStyleLocation(left.page, right.page) && sameNewStyleLocation(left.component, right.component);
}

/**
 * The stylesheets a scope may choose from, in the order given, as project-relative paths. Files
 * that are not stylesheet paths are left out (the project lists more than plain CSS: an `.astro`
 * component is not a stylesheet).
 */
export function stylesheetChoices(rels: readonly string[]): readonly string[] {
  const choices = rels.filter(isStylesheetPath);
  assert(choices.length <= rels.length, 'stylesheetChoices: filtering never adds a path');
  return choices;
}

/**
 * Whether a location's file is among the project's stylesheets. A `tag` location has no file and
 * is never missing.
 */
export type LocationHealth = { readonly kind: 'ready' } | { readonly kind: 'missing'; readonly path: string };

export function locationHealth(location: NewStyleLocation, rels: readonly string[]): LocationHealth {
  if (location.kind === 'tag') {
    return { kind: 'ready' };
  }
  return rels.includes(location.path) ? { kind: 'ready' } : { kind: 'missing', path: location.path };
}

/**
 * The location a writer uses: the chosen file while it exists, else the scope's tag default. The
 * fallback is silent here (the Settings tab warns); a writer never targets a path it did not find.
 */
export function effectiveLocation(
  location: NewStyleLocation,
  rels: readonly string[],
): { readonly kind: 'tag'; readonly tag: NewStyleTagSettings } | { readonly kind: 'file'; readonly path: string } {
  if (location.kind === 'file' && rels.includes(location.path)) {
    return { kind: 'file', path: location.path };
  }
  return { kind: 'tag', tag: location.tag };
}

/**
 * The wrapper chain a new rule goes inside in a stylesheet's text, by the placement rules above.
 * Empty means the top level. Expected failures (a file that is not balanced CSS, a marker inside a
 * rule) are values: the chain is empty and the rule is appended at the top level, as ever.
 */
export function fileRuleWrappers(css: string): readonly TemplateWrapper[] {
  const frame = templateFrame(css);
  if (!frame.ok) {
    return [];
  }
  if (css.includes(NEW_STYLE_TAG_RULES_TOKEN)) {
    return frame.frame.wrappers;
  }
  const wrappers = frame.frame.wrappers;
  const only = wrappers[0];
  if (wrappers.length === 1 && only !== undefined && only.name === 'layer') {
    return wrappers;
  }
  return [];
}
