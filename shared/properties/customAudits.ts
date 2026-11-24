// i18n-ignore-file: problem messages here are English for the CLI and logs; the panel shows each problem by its code (customAudits.problem.*).
// Custom audits: the checks a project writes for itself, kept in `.stacki/audits.json` under `customAudits` beside the
// ignores and the built-in checks' settings, so the whole team shares them and the CLI, Desktop and Studio read one list.
//
//   "customAudits": [
//     { "id": "hard-coded-text-align", "name": "Hard-coded text-align", "icon": "text", "category": "tokens", "severity": "low",
//       "scope": "declaration", "match": { "property": "^text-align$", "valueMustNotMatch": "var\\(" }, "enabled": true },
//     { "id": "todo-comment", "name": "TODO left in markup", "icon": "placeholder", "category": "Launch", "scope": "markup",
//       "match": { "pattern": "TODO|FIXME" }, "enabled": true }
//   ]
//
// A custom audit says what it looks at (`scope`) and what it looks for (`match`):
// - `declaration`: each CSS declaration in stylesheets and `<style>` blocks. `property` is a regular expression on the property
//   name, `valueMustMatch` and `valueMustNotMatch` are regular expressions on the value. "Match this and not that" is two
//   fields, so neither owner example needs a lookahead.
// - `css`: the text of stylesheets and `<style>` blocks; `markup`: the template of .astro files (frontmatter, styles and
//   scripts left out); `rendered`: the HTML the dev server serves. Each takes one `pattern`.
// `exclude`, when present, drops a match whose declaration (`property: value`) or, for the text scopes, whose line also
// matches it. Every expression is case-insensitive.
//
// Why the regular expressions are checked here and not trusted: a person (or an agent) types them, and one catastrophic
// pattern would hang the app on every audit. `checkPattern` refuses what can blow up (nested repetition, backreferences,
// too many unbounded repeats, an expression that matches nothing in particular, an over-long one) before anything runs it,
// and the matcher (shared/page/auditCustom.ts) bounds what remains with per-file and per-run caps and a time budget.
//
// The file parser is strict on shape and bounds, like the rest of audits.json, and tolerant in two ways: an entry's unknown
// keys are ignored (a newer Stacki may add one), and a pattern is not compiled while the file is read. A hand-edited pattern
// that fails the check makes that one audit report a problem when it runs; it never makes the ignores and settings unreadable.
// Every writer (the panel's editor and `stacki audits`) checks the patterns first and refuses an unsafe one.
import { assert } from '../core/assert';
import { err, ok, type Result } from '../core/result';
import { toRecord } from '../core/record';

/** Bounds of the custom audit list, enforced by the parser and by every writer. */
export const CUSTOM_AUDIT_LIMITS = {
  auditsMax: 50,
  idCharsMax: 40,
  nameCharsMax: 60,
  categoryCharsMax: 40,
  messageCharsMax: 240,
  patternCharsMax: 300,
  /** Unbounded repeats (`*`, `+`, `{n,}`) one pattern may hold: each one more multiplies the worst-case backtracking. */
  repeatsUnboundedMax: 3,
} as const satisfies Record<string, number>;

export const CUSTOM_AUDIT_SCOPES = ['declaration', 'css', 'markup', 'rendered'] as const;
export type CustomAuditScope = (typeof CUSTOM_AUDIT_SCOPES)[number];

export const CUSTOM_AUDIT_SEVERITIES = ['high', 'medium', 'low'] as const;
export type CustomAuditSeverity = (typeof CUSTOM_AUDIT_SEVERITIES)[number];

/** The built-in categories a custom audit can join; any other name is a category of its own. */
export const CUSTOM_AUDIT_BUILTIN_CATEGORIES = ['accessibility', 'seo', 'content', 'tokens', 'performance'] as const;
export type CustomAuditBuiltinCategory = (typeof CUSTOM_AUDIT_BUILTIN_CATEGORIES)[number];

/**
 * The icons a custom audit can show, by name: every one is an icon the Audits panel already draws (src/features/audits/AuditIcons.tsx
 * maps each name), so a custom audit never brings an icon of its own.
 */
