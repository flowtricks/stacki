// The custom audit editor's form, apart from drawing it: what the fields hold, how an audit becomes a form and a form an audit.
// Pure, so the round trips (an audit opened, unchanged, saves the same bytes) are tested without the dialog.
//
// Two ways to say what to look for. "Property and value" is for designers: property names (`text-align, color`, a trailing
// `*` for a prefix such as `border*`) and plain text the value contains or does not contain; the editor writes the regular
// expressions itself, escaped. "Regular expression" shows the expressions as they are stored and every scope. An audit
// opens in the simple mode when its expressions are exactly what the simple mode would write, and in the advanced mode otherwise.
import { assert } from '../../../shared/core/assert';
import { err, ok, type Result } from '../../../shared/core/result';
import {
  CUSTOM_AUDIT_LIMITS,
  compileCustomAudit,
  customAuditCategoryOf,
  customAuditIdFor,
  type CustomAudit,
  type CustomAuditIcon,
  type CustomAuditMatch,
  type CustomAuditProblem,
  type CustomAuditScope,
  type CustomAuditSeverity,
} from '../../../shared/properties/customAudits';

export type CustomAuditMode = 'simple' | 'advanced';

export interface CustomAuditForm {
  readonly name: string;
  readonly icon: CustomAuditIcon;
  /** A built-in category id or the project's own name. */
  readonly category: string;
  readonly severity: CustomAuditSeverity;
  readonly mode: CustomAuditMode;
  /** Simple mode: property names, comma separated. */
  readonly properties: string;
  /** Simple mode: plain text the value must hold, and must not hold. */
  readonly valueContains: string;
  readonly valueLacks: string;
  /** Advanced mode: the scope and the expressions as stored. */
  readonly scope: CustomAuditScope;
  readonly property: string;
  readonly valueMustMatch: string;
  readonly valueMustNotMatch: string;
  readonly pattern: string;
  readonly exclude: string;
  readonly message: string;
}

export const EMPTY_CUSTOM_AUDIT_FORM: CustomAuditForm = {
  name: '',
  icon: 'star',
  category: 'tokens',
  severity: 'medium',
  mode: 'simple',
  properties: '',
  valueContains: '',
  valueLacks: '',
  scope: 'declaration',
  property: '',
  valueMustMatch: '',
  valueMustNotMatch: '',
  pattern: '',
  exclude: '',
  message: '',
};

/** Property names one simple rule may list. */
const PROPERTIES_MAX = 40;

/** `text` as a regular expression that matches it literally. */
export function escapedPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

/** The literal text a pattern written by `escapedPattern` stands for, or undefined when the pattern is more than a literal. */
export function literalOf(pattern: string): string | undefined {
  let out = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    if (char === '\\') {
      const next = pattern[index + 1] ?? '';
      if (!/[.*+?^${}()|[\]\\/]/.test(next)) {
        return undefined; // `\s`, `\d`: a class, not a literal.
      }
      out += next;
      index += 1;
    } else if (/[.*+?^${}()|[\]]/.test(char)) {
      return undefined;
    } else {
      out += char;
    }
  }
  assert(out.length <= pattern.length, 'literalOf: a literal is never longer than its pattern');
  return out;
}

/** The property pattern for a list of names: `text-align, border*` → `^(text-align|border[a-z-]*)$`. */
export function propertyPatternOf(names: string): string {
  const list = propertyNames(names);
  const parts = list.map((name) => (name.endsWith('*') ? `${escapedPattern(name.slice(0, -1))}[a-z-]*` : escapedPattern(name)));
  return parts.length === 1 ? `^${parts[0] ?? ''}$` : `^(${parts.join('|')})$`;
}

/** The names a property pattern written by `propertyPatternOf` lists, or undefined when it is any other expression. */
export function propertyNamesOf(pattern: string): string | undefined {
  const inner = /^\^\((.*)\)\$$/.exec(pattern)?.[1] ?? /^\^(.*)\$$/.exec(pattern)?.[1];
  if (inner === undefined || inner.length === 0) {
    return undefined;
  }
  const names: string[] = [];
  for (const part of inner.split('|').slice(0, PROPERTIES_MAX + 1)) {
    const prefix = part.endsWith('[a-z-]*');
    const literal = literalOf(prefix ? part.slice(0, -'[a-z-]*'.length) : part);
    if (literal === undefined || literal.length === 0 || !/^-{0,2}[a-z][a-z0-9-]*$/i.test(literal)) {
      return undefined;
    }
    names.push(prefix ? `${literal}*` : literal);
  }
  return names.length > PROPERTIES_MAX ? undefined : names.join(', ');
}

