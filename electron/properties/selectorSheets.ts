// Where a project's selectors are written, and what each one requires. A
// stylesheet region is a whole `.css` file or one `<style>` block of an
// `.astro` file; every rule in it becomes one entry per selector in its list,
// with the class and id names it cannot match without.
//
// `<style>` blocks are located by the editor's own parser, whose offsets are
// checked against the file's bytes before a block is trusted (locateStyleBlock).
// A file the visual editor cannot represent is read by a small scanner of the
// template instead (scanTemplate). Astro's compiler is not used: on a 2 MB icon
// component it exhausts its memory and aborts the whole process, which no
// try/catch can stop.
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
  const bodyStart = templateStart(source);
  const dynamicClass = DYNAMIC_CLASS.test(source.slice(bodyStart));
  const parsed = parsePage(source, { locs: true });
  const found = parsed.editable ? fromParser(rel, source, parsed.model.nodes) : fromScanner(rel, source, bodyStart);
  if (typeof found === 'string') {
    // Nothing is blanked: every style block stays in the mention text, which can
    // only protect more names, never fewer.
    return { rel, source, regions: [], ownText: source, foreignText: source, dynamicClass: true, unreadable: found };
  }
  const regions = [...found.regions].sort((left, right) => left.start - right.start).map((region, block) => ({ ...region, block }));
  const ownText = blankRanges(
    source,
    regions.map((region) => [region.start, region.start + region.text.length] as const),
  );
  return { rel, source, regions, ownText, foreignText: blankRanges(ownText, found.classValues), dynamicClass, unreadable: found.unreadable };
}

interface FoundSheet {
  readonly regions: readonly StyleRegion[];
  readonly classValues: ReadonlyArray<readonly [number, number]>;
  readonly unreadable: string | undefined;
}

function fromParser(rel: string, source: string, nodes: readonly ParserNode[]): FoundSheet {
  const regions: StyleRegion[] = [];
  const classValues: Array<readonly [number, number]> = [];
  let unreadable: string | undefined;
  const stack: ParserNode[] = [...nodes];
  for (let visited = 0; stack.length > 0; visited += 1) {
    assert(visited <= LIMITS.treeNodesMax, 'fromParser: the parser bounds the tree');
    const node = stack.pop();
    assert(node !== undefined, 'fromParser: the stack was not empty');
    for (const span of node.attrSpans ?? []) {
      if (span.type === 'string') {
        if (span.name === 'class' || span.name === 'className') {
          classValues.push([span.valueSpan.start, span.valueSpan.end]);
        }
      }
    }
    if (node.kind === 'raw') {
      if (node.name.toLowerCase() === 'style') {
        const located = locateStyleBlock(rel, source, node, 0);
        if (typeof located === 'string') {
          unreadable = located;
        } else if (located.text !== '') {
          regions.push(located);
        }
      }
    } else if (node.children !== undefined) {
      stack.push(...node.children);
    }
  }
  return { regions, classValues, unreadable };
}

