// Where a project's selectors are written, and what each one requires. A
// stylesheet region is a whole `.css` file or one `<style>` block of an
// `.astro` file; every rule in it becomes one entry per selector in its list,
// with the class and id names it cannot match without.
//
// `<style>` blocks are located in documents/astroStyleBlocks.ts.
import postcss from 'postcss';
import type { Container, Document, Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { SELECTOR_USAGE_LIMITS } from '../../shared/properties/selectorUsage';
import type { StyleRegion } from '../documents/astroStyleBlocks';

export { TEMPLATE_SCAN_LIMITS, cssFileRegion, readAstroSheet, type AstroSheet, type StyleRegion } from '../documents/astroStyleBlocks';

export interface RuleSelector {
  readonly region: StyleRegion;
  /** The rule's offsets in the region text: [ruleStart, ruleEnd). */
  readonly ruleStart: number;
  readonly ruleEnd: number;
  /** Position in the rule's selector list. */
  readonly index: number;
  /** Selectors in the rule's list. */
  readonly listCount: number;
  readonly text: string;
  /** Class and id names the selector requires at its top level. */
  readonly names: readonly string[];
  /** 1-based line in the file. */
  readonly line: number;
  /** Why this selector can never be removed, when it cannot. */
  readonly fixed: Described | undefined;
  /** The at-rules and rules around this one, outermost first, for postconditions. */
  readonly context: string;
}

export type RegionRules = { readonly kind: 'rules'; readonly selectors: readonly RuleSelector[] } | { readonly kind: 'unreadable'; readonly reason: Described };

/** Every selector of every rule in a region, or why the region cannot be read. */
export function readRegionRules(region: StyleRegion): RegionRules {
  let parsed: ParsedCss;
  try {
    parsed = parseCss(region.text);
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: described('selectors.problem.cssUnreadable', { detail: error instanceof Error ? error.message : String(error) }) };
  }
  const selectors: RuleSelector[] = [];
  const failure = collectRules(region, parsed, selectors);
  if (failure !== undefined) {
    return { kind: 'unreadable', reason: failure };
  }
  assert(selectors.length <= SELECTOR_USAGE_LIMITS.entriesMax, 'readRegionRules: collectRules bounds entries');
  return { kind: 'rules', selectors };
}

export const CSS_REPAIR_LIMITS = {
  /** Missing semicolons one stylesheet region may be read past. */
  repairsMax: 256,
} as const satisfies Record<string, number>;

/** A parsed region, and the map from the parse's offsets back to the region's own. */
export interface ParsedCss {
  readonly root: postcss.Root;
  readonly original: (offset: number) => number;
}

// Browsers recover from two mistakes postcss refuses a whole sheet for, and the
// parse is retried on a repaired copy the way a browser would read it:
// - A missing semicolon (`opacity: 1` on one line, `transform: …` on the
//   next): one is inserted where postcss says it is missing.
// - A declaration that is not one (`// pointer-events: none;` — `//` is not a
//   CSS comment): the browser drops it up to its `;`, so the copy has it
//   replaced with spaces. Only inside a block, and only when the dropped
//   text holds no brace.
// - A block never closed: the browser closes it at the end of the sheet, so
//   the copy gets its `}` there.
// Each repair reads the sheet the way a browser does, so rule boundaries are
// where the browser puts them; every other syntax error still makes the region
// unreadable.
// Offsets are mapped back so edits land in the original bytes.
export function parseCss(text: string): ParsedCss {
  const inserted: number[] = []; // Original offsets, ascending.
  const original = (offset: number): number => {
    let shift = 0;
    for (const [index, position] of inserted.entries()) {
      if (position + index < offset) {
        shift += 1;
      }
    }
    return offset - shift;
  };
  let repaired = text;
  for (let attempt = 0; attempt <= CSS_REPAIR_LIMITS.repairsMax; attempt += 1) {
    try {
      const root = postcss.parse(repaired);
      assert(repaired.length === text.length + inserted.length, 'parseCss: insertions add one character, blanks none');
      return { root, original };
    } catch (error: unknown) {
      const repair = repairFor(repaired, error);
      if (repair === undefined || attempt === CSS_REPAIR_LIMITS.repairsMax) {
        throw error;
      }
      if (repair.kind === 'insert') {
        inserted.push(original(repair.offset));
        inserted.sort((left, right) => left - right);
        repaired = repaired.slice(0, repair.offset) + repair.text + repaired.slice(repair.offset);
      } else {
        const dropped = repaired.slice(repair.start, repair.end);
        assert(!/[{}]/.test(dropped), 'parseCss: a dropped declaration holds no brace');
        repaired = repaired.slice(0, repair.start) + dropped.replace(/[^\n]/g, ' ') + repaired.slice(repair.end);
      }
    }
  }
  assert(false, 'parseCss: the loop returns or throws');
}

