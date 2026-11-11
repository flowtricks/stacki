// The design-token linter: raw values in CSS that should come from variables.
// It reads declarations only — a property, a colon, a value — and never a
// selector, so a fix can only ever swap a value: the selector, its scoping and
// every other byte stay as written (Stacki never rewrites a person's CSS
// scoping). Values inside `var(…)` (fallbacks included), variable definitions
// (`--x: 1rem`), keywords, the project's allowed raw values, and calc() whose
// parts are all variables are left alone.
import { assert } from '../core/assert';

/** The rules the linter applies; `.stacki/audits.json` supplies them (shared/properties/auditIgnores.ts TokenRules has this shape). */
export interface TokenRules {
  readonly properties: readonly string[];
  readonly colors: boolean;
  readonly px: boolean;
  readonly remOutsideVariables: boolean;
  readonly allowed: readonly string[];
}

/** Whether `property` is one the rules cover: an exact name, or a `prefix*` pattern. */
export function coveredProperty(rules: Pick<TokenRules, 'properties'>, property: string): boolean {
  const name = property.toLowerCase();
  assert(name.length > 0, 'coveredProperty: a property has a name');
  return rules.properties.some((pattern) => (pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern.toLowerCase()));
}

export type TokenIssueKind = 'token-color' | 'token-value' | 'token-unit';

/** One raw value in one declaration, by its offsets in the text that was linted. */
export interface TokenIssue {
  readonly kind: TokenIssueKind;
  readonly property: string;
  /** The declaration's whole value, as written. */
  readonly value: string;
  /** The raw token: `#121212`, `12px`, `rgb(0 0 0 / 50%)`. */
  readonly token: string;
  readonly offset: number;
  /** The rule's selector (`.button:hover`), or empty for an inline style. */
  readonly selector: string;
}

/** Declarations one text may hold before the linter stops reading it. */
const DECLARATIONS_MAX = 20_000;
const TOKEN_ISSUES_MAX = 2_000;

const COLOR_RE = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\([^()]*\)/g;
const NUMBER_RE = /(?<![\w#.-])-?(?:\d+\.?\d*|\.\d+)(?:px|rem|em|%|vh|vw|vmin|vmax|ch|ex|pt|svh|dvh|lvh|cqw|cqh)?(?![\w.%])/g;

/** Every raw value in `text` (a stylesheet, a style block's inside, or an inline style's value) the rules flag. */
export function lintCss(text: string, settings: TokenRules): readonly TokenIssue[] {
  assert(text.length <= 10_000_000, 'lintCss: the text is inside the source bound');
  const clean = blankComments(text);
  const issues: TokenIssue[] = [];
  const declaration = /([A-Za-z-][\w-]*)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/g;
  let count = 0;
  for (const match of clean.matchAll(declaration)) {
    count += 1;
    if (count > DECLARATIONS_MAX || issues.length >= TOKEN_ISSUES_MAX) {
      break;
    }
    const property = match[1] ?? '';
    const value = match[2] ?? '';
    const valueOffset = (match.index ?? 0) + match[0].indexOf(value, property.length);
    if (property.startsWith('--') || !looksLikeDeclaration(clean, match.index ?? 0)) {
      continue; // A variable definition is where raw values belong; anything else is a selector's colon.
    }
    issues.push(...declarationIssues({ property, value, valueOffset, selector: selectorAt(clean, match.index ?? 0) }, settings));
  }
  assert(issues.length <= TOKEN_ISSUES_MAX + 64, 'lintCss: issues are bounded');
  return issues;
}

// A declaration starts a statement: after `{`, `;` or the start of the text, not inside a selector.
function looksLikeDeclaration(text: string, at: number): boolean {
  const before = text.slice(Math.max(0, at - 200), at).replace(/\s+$/, '');
  return before.length === 0 || before.endsWith('{') || before.endsWith(';');
}

function declarationIssues(
  declaration: { readonly property: string; readonly value: string; readonly valueOffset: number; readonly selector: string },
  settings: TokenRules,
): readonly TokenIssue[] {
  const { property, value, valueOffset, selector } = declaration;
  if (settings.allowed.includes(value.trim().toLowerCase())) {
    return [];
  }
  const outside = blankVariables(value);
  const issues: TokenIssue[] = [];
  const taken: [number, number][] = [];
  const push = (kind: TokenIssueKind, token: string, at: number): void => {
    if (taken.some(([start, end]) => at < end && at + token.length > start)) {
      return;
    }
    taken.push([at, at + token.length]);
    issues.push({ kind, property, value, token, offset: valueOffset + at, selector });
  };
  if (settings.colors) {
    for (const match of outside.matchAll(COLOR_RE)) {
      push('token-color', match[0], match.index ?? 0);
    }
  }
  const covered = coveredProperty(settings, property);
  for (const match of outside.matchAll(NUMBER_RE)) {
    const token = match[0];
    const at = match.index ?? 0;
    if (Number.parseFloat(token) === 0 || settings.allowed.includes(token.toLowerCase()) || insideCalculationFactor(outside, at, token)) {
      continue;
    }
    if (covered) {
      push('token-value', token, at);
    } else if (settings.px && token.endsWith('px')) {
      push('token-unit', token, at);
    } else if (settings.remOutsideVariables && token.endsWith('rem')) {
      push('token-unit', token, at);
    }
  }
  return issues.sort((left, right) => left.offset - right.offset);
}

// A unitless factor inside calc() (`calc(var(--x) * 2)`) scales a variable; it is not a raw size.
function insideCalculationFactor(value: string, at: number, token: string): boolean {
  if (/[a-z%]$/i.test(token)) {
    return false;
  }
  // The functions open at `at`, innermost last: inside calc() however deep its parentheses go.
  const open: string[] = [];
  const before = value.slice(0, at);
  for (let index = 0; index < before.length; index++) {
    const char = before[index];
    if (char === '(') {
      open.push(/([a-z-]*)$/i.exec(before.slice(0, index))?.[1]?.toLowerCase() ?? '');
    } else if (char === ')') {
      open.pop();
    }
  }
  return open.includes('calc');
}

/** The selector of the rule a declaration at `at` sits in: the text before its nearest enclosing `{`. */
export function selectorAt(text: string, at: number): string {
  assert(at >= 0, 'selectorAt: an offset');
  let depth = 0;
  for (let index = at - 1; index >= 0; index--) {
    const char = text[index];
    if (char === '}') {
      depth += 1;
    } else if (char === '{') {
      if (depth === 0) {
        const start = Math.max(text.lastIndexOf('}', index - 1), text.lastIndexOf('{', index - 1), text.lastIndexOf(';', index - 1)) + 1;
        return text.slice(start, index).replace(/\s+/g, ' ').trim();
      }
      depth -= 1;
    }
  }
  return '';
}

/** `text` with every comment blanked, so offsets still index the original. */
export function blankComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, (comment) => ' '.repeat(comment.length));
}

