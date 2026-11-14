// `.stacki/variables.json`: which custom properties the variable suggestion dropdowns leave out.
//
//   { "version": 1, "hiddenFromSuggestions": ["--light-100", "--tint-100"] }
//
// It is a tracked project file in the same family as `.stacki/components.json` and `.stacki/guide.json`, shared by
// Desktop and Studio and committed with the project, so a team curates one list of suggestions. Names are the custom
// property's own, leading `--` included, written sorted and without duplicates so a diff shows only what changed.
//
// What hiding does and does not do: it removes a variable from the suggestion lists (the style panel's variable
// picker). It never touches the Variables panel, how a variable resolves, the canvas or the exported CSS. The one
// exception on the suggestion side is the variable already applied to the property being edited: it stays listed and
// selected, so a hidden variable can still be seen and replaced (`suggestionNames` below is the rule in one place).
//
// Boundary: `parseVariableVisibilitySource` takes the file's bytes (or `undefined` when the file does not exist) and
// answers a `Result`; a hand-edited, merged or truncated file is an error value, never a crash. Callers treat an
// error as "nothing hidden" for reading and refuse to write over the file, so a corrupt file is never overwritten
// silently. The bounds sit next to the code that enforces them (AGENTS.md section 10).
import { assert } from '../core/assert';
import { err, ok, type AppError, type Result } from '../core/result';

export const VARIABLE_VISIBILITY_FILE = '.stacki/variables.json';

export const VARIABLE_VISIBILITY_LIMITS = {
  /** Hidden names in one project: far past any design system's token count, small enough to read and diff. */
  hiddenMax: 5_000,
  /** Characters in one custom property name, `--` included. */
  nameCharsMax: 128,
} as const satisfies Record<string, number>;

export interface VariableVisibility {
  readonly version: 1;
  /** Custom property names (`--light-100`), sorted, without duplicates. */
  readonly hiddenFromSuggestions: readonly string[];
}

export const EMPTY_VARIABLE_VISIBILITY: VariableVisibility = { version: 1, hiddenFromSuggestions: [] };

