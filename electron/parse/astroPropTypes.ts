// Prop types as the props panel reads them: a type split at its top level,
// a union exploded into members, a stated default, number rules from JSDoc
// tags, and a TypeScript type normalized to the panel's kinds.

import type { NumberRules, StatedDefault, NormalizedType } from './astroParserTypes';
import { required } from './astroAttrs';
import { skipStringOrComment } from './astroScan';

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
    if ('([{<'.includes(character)) {
      depth++;
    } else if (')]}>'.includes(character)) {
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
export function explodeMembers(block: string): string {
  return splitTypeTop(block, ';').join('\n');
}

// `prelude` carries type declarations this file imports from elsewhere. A
// component is free to write `type Props = SeoProps` with SeoProps in
// types.ts, and without the declaration text there is nothing to read — the
// panel would show a component with no props at all. The caller (which has
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
  // Union of string literals ('primary' | 'secondary') → enum with options.
  const parts = typeText
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length > 1) {
    const literals = parts.filter((part) => /^(['"`]).*\1$/.test(part));
    const rest = parts.filter((part) => !/^(['"`]).*\1$/.test(part));
    if (literals.length >= 2 && rest.every((part) => part === 'undefined' || part === 'null')) {
      return { type: 'enum', options: literals.map((part) => part.slice(1, -1)) };
    }
    // The same thing written with numbers — `1 | 2 | … | 12` for a column
    // count. A free number field would take -1, 0 and 1.5, none of which the
    // type allows, so this is a list too. `numeric` tells the panel to write
    // `cols={3}` rather than `cols="3"`; the component is typed for a number.
    const nums = parts.filter((part) => /^-?\d+(?:\.\d+)?$/.test(part));
    const notNums = parts.filter((part) => !/^-?\d+(?:\.\d+)?$/.test(part));
    if (nums.length >= 2 && notNums.every((part) => part === 'undefined' || part === 'null')) {
      return { type: 'enum', numeric: true, options: nums };
    }
  }
  // Arrays, tuples and object literals are values only JS can express —
  // `number[]`, `(number | \`${number}x\`)[]`, `{ a: 1 }`. They must be checked
  // BEFORE the primitive prefixes, or `number[]` reads as a plain number and
  // the field writes `widths="400"` where the component wants `widths={[400]}`.
  // A text field here produces a string, and the component does .map on it.
  const arrayish = /\[\s*\]\s*$/.test(typeText) || /^Array\s*</.test(typeText) || /^\[[\s\S]*\]$/.test(typeText);
  // A plain bag of attributes still edits as name/value rows — that reads far
  // better than a JS literal. Only when it can also be an ARRAY does it have
  // to become code, since rows cannot express one.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(typeText) && !arrayish) {
    return { type: 'attrs' };
  }
  if (arrayish || /^\{[\s\S]*\}$/.test(typeText)) {
    return { type: 'code' };
  }
  if (/^string\b/.test(typeText)) {
    return { type: 'string' };
  }
  if (/^number\b/.test(typeText)) {
    return { type: 'number' };
  }
  if (/^boolean\b/.test(typeText)) {
    return { type: 'boolean' };
  }
  if (/^(['"`]).*\1$/.test(typeText)) {
    return { type: 'string' };
  }
  // Objects of attributes (HTMLAttributes<"div">, Record<string, …>) edit
  // as name/value rows.
  if (/^(HTMLAttributes\b|astroHTML\.|Record\s*<)/.test(typeText)) {
    return { type: 'attrs' };
  }
  return { type: 'other' };
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
  if (/@(?:int|integer)\b/i.test(documentation) && rules.step === undefined) {
    rules.step = 1;
  }

  return rules;
}