type CssRepair =
  { readonly kind: 'insert'; readonly offset: number; readonly text: ';' | '}' } | { readonly kind: 'drop'; readonly start: number; readonly end: number };

function repairFor(text: string, error: unknown): CssRepair | undefined {
  if (!(error instanceof postcss.CssSyntaxError)) {
    return undefined;
  }
  if (error.line === undefined || error.column === undefined) {
    return undefined;
  }
  const at = offsetOf(text, error.line, error.column);
  if (at === undefined) {
    return undefined;
  }
  if (error.reason === 'Missed semicolon') {
    return { kind: 'insert', offset: at, text: ';' };
  }
  if (error.reason.startsWith('Unknown word')) {
    return droppedDeclaration(text, at);
  }
  if (error.reason === 'Unclosed block') {
    // The browser closes every open block at the end of the sheet.
    return { kind: 'insert', offset: text.length, text: '}' };
  }
  return undefined;
}

// The statement around `at`: from just after the `{`, `;` or `}` before it to
// the `;` that ends it (or the `}` that closes its block, or the sheet's end).
// Undefined when that is not plainly one statement inside a block.
function droppedDeclaration(text: string, at: number): CssRepair | undefined {
  let start = at;
  while (start > 0 && !/[{};]/.test(text.charAt(start - 1))) {
    start -= 1;
  }
  // Inside a block, after a declaration or a nested rule; never at the top level.
  if (start === 0 || braceDepth(text, start) < 1) {
    return undefined;
  }
  let end = at;
  while (end < text.length && !/[{};]/.test(text.charAt(end))) {
    end += 1;
  }
  if (text.charAt(end) === '{') {
    return undefined;
  }
  return { kind: 'drop', start, end: text.charAt(end) === ';' ? end + 1 : end };
}

// Open braces before `at`, skipping comments and quoted strings.
function braceDepth(text: string, at: number): number {
  let depth = 0;
  let index = 0;
  while (index < at) {
    const char = text.charAt(index);
    if (text.startsWith('/*', index)) {
      const close = text.indexOf('*/', index + 2);
      index = close === -1 ? at : close + 2;
    } else if (char === '"' || char === "'") {
      const close = text.indexOf(char, index + 1);
      index = close === -1 ? at : close + 1;
    } else {
      depth += char === '{' ? 1 : char === '}' ? -1 : 0;
      index += 1;
    }
  }
  return depth;
}

function offsetOf(text: string, line: number, column: number): number | undefined {
  let offset = 0;
  for (let current = 1; current < line; current += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) {
      return undefined;
    }
    offset = next + 1;
  }
  const at = offset + column - 1;
  return at <= text.length ? at : undefined;
}

/** Context strings of every selector in a region, the shape a cleanup must preserve. */
export function selectorShapes(region: StyleRegion): readonly string[] | undefined {
  const rules = readRegionRules(region);
  if (rules.kind === 'unreadable') {
    return undefined;
  }
  return rules.selectors.map(shapeOf);
}