// A custom property name: `--` and at least one more character that is not whitespace, a quote or a CSS delimiter.
// Anything else could never be a declared name, so a hand-typed typo is refused rather than stored.
const CUSTOM_PROPERTY_NAME = /^--[^\s"'`;:{}()<>\\/,]+$/;

/** True when `name` is a storable custom property name within the bound. */
export function isVariableName(name: string): boolean {
  if (name.length > VARIABLE_VISIBILITY_LIMITS.nameCharsMax) {
    return false;
  }
  return CUSTOM_PROPERTY_NAME.test(name);
}

/** The file's bytes to a value. `undefined` (no file yet) reads as nothing hidden. */
export function parseVariableVisibilitySource(source: string | undefined): Result<VariableVisibility> {
  if (source === undefined) {
    return ok(EMPTY_VARIABLE_VISIBILITY);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error: unknown) {
    return failure('unreadable', `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseVariableVisibility(input);
}

/** A parsed JSON value to a value, every field checked. */
export function parseVariableVisibility(input: unknown): Result<VariableVisibility> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'expected an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  if (fields.get('version') !== 1) {
    return failure('version', 'unsupported version, expected 1');
  }
  const hidden = fields.get('hiddenFromSuggestions');
  if (!Array.isArray(hidden)) {
    return failure('shape', 'hiddenFromSuggestions must be an array');
  }
  if (hidden.length > VARIABLE_VISIBILITY_LIMITS.hiddenMax) {
    return failure('limit', `more than ${VARIABLE_VISIBILITY_LIMITS.hiddenMax} hidden variables`);
  }
  const names = new Set<string>();
  // The array is bounded above, so this loop is too.
  for (const entry of hidden) {
    if (typeof entry !== 'string') {
      return failure('shape', 'every hidden name must be a string');
    }
    if (entry.length > VARIABLE_VISIBILITY_LIMITS.nameCharsMax) {
      return failure('limit', `a name is longer than ${VARIABLE_VISIBILITY_LIMITS.nameCharsMax} characters`);
    }
    if (!isVariableName(entry)) {
      return failure('name', `"${entry}" is not a custom property name starting with --`);
    }
    if (names.has(entry)) {
      return failure('duplicate', `"${entry}" is listed twice`);
    }
    names.add(entry);
  }
  return ok({ version: 1, hiddenFromSuggestions: sortedNames(names) });
}

/** The pretty-printed file text: sorted, without duplicates, two-space indent, a trailing newline. */
export function serializeVariableVisibility(value: VariableVisibility): string {
  assert(value.version === 1, 'serializeVariableVisibility: version 1');
  assert(value.hiddenFromSuggestions.length <= VARIABLE_VISIBILITY_LIMITS.hiddenMax, 'serializeVariableVisibility: within the count bound');
  const names = sortedNames(new Set(value.hiddenFromSuggestions));
  for (const name of names) {
    assert(isVariableName(name), 'serializeVariableVisibility: every name is a custom property name');
  }
  return JSON.stringify({ version: 1, hiddenFromSuggestions: names }, undefined, 2) + '\n';
}

/**
 * The value with `name` hidden. Idempotent: hiding a hidden name returns an equal value. A name that is not a custom
 * property name, or a list past the bound, is an error value.
 */
export function withHidden(value: VariableVisibility, name: string): Result<VariableVisibility> {
  return changed(value, name, { hide: true });
}

/** The value with `name` shown again. Idempotent: showing a visible name returns an equal value. */
export function withShown(value: VariableVisibility, name: string): Result<VariableVisibility> {
  return changed(value, name, { hide: false });
}

function changed(value: VariableVisibility, name: string, change: { readonly hide: boolean }): Result<VariableVisibility> {
  if (!isVariableName(name)) {
    return failure('name', `"${name}" is not a custom property name starting with --`);
  }
  const names = new Set(value.hiddenFromSuggestions);
  if (change.hide) {
    names.add(name);
  } else {
    names.delete(name);
  }
  if (names.size > VARIABLE_VISIBILITY_LIMITS.hiddenMax) {
    return failure('limit', `more than ${VARIABLE_VISIBILITY_LIMITS.hiddenMax} hidden variables`);
  }
  const next: VariableVisibility = { version: 1, hiddenFromSuggestions: sortedNames(names) };
  assert(next.hiddenFromSuggestions.includes(name) === change.hide, 'changed: the name is hidden exactly when asked');
  return ok(next);
}

/** The hidden names as a set, for constant-time checks while a list is drawn. */
export function hiddenNameSet(value: VariableVisibility): ReadonlySet<string> {
  return new Set(value.hiddenFromSuggestions);
}

/** True when `name` is left out of suggestion lists. A name that is not hidden, or not a name at all, is not. */
export function isHiddenFromSuggestions(hidden: ReadonlySet<string>, name: string): boolean {
  return hidden.has(name);
}

/**
 * The names a suggestion list shows: every candidate except the hidden ones, and except nothing the property being
 * edited already uses. `applied` is the variable currently applied to that property (`--light-100`), or undefined.
 * Order is the candidates' order. Pure, so the picker's rule and its test are the same code.
 */
export function suggestionNames(candidates: readonly string[], hidden: ReadonlySet<string>, applied: string | undefined): readonly string[] {
  return candidates.filter((name) => name === applied || !hidden.has(name));
}

function sortedNames(names: ReadonlySet<string>): readonly string[] {
  // Code unit order: the same on every machine, unlike a locale-aware compare.
  return [...names].sort((first, second) => (first < second ? -1 : first > second ? 1 : 0));
}

function failure(code: string, detail: string): Result<never, AppError> {
  return err({ code: `variables-visibility-${code}`, message: `.stacki/variables.json: ${detail}` });
}
