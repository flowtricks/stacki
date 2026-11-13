// The `<style>` blocks of an Astro file, where every tool that reads a file's CSS
// finds them: the selector cleanup (selectorSheets.ts) and the Variables panel
// (cssVarRegions.ts). A stylesheet region is a whole `.css` file or one block.
//
// Blocks are located by the editor's own parser, whose offsets are checked
// against the file's bytes before a block is trusted (locateStyleBlock). A file
// the visual editor cannot represent is read by a small scanner of the template
// instead (scanTemplate). Astro's compiler is not used: on a 2 MB icon component
// it exhausts its memory and aborts the whole process, which no try/catch can stop.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import type { SelectorScope } from '../../shared/properties/selectorUsage';
import { parsePage } from '../parse/astroParser';
import type { ParserNode } from '../parse/astroParserTypes';

export interface StyleRegion {
  readonly rel: string;
  /** 0 for a stylesheet file; the block's position among the file's `<style>` blocks otherwise. */
  readonly block: number;
  /** UTF-16 offset of the region's first character in its file. */
  readonly start: number;
  readonly text: string;
  readonly scope: SelectorScope;
  /** How the block was written; `is:inline` and `is:global` share a scope but not a build path. */
  readonly written: StyleBlockWriting;
  /** The block sits in a `{…}` expression, so whether it renders is decided at run time. */
  readonly conditional: boolean;
  /** 1-based line of the region's first character in its file. */
  readonly line: number;
}

export type StyleBlockWriting = 'stylesheet' | 'global' | 'inline' | 'scoped';

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
  readonly unreadable: Described | undefined;
}

/** Why a style block or template could not be read: the English sentence and its reference, which the Selectors panel words in the person's language. */
export interface StyleProblem extends Described {
  readonly failed: true;
}

function problem(...input: Parameters<typeof described>): StyleProblem {
  return { failed: true, ...described(...input) };
}

function isProblem(value: unknown): value is StyleProblem {
  return typeof value === 'object' && value !== null && 'failed' in value;
}

export function cssFileRegion(rel: string, text: string): StyleRegion {
  return { rel, block: 0, start: 0, text, scope: 'global', written: 'stylesheet', conditional: false, line: 1 };
}