export const CUSTOM_AUDIT_ICONS = [
  'droplet',
  'text',
  'ruler',
  'variable',
  'layers',
  'tag',
  'braces',
  'image',
  'link',
  'globe',
  'hash',
  'heading',
  'contrast',
  'form',
  'accessibility',
  'placeholder',
  'star',
  'chart',
  'gauge',
  'block',
  'file',
  'hide',
  'clock',
  'target',
] as const;
export type CustomAuditIcon = (typeof CUSTOM_AUDIT_ICONS)[number];

/** What a custom audit looks for. A declaration audit judges a property and its value; the others run one pattern over text. */
export type CustomAuditMatch =
  | {
      readonly scope: 'declaration';
      /** On the property name: `^text-align$`. */
      readonly property: string;
      /** The value must hold this, when given: `var\(\s*--swatch-`. */
      readonly valueMustMatch: string | undefined;
      /** The value must not hold this, when given: `var\(`. */
      readonly valueMustNotMatch: string | undefined;
    }
  | { readonly scope: Exclude<CustomAuditScope, 'declaration'>; readonly pattern: string };

export interface CustomAudit {
  /** Lowercase letters, digits and hyphens; unique in the list. Findings and ignores key on it. */
  readonly id: string;
  readonly name: string;
  readonly icon: CustomAuditIcon;
  /** A built-in category id (`tokens`) or the name of a category of the project's own (`Brand`). */
  readonly category: string;
  readonly severity: CustomAuditSeverity;
  readonly match: CustomAuditMatch;
  /** A match is dropped when its declaration (`property: value`) or, for a text scope, its line also matches this. */
  readonly exclude: string | undefined;
  /** One line shown under the audit's name: why it matters or what to use instead. */
  readonly message: string | undefined;
  readonly enabled: boolean;
}

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

/** Whether `id` is a custom audit id: lowercase letters, digits and inner hyphens, at most 40 characters. */
export function isCustomAuditId(id: string): boolean {
  return id.length <= CUSTOM_AUDIT_LIMITS.idCharsMax && ID_PATTERN.test(id);
}

// ----- the file ---------------------------------------------------------------------------------

/** The `customAudits` list as the file holds it, or a throw naming the first field that is wrong. */
export function parseCustomAudits(input: unknown): readonly CustomAudit[] {
  if (!Array.isArray(input)) {
    throw new Error('Audit settings.customAudits: expected an array');
  }
  if (input.length > CUSTOM_AUDIT_LIMITS.auditsMax) {
    throw new Error(`Audit settings.customAudits: more than ${CUSTOM_AUDIT_LIMITS.auditsMax} audits`);
  }
  const audits = input.map((entry: unknown, index) => parseCustomAudit(entry, `Audit settings.customAudits[${index}]`));
  if (new Set(audits.map((audit) => audit.id)).size !== audits.length) {
    throw new Error('Audit settings.customAudits: an id is listed twice');
  }
  assert(audits.length <= CUSTOM_AUDIT_LIMITS.auditsMax, 'parseCustomAudits: the list is bounded');
  return audits;
}