function fromScanner(rel: string, source: string, bodyStart: number): FoundSheet | string {
  const scanned = scanTemplate(source, bodyStart);
  if (typeof scanned === 'string') {
    return scanned;
  }
  const regions: StyleRegion[] = [];
  let unreadable: string | undefined;
  for (const style of scanned.styles) {
    const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(style.attributes)?.[1];
    if (lang !== undefined && lang.toLowerCase() !== 'css') {
      unreadable = `A <style lang="${lang}"> block is not plain CSS`;
      continue;
    }
    if (style.end > style.start) {
      const global = /(?:^|\s)is:(?:global|inline)\b/.test(style.attributes);
      regions.push({
        rel,
        block: 0,
        start: style.start,
        text: source.slice(style.start, style.end),
        scope: global ? 'global' : 'scoped',
        line: lineAt(source, style.start),
      });
    }
  }
  return { regions, classValues: scanned.classValues, unreadable };
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

export const TEMPLATE_SCAN_LIMITS = {
  /** Characters scanned past one tag's `<` looking for its `>`. */
  tagCharsMax: 64 * 1024,
} as const satisfies Record<string, number>;

interface FoundStyle {
  /** The inner CSS text: [start, end) in the file. */
  readonly start: number;
  readonly end: number;
  /** The opening tag's attribute text. */
  readonly attributes: string;
}

interface TemplateScan {
  readonly styles: readonly FoundStyle[];
  /** Written class="…" values: [start, end) of the value. */
  readonly classValues: ReadonlyArray<readonly [number, number]>;
}

// One pass over the template. Comments, `<script>` and `<style>` bodies are
// skipped whole; `{…}` expressions are tracked by depth. Inside an expression a
// `<` starts markup only where markup can start — after `(`, `>`, `&&`, `?` or
// `:` — never after a name, so `i<n` stays code. Any imbalance makes the whole
// file unreadable rather than guessed at.
function scanTemplate(source: string, bodyStart: number): TemplateScan | string {
  const styles: FoundStyle[] = [];
  const classValues: Array<readonly [number, number]> = [];
  let depth = 0;
  let index = bodyStart;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close === -1) {
        return 'An HTML comment is never closed';
      }
      index = close + 3;
      continue;
    }
    const char = source.charAt(index);
    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth < 0) {
        return 'Its template has a } with no matching {';
      }
    } else if (char === '<' && /[A-Za-z]/.test(source.charAt(index + 1)) && startsMarkup(source, index, depth)) {
      const tag = scanTag(source, index, styles, classValues);
      if (typeof tag === 'string') {
        return tag;
      }
      index = tag;
      continue;
    }
    index += 1;
  }
  if (depth !== 0) {
    return 'Its template has a { that is never closed';
  }
  return { styles, classValues };
}

// One tag at depth zero: its class values, and for <style> and <script> its
// whole body. Returns where scanning continues.
function scanTag(source: string, start: number, styles: FoundStyle[], classValues: Array<readonly [number, number]>): number | string {
  const end = tagEnd(source, start);
  if (end === undefined) {
    return 'A tag is never closed with >';
  }
  const name = /^<([A-Za-z][\w:.-]*)/.exec(source.slice(start, start + 64))?.[1]?.toLowerCase() ?? '';
  const tag = source.slice(start, end);
  for (const match of tag.matchAll(/\sclass(?:Name)?\s*=\s*(["'])([^"']*)\1/g)) {
    const valueStart = start + match.index + match[0].length - 1 - (match[2] ?? '').length;
    classValues.push([valueStart, valueStart + (match[2] ?? '').length]);
  }
  if (name !== 'style' && name !== 'script') {
    return end;
  }
  if (tag.endsWith('/>')) {
    return end;
  }
  const close = source.slice(end).search(new RegExp(`</${name}\\s*>`, 'i'));
  if (close === -1) {
    return `A <${name}> block is never closed`;
  }
  if (name === 'style') {
    styles.push({ start: end, end: end + close, attributes: tag.slice(name.length + 1, -1) });
  }
  return source.indexOf('>', end + close) + 1;
}

function startsMarkup(source: string, index: number, depth: number): boolean {
  if (depth === 0) {
    return true;
  }
  const before = source.slice(Math.max(0, index - 32), index).trimEnd();
  return /(?:[(>?:,[]|&&|\|\||=>|return)$/.test(before);
}

/** The index just past a tag's `>`, skipping quoted values and {…} expressions. */
function tagEnd(source: string, start: number): number | undefined {
  let quote = '';
  let braces = 0;
  const limit = Math.min(source.length, start + TEMPLATE_SCAN_LIMITS.tagCharsMax);
  for (let index = start + 1; index < limit; index += 1) {
    const char = source.charAt(index);
    if (quote !== '') {
      if (char === quote) {
        quote = '';
      }
    } else if (char === '"' || char === "'" || (char === '`' && braces > 0)) {
      quote = char;
    } else if (char === '{') {
      braces += 1;
    } else if (char === '}') {
      braces -= 1;
    } else if (char === '>' && braces === 0) {
      return index + 1;
    }
  }
  return undefined;
}

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
