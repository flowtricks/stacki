// The unused-selector report: every class or id selector in the project's
// stylesheets with a verdict on whether anything can still match it, and the
// cleanup requests that remove the proven-unused ones. Desktop's style
// selectors panel, the delete prompt and `check-project` all read this shape.
//
// The verdicts are asymmetric on purpose. `unused` is a proof: no project file,
// installed package or allowed source of markup mentions a name the selector
// requires. Anything that weakens the proof makes the selector `unknown`, which
// is shown and never removed. A wrong `unknown` costs a leftover rule; a wrong
// `unused` breaks a live page.
import { assert } from '../core/assert';
import { count, digest, list, object, pathText, record, text } from '../core/boundary';
import type { Digest } from '../core/brand';
import { err, ok, type Result } from '../core/result';

export const SELECTOR_USAGE_LIMITS = {
  /** Selector entries in one report. A large site holds a few thousand. */
  entriesMax: 50_000,
  /** Characters of one selector as reported; longer selectors are cut for display only. */
  selectorCharsMax: 2_048,
  /** Required names one entry lists. */
  namesPerEntryMax: 64,
  /** Characters of one class or id name. */
  nameCharsMax: 256,
  /** Project notes in one report: files that could not be read, and why. */
  notesMax: 500,
  /** Stylesheet files one report or cleanup covers. */
  filesMax: 5_000,
  /** Selectors one cleanup may remove. */
  removalsMax: 10_000,
} as const satisfies Record<string, number>;

export type SelectorScope = 'global' | 'scoped';

export type SelectorVerdict =
  | { readonly kind: 'used' }
  /** No class or id to check: element, attribute and universal selectors. */
  | { readonly kind: 'untracked' }
  /** Proven unused: nothing can produce `names`, which the selector requires. */
  | { readonly kind: 'unused'; readonly names: readonly string[] }
  /** Would be unused, but the keep list protects `names`. */
  | { readonly kind: 'kept'; readonly names: readonly string[] }
  | { readonly kind: 'unknown'; readonly names: readonly string[]; readonly reason: string }
  /** Not found in the project; installed packages are still being searched for `names`. */
  | { readonly kind: 'checking'; readonly names: readonly string[] };

export type SelectorVerdictKind = SelectorVerdict['kind'];

export interface SelectorEntry {
  /** Stable while the file's bytes are: file, block, rule offset, list index. */
  readonly id: string;
  readonly rel: string;
  /** 1-based line of the rule in its file. */
  readonly line: number;
  readonly selector: string;
  readonly scope: SelectorScope;
  readonly verdict: SelectorVerdict;
}

export interface SelectorNote {
  readonly rel: string;
  readonly message: string;
}

export interface SelectorFileDigest {
  readonly rel: string;
  readonly digest: Digest;
}

export interface SelectorReport {
  readonly entries: readonly SelectorEntry[];
  /** Files or project facts the verdicts depend on, worded for the user. */
  readonly notes: readonly SelectorNote[];
  /** The stylesheet bytes the verdicts were computed against. */
  readonly files: readonly SelectorFileDigest[];
}

/** One file a cleanup or its undo rewrote: `before` restores it, `after` redoes it. */
export interface SelectorFileChange {
  readonly rel: string;
  readonly before: string;
  readonly after: string;
}

export interface SelectorRemoval {
  readonly removed: number;
  readonly changes: readonly SelectorFileChange[];
}

export function parseSelectorReport(input: unknown): SelectorReport {
  const value = record(input);
  const entries = list(parseSelectorEntry)(value['entries']);
  if (entries.length > SELECTOR_USAGE_LIMITS.entriesMax) {
    throw new Error('Selector report exceeds its entry limit');
  }
  const notes = list(object({ rel: pathText, message: text }))(value['notes']);
  if (notes.length > SELECTOR_USAGE_LIMITS.notesMax) {
    throw new Error('Selector report exceeds its note limit');
  }
  const files = list(object({ rel: pathText, digest }))(value['files']);
  if (files.length > SELECTOR_USAGE_LIMITS.filesMax) {
    throw new Error('Selector report exceeds its file limit');
  }
  return { entries, notes, files };
}

export function parseSelectorReportResult(input: unknown): Result<SelectorReport> {
  return parseResult(input, parseSelectorReport);
}

export function parseSelectorRemovalResult(input: unknown): Result<SelectorRemoval> {
  return parseResult(input, parseSelectorRemoval);
}