/** One custom audit from the file or from the CLI, or a throw naming the field. Unknown keys are ignored (a newer Stacki may write one). */
export function parseCustomAudit(input: unknown, where: string): CustomAudit {
  const value = toRecord(input);
  if (value === undefined) {
    throw new Error(`${where}: expected an object`);
  }
  const id = value['id'];
  if (typeof id !== 'string' || !isCustomAuditId(id)) {
    throw new Error(`${where}.id: expected lowercase letters, digits and hyphens, at most ${CUSTOM_AUDIT_LIMITS.idCharsMax} characters`);
  }
  const icon = CUSTOM_AUDIT_ICONS.find((known) => known === value['icon']);
  if (icon === undefined) {
    throw new Error(`${where}.icon: expected one of ${CUSTOM_AUDIT_ICONS.join(', ')}`);
  }
  const severityRaw = value['severity'] ?? 'medium';
  const severity = CUSTOM_AUDIT_SEVERITIES.find((known) => known === severityRaw);
  if (severity === undefined) {
    throw new Error(`${where}.severity: expected high, medium or low`);
  }
  const enabled = value['enabled'] ?? true;
  if (typeof enabled !== 'boolean') {
    throw new Error(`${where}.enabled: expected a boolean`);
  }
  return {
    id,
    name: boundedText(value['name'], `${where}.name`, CUSTOM_AUDIT_LIMITS.nameCharsMax),
    icon,
    category: boundedText(value['category'], `${where}.category`, CUSTOM_AUDIT_LIMITS.categoryCharsMax),
    severity,
    match: parseMatch(value['scope'], value['match'], where),
    exclude: optionalPattern(value['exclude'], `${where}.exclude`),
    message: value['message'] === undefined ? undefined : boundedText(value['message'], `${where}.message`, CUSTOM_AUDIT_LIMITS.messageCharsMax),
    enabled,
  };
}

function parseMatch(scopeRaw: unknown, input: unknown, where: string): CustomAuditMatch {
  const scope = CUSTOM_AUDIT_SCOPES.find((known) => known === scopeRaw);
  if (scope === undefined) {
    throw new Error(`${where}.scope: expected one of ${CUSTOM_AUDIT_SCOPES.join(', ')}`);
  }
  const match = toRecord(input);
  if (match === undefined) {
    throw new Error(`${where}.match: expected an object`);
  }
  if (scope === 'declaration') {
    return {
      scope,
      property: requiredPattern(match['property'], `${where}.match.property`),
      valueMustMatch: optionalPattern(match['valueMustMatch'], `${where}.match.valueMustMatch`),
      valueMustNotMatch: optionalPattern(match['valueMustNotMatch'], `${where}.match.valueMustNotMatch`),
    };
  }
  return { scope, pattern: requiredPattern(match['pattern'], `${where}.match.pattern`) };
}

function boundedText(input: unknown, where: string, charsMax: number): string {
  if (typeof input !== 'string' || input.trim().length === 0) {
    throw new Error(`${where}: expected a non-empty string`);
  }
  if (input.length > charsMax) {
    throw new Error(`${where}: longer than ${charsMax} characters`);
  }
  return input.trim();
}

function requiredPattern(input: unknown, where: string): string {
  if (typeof input !== 'string' || input.length === 0) {
    throw new Error(`${where}: expected a regular expression`);
  }
  if (input.length > CUSTOM_AUDIT_LIMITS.patternCharsMax) {
    throw new Error(`${where}: longer than ${CUSTOM_AUDIT_LIMITS.patternCharsMax} characters`);
  }
  return input;
}

function optionalPattern(input: unknown, where: string): string | undefined {
  return input === undefined ? undefined : requiredPattern(input, where);
}

/** The list as the file writes it: fields at their defaults left out (severity medium, enabled), so a file says only what was chosen. */
export function serializedCustomAudits(audits: readonly CustomAudit[]): readonly Record<string, unknown>[] {
  assert(audits.length <= CUSTOM_AUDIT_LIMITS.auditsMax, 'serializedCustomAudits: the list is bounded');
  return audits.map((audit) => {
    const match =
      audit.match.scope === 'declaration'
        ? {
            property: audit.match.property,
            ...(audit.match.valueMustMatch === undefined ? {} : { valueMustMatch: audit.match.valueMustMatch }),
            ...(audit.match.valueMustNotMatch === undefined ? {} : { valueMustNotMatch: audit.match.valueMustNotMatch }),
          }
        : { pattern: audit.match.pattern };
    return {
      id: audit.id,
      name: audit.name,
      icon: audit.icon,
      category: audit.category,
      ...(audit.severity === 'medium' ? {} : { severity: audit.severity }),
      scope: audit.match.scope,
      match,
      ...(audit.exclude === undefined ? {} : { exclude: audit.exclude }),
      ...(audit.message === undefined ? {} : { message: audit.message }),
      enabled: audit.enabled,
    };
  });
}

