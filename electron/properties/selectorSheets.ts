// Where a project's selectors are written, and what each one requires. A
// stylesheet region is a whole `.css` file or one `<style>` block of an
// `.astro` file; every rule in it becomes one entry per selector in its list,
// with the class and id names it cannot match without.
//
// Two independent readers must agree before a `<style>` block is trusted: the
// page parser that located it, and the bytes at the offsets it reported. A
// block the two disagree on is never edited (see locateStyleBlock).
import postcss from 'postcss';
import type { Container, Document, Rule } from 'postcss';
import selectorParser from 'postcss-selector-parser';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { parsePage } from '../parse/astroParser';
import type { ParserNode } from '../parse/astroParserTypes';
import { SELECTOR_USAGE_LIMITS, type SelectorScope } from '../../shared/properties/selectorUsage';

export interface StyleRegion {
  readonly rel: string;
  /** 0 for a stylesheet file; the block's position among the file's `<style>` blocks otherwise. */
  readonly block: number;
  /** UTF-16 offset of the region's first character in its file. */
  readonly start: number;
  readonly text: string;
  readonly scope: SelectorScope;
  /** 1-based line of the region's first character in its file. */
  readonly line: number;
}

/** What an `.astro` file contributes: its style regions and the text that can mention names. */
export interface AstroSheet {
  readonly rel: string;
  /** The file as read; the regions' offsets index it. */
  readonly source: string;
  readonly regions: readonly StyleRegion[];
  /** The file with its readable style blocks blanked: everything that can name a class. */
  readonly ownText: string;
  /** `ownText` with static `class="…"` values blanked as well: what can reach another file's elements. */
  readonly foreignText: string;
  /** The template computes a class or spreads attributes, so its classes are not all written down. */
  readonly dynamicClass: boolean;
  /** Why the file's own style blocks could not be read, when they could not. */
  readonly unreadable: string | undefined;
}

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
  readonly fixed: string | undefined;
  /** The at-rules and rules around this one, outermost first, for postconditions. */
  readonly context: string;
}

export type RegionRules = { readonly kind: 'rules'; readonly selectors: readonly RuleSelector[] } | { readonly kind: 'unreadable'; readonly reason: string };

export function cssFileRegion(rel: string, text: string): StyleRegion {
  return { rel, block: 0, start: 0, text, scope: 'global', line: 1 };
}

