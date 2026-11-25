// The custom audit matcher: a project's own checks (shared/properties/customAudits.ts) run over one text at a time. Patterns
// arrive compiled and already checked by the regular expression guard there; this file bounds everything that is left, so a
// pattern that passed the guard and is still slow (several overlapping repeats over a long line) cannot hang an audit:
//
// - a text longer than textCharsMax is not read;
// - a declaration value or a line is cut at valueCharsMax / lineCharsMax before a pattern sees it, which bounds the cost of one
//   regular expression call;
// - a scan stops at its match cap, and between calls it asks the clock: past the deadline it stops and says so (`stopped`).
//
// A declaration scan reads declarations only, as the token linter does (shared/page/auditTokens.ts): comments and quoted strings
// are blanked first, so `/* text-align: left */` and `content: "a: b"` are never declarations, and a colon in a selector or an
// at-rule's condition is never one either. Custom properties (`--x: …`) are declarations like any other: the property pattern
// decides whether they count.
import { assert } from '../core/assert';
import { lineOf, lineStarts } from './auditMarkup';
import { blankComments, selectorAt } from './auditTokens';

/** Bounds of one scan, enforced here, at the point where matches accumulate. */
export const CUSTOM_MATCH_LIMITS = {
  /** Characters of one text a scan reads; a longer stylesheet or page is skipped and counted. */
  textCharsMax: 2_000_000,
  /** Characters of one declaration value a pattern sees. */
  valueCharsMax: 1_000,
  /** Characters of one line a text pattern sees. */
  lineCharsMax: 1_000,
  /** Declarations one text may hold before a scan stops reading it. */
  declarationsMax: 20_000,
  /** Lines one text may hold before a scan stops reading it. */
  linesMax: 100_000,
  /** Characters of a match's text kept for the row and the samples. */
  matchCharsMax: 160,
  /** Matches one audit keeps in one file. */
  matchesPerFileMax: 200,
  /** Matches one audit keeps in one run, across every file. */
  matchesPerRunMax: 2_000,
  /** Time one audit may spend across one run, in milliseconds: past it the run stops early and says so. */
  runMsMax: 1_500,
} as const satisfies Record<string, number>;

/** A compiled custom audit's patterns (shared/properties/customAudits.ts CompiledCustomMatch has this shape). */
export type CustomMatcher =
  | {
      readonly scope: 'declaration';
      readonly property: RegExp;
      readonly valueMustMatch: RegExp | undefined;
      readonly valueMustNotMatch: RegExp | undefined;
      readonly exclude: RegExp | undefined;
    }
  | { readonly scope: 'css' | 'markup' | 'rendered'; readonly pattern: RegExp; readonly exclude: RegExp | undefined };

/** One place a custom audit matched, by its offset in the text that was scanned. */
export interface CustomMatch {
  readonly offset: number;
  /** 1-based, in the text that was scanned. */
  readonly line: number;
  /** What matched, bounded: the declaration (`text-align: left`) or the pattern's match. */
  readonly text: string;
  /** For a declaration: its property, its value as written and its rule's selector. */
  readonly declaration: { readonly property: string; readonly value: string; readonly selector: string } | undefined;
}

/** Why a scan ended: it read everything, it reached its match cap, it ran out of time, or the text was too long to read. */
export type CustomScanStop = 'complete' | 'match-limit' | 'time-limit' | 'too-large';

export interface CustomScan {
  readonly matches: readonly CustomMatch[];
  readonly stopped: CustomScanStop;
}

/** How much a scan may do: its match cap and its deadline on the clock it is given. */
export interface CustomScanBudget {
  readonly matchesMax: number;
  readonly deadlineMs: number;
}

/** Every match of `matcher` in `text`. `now` is the clock the deadline is read on (performance.now in the app, a fake in tests). */
export function scanCustom(text: string, matcher: CustomMatcher, budget: CustomScanBudget, now: () => number): CustomScan {
  assert(Number.isSafeInteger(budget.matchesMax), 'scanCustom: the match cap is an integer');
  assert(budget.matchesMax >= 0, 'scanCustom: the match cap is not negative');
  if (text.length > CUSTOM_MATCH_LIMITS.textCharsMax) {
    return { matches: [], stopped: 'too-large' };
  }
  const scan = matcher.scope === 'declaration' ? scanDeclarations(text, matcher, budget, now) : scanLines(text, matcher, budget, now);
  assert(scan.matches.length <= budget.matchesMax, 'scanCustom: the matches are inside the cap');
  return scan;
}

type DeclarationMatcher = Extract<CustomMatcher, { readonly scope: 'declaration' }>;
type TextMatcher = Exclude<CustomMatcher, DeclarationMatcher>;