// ----- editing the list -------------------------------------------------------------------------

/** The list with `audit` added, or replacing the audit with the same id. Throws past the bound; checks the patterns first. */
export function withCustomAudit(audits: readonly CustomAudit[], audit: CustomAudit): readonly CustomAudit[] {
  assert(isCustomAuditId(audit.id), 'withCustomAudit: a custom audit id');
  const index = audits.findIndex((existing) => existing.id === audit.id);
  if (index === -1 && audits.length >= CUSTOM_AUDIT_LIMITS.auditsMax) {
    throw new Error(`A project has at most ${CUSTOM_AUDIT_LIMITS.auditsMax} custom audits`);
  }
  const next = index === -1 ? [...audits, audit] : audits.map((existing) => (existing.id === audit.id ? audit : existing));
  assert(next.length <= audits.length + 1, 'withCustomAudit: adds at most one audit');
  return next;
}

/** The list without the audit `id`. */
export function withoutCustomAudit(audits: readonly CustomAudit[], id: string): readonly CustomAudit[] {
  const next = audits.filter((audit) => audit.id !== id);
  assert(next.length >= audits.length - 1, 'withoutCustomAudit: removes at most one audit');
  return next;
}

/** An id for a new audit named `name`: its words lowercased and hyphenated, made unique against `taken` with `-2`, `-3`, ... */
export function customAuditIdFor(name: string, taken: readonly string[]): string {
  const words = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  // Room is left for a `-NN` suffix; a long name is cut at a word, never inside one.
  const room = CUSTOM_AUDIT_LIMITS.idCharsMax - 4;
  const cut = words.length <= room ? words : words.slice(0, words.lastIndexOf('-', room) > 0 ? words.lastIndexOf('-', room) : room);
  const base = (cut.length === 0 ? 'custom-audit' : cut).replace(/-+$/, '');
  const stem = base.length === 0 ? 'custom-audit' : base;
  const used = new Set(taken);
  if (!used.has(stem)) {
    return stem;
  }
  // The list is bounded, so a free suffix exists within auditsMax + 1 tries.
  for (let suffix = 2; suffix <= CUSTOM_AUDIT_LIMITS.auditsMax + 2; suffix++) {
    const candidate = `${stem}-${suffix}`;
    if (!used.has(candidate)) {
      assert(isCustomAuditId(candidate), 'customAuditIdFor: the id is well formed');
      return candidate;
    }
  }
  throw new Error('customAuditIdFor: no free id within the list bound');
}

/** The category a typed name means: a built-in id when it names one (`Tokens`, `seo`), otherwise the name as typed, trimmed. */
export function customAuditCategoryOf(typed: string): string {
  const trimmed = typed.trim();
  const builtin = CUSTOM_AUDIT_BUILTIN_CATEGORIES.find((id) => id === trimmed.toLowerCase());
  assert(trimmed.length <= CUSTOM_AUDIT_LIMITS.categoryCharsMax || builtin === undefined, 'customAuditCategoryOf: a built-in id is short');
  return builtin ?? trimmed;
}

/** Whether `category` is one of the built-in categories. */
export function builtinCategoryOf(category: string): CustomAuditBuiltinCategory | undefined {
  return CUSTOM_AUDIT_BUILTIN_CATEGORIES.find((id) => id === category);
}

// ----- the regular expression guard -------------------------------------------------------------

/** Why a pattern was refused, by a stable code the panel translates; the message is the English the CLI prints. */
export interface CustomAuditProblem {
  readonly code: 'empty' | 'too-long' | 'invalid' | 'backreference' | 'nested-repeat' | 'too-many-repeats' | 'matches-empty';
  /** Which field: `property`, `valueMustMatch`, `valueMustNotMatch`, `pattern` or `exclude`. */
  readonly field: CustomAuditPatternField;
  readonly message: string;
}

export type CustomAuditPatternField = 'property' | 'valueMustMatch' | 'valueMustNotMatch' | 'pattern' | 'exclude';