function propertyNames(names: string): readonly string[] {
  return names
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0)
    .slice(0, PROPERTIES_MAX);
}

/** The form an audit opens as: the simple mode when its expressions are what the simple mode writes, the advanced mode otherwise. */
export function formOf(audit: Omit<CustomAudit, 'id' | 'enabled'>): CustomAuditForm {
  const base: CustomAuditForm = {
    ...EMPTY_CUSTOM_AUDIT_FORM,
    name: audit.name,
    icon: audit.icon,
    category: audit.category,
    severity: audit.severity,
    exclude: audit.exclude ?? '',
    message: audit.message ?? '',
    scope: audit.match.scope,
  };
  const match = audit.match;
  if (match.scope !== 'declaration') {
    return { ...base, mode: 'advanced', pattern: match.pattern };
  }
  const advanced: CustomAuditForm = {
    ...base,
    mode: 'advanced',
    property: match.property,
    valueMustMatch: match.valueMustMatch ?? '',
    valueMustNotMatch: match.valueMustNotMatch ?? '',
  };
  const names = propertyNamesOf(match.property);
  const contains = match.valueMustMatch === undefined ? '' : literalOf(match.valueMustMatch);
  const lacks = match.valueMustNotMatch === undefined ? '' : literalOf(match.valueMustNotMatch);
  if (names === undefined || contains === undefined || lacks === undefined || audit.exclude !== undefined) {
    return advanced;
  }
  return { ...advanced, mode: 'simple', properties: names, valueContains: contains, valueLacks: lacks };
}

/** Why a form cannot be saved yet: a field to fill, or a pattern the guard refuses. */
export type CustomAuditFormProblem =
  | { readonly kind: 'name' }
  | { readonly kind: 'category' }
  | { readonly kind: 'properties' }
  | { readonly kind: 'pattern'; readonly problem: CustomAuditProblem };

/** What the form describes: the match it stores, its exclusion, and whether its patterns pass the guard. */
export function matchOf(form: CustomAuditForm): Result<{ readonly match: CustomAuditMatch; readonly exclude: string | undefined }, CustomAuditFormProblem> {
  const optional = (text: string): string | undefined => (text.length === 0 ? undefined : text);
  let match: CustomAuditMatch;
  let exclude: string | undefined;
  if (form.mode === 'simple') {
    if (propertyNames(form.properties).length === 0) {
      return err({ kind: 'properties' });
    }
    match = {
      scope: 'declaration',
      property: propertyPatternOf(form.properties),
      valueMustMatch: optional(escapedPattern(form.valueContains.trim())),
      valueMustNotMatch: optional(escapedPattern(form.valueLacks.trim())),
    };
    exclude = undefined;
  } else if (form.scope === 'declaration') {
    match = {
      scope: 'declaration',
      property: form.property,
      valueMustMatch: optional(form.valueMustMatch),
      valueMustNotMatch: optional(form.valueMustNotMatch),
    };
    exclude = optional(form.exclude);
  } else {
    match = { scope: form.scope, pattern: form.pattern };
    exclude = optional(form.exclude);
  }
  const compiled = compileCustomAudit({ match, exclude });
  return compiled.ok ? ok({ match, exclude }) : err({ kind: 'pattern', problem: compiled.error });
}

/** The audit a form saves as: `id` kept when editing, a fresh one from the name when adding. */
export function auditOf(
  form: CustomAuditForm,
  identity: { readonly id: string | undefined; readonly enabled: boolean; readonly taken: readonly string[] },
): Result<CustomAudit, CustomAuditFormProblem> {
  const name = form.name.trim().slice(0, CUSTOM_AUDIT_LIMITS.nameCharsMax);
  if (name.length === 0) {
    return err({ kind: 'name' });
  }
  const category = customAuditCategoryOf(form.category).slice(0, CUSTOM_AUDIT_LIMITS.categoryCharsMax);
  if (category.length === 0) {
    return err({ kind: 'category' });
  }
  const described = matchOf(form);
  if (!described.ok) {
    return described;
  }
  const message = form.message.trim().slice(0, CUSTOM_AUDIT_LIMITS.messageCharsMax);
  const id = identity.id ?? customAuditIdFor(name, identity.taken);
  return ok({
    id,
    name,
    icon: form.icon,
    category,
    severity: form.severity,
    match: described.value.match,
    exclude: described.value.exclude,
    message: message.length === 0 ? undefined : message,
    enabled: identity.enabled,
  });
}