// Declarations, found on the text with comments and strings blanked (offsets kept), judged on the value as written.
function scanDeclarations(text: string, matcher: DeclarationMatcher, budget: CustomScanBudget, now: () => number): CustomScan {
  const clean = blankComments(text);
  const discovery = blankStrings(clean);
  const lines = lineStarts(text);
  const matches: CustomMatch[] = [];
  const declaration = /(-{0,2}[A-Za-z_][\w-]*)\s*:\s*([^;{}]+?)\s*(?=;|}|$)/g;
  let count = 0;
  for (const found of discovery.matchAll(declaration)) {
    count += 1;
    if (count > CUSTOM_MATCH_LIMITS.declarationsMax) {
      return { matches, stopped: 'match-limit' };
    }
    if (now() > budget.deadlineMs) {
      return { matches, stopped: 'time-limit' };
    }
    const at = found.index;
    const property = found[1] ?? '';
    if (!startsStatement(discovery, at)) {
      continue; // A selector's or a condition's colon, not a declaration.
    }
    const valueFound = found[2] ?? '';
    const valueStart = at + found[0].indexOf(valueFound, property.length);
    const value = clean.slice(valueStart, valueStart + valueFound.length).trim();
    if (!declarationMatches(matcher, property, value)) {
      continue;
    }
    if (matches.length >= budget.matchesMax) {
      return { matches, stopped: 'match-limit' };
    }
    matches.push({
      offset: valueStart,
      line: lineOf(lines, valueStart),
      text: bounded(`${property}: ${value}`),
      declaration: { property, value, selector: selectorAt(clean, at) },
    });
  }
  return { matches, stopped: 'complete' };
}

/** Whether one declaration is what the matcher looks for: the property, then the value rules, then the exclusion. */
export function declarationMatches(matcher: DeclarationMatcher, property: string, value: string): boolean {
  assert(property.length > 0, 'declarationMatches: a declaration has a property');
  const seen = value.slice(0, CUSTOM_MATCH_LIMITS.valueCharsMax);
  if (!matcher.property.test(property)) {
    return false;
  }
  if (matcher.valueMustMatch !== undefined && !matcher.valueMustMatch.test(seen)) {
    return false;
  }
  if (matcher.valueMustNotMatch !== undefined && matcher.valueMustNotMatch.test(seen)) {
    return false;
  }
  return matcher.exclude === undefined || !matcher.exclude.test(`${property}: ${seen}`);
}

// A text pattern, line by line: each line is cut at lineCharsMax, so one call's cost is bounded by the line, not the file.
function scanLines(text: string, matcher: TextMatcher, budget: CustomScanBudget, now: () => number): CustomScan {
  const matches: CustomMatch[] = [];
  const global = new RegExp(matcher.pattern.source, matcher.pattern.flags.includes('g') ? matcher.pattern.flags : `${matcher.pattern.flags}g`);
  let start = 0;
  for (let line = 1; start <= text.length; line++) {
    if (line > CUSTOM_MATCH_LIMITS.linesMax) {
      return { matches, stopped: 'match-limit' };
    }
    if (now() > budget.deadlineMs) {
      return { matches, stopped: 'time-limit' };
    }
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    const seen = text.slice(start, Math.min(end, start + CUSTOM_MATCH_LIMITS.lineCharsMax));
    if (seen.trim().length > 0) {
      for (const found of seen.matchAll(global)) {
        if (found[0].length === 0) {
          continue; // The guard refuses a pattern that matches empty text; a zero-width match inside a line is not a place.
        }
        if (matcher.exclude !== undefined && matcher.exclude.test(seen)) {
          continue; // A text audit's exclusion names lines to leave alone: `TODO(ok)` skips the line that says so.
        }
        if (matches.length >= budget.matchesMax) {
          return { matches, stopped: 'match-limit' };
        }
        matches.push({ offset: start + found.index, line, text: bounded(found[0].trim()), declaration: undefined });
      }
    }
    if (newline === -1) {
      break;
    }
    start = newline + 1;
  }
  return { matches, stopped: 'complete' };
}

// A declaration starts a statement: after `{`, `;` or `}` (nested rules), or at the start of the text, never after `(` or a selector's word.
function startsStatement(text: string, at: number): boolean {
  for (let index = at - 1; index >= 0 && at - index <= 400; index--) {
    const char = text[index] ?? '';
    if (/\s/.test(char)) {
      continue;
    }
    return char === '{' || char === ';' || char === '}';
  }
  return at <= 400;
}