/** Whether a pattern must find something to be useful: a positive one that matches the empty string would flag every place. */
type PatternRole = 'finds' | 'filters';

/**
 * The pattern compiled (case-insensitive), or why it is refused. Refused: empty, longer than patternCharsMax, not a valid
 * regular expression, a backreference, repetition inside repetition (`(a+)+`, `(\w*){5}`: the shapes that backtrack
 * exponentially), more than repeatsUnboundedMax unbounded repeats, and, for a pattern that finds, one that matches the empty string.
 */
export function checkPattern(pattern: string, field: CustomAuditPatternField): Result<RegExp, CustomAuditProblem> {
  const role: PatternRole = field === 'valueMustNotMatch' || field === 'exclude' ? 'filters' : 'finds';
  const refuse = (code: CustomAuditProblem['code'], message: string): Result<never, CustomAuditProblem> =>
    err({ code, field, message: `${field}: ${message}` });
  if (pattern.length === 0) {
    return refuse('empty', 'write a regular expression.');
  }
  if (pattern.length > CUSTOM_AUDIT_LIMITS.patternCharsMax) {
    return refuse('too-long', `at most ${CUSTOM_AUDIT_LIMITS.patternCharsMax} characters.`);
  }
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern, 'i');
  } catch (error: unknown) {
    return refuse('invalid', `not a regular expression (${error instanceof Error ? error.message : String(error)}).`);
  }
  const shape = patternShape(pattern);
  if (shape.backreference) {
    return refuse('backreference', 'backreferences such as \\1 can take very long to run; match the text itself instead.');
  }
  if (shape.nestedRepeat) {
    return refuse('nested-repeat', 'a repeat inside a repeated group, such as (a+)+, can take very long to run; repeat only once.');
  }
  if (shape.unboundedRepeats > CUSTOM_AUDIT_LIMITS.repeatsUnboundedMax) {
    return refuse('too-many-repeats', `at most ${CUSTOM_AUDIT_LIMITS.repeatsUnboundedMax} open-ended repeats (*, + or {n,}).`);
  }
  if (role === 'finds' && compiled.test('')) {
    return refuse('matches-empty', 'it matches empty text, so it would flag every place; make it ask for at least one character.');
  }
  return ok(compiled);
}

interface PatternShape {
  readonly backreference: boolean;
  readonly nestedRepeat: boolean;
  readonly unboundedRepeats: number;
}

// One pass over a pattern that compiled: escapes and character classes are skipped, each group remembers whether it holds a
// repeat, and a repeat applied to a group that holds one is nested repetition. Iterative over a stack bounded by the pattern's
// own length, which the caller has already bounded.
function patternShape(pattern: string): PatternShape {
  assert(pattern.length <= CUSTOM_AUDIT_LIMITS.patternCharsMax, 'patternShape: the pattern is bounded');
  const groups: { repeats: boolean }[] = [{ repeats: false }];
  let backreference = false;
  let nestedRepeat = false;
  let unboundedRepeats = 0;
  // Whether the atom just read was a group, and whether that group held a repeat.
  let lastGroupRepeats: boolean | undefined;
  let index = 0;
  for (let steps = 0; index < pattern.length && steps <= pattern.length; steps++) {
    const char = pattern[index] ?? '';
    const repeat = repeatAt(pattern, index);
    if (repeat !== undefined) {
      const top = groups[groups.length - 1];
      assert(top !== undefined, 'patternShape: a group is open');
      if (repeat.many) {
        if (lastGroupRepeats === true) {
          nestedRepeat = true;
        }
        top.repeats = true;
      }
      if (repeat.unbounded) {
        unboundedRepeats += 1;
      }
      lastGroupRepeats = undefined;
      index += repeat.length;
      continue;
    }
    lastGroupRepeats = undefined;
    if (char === '\\') {
      const next = pattern[index + 1] ?? '';
      if (/[1-9]/.test(next) || (next === 'k' && pattern[index + 2] === '<')) {
        backreference = true;
      }
      index += 2;
    } else if (char === '[') {
      index = classEnd(pattern, index);
    } else if (char === '(') {
      groups.push({ repeats: false });
      index += pattern[index + 1] === '?' ? groupPrefixLength(pattern, index) : 1;
    } else if (char === ')') {
      const closed = groups.pop();
      const parent = groups[groups.length - 1];
      assert(closed !== undefined, 'patternShape: a compiled pattern closes only groups it opened');
      assert(parent !== undefined, 'patternShape: the outermost level is never closed');
      parent.repeats = parent.repeats || closed.repeats;
      lastGroupRepeats = closed.repeats;
      index += 1;
    } else {
      index += 1;
    }
  }
  return { backreference, nestedRepeat, unboundedRepeats };
}

