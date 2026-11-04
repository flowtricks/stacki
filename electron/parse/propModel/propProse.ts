// What a prop's doc comment says in prose: the fallback it promises
// ("Defaults to `webp`") and the range a number takes ("between 1 and 6").
// The tags (`@min`, `@decimals`, …) are read by shared/properties/propTags.ts,
// the one tag reader every panel shares; prose is read only here, by the main
// process's prop model, and a tag always wins over the prose beside it.

import type ts from 'typescript';
import { assert } from '../../../shared/core/assert';
import { readPropTags, tagStep } from '../../../shared/properties/propTags';
import type { DefaultRule } from '../../../shared/properties/propSchema';
import type { NumberRules } from '../astroParserTypes';

export interface StatedDefault {
  readonly value?: string | number;
  readonly hint?: string;
  readonly when?: DefaultRule;
}

// A member is documented by a handful of comment lines; past this many the rest are not read.
const DOCUMENTATION_COMMENTS_MAX = 64;

/**
 * The doc of the member that starts at `position`: the comments right above it,
 * as one line of text. A blank line ends a comment's reach, so a note about the
 * interface itself does not land on whatever prop comes next. Block comments
 * lose their `/*`, `*\/` and leading `*`; line comments their `//`.
 */
export function commentDocumentation(text: string, position: number, ranges: readonly ts.CommentRange[]): string {
  assert(position >= 0, 'commentDocumentation: the member starts inside the text');
  assert(ranges.length <= DOCUMENTATION_COMMENTS_MAX * 4, 'commentDocumentation: comments are bounded');
  let pieces: string[] = [];
  for (let index = 0; index < ranges.length && index < DOCUMENTATION_COMMENTS_MAX; index++) {
    const range = ranges[index];
    assert(range !== undefined, 'commentDocumentation: a comment range exists');
    const before = index === 0 ? '' : text.slice(ranges[index - 1]?.end ?? range.pos, range.pos);
    if (/\n[^\S\n]*\n/.test(before)) {
      pieces = [];
    }
    pieces.push(commentText(text.slice(range.pos, range.end)));
  }
  const last = ranges.at(-1);
  if (last !== undefined && /\n[^\S\n]*\n/.test(text.slice(last.end, position))) {
    return '';
  }
  return pieces.join(' ').replace(/\s+/g, ' ').trim();
}

function commentText(comment: string): string {
  if (comment.startsWith('//')) {
    return comment.slice(2).trim();
  }
  const body = comment.replace(/^\/\*/, '').replace(/\*\/$/, '');
  return body
    .split('\n')
    .map((line) => line.trim().replace(/^\*+\s?/, ''))
    .join(' ');
}

// What a doc comment promises about a prop's fallback. Returns a value when it
// names exactly one, a hint when it names several, and nothing when it is
// prose. Used twice: once for the field itself, and once per union branch,
// where a prop written in several branches has a different answer in each.
export function statedDefault(documentation: string | undefined): StatedDefault {
  if (!documentation) {
    return {};
  }
  const stated = documentation.match(/defaults?\s*(?:to|:)\s*`([^`]+)`/i) || documentation.match(/defaults?\s*(?:to|:)\s*([^`.,;]+)/i);
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
      clause.match(/^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s+(?:is|=|===)\s*`?([^`\s.,]+)`?/i) ||
      clause.match(/^\s*`([^`]+)`.*?\bor\b\s*`([^`]+)`\s*(?:when|while|if)\s+([A-Za-z_$][\w$]*)\s*$/i);
    const prop = rule?.[3];
    const then = rule?.[2];
    const otherwise = rule?.[1];
    if (prop !== undefined && then !== undefined && otherwise !== undefined) {
      return { hint, when: { prop, is: rule?.[4] === undefined ? 'true' : String(rule[4]), then, otherwise } };
    }
    return hint ? { hint } : {};
  }

  const text = (stated[1] ?? '').trim().replace(/^["']|["']$/g, '');
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
  const tags = readPropTags(documentation);
  const rules: NumberRules = {};
  if (tags.min !== undefined) {
    rules.min = tags.min;
  }
  if (tags.max !== undefined) {
    rules.max = tags.max;
  }
  const step = tagStep(tags);
  if (step !== undefined) {
    rules.step = step;
  }
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
  // Prose and tags together may still disagree ("between 5 and 1"); a range
  // that contradicts itself keeps its minimum, as the tag reader does.
  if (rules.min !== undefined && rules.max !== undefined && rules.max < rules.min) {
    delete rules.max;
    delete rules.maxExclusive;
  }
  return rules;
}

/**
 * What every branch of a union says about each prop it documents differently:
 * their common opening, to the last sentence they share. Where they part is
 * the per-branch fallback, which the field answers for the branch in force.
 */
export function sharedDocumentation(branchDocs: readonly Readonly<Record<string, string>>[]): ReadonlyMap<string, string> {
  const perName = new Map<string, Set<string>>();
  for (const docs of branchDocs) {
    for (const [name, documentation] of Object.entries(docs)) {
      const set = perName.get(name) ?? new Set<string>();
      set.add(documentation);
      perName.set(name, set);
    }
  }
  const shared = new Map<string, string>();
  for (const [name, docs] of perName) {
    if (docs.size < 2) {
      continue;
    }
    const all = [...docs];
    const first = all[0] ?? '';
    let index = 0;
    while (index < first.length && all.every((other) => other[index] === first[index])) {
      index++;
    }
    const cut = first.slice(0, index).lastIndexOf('.');
    const common = cut === -1 ? '' : first.slice(0, cut + 1).trim();
    if (common) {
      shared.set(name, common);
    }
  }
  assert(shared.size <= perName.size, 'sharedDocumentation: one entry per documented name at most');
  return shared;
}