const DYNAMIC_CLASS = /\bclass(?:Name)?\s*=\s*\{|\bclass:list\b|\{\s*\.\.\./;

export function readAstroSheet(rel: string, source: string): AstroSheet {
  const parsed = parsePage(source, { locs: true });
  const bodyStart = templateStart(source);
  const dynamicClass = DYNAMIC_CLASS.test(source.slice(bodyStart));
  if (!parsed.editable) {
    // Nothing is blanked: every style block stays in the mention text, which can
    // only protect more names, never fewer.
    return { rel, source, regions: [], ownText: source, foreignText: source, dynamicClass: true, unreadable: parsed.reason };
  }
  const regions: StyleRegion[] = [];
  const blanks: Array<readonly [number, number]> = [];
  const classValues: Array<readonly [number, number]> = [];
  let unreadable: string | undefined;
  const stack: ParserNode[] = [...parsed.model.nodes];
  let visited = 0;
  while (stack.length > 0) {
    visited += 1;
    assert(visited <= LIMITS.treeNodesMax, 'readAstroSheet: the parser bounds the tree');
    const node = stack.pop();
    assert(node !== undefined, 'readAstroSheet: the stack was not empty');
    for (const span of node.attrSpans ?? []) {
      if (span.type === 'string') {
        if (span.name === 'class' || span.name === 'className') {
          classValues.push([span.valueSpan.start, span.valueSpan.end]);
        }
      }
    }
    if (node.kind === 'raw') {
      if (node.name.toLowerCase() === 'style') {
        // Blocks are numbered by position once all are found (below).
        const located = locateStyleBlock(rel, source, node, 0);
        if (typeof located === 'string') {
          unreadable = located;
        } else {
          regions.push(located);
          blanks.push([located.start, located.start + located.text.length]);
        }
      }
    } else if (node.children !== undefined) {
      stack.push(...node.children);
    }
  }
  regions.sort((left, right) => left.start - right.start);
  const ownText = blankRanges(source, blanks);
  return {
    rel,
    source,
    regions: regions.map((region, block) => ({ ...region, block })),
    ownText,
    foreignText: blankRanges(ownText, classValues),
    dynamicClass,
    unreadable,
  };
}

/** Every selector of every rule in a region, or why the region cannot be read. */
export function readRegionRules(region: StyleRegion): RegionRules {
  let parsed: ParsedCss;
  try {
    parsed = parseCss(region.text);
  } catch (error: unknown) {
    return { kind: 'unreadable', reason: `CSS could not be read: ${error instanceof Error ? error.message : String(error)}` };
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

// Browsers read past a declaration with a missing semicolon (`opacity: 1` on
// one line, `transform: …` on the next); postcss refuses the whole sheet. The
// parse is retried on a copy with the semicolon inserted where postcss says it
// is missing. That repair stays inside one declaration's value, so it cannot
// move a rule boundary; every other syntax error still makes the region
// unreadable. Offsets are mapped back so edits land in the original bytes.
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
      assert(repaired.length === text.length + inserted.length, 'parseCss: each repair inserts one character');
      return { root, original };
    } catch (error: unknown) {
      const offset = missedSemicolonAt(repaired, error);
      if (offset === undefined || attempt === CSS_REPAIR_LIMITS.repairsMax) {
        throw error;
      }
      const at = original(offset);
      inserted.push(at);
      inserted.sort((left, right) => left - right);
      repaired = repaired.slice(0, offset) + ';' + repaired.slice(offset);
    }
  }
  assert(false, 'parseCss: the loop returns or throws');
}

function missedSemicolonAt(text: string, error: unknown): number | undefined {
  if (!(error instanceof postcss.CssSyntaxError)) {
    return undefined;
  }
  if (error.reason !== 'Missed semicolon' || error.line === undefined || error.column === undefined) {
    return undefined;
  }
  let offset = 0;
  for (let line = 1; line < error.line; line += 1) {
    const next = text.indexOf('\n', offset);
    if (next === -1) {
      return undefined;
    }
    offset = next + 1;
  }
  const at = offset + error.column - 1;
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

function collectRules(region: StyleRegion, parsed: ParsedCss, out: RuleSelector[]): string | undefined {
  const { root, original } = parsed;
  const lineBase = region.line - 1;
  let failure: string | undefined;
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
      failure = 'CSS rule has no source position';
      return false;
    }
    const parsed = parseSelectorList(rule.selector);
    if (parsed === undefined) {
      failure = `Selector "${rule.selector.slice(0, 80)}" could not be read`;
      return false;
    }
    if (out.length + parsed.length > SELECTOR_USAGE_LIMITS.entriesMax) {
      failure = 'Too many selectors to check';
      return false;
    }
    const context = contextOf(rule);
    // A selector written with comments in it keeps them in raws; rewriting its
    // list could drop them, so such a rule is reported and never edited.
    const fixed = rule.raws.selector === undefined ? undefined : 'Its selector contains a comment';
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

// The `<style>` block's inner text is located twice: from the parser's node
// offsets, and by checking that the bytes there are exactly the inner text the
// parser captured followed by the closing tag. Disagreement means the offsets
// cannot be trusted for an edit.
function locateStyleBlock(rel: string, source: string, node: Extract<ParserNode, { kind: 'raw' }>, block: number): StyleRegion | string {
  const lang = attrText(node, 'lang');
  if (lang !== undefined && lang.toLowerCase() !== 'css') {
    return `A <style lang="${lang}"> block is not plain CSS`;
  }
  if (node.start === undefined || node.end === undefined) {
    return 'A <style> block has no source position';
  }
  const tag = source.slice(node.start, node.end);
  const close = /<\/style\s*>$/i.exec(tag);
  if (close === null) {
    return 'A <style> block has no closing tag where the parser placed it';
  }
  const closeStart = node.start + close.index;
  const start = closeStart - node.inner.length;
  if (start <= node.start || source.slice(start, closeStart) !== node.inner) {
    return 'A <style> block was not where the parser placed it';
  }
  const global = node.props?.['is:global'] !== undefined || node.props?.['is:inline'] !== undefined;
  return { rel, block, start, text: node.inner, scope: global ? 'global' : 'scoped', line: lineAt(source, start) };
}

function attrText(node: Extract<ParserNode, { kind: 'raw' }>, name: string): string | undefined {
  const attr = node.props?.[name];
  if (attr === undefined) {
    return undefined;
  }
  return attr.type === 'string' ? attr.value : '(expression)';
}

function templateStart(source: string): number {
  const bom = source.startsWith('﻿') ? 1 : 0;
  const fence = /^---\r?\n(?:---|[\s\S]*?\r?\n---)\r?\n?/.exec(source.slice(bom));
  return bom + (fence === null ? 0 : fence[0].length);
}

function lineAt(source: string, offset: number): number {
  assert(offset >= 0, 'lineAt: offset is nonnegative');
  assert(offset <= source.length, 'lineAt: offset is inside the source');
  let line = 1;
  for (let index = source.indexOf('\n'); index !== -1 && index < offset; index = source.indexOf('\n', index + 1)) {
    line += 1;
  }
  return line;
}

/** Replace ranges with spaces, keeping newlines so offsets and lines still agree. */
function blankRanges(source: string, ranges: ReadonlyArray<readonly [number, number]>): string {
  if (ranges.length === 0) {
    return source;
  }
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    assert(start >= cursor, 'blankRanges: ranges do not overlap');
    assert(end <= source.length, 'blankRanges: ranges are inside the source');
    out += source.slice(cursor, start) + source.slice(start, end).replace(/[^\n]/g, ' ');
    cursor = end;
  }
  out += source.slice(cursor);
  assert(out.length === source.length, 'blankRanges: blanking keeps the length');
  return out;
}