// The quantifier at `index`, if one starts there: its length (a lazy `?` included), whether it repeats more than once and whether it is unbounded.
function repeatAt(pattern: string, index: number): { readonly length: number; readonly many: boolean; readonly unbounded: boolean } | undefined {
  const char = pattern[index];
  const lazy = (end: number): number => (pattern[end] === '?' ? 1 : 0);
  if (char === '*' || char === '+') {
    return { length: 1 + lazy(index + 1), many: true, unbounded: true };
  }
  if (char === '?') {
    return { length: 1 + lazy(index + 1), many: false, unbounded: false };
  }
  if (char === '{') {
    const braces = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index, index + 24));
    if (braces === null) {
      return undefined; // A literal brace.
    }
    const low = Number(braces[1]);
    const open = braces[2] !== undefined && (braces[3] ?? '') === '';
    const high = open ? Number.POSITIVE_INFINITY : braces[2] === undefined ? low : Number(braces[3]);
    return { length: braces[0].length + lazy(index + braces[0].length), many: high > 1, unbounded: open };
  }
  return undefined;
}

// The index after a character class that starts at `index`, its escapes and a leading `]` included.
function classEnd(pattern: string, index: number): number {
  let at = index + 1;
  if (pattern[at] === '^') {
    at += 1;
  }
  if (pattern[at] === ']') {
    at += 1;
  }
  for (; at < pattern.length; at++) {
    if (pattern[at] === '\\') {
      at += 1;
    } else if (pattern[at] === ']') {
      return at + 1;
    }
  }
  return pattern.length;
}

