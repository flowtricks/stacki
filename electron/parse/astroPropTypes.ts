// Prop types as the props panel reads them: a type split at its top level,
// a union exploded into members, a stated default, number rules from JSDoc
// tags, and a TypeScript type normalized to the panel's kinds.

import type { NumberRules, StatedDefault, NormalizedType } from './astroParserTypes';
import { required } from './astroAttrs';
import { skipStringOrComment } from './astroScan';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

// ---------------------------------------------------------------------------
// Component prop schema extraction
// ---------------------------------------------------------------------------

// Returns [{name, type: 'string'|'number'|'boolean'|'other', optional, default}]
// Splits a type expression on a top-level operator, ignoring ones inside
// braces, parens, brackets or strings.
export function splitTypeTop(expr: string, op: string): string[] {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < expr.length; i++) {
    const skipped = skipStringOrComment(expr, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const character = expr.charAt(i);
    // The `>` of a function type's arrow closes nothing: counting it left every
    // member after `format?: (value: number) => string;` one level too deep.
    const arrow = character === '>' && expr.charAt(i - 1) === '=';
    if ('([{<'.includes(character)) {
      depth++;
    } else if (')]}>'.includes(character) && !arrow) {
      depth--;
    } else if (character === op && depth === 0) {
      out.push(expr.slice(start, i));
      start = i + 1;
    }
  }
  out.push(expr.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

// A member block written on one line (`{ variant: "fixed"; sizes?: never }`)
// holds several members between semicolons. Both walkers below read one member
// per line, so the top-level semicolons become newlines first — nested ones
// (inside a nested object or a generic) are left alone.
//
// A member whose type is an object written over several lines
//   cta: {
//     label: string;
//     link: { href: string };
//   };
// stays one line too: its inner line breaks become spaces (and comments inside
// it are dropped), or each inner member would read as a prop of its own.
export function explodeMembers(block: string): string {
  return splitTypeTop(block, ';').map(flattenNested).join('\n');
}

// One member's text with everything inside brackets on one line. Comments at
// the top level stay where they are: they document the member below them.
function flattenNested(member: string): string {
  let out = '';
  let depth = 0;
  for (let i = 0; i < member.length; i++) {
    const skipped = skipStringOrComment(member, i);
    if (skipped !== i) {
      const piece = member.slice(i, skipped);
      const comment = piece.startsWith('//') || piece.startsWith('/*');
      out += depth > 0 && comment ? ' ' : piece;
      i = skipped - 1;
      continue;
    }
    const character = member.charAt(i);
    const arrow = character === '>' && member.charAt(i - 1) === '=';
    if ('([{<'.includes(character)) {
      depth++;
    } else if (')]}>'.includes(character) && !arrow) {
      depth = Math.max(0, depth - 1);
    }
    out += depth > 0 && (character === '\n' || character === '\r') ? ' ' : character;
  }
  assert(out.length <= member.length, 'flattenNested: flattening never adds text');
  return out;
}

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
// A const array or object of literals in the frontmatter, the way a component
// lists its choices once and types a prop from it:
//   const SIZES = ['sm', 'md', 'lg'] as const;     size?: (typeof SIZES)[number]
//   const Tone = { Info: 'info' } as const;        tone?: (typeof Tone)[keyof typeof Tone]
// Entries keep each value's literal text (`'sm'`, `3`); an array's keys are its indexes.
export interface ConstLiterals {
  readonly kind: 'array' | 'object';
  readonly asConst: boolean;
  readonly entries: readonly (readonly [key: string, literal: string])[];
}

// A frontmatter declares a few such lists; more than this are not read.
const CONST_LISTS_MAX = 64;
const LITERAL_RE = /^(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|-?\d+(?:\.\d+)?|true|false)$/;

/** Every `const X = [literals]` and `const X = { key: literal }` the code declares, by name. */
export function constLiteralLists(code: string): ReadonlyMap<string, ConstLiterals> {
  const out = new Map<string, ConstLiterals>();
  const declaration = /(?:^|[\n;])\s*(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*([[{])/g;
  for (let found = 0; found < CONST_LISTS_MAX; found++) {
    const match = declaration.exec(code);
    if (match === null) {
      break;
    }
    const open = match.index + match[0].length - 1;
    const close = matchingBracket(code, open);
    if (close === -1) {
      continue;
    }
    const kind = code.charAt(open) === '[' ? 'array' : 'object';
    const entries = literalEntries(code.slice(open + 1, close), kind);
    if (entries !== undefined) {
      const asConst = /^\s*as\s+const\b/.test(code.slice(close + 1));
      out.set(required(match[1], 'Const list name capture'), { kind, asConst, entries });
    }
  }
  assert(out.size <= CONST_LISTS_MAX, 'constLiteralLists: bounded');
  return out;
}

// The text with each type query over an `as const` list replaced by the union
// it stands for, so the type reader sees `'sm' | 'md' | 'lg'`. An array's
// values are `(typeof X)[number]` (or `typeof X[number]`), an object's values
// `(typeof X)[keyof typeof X]`, and an object's keys `keyof typeof X`.
export function resolveConstTypeQueries(code: string): string {
  const lists = constLiteralLists(code);
  if (lists.size === 0) {
    return code;
  }
  const union = (name: string, part: 'values' | 'keys', kind: ConstLiterals['kind']): string | undefined => {
    const list = lists.get(name);
    if (list === undefined || !list.asConst || list.kind !== kind) {
      return undefined;
    }
    const pieces = list.entries.map(([key, literal]) => (part === 'keys' ? JSON.stringify(key) : literal));
    return pieces.length ? pieces.join(' | ') : undefined;
  };
  const resolved = code
    .replace(
      /(?:\(\s*)?typeof\s+([A-Za-z_$][\w$]*)(?:\s*\))?\s*\[\s*keyof\s+typeof\s+\1\s*\]/g,
      (whole, name: string) => union(name, 'values', 'object') ?? whole,
    )
    .replace(/(?:\(\s*)?typeof\s+([A-Za-z_$][\w$]*)(?:\s*\))?\s*\[\s*number\s*\]/g, (whole, name: string) => union(name, 'values', 'array') ?? whole)
    .replace(/\bkeyof\s+typeof\s+([A-Za-z_$][\w$]*)/g, (whole, name: string) => union(name, 'keys', 'object') ?? whole);
  assert(resolved.length > 0, 'resolveConstTypeQueries: text stays');
  return resolved;
}

// The entries between a list's brackets, when every value is a literal.
function literalEntries(inside: string, kind: ConstLiterals['kind']): (readonly [string, string])[] | undefined {
  const items = splitTypeTop(inside, ',');
  if (items.length > LIMITS.propOptionsMax) {
    return undefined;
  }
  const entries: (readonly [string, string])[] = [];
  for (const [index, item] of items.entries()) {
    if (kind === 'array') {
      if (!LITERAL_RE.test(item)) {
        return undefined;
      }
      entries.push([String(index), item]);
      continue;
    }
    const member = item.match(/^([A-Za-z_$][\w$]*|"[^"\n]*"|'[^'\n]*')\s*:\s*([\s\S]+)$/);
    const literal = member?.[2]?.trim();
    if (member === null || literal === undefined || !LITERAL_RE.test(literal)) {
      return undefined;
    }
    entries.push([memberName(required(member[1], 'Const member name capture')), literal]);
  }
  return entries;
}

function matchingBracket(code: string, open: number): number {
  const opener = code.charAt(open);
  assert(opener === '[' || opener === '{', 'matchingBracket: starts at a bracket');
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const skipped = skipStringOrComment(code, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const character = code.charAt(i);
    if (character === '[' || character === '{' || character === '(') {
      depth++;
    } else if (character === ']' || character === '}' || character === ')') {
      depth--;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

// A member's name in a type: an identifier, or a quoted name such as
// `'data-id'` or `"aria-label"` (attributes are spelled with dashes).
export const MEMBER_NAME_SOURCE = String.raw`([\w$]+|'[^'\n]+'|"[^"\n]+")`;

/** A member name as the prop is called: quotes taken off a quoted one. */
export function memberName(raw: string): string {
  const quoted = raw.match(/^(['"])(.+)\1$/);
  const name = quoted ? required(quoted[2], 'Quoted member name capture') : raw;
  assert(name.length > 0, 'memberName: a member has a name');
  return name;
}

// What a doc comment promises about a prop's fallback. Returns a value when it
// names exactly one, a hint when it names several, and nothing when it is
// prose. Used twice: once for the field itself, and once per union branch,
// where a prop written in several branches has a different answer in each.
export function statedDefault(documentation: string | undefined): StatedDefault {
  if (!documentation) {
    return {};
  }
  const stated = documentation.match(/defaults?\s*(?:to|:)\s*\`([^\`]+)\`/i) || documentation.match(/defaults?\s*(?:to|:)\s*([^\`.,;]+)/i);
  if (!stated) {
    return {};
  }

  // "Defaults to `webp`, or `svg` for SVG sources" is TWO answers, and which
  // one applies depends on a prop only the component can weigh. Asserting the
  // first would have the panel show `webp` while the build emits `svg`.
  //
  // Naming a second value is the tell, whatever word joins them. Asking for
  // "for", "when", "if" or "on" as well let "Defaults to `Play`, or `Pause`
  // while pressed" through as a plain default of Play, and the panel offered
  // Play on a close button. A list of joining words is always one word short.
  // Explicit advice after "; use" starts a separate clause about an authored
  // choice, not another automatic fallback. Keep quoted values intact while
  // stopping there. Prose still needs joining words, having no values to count.
  const clause = (documentation.match(/defaults?\s*(?:to|:)\s*((?:`[^`]*`|(?!;\s*use\b)[^.])+)/i) || [])[1] || '';
  const named = clause.match(/`[^`]+`/g) || [];
  const conditional = named.length > 1 || (/\bor\b/i.test(clause) && /\b(?:for|when|if|on|while|unless|with|without|depending)\b/i.test(clause));
  if (conditional) {
    const hint = clause
      .replace(/`/g, '')
      .replace(/\s+/g, ' ')
      .replace(/\s*passthrough\s*/i, ' ')
      .trim();

    // A clause that names the prop it turns on can be answered rather than
    // only reported: "Defaults to `Next`, or `Previous` when direction is
    // `back`" is a rule the panel can weigh, because direction is a prop it
    // already has. The bare form — "or `Pause` when pressed" — reads a
    // boolean prop being true.
    const rule =
      clause.match(
        new RegExp('^\\s*`([^`]+)`.*?\\bor\\b\\s*`([^`]+)`\\s*(?:when|whi' + 'le|if)\\s+([A-Za-z_$][\\w$]*)\\s+(?:is|=|===)\\s*`?(' + '[^`\\s.,]+)`?', 'i'),
      ) || clause.match(/^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s*$/i);
    if (rule) {
      return {
        hint,
        when: {
          prop: required(rule[3], 'Default condition prop capture'),
          is: rule[4] === undefined ? 'true' : String(rule[4]),
          then: required(rule[2], 'Conditional default capture'),
          otherwise: required(rule[1], 'Fallback default capture'),
        },
      };
    }
    return hint ? { hint } : {};
  }

  const text = required(stated[1], 'Stated default capture')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (text && text.length <= 24 && !/\s(the|a|an|whatever|sensible)\s/i.test(` ${text} `)) {
    return { value: /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : text };
  }
  return {};
}

// What a number prop will actually accept. TypeScript can't say "greater than
// zero", so components say it in the doc comment — either as a tag, which is
// exact, or in the sentence a human reads, which is a guess and can be
// overridden by a tag. Returns {} when the doc says nothing about a range.
const NUMBER_RE = String.raw`-?\d+(?:\.\d+)?`;
export function numberRules(documentation: string | undefined): NumberRules {
  if (!documentation) {
    return {};
  }
  const rules = numberRulesTags(documentation);
  // Prose, for the props that were written before any of that existed. Only
  // phrases that state a bound outright — "Defaults to 12" is not one, and
  // neither is "Columns from 30rem up". Each match is struck out as it is
  // read, so "no more than 8" can't be picked up a second time by the bare
  // "more than" pattern underneath it and turned into a minimum.
  let prose = documentation.replace(/@\w+\s+-?[\d.]+/g, ' ');
  const take = (re: RegExp, apply: (a: number, b: number) => void) => {
    const match = prose.match(re);
    if (!match) {
      return;
    }
    apply(Number.parseFloat(match[1] ?? ''), Number.parseFloat(match[2] ?? ''));
    prose = prose.replace(match[0], ' ');
  };
  take(new RegExp(`between\\s+(${NUMBER_RE})\\s+and\\s+(${NUMBER_RE})`, 'i'), (low, high) => {
    if (rules.min === undefined) {
      rules.min = low;
    }
    if (rules.max === undefined) {
      rules.max = high;
    }
  });
  // Inclusive bounds first: they contain the words the exclusive ones use.
  take(new RegExp(`(?:no more than|not more than|at most|maximum(?: of)?|up to)\\s+(${NUMBER_RE})`, 'i'), (bound) => {
    if (rules.max === undefined) {
      rules.max = bound;
    }
  });
  take(new RegExp(`(?:no less than|not less than|at least|minimum(?: of)?)\\s+(${NUMBER_RE})`, 'i'), (bound) => {
    if (rules.min === undefined) {
      rules.min = bound;
    }
  });
  take(new RegExp(`(?:greater than|more than|above)\\s+(${NUMBER_RE})`, 'i'), (bound) => {
    if (rules.min !== undefined) {
      return;
    }
    rules.min = bound;
    rules.minExclusive = true;
  });
  take(new RegExp(`(?:less than|below|under)\\s+(${NUMBER_RE})`, 'i'), (bound) => {
    if (rules.max !== undefined) {
      return;
    }
    rules.max = bound;
    rules.maxExclusive = true;
  });
  if (rules.step === undefined && /\b(whole numbers?|integers?|no decimals?)\b/i.test(prose)) {
    rules.step = 1;
  }
  return rules;
}

export function normalizeType(typeText: string): NormalizedType {
  // `readonly string[]` and `readonly [min: number, max: number]` are the same
  // values as their mutable forms; the modifier only stops the component
  // reassigning them.
  const text = typeText.trim().replace(/^readonly\s+/, '');
  const choice = literalChoice(text);
  if (choice !== undefined) {
    return choice;
  }
  // Arrays, tuples and object literals are values only JS can express —
  // `number[]`, `(number | \`${number}x\`)[]`, `{ a: 1 }`. They must be checked
  // BEFORE the primitive prefixes, or `number[]` reads as a plain number and
  // the field writes `widths="400"` where the component wants `widths={[400]}`.
  // A text field here produces a string, and the component does .map on it.
  const arrayish = /\[\s*\]\s*$/.test(text) || /^(?:Readonly)?Array\s*</.test(text) || /^\[[\s\S]*\]$/.test(text);
  // A plain bag of attributes still edits as name/value rows — that reads far
  // better than a JS literal. Only when it can also be an ARRAY does it have
  // to become code, since rows cannot express one.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(text) && !arrayish) {
    return { type: 'attrs' };
  }
  if (arrayish) {
    return { type: 'code' };
  }
  // An object is not a list: the list editor would write `[…]` into it. The
  // panel edits a simple one as its fields and shows any other as code.
  if (/^\{[\s\S]*\}$/.test(text) && !/^\{\s*\}$/.test(text)) {
    return { type: 'code', codeKind: 'object' };
  }
  const codeKind = codeOnlyKind(text);
  if (codeKind !== undefined) {
    return { type: 'other', codeKind };
  }
  if (/^string\b/.test(text)) {
    return { type: 'string' };
  }
  if (/^number\b/.test(text)) {
    return { type: 'number' };
  }
  if (/^boolean\b/.test(text)) {
    return { type: 'boolean' };
  }
  if (/^(['"`]).*\1$/.test(text)) {
    return { type: 'string' };
  }
  return { type: 'other' };
}

// The longest type text a schema carries for the code row; longer text is cut.
const TYPE_TEXT_CHARS_MAX = 512;

/** A type's text as the panel shows it beside a value set in code: one line, bounded. */
export function shownTypeText(typeText: string): string {
  const flat = typeText.replace(/\s+/g, ' ').trim();
  const shown = flat.length <= TYPE_TEXT_CHARS_MAX ? flat : `${flat.slice(0, TYPE_TEXT_CHARS_MAX - 1)}…`;
  assert(shown.length <= TYPE_TEXT_CHARS_MAX, 'shownTypeText: bounded');
  return shown;
}

const STRING_LITERAL_RE = /^(['"])(.*)\1$/s;
const NUMBER_LITERAL_RE = /^-?\d+(?:\.\d+)?$/;
const NULLISH_PARTS: ReadonlySet<string> = new Set(['undefined', 'null']);

// A union of literals is a fixed set of choices: `'sm' | 'lg'`, `1 | 2 | 3`,
// and mixed ones — `boolean | 'auto'` is true, false or auto, and
// `'sm' | 'lg' | number` offers its two words (a number stays possible in
// code). The options that are not strings are written as expressions, so
// `flag={true}` stays a boolean. Undefined when the type is not such a union.
function literalChoice(text: string): NormalizedType | undefined {
  const parts = splitTypeTop(text, '|').filter((part) => !NULLISH_PARTS.has(part));
  if (parts.length < 2) {
    return undefined;
  }
  const options: string[] = [];
  const expressions: string[] = [];
  let strings = 0;
  let widenedToNumber = false;
  for (const part of parts) {
    const literal = part.match(STRING_LITERAL_RE);
    if (literal) {
      options.push(required(literal[2], 'String literal capture'));
      strings++;
    } else if (NUMBER_LITERAL_RE.test(part) || part === 'true' || part === 'false') {
      options.push(part);
      expressions.push(part);
    } else if (part === 'boolean') {
      options.push('true', 'false');
      expressions.push('true', 'false');
    } else if (part === 'number') {
      widenedToNumber = true;
    } else {
      return undefined;
    }
  }
  const unique = [...new Set(options)];
  assert(unique.length <= options.length, 'literalChoice: options never grow when made unique');
  if (unique.length < 2 || unique.length > LIMITS.propOptionsMax) {
    return undefined;
  }
  // `number | 1 | 2` is any number; only words beside `number` make a choice.
  if (widenedToNumber && strings < 2) {
    return undefined;
  }
  if (strings === 0) {
    // `true | false` is just a boolean.
    if (unique.every((option) => option === 'true' || option === 'false')) {
      return { type: 'boolean' };
    }
    if (unique.every((option) => NUMBER_LITERAL_RE.test(option))) {
      return { type: 'enum', numeric: true, options: unique };
    }
  }
  const written = unique.filter((option) => expressions.includes(option));
  return written.length ? { type: 'enum', options: unique, expressionOptions: written } : { type: 'enum', options: unique };
}

// Values only code can give a prop: a function (an action the component calls),
// and types that say nothing a field could fill in — `any`, `unknown`,
// `object`, a promise, a symbol. Undefined for every other type.
function codeOnlyKind(text: string): 'function' | 'opaque' | undefined {
  const parts = splitTypeTop(text, '|').filter((part) => !NULLISH_PARTS.has(part));
  if (parts.length === 0) {
    return undefined;
  }
  if (parts.every(isFunctionType)) {
    return 'function';
  }
  if (
    parts.length === 1 &&
    /^(?:any|unknown|object|Object|\{\s*\}|symbol|unique\s+symbol|bigint|never|void|(?:Promise|PromiseLike|Map|Set|WeakMap|WeakSet)\s*<[\s\S]*>)$/.test(
      required(parts[0], 'One part'),
    )
  ) {
    return 'opaque';
  }
  return undefined;
}

// `(item: T) => string`, `<T>(x: T) => T`, `() => void`, `(() => void)`,
// `new () => Thing` and `Function`.
function isFunctionType(part: string): boolean {
  const text = part.trim().replace(/^\(([\s\S]*)\)$/, (whole, inner: string) => (balanced(inner) ? inner.trim() : whole));
  if (text === 'Function') {
    return true;
  }
  if (!/^(?:new\s*)?[(<]/.test(text)) {
    return false;
  }
  // The arrow must be at the top level, after the parameter list.
  const arrow = topLevelArrow(text);
  return arrow > 0;
}

function balanced(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const character = text.charAt(i);
    if (character === '(') {
      depth++;
    } else if (character === ')') {
      depth--;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function topLevelArrow(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const skipped = skipStringOrComment(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const character = text.charAt(i);
    const arrow = character === '>' && text.charAt(i - 1) === '=';
    if (arrow && depth === 0) {
      return i;
    }
    if ('([{<'.includes(character)) {
      depth++;
    } else if (')]}>'.includes(character) && !arrow) {
      depth--;
    }
  }
  return -1;
}

function numberRulesTags(documentation: string): NumberRules {
  const rules: NumberRules = {};
  const tag = (name: string) => {
    const match = documentation.match(new RegExp(`@${name}\\s+(${NUMBER_RE})`, 'i'));
    return match ? parseFloat(required(match[1], 'Number rule capture')) : undefined;
  };
  const min = tag('min');
  const max = tag('max');
  const step = tag('step');
  if (min !== undefined) {
    rules.min = min;
  }
  if (max !== undefined) {
    rules.max = max;
  }
  if (step !== undefined) {
    rules.step = step;
  }
  // `@decimals 2` is the precision the property settings form writes: a step of 0.01.
  const decimals = tag('decimals');
  if (decimals !== undefined && Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 10 && rules.step === undefined) {
    rules.step = Number((10 ** -decimals).toFixed(decimals));
  }
  if (/@(?:int|integer)\b/i.test(documentation) && rules.step === undefined) {
    rules.step = 1;
  }

  return rules;
}