export function shapeOf(selector: RuleSelector): string {
  return `${selector.context}\u0000${selector.text}`;
}

function collectRules(region: StyleRegion, parsed: ParsedCss, out: RuleSelector[]): Described | undefined {
  const { root, original } = parsed;
  const lineBase = region.line - 1;
  let failure: Described | undefined;
  root.walkRules((rule: Rule) => {
    if (failure !== undefined) {
      return false;
    }
    if (insideKeyframes(rule)) {
      return undefined;
    }
    const startOffset = rule.source?.start?.offset;
    const endOffset = rule.source?.end?.offset;
    const ruleStart = startOffset === undefined ? undefined : original(startOffset);
    const ruleEnd = endOffset === undefined ? undefined : original(endOffset);
    const line = rule.source?.start?.line;
    if (ruleStart === undefined || ruleEnd === undefined || line === undefined) {
      failure = described('selectors.problem.ruleNoPosition');
      return false;
    }
    const parsed = parseSelectorList(rule.selector);
    if (parsed === undefined) {
      failure = described('selectors.problem.selectorUnreadable', { selector: rule.selector.slice(0, 80) });
      return false;
    }
    if (out.length + parsed.length > SELECTOR_USAGE_LIMITS.entriesMax) {
      failure = described('selectors.problem.tooManyToCheck');
      return false;
    }
    const context = contextOf(rule);
    // A selector written with comments in it keeps them in raws; rewriting its
    // list could drop them, so such a rule is reported and never edited.
    const fixed = rule.raws.selector === undefined ? undefined : described('selectors.reason.selectorComment');
    for (const [index, item] of parsed.entries()) {
      out.push({ region, ruleStart, ruleEnd, index, listCount: parsed.length, text: item.text, names: item.names, line: lineBase + line, fixed, context });
    }
    return undefined;
  });
  return failure;
}

interface ParsedSelector {
  readonly text: string;
  readonly names: readonly string[];
}

function parseSelectorList(selector: string): readonly ParsedSelector[] | undefined {
  const out: ParsedSelector[] = [];
  try {
    selectorParser((root) => {
      root.each((item) => {
        const names: string[] = [];
        // Only top-level compounds are requirements. A name inside a pseudo
        // function is not: `:not(.x)` matches more when .x is absent, and
        // `:is(.a, .b)` needs just one alternative.
        for (const node of item.nodes) {
          if (node.type === 'class' || node.type === 'id') {
            names.push(node.value);
          }
        }
        out.push({ text: item.toString().trim(), names: [...new Set(names)].slice(0, SELECTOR_USAGE_LIMITS.namesPerEntryMax) });
      });
    }).processSync(selector);
  } catch {
    return undefined;
  }
  return out;
}

function insideKeyframes(rule: Rule): boolean {
  let parent: Container | Document | undefined = rule.parent;
  let depth = 0;
  while (parent !== undefined) {
    depth += 1;
    assert(depth <= LIMITS.treeDepthMax * 4, 'insideKeyframes: CSS nesting is bounded by the parse');
    if (parent instanceof postcss.AtRule) {
      if (/keyframes$/i.test(parent.name)) {
        return true;
      }
    }
    parent = parent.parent;
  }
  return false;
}

function contextOf(rule: Rule): string {
  const parts: string[] = [];
  let parent: Container | Document | undefined = rule.parent;
  let depth = 0;
  while (parent !== undefined) {
    depth += 1;
    assert(depth <= LIMITS.treeDepthMax * 4, 'contextOf: CSS nesting is bounded by the parse');
    if (parent instanceof postcss.AtRule) {
      parts.push(`@${parent.name} ${parent.params}`);
    } else if (parent instanceof postcss.Rule) {
      // The depth, not the selector: a cleanup may shorten an outer rule's
      // list, and its nested rules are still the same rules.
      parts.push('&');
    }
    parent = parent.parent;
  }
  return parts.reverse().join('\u0001');
}