// The length of a group's opening with its modifier: `(?:`, `(?=`, `(?!`, `(?<=`, `(?<!`, `(?<name>`.
function groupPrefixLength(pattern: string, index: number): number {
  const rest = pattern.slice(index, index + 40);
  const named = /^\(\?<[A-Za-z_$][\w$]*>/.exec(rest);
  if (named !== null) {
    return named[0].length;
  }
  return rest.startsWith('(?<=') || rest.startsWith('(?<!') ? 4 : 3;
}

/** A custom audit's patterns compiled, or the first problem. The matcher (shared/page/auditCustom.ts) runs what this returns. */
export type CompiledCustomMatch =
  | {
      readonly scope: 'declaration';
      readonly property: RegExp;
      readonly valueMustMatch: RegExp | undefined;
      readonly valueMustNotMatch: RegExp | undefined;
      readonly exclude: RegExp | undefined;
    }
  | { readonly scope: Exclude<CustomAuditScope, 'declaration'>; readonly pattern: RegExp; readonly exclude: RegExp | undefined };

export function compileCustomAudit(audit: Pick<CustomAudit, 'match' | 'exclude'>): Result<CompiledCustomMatch, CustomAuditProblem> {
  const exclude = audit.exclude === undefined ? ok(undefined) : checkPattern(audit.exclude, 'exclude');
  if (!exclude.ok) {
    return exclude;
  }
  const match = audit.match;
  if (match.scope === 'declaration') {
    const property = checkPattern(match.property, 'property');
    const must = match.valueMustMatch === undefined ? ok(undefined) : checkPattern(match.valueMustMatch, 'valueMustMatch');
    const mustNot = match.valueMustNotMatch === undefined ? ok(undefined) : checkPattern(match.valueMustNotMatch, 'valueMustNotMatch');
    if (!property.ok) {
      return property;
    }
    if (!must.ok) {
      return must;
    }
    if (!mustNot.ok) {
      return mustNot;
    }
    return ok({ scope: 'declaration', property: property.value, valueMustMatch: must.value, valueMustNotMatch: mustNot.value, exclude: exclude.value });
  }
  const pattern = checkPattern(match.pattern, 'pattern');
  return pattern.ok ? ok({ scope: match.scope, pattern: pattern.value, exclude: exclude.value }) : pattern;
}

// ----- presets ----------------------------------------------------------------------------------

/** A starting point the editor and `stacki audits presets` offer: a whole audit minus its id, with a key the panel names it by. */
export interface CustomAuditPreset {
  /** Stable: `stacki audits add --preset <id>` and the panel's menu name it. */
  readonly preset: string;
  readonly audit: Omit<CustomAudit, 'id' | 'enabled'>;
}

/** The colour-carrying properties and the shorthands that can hold a colour, for the core-swatch preset. */
export const COLOR_PROPERTY_PATTERN =
  '^(color|background(-color)?|border(-(top|right|bottom|left|block|inline)(-(start|end))?)?(-color)?|outline(-color)?|' +
  'text-decoration(-color)?|text-emphasis-color|column-rule(-color)?|caret-color|accent-color|fill|stroke|box-shadow|text-shadow|filter)$';

export const CUSTOM_AUDIT_PRESETS: readonly CustomAuditPreset[] = [
  {
    preset: 'hard-coded-text-align',
    audit: {
      name: 'Hard-coded text-align',
      icon: 'text',
      category: 'tokens',
      severity: 'low',
      match: { scope: 'declaration', property: '^text-align$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' },
      exclude: undefined,
      message: 'Alignment is written by hand; a variable keeps it in step across breakpoints and themes.',
    },
  },
  {
    preset: 'core-swatch-instead-of-theme',
    audit: {
      name: 'Core swatch instead of theme variable',
      icon: 'droplet',
      category: 'tokens',
      severity: 'medium',
      match: { scope: 'declaration', property: COLOR_PROPERTY_PATTERN, valueMustMatch: 'var\\(\\s*--swatch-', valueMustNotMatch: undefined },
      exclude: undefined,
      message: 'A core swatch does not follow the theme; use a theme variable such as var(--theme-text).',
    },
  },
  {
    preset: 'important',
    audit: {
      name: '!important',
      icon: 'block',
      category: 'tokens',
      severity: 'low',
      match: { scope: 'declaration', property: '^[a-z]', valueMustMatch: '!\\s*important', valueMustNotMatch: undefined },
      exclude: undefined,
      message: '!important overrides every layer and makes later changes hard.',
    },
  },
  {
    preset: 'hard-coded-z-index',
    audit: {
      name: 'Hard-coded z-index',
      icon: 'layers',
      category: 'tokens',
      severity: 'low',
      match: { scope: 'declaration', property: '^z-index$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' },
      exclude: undefined,
      message: 'Stacking order written by hand drifts; keep the levels in variables.',
    },
  },
  {
    preset: 'inline-style',
    audit: {
      name: 'Inline style attribute',
      icon: 'tag',
      category: 'content',
      severity: 'low',
      match: { scope: 'markup', pattern: '\\sstyle\\s*=' },
      exclude: undefined,
      message: 'Styles written on the element are hard to find and reuse; give it a class.',
    },
  },
  {
    preset: 'todo-comment',
    audit: {
      name: 'TODO left in markup',
      icon: 'placeholder',
      category: 'content',
      severity: 'medium',
      match: { scope: 'markup', pattern: '\\b(TODO|FIXME)\\b' },
      exclude: undefined,
      message: 'A note to finish something is still in the page.',
    },
  },
];

/** The preset named `preset`, or undefined. */
export function customAuditPreset(preset: string): CustomAuditPreset | undefined {
  return CUSTOM_AUDIT_PRESETS.find((entry) => entry.preset === preset);
}