/** `text` with the inside of every quoted string blanked, quotes and offsets kept, so a string's `;` or `:` is never CSS. */
export function blankStrings(text: string): string {
  const out = text.replace(/(["'])(?:\\.|(?!\1)[^\\\n])*\1/g, (quoted) => `${quoted[0] ?? ''}${' '.repeat(Math.max(0, quoted.length - 2))}${quoted[0] ?? ''}`);
  assert(out.length === text.length, 'blankStrings: offsets are kept');
  return out;
}

function bounded(text: string): string {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > CUSTOM_MATCH_LIMITS.matchCharsMax ? `${flat.slice(0, CUSTOM_MATCH_LIMITS.matchCharsMax - 1)}…` : flat;
}

// The rest of a `<style>` or `<script>` opening tag that has content. A self-closing one (`<script set:html={data} />`) has none,
// and must not open a block that runs on to a later closing tag over the template between. An arrow's `>` does not end the tag.
const BLOCK_ATTRIBUTES = '(?:[^>=]|=>|=(?!>))*(?<!/)>';

/**
 * An .astro file's template as markup patterns read it: the frontmatter and the inside of every `<style>` and `<script>` blanked,
 * offsets and line breaks kept, so a match's line is the file's own and a stylesheet's text is never "markup".
 */
export function markupText(source: string): string {
  assert(source.length <= CUSTOM_MATCH_LIMITS.textCharsMax, 'markupText: the source is inside the text bound');
  const blank = (part: string): string => part.replace(/[^\n]/g, ' ');
  const fence = /^(\s*---\r?\n[\s\S]*?\r?\n---)/.exec(source);
  const withoutFrontmatter = fence === null ? source : `${blank(fence[1] ?? '')}${source.slice((fence[1] ?? '').length)}`;
  const out = withoutFrontmatter.replace(
    new RegExp(`(<(style|script)\\b${BLOCK_ATTRIBUTES})([\\s\\S]*?)(<\\/\\2\\s*>)`, 'gi'),
    (_whole, open: string, _name: string, inner: string, close: string) => `${open}${blank(inner)}${close}`,
  );
  assert(out.length === source.length, 'markupText: offsets are kept');
  return out;
}

/** One stretch of a file a scope reads: its text and where it starts in the file. */
export interface CustomSegment {
  readonly text: string;
  readonly offset: number;
}

/**
 * The parts of a project file a scope reads, found in its source text: a stylesheet whole, an .astro file's `<style>` blocks
 * (declaration and css) or its template (markup). Rendered HTML is not a project file, so it has none. The Audits panel walks the
 * parsed tree instead (it needs each block's element path); the CLI and the editor's live count read these, and both scan the
 * same text, so their counts agree.
 */
export function customSegments(file: string, source: string, scope: CustomMatcher['scope']): readonly CustomSegment[] {
  assert(file.length > 0, 'customSegments: a file has a path');
  if (source.length > CUSTOM_MATCH_LIMITS.textCharsMax || scope === 'rendered') {
    return [];
  }
  const stylesheet = /\.(css|scss|sass|less|pcss)$/i.test(file);
  const astro = /\.astro$/i.test(file);
  if (scope === 'markup') {
    return astro ? [{ text: markupText(source), offset: 0 }] : [];
  }
  if (stylesheet) {
    return [{ text: source, offset: 0 }];
  }
  if (!astro) {
    return [];
  }
  const segments: CustomSegment[] = [];
  for (const block of source.matchAll(new RegExp(`(<style\\b${BLOCK_ATTRIBUTES})([\\s\\S]*?)<\\/style\\s*>`, 'gi'))) {
    segments.push({ text: block[2] ?? '', offset: block.index + (block[1] ?? '').length });
  }
  return segments;
}

/** A place a scan over files found, for a sample or a CLI answer. */
export interface CustomFileMatch {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

export interface CustomFilesScan {
  /** Matches found, up to the run cap. */
  readonly count: number;
  /** The first matches, in file order, at most `samplesMax`. */
  readonly samples: readonly CustomFileMatch[];
  readonly files: number;
  readonly stopped: CustomScanStop;
}

/** One matcher over many files, with the run's caps and time budget: what `stacki audits test` and the editor's live count report. */
export function scanCustomFiles(
  files: readonly { readonly file: string; readonly source: string }[],
  matcher: CustomMatcher,
  options: { readonly samplesMax: number; readonly startedMs: number },
  now: () => number,
): CustomFilesScan {
  assert(options.samplesMax >= 0, 'scanCustomFiles: a sample count');
  const deadlineMs = options.startedMs + CUSTOM_MATCH_LIMITS.runMsMax;
  const samples: CustomFileMatch[] = [];
  let count = 0;
  let stopped: CustomScanStop = 'complete';
  let read = 0;
  for (const entry of files) {
    if (count >= CUSTOM_MATCH_LIMITS.matchesPerRunMax) {
      stopped = 'match-limit';
      break;
    }
    if (now() > deadlineMs) {
      stopped = 'time-limit';
      break;
    }
    read += 1;
    const lines = lineStarts(entry.source);
    for (const segment of customSegments(entry.file, entry.source, matcher.scope)) {
      const matchesMax = Math.min(CUSTOM_MATCH_LIMITS.matchesPerFileMax, CUSTOM_MATCH_LIMITS.matchesPerRunMax - count);
      const scan = scanCustom(segment.text, matcher, { matchesMax, deadlineMs }, now);
      count += scan.matches.length;
      for (const match of scan.matches.slice(0, Math.max(0, options.samplesMax - samples.length))) {
        samples.push({ file: entry.file, line: lineOf(lines, segment.offset + match.offset), text: match.text });
      }
      if (scan.stopped === 'time-limit') {
        stopped = 'time-limit';
      }
    }
  }
  assert(count <= CUSTOM_MATCH_LIMITS.matchesPerRunMax, 'scanCustomFiles: the run is capped');
  return { count, samples, files: read, stopped };
}
