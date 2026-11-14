// How a stylesheet's custom properties are grouped for the editor: naming a
// rule, merging rules that are modes of one set, the families of columns inside
// one rule, and prefix sections (cssVars.ts).

import { assert } from '../../shared/core/assert';
import { type Rule } from './cssVarRead';

export const titleize = (text: unknown): string =>
  String(text)
    .replace(/[-_]+/g, ' ')
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase());

// What to call a rule. A selector list usually leads with the generic one
// (`:root, .theme-light, …`) and the name people use for it is the specific
// one, so the first plain class wins over `:root`, `*` and anything nested.
export function labelForRule(rule: Rule): string {
  const candidates = rule.selectors.length ? rule.selectors : [rule.selector];
  const simpleClass = candidates.find((selector) => /^\.[a-z0-9_-]+$/i.test(selector.trim()));
  const chosen = simpleClass || candidates[0] || rule.selector;
  const cleaned = String(chosen).trim();
  if (cleaned === ':root') {
    return ':root';
  }
  if (/^\.[a-z0-9_-]+$/i.test(cleaned)) {
    return titleize(cleaned.slice(1));
  }
  return cleaned;
}

// The stem shared by a set of labels, for naming a group of modes: "Theme
// light" + "Theme dark" + "Theme brand" → "Theme".
export function commonStem(labels: readonly string[]): string {
  if (!labels.length) {
    return '';
  }
  const words = labels.map((label) => label.split(/\s+/));
  const stem: string[] = [];
  for (let i = 0; i < (words[0]?.length ?? 0); i++) {
    const word = words[0]?.[i];
    if (!word || !words.every((labelWords) => labelWords[i] === word)) {
      break;
    }
    stem.push(word);
  }
  return stem.join(' ');
}

// --- grouping --------------------------------------------------------------

export const namesOf = (rule: Rule): string[] => rule.entries.filter((entry) => entry.kind === 'var').map((entry) => entry.name);

export const overlap = (left: readonly string[], right: readonly string[]): number => {
  const rightSet = new Set(right);
  const shared = left.filter((name) => rightSet.has(name)).length;
  return shared / Math.max(left.length, right.length);
};

// Rules that declare the same names are one thing in several modes — a light
// theme and a dark one, a size scale and its variants. They are shown as
// columns of a single table rather than as three tables nobody can compare.
export const MERGE_THRESHOLD = 0.6;

export function groupRules(rules: readonly Rule[]): Rule[][] {
  const groups: Rule[][] = [];
  const taken = new Set<number>();

  rules.forEach((rule, index) => {
    if (taken.has(index)) {
      return;
    }
    const names = namesOf(rule);
    const members: Rule[] = [rule];
    taken.add(index);

    for (let other = index + 1; other < rules.length; other++) {
      if (taken.has(other)) {
        continue;
      }
      const candidate = rules[other];
      if (!candidate || candidate.context.join('|') !== rule.context.join('|')) {
        continue;
      }
      const otherNames = namesOf(candidate);
      const same = overlap(names, otherNames);
      // One shared name is only a mode when it is the whole of both rules —
      // a page of utilities each setting `--_gap-size` is a scale, not a
      // coincidence.
      const enough = names.length > 1 ? same >= MERGE_THRESHOLD : same === 1 && otherNames.length === names.length;
      if (enough) {
        members.push(candidate);
        taken.add(other);
      }
    }
    groups.push(members);
  });

  return groups;
}

// --- families (the columns inside one rule) --------------------------------

// Every way a name can be cut into a prefix and a suffix at a dash.
export function splits(name: string): { prefix: string; suffix: string }[] {
  const body = name.replace(/^--/, '');
  const parts = body.split('-');
  const out: { prefix: string; suffix: string }[] = [];
  for (let at = 1; at < parts.length; at++) {
    out.push({ prefix: parts.slice(0, at).join('-'), suffix: parts.slice(at).join('-') });
  }
  return out;
}

export interface Family {
  prefixes: string[];
  rows: string[];
  self: boolean;
}

/**
 * The tables hiding in a list of names.
 *
 * A family is a set of prefixes that declare exactly the same variables:
 * {h1, h2, …} each having {line-height, margin-top, …} and nothing else. Exact,
 * not "most": a table is only worth reading when every column fills every row.
 * Prefixes that merely overlap — a few names in common and the rest their own —
 * made tables that were mostly dashes, so they stay lists. A name that is only
 * the prefix (`--h1`) is the family's own value, and is the first row; either
 * every prefix has one or none does.
 */
// Families one stylesheet is read into: a stylesheet, not a database.
export const FAMILIES_MAX = 25;