const DYNAMIC_CLASS = /\bclass(?:Name)?\s*=\s*\{|\bclass:list\b|\{\s*\.\.\./;

export function readAstroSheet(rel: string, source: string): AstroSheet {
  const bodyStart = templateStart(source);
  const dynamicClass = DYNAMIC_CLASS.test(source.slice(bodyStart));
  const parsed = parsePage(source, { locs: true });
  const found = parsed.editable ? fromParser(rel, source, parsed.model.nodes) : fromScanner(rel, source, bodyStart);
  if (isProblem(found)) {
    // Nothing is blanked: every style block stays in the mention text, which can
    // only protect more names, never fewer.
    return {
      rel,
      source,
      regions: [],
      ownText: source,
      foreignText: source,
      dynamicClass: true,
      unreadable: { message: found.message, messageRef: found.messageRef },
    };
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
  readonly unreadable: Described | undefined;
}

function fromParser(rel: string, source: string, nodes: readonly ParserNode[]): FoundSheet {
  const regions: StyleRegion[] = [];
  const classValues: Array<readonly [number, number]> = [];
  let unreadable: Described | undefined;
  const stack: Array<{ readonly node: ParserNode; readonly conditional: boolean }> = nodes.map((node) => ({ node, conditional: false }));
  for (let visited = 0; stack.length > 0; visited += 1) {
    assert(visited <= LIMITS.treeNodesMax, 'fromParser: the parser bounds the tree');
    const entry = stack.pop();
    assert(entry !== undefined, 'fromParser: the stack was not empty');
    const { node, conditional } = entry;
    for (const span of node.attrSpans ?? []) {
      if (span.type === 'string') {
        if (span.name === 'class' || span.name === 'className') {
          classValues.push([span.valueSpan.start, span.valueSpan.end]);
        }
      }
    }
    if (node.kind === 'raw') {
      if (node.name.toLowerCase() === 'style') {
        const located = locateStyleBlock(rel, source, node, { conditional });
        if (isProblem(located)) {
          unreadable = { message: located.message, messageRef: located.messageRef };
        } else if (located.text !== '') {
          regions.push(located);
        }
      }
    } else if (node.children !== undefined) {
      // A map or a condition is a `{…}` expression, and everything under it is too.
      const inside = conditional || node.kind === 'map' || node.kind === 'cond';
      stack.push(...node.children.map((child) => ({ node: child, conditional: inside })));
    }
  }
  return { regions, classValues, unreadable };
}

function fromScanner(rel: string, source: string, bodyStart: number): FoundSheet | StyleProblem {
  const scanned = scanTemplate(source, bodyStart);
  if (isProblem(scanned)) {
    return scanned;
  }
  const regions: StyleRegion[] = [];
  let unreadable: Described | undefined;
  for (const style of scanned.styles) {
    const lang = /\blang\s*=\s*["']?([\w-]+)/i.exec(style.attributes)?.[1];
    if (lang !== undefined && lang.toLowerCase() !== 'css') {
      unreadable = described('selectors.problem.styleLang', { tag: `<style lang="${lang}">` });
      continue;
    }
    if (style.end > style.start) {
      const written = /(?:^|\s)is:inline\b/.test(style.attributes) ? 'inline' : /(?:^|\s)is:global\b/.test(style.attributes) ? 'global' : 'scoped';
      regions.push({
        rel,
        block: 0,
        start: style.start,
        text: source.slice(style.start, style.end),
        scope: written === 'scoped' ? 'scoped' : 'global',
        written,
        conditional: style.conditional,
        line: lineAt(source, style.start),
      });
    }
  }
  return { regions, classValues: scanned.classValues, unreadable };
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
  /** The tag sits inside a `{…}` expression. */
  readonly conditional: boolean;
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
function scanTemplate(source: string, bodyStart: number): TemplateScan | StyleProblem {
  const styles: FoundStyle[] = [];
  const classValues: Array<readonly [number, number]> = [];
  let depth = 0;
  let index = bodyStart;
  while (index < source.length) {
    if (source.startsWith('<!--', index)) {
      const close = source.indexOf('-->', index + 4);
      if (close === -1) {
        return problem('selectors.problem.commentOpen');
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
        return problem('selectors.problem.braceClose');
      }
    } else if (char === '<' && /[A-Za-z]/.test(source.charAt(index + 1)) && startsMarkup(source, index, depth)) {
      const tag = scanTag(source, { start: index, conditional: depth > 0 }, styles, classValues);
      if (isProblem(tag)) {
        return tag;
      }
      index = tag;
      continue;
    }
    index += 1;
  }
  if (depth !== 0) {
    return problem('selectors.problem.braceOpen');
  }
  return { styles, classValues };
}

// One tag at depth zero: its class values, and for <style> and <script> its
// whole body. Returns where scanning continues.
function scanTag(
  source: string,
  { start, conditional }: { readonly start: number; readonly conditional: boolean },
  styles: FoundStyle[],
  classValues: Array<readonly [number, number]>,
): number | StyleProblem {
  const end = tagEnd(source, start);
  if (end === undefined) {
    return problem('selectors.problem.tagOpen');
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
    return problem('selectors.problem.blockOpen', { tag: `<${name}>` });
  }
  if (name === 'style') {
    styles.push({ start: end, end: end + close, attributes: tag.slice(name.length + 1, -1), conditional });
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

function locateStyleBlock(
  rel: string,
  source: string,
  node: Extract<ParserNode, { kind: 'raw' }>,
  { conditional }: { readonly conditional: boolean },
): StyleRegion | StyleProblem {
  const lang = attrText(node, 'lang');
  if (lang !== undefined && lang.toLowerCase() !== 'css') {
    return problem('selectors.problem.styleLang', { tag: `<style lang="${lang}">` });
  }
  if (node.start === undefined || node.end === undefined) {
    return problem('selectors.problem.styleNoPosition', { tag: '<style>' });
  }
  const tag = source.slice(node.start, node.end);
  const close = /<\/style\s*>$/i.exec(tag);
  if (close === null) {
    return problem('selectors.problem.styleNoClosing', { tag: '<style>' });
  }
  const closeStart = node.start + close.index;
  const start = closeStart - node.inner.length;
  if (start <= node.start || source.slice(start, closeStart) !== node.inner) {
    return problem('selectors.problem.styleMoved', { tag: '<style>' });
  }
  const written = node.props?.['is:inline'] !== undefined ? 'inline' : node.props?.['is:global'] !== undefined ? 'global' : 'scoped';
  // The block's position is assigned once every block is found (readAstroSheet).
  return { rel, block: 0, start, text: node.inner, scope: written === 'scoped' ? 'scoped' : 'global', written, conditional, line: lineAt(source, start) };
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