/** `value` with every `var(…)`, nested parentheses and all, blanked, so offsets still index the original. */
export function blankVariables(value: string): string {
  let out = value;
  for (let start = out.indexOf('var('); start !== -1; start = out.indexOf('var(', start + 1)) {
    let depth = 0;
    let end = start + 3;
    for (; end < out.length; end++) {
      const char = out[end];
      if (char === '(') {
        depth += 1;
      } else if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          break;
        }
      }
    }
    out = `${out.slice(0, start)}${' '.repeat(end + 1 - start)}${out.slice(end + 1)}`;
  }
  assert(out.length === value.length, 'blankVariables: offsets are kept');
  return out;
}

/** The variables whose value is exactly `token`, compared without case or extra spaces. */
export function variablesFor(token: string, variables: ReadonlyMap<string, string>): readonly string[] {
  const wanted = normalized(token);
  const found = [...variables].filter(([, value]) => normalized(value) === wanted).map(([name]) => name);
  assert(found.length <= variables.size, 'variablesFor: a subset');
  return found.sort();
}

function normalized(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

export const TOKEN_GROUPS = ['colour', 'spacing', 'radius', 'type', 'size', 'unit'] as const;
export type TokenGroup = (typeof TOKEN_GROUPS)[number];

/** What kind of value an issue is, for the review's filters and the row's breakdown. */
export function tokenGroup(issue: Pick<TokenIssue, 'kind' | 'property'>): TokenGroup {
  if (issue.kind === 'token-color') {
    return 'colour';
  }
  if (issue.kind === 'token-unit') {
    return 'unit';
  }
  const property = issue.property.toLowerCase();
  if (property.includes('radius')) {
    return 'radius';
  }
  if (/^(font|line-height|letter-spacing)/.test(property)) {
    return 'type';
  }
  return /^(padding|margin|gap|row-gap|column-gap|inset|top|right|bottom|left)/.test(property) ? 'spacing' : 'size';
}

/** Rules whose custom properties are the project's design tokens: the root, the document and theme scopes. */
const TOKEN_SCOPE = /^(?::root|html|:host|body|\[data-theme[^\]]*\]|\.theme[\w-]*|:root\s*\[[^\]]*\]|:root\.[\w-]+)$/i;

/**
 * The project's design tokens, from the variable reader's files (`css:variables`): custom properties
 * declared in a stylesheet (not a component's style block) in a root or theme rule. A private name
 * (`--_size`) or one a component rule defines for itself is never offered as a replacement.
 */
export function tokenVariables(files: unknown): ReadonlyMap<string, string> {
  const tokens = new Map<string, string>();
  const list = Array.isArray(files) ? files : [];
  for (const file of list.slice(0, 500)) {
    const rel: unknown = typeof file === 'object' && file !== null ? Reflect.get(file, 'rel') : undefined;
    const rules: unknown = typeof file === 'object' && file !== null ? Reflect.get(file, 'declarations') : undefined;
    if (typeof rel !== 'string' || !rel.endsWith('.css') || !Array.isArray(rules)) {
      continue;
    }
    for (const rule of rules.slice(0, 5_000)) {
      collectRule(rule, tokens);
    }
  }
  assert(tokens.size <= 100_000, 'tokenVariables: bounded');
  return tokens;
}

function collectRule(rule: unknown, tokens: Map<string, string>): void {
  if (typeof rule !== 'object' || rule === null) {
    return;
  }
  const selector: unknown = Reflect.get(rule, 'selector');
  const entries: unknown = Reflect.get(rule, 'entries');
  if (typeof selector !== 'string' || !Array.isArray(entries)) {
    return;
  }
  const scopes = selector.split(',').map((part) => part.trim());
  if (!scopes.every((scope) => TOKEN_SCOPE.test(scope))) {
    return;
  }
  for (const entry of entries.slice(0, 5_000)) {
    if (typeof entry !== 'object' || entry === null || Reflect.get(entry, 'kind') !== 'var') {
      continue;
    }
    const name: unknown = Reflect.get(entry, 'name');
    const value: unknown = Reflect.get(entry, 'value');
    if (typeof name === 'string' && typeof value === 'string') {
      const full = name.startsWith('--') ? name : `--${name}`;
      if (!full.startsWith('--_') && !tokens.has(full)) {
        tokens.set(full, value);
      }
    }
  }
}