export function parseSelectorRemoval(input: unknown): SelectorRemoval {
  const value = record(input);
  const changes = list(parseSelectorFileChange)(value['changes']);
  if (changes.length > SELECTOR_USAGE_LIMITS.filesMax) {
    throw new Error('Selector cleanup exceeds its file limit');
  }
  return { removed: count(value['removed']), changes };
}

export function parseSelectorFileChange(input: unknown): SelectorFileChange {
  return object({ rel: pathText, before: text, after: text })(input);
}

/** A cleanup request: which entries, against which stylesheet bytes. */
export function parseSelectorIds(input: unknown): readonly string[] {
  const ids = list(selectorId)(input);
  if (ids.length === 0) {
    throw new Error('Choose at least one selector to remove');
  }
  if (ids.length > SELECTOR_USAGE_LIMITS.removalsMax) {
    throw new Error(`A cleanup removes at most ${SELECTOR_USAGE_LIMITS.removalsMax} selectors`);
  }
  return ids;
}

export function parseSelectorFileDigests(input: unknown): readonly SelectorFileDigest[] {
  const files = list(object({ rel: pathText, digest }))(input);
  if (files.length > SELECTOR_USAGE_LIMITS.filesMax) {
    throw new Error('Selector cleanup exceeds its file limit');
  }
  return files;
}

export function parseSelectorFileChanges(input: unknown): readonly SelectorFileChange[] {
  const changes = list(parseSelectorFileChange)(input);
  if (changes.length === 0) {
    throw new Error('Nothing to restore');
  }
  if (changes.length > SELECTOR_USAGE_LIMITS.filesMax) {
    throw new Error('Selector restore exceeds its file limit');
  }
  return changes;
}

/** The verdict's names, the ones a user can add to the keep list. */
export function verdictNames(verdict: SelectorVerdict): readonly string[] {
  switch (verdict.kind) {
    case 'used':
    case 'untracked':
      return [];
    case 'unused':
    case 'kept':
    case 'unknown':
    case 'checking':
      return verdict.names;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/** Entry ids encode where the rule is, so a stale id can never name another rule. */
export function selectorEntryId(input: { readonly rel: string; readonly block: number; readonly offset: number; readonly index: number }): string {
  assert(Number.isSafeInteger(input.block), 'selectorEntryId: block is an index');
  assert(input.block >= 0, 'selectorEntryId: block is nonnegative');
  assert(Number.isSafeInteger(input.offset), 'selectorEntryId: offset is an index');
  assert(input.index >= 0, 'selectorEntryId: list index is nonnegative');
  return `${input.rel}|${input.block}|${input.offset}|${input.index}`;
}

function parseSelectorEntry(input: unknown): SelectorEntry {
  const value = record(input);
  const line = count(value['line']);
  if (line === 0) {
    throw new Error('Selector line is 1-based');
  }
  const scope = value['scope'];
  if (scope !== 'global' && scope !== 'scoped') {
    throw new Error('Unknown selector scope');
  }
  const selector = text(value['selector']);
  if (selector.length > SELECTOR_USAGE_LIMITS.selectorCharsMax) {
    throw new Error('Selector exceeds its display limit');
  }
  return { id: selectorId(value['id']), rel: pathText(value['rel']), line, selector, scope, verdict: parseVerdict(value['verdict']) };
}

function parseVerdict(input: unknown): SelectorVerdict {
  const value = record(input);
  const kind = value['kind'];
  switch (kind) {
    case 'used':
    case 'untracked':
      return { kind };
    case 'unused':
    case 'kept':
    case 'checking':
      return { kind, names: parseNames(value['names']) };
    case 'unknown':
      return { kind, names: parseNames(value['names']), reason: text(value['reason']) };
    default:
      throw new Error('Unknown selector verdict');
  }
}

function parseNames(input: unknown): readonly string[] {
  const names = list(text)(input);
  if (names.length > SELECTOR_USAGE_LIMITS.namesPerEntryMax) {
    throw new Error('Selector names exceed their limit');
  }
  for (const name of names) {
    if (name.length === 0 || name.length > SELECTOR_USAGE_LIMITS.nameCharsMax) {
      throw new Error('Selector name length is out of range');
    }
  }
  return names;
}

function selectorId(input: unknown): string {
  const value = text(input);
  if (!/^[^|]+\|\d+\|\d+\|\d+$/.test(value)) {
    throw new Error('Invalid selector id');
  }
  return value;
}

function parseResult<T>(input: unknown, parse: (value: unknown) => T): Result<T> {
  const value = record(input);
  if (value['ok'] === true) {
    return ok(parse(value['value']));
  }
  if (value['ok'] === false) {
    return err(object({ code: text, message: text })(value['error']));
  }
  throw new Error('Expected a result');
}