export function findFamilies(names: readonly string[]): { families: Family[]; used: Set<string> } {
  const bySuffix = new Map<string, Set<string>>(); // suffix -> Set(prefix)
  const byPrefix = new Map<string, string[]>(); // prefix -> suffixes, in source order
  for (const name of names) {
    for (const { prefix, suffix } of splits(name)) {
      const owners = bySuffix.get(suffix);
      if (owners) {
        owners.add(prefix);
      } else {
        bySuffix.set(suffix, new Set([prefix]));
      }
      const suffixes = byPrefix.get(prefix);
      if (suffixes) {
        suffixes.push(suffix);
      } else {
        byPrefix.set(prefix, [suffix]);
      }
    }
  }

  const nameSet = new Set(names);
  const families: Family[] = [];
  const used = new Set<string>();

  while (families.length < FAMILIES_MAX) {
    const best = bestFamilySeed(bySuffix, byPrefix, nameSet, used);
    if (best === undefined) {
      break;
    }
    const family = familyFrom(best, names, nameSet);
    assert(family.prefixes.length >= 2, 'findFamilies: a family has at least two columns');
    const sizeBefore = used.size;
    // `--h1` itself, if it exists: the value the family is named for.
    if (family.self) {
      for (const prefix of family.prefixes) {
        used.add(`--${prefix}`);
      }
    }
    for (const suffix of family.rows) {
      for (const prefix of family.prefixes) {
        used.add(`--${prefix}-${suffix}`);
      }
    }
    // Every family claims names nobody had, so the search ends before the bound in practice.
    assert(used.size > sizeBefore, 'findFamilies: a family claims new names');
    families.push(family);
  }

  return { families, used };
}

export interface FamilySeed {
  readonly score: number;
  readonly prefixes: readonly string[];
  readonly rows: string[];
}

// Every suffix is a candidate seed: the prefixes that share it might be a
// family. Among them, only prefixes with the same signature — the same
// unclaimed suffixes, and the same answer to "is the prefix a variable too" —
// can be columns of one table. Which seed is picked matters — `--h1-margin-top`
// and `--h1-trim-top` both end in `top`, so "top" seeds candidates of
// `*-margin`/`*-trim` prefixes that would eat two rows out of the real table.
// The family that accounts for the most declarations wins, which is the deep
// one: seven headings by thirteen properties.
export function bestFamilySeed(
  bySuffix: ReadonlyMap<string, ReadonlySet<string>>,
  byPrefix: ReadonlyMap<string, readonly string[]>,
  nameSet: ReadonlySet<string>,
  used: ReadonlySet<string>,
): FamilySeed | undefined {
  let best: FamilySeed | undefined = undefined;
  for (const [suffix, prefixes] of bySuffix) {
    const seed = [...prefixes].filter((prefix) => !used.has(`--${prefix}-${suffix}`));
    if (seed.length < 2) {
      continue;
    }
    for (const candidate of signatureGroups(seed, byPrefix, nameSet, used)) {
      if (candidate.prefixes.length < 2) {
        continue;
      }
      // A one-row table is a list turned sideways.
      const height = candidate.rows.length + (candidate.self ? 1 : 0);
      if (height < 2) {
        continue;
      }
      const score = candidate.prefixes.length * height;
      if (!best || score > best.score) {
        best = { score, prefixes: candidate.prefixes, rows: candidate.rows };
      }
    }
  }
  return best;
}

interface SignatureGroup {
  readonly prefixes: string[];
  readonly rows: string[];
  readonly self: boolean;
}

// The seed's prefixes, split by exactly what each declares that is not
// claimed yet. Prefixes in one group have identical rows, so a table of them
// has no empty cells.
function signatureGroups(
  seed: readonly string[],
  byPrefix: ReadonlyMap<string, readonly string[]>,
  nameSet: ReadonlySet<string>,
  used: ReadonlySet<string>,
): SignatureGroup[] {
  assert(seed.length >= 2, 'signatureGroups: a seed has at least two prefixes');
  const groups = new Map<string, SignatureGroup>();
  for (const prefix of seed) {
    const rows = [...new Set(byPrefix.get(prefix) ?? [])].filter((suffix) => !used.has(`--${prefix}-${suffix}`));
    assert(rows.length > 0, 'signatureGroups: a seed prefix declares its seed suffix');
    const self = nameSet.has(`--${prefix}`) && !used.has(`--${prefix}`);
    // Suffixes are names without the prefix, so a newline cannot occur in one.
    const key = `${self ? 'self' : 'none'}\n${[...rows].sort().join('\n')}`;
    const group = groups.get(key);
    if (group) {
      group.prefixes.push(prefix);
    } else {
      groups.set(key, { prefixes: [prefix], rows, self });
    }
  }
  return [...groups.values()];
}

// The family a seed describes, with its rows and columns in source order: the order the author
// chose, rather than anything alphabetical.
export function familyFrom(best: FamilySeed, names: readonly string[], nameSet: ReadonlySet<string>): Family {
  const { prefixes } = best;
  const order = new Map<string, number>();
  names.forEach((name, index) => {
    for (const { prefix, suffix } of splits(name)) {
      if (prefixes.includes(prefix) && !order.has(suffix)) {
        order.set(suffix, index);
      }
    }
  });
  const rows = [...best.rows].sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));

  const columnOrder = new Map<string, number>();
  names.forEach((name, index) => {
    const body = name.replace(/^--/, '');
    for (const prefix of prefixes) {
      if ((body === prefix || body.startsWith(`${prefix}-`)) && !columnOrder.has(prefix)) {
        columnOrder.set(prefix, index);
      }
    }
  });
  const columns = [...prefixes].sort((left, right) => (columnOrder.get(left) ?? 0) - (columnOrder.get(right) ?? 0));
  const self = columns.some((prefix) => nameSet.has(`--${prefix}`));
  return { prefixes: columns, rows, self };
}

// The prefix sections live in shared/ so the variable picker groups names the way the panel does.
export { prefixSections } from '../../shared/properties/variableGroups';
