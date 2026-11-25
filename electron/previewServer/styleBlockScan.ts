// Which `<style>` blocks of an `.astro` file Astro extracts into stylesheet
// modules (`File.astro?astro&type=style&index=N`), read from the file's text the
// way Astro's compiler (@astrojs/compiler-rs) reads it.
//
// The dev preview needs the count to tell a block that was deleted from one that
// exists (preview/markerConfig.ts, avbStyleBlockCount): it answers a request for
// a deleted block with an empty stylesheet instead of Astro's error overlay. A
// count that is too low would empty a block that exists, so the scan says
// `uncertain` whenever the text is anything the compiler might read differently,
// and the preview then serves whatever Astro serves.
//
// What the compiler extracts (each rule checked against its css.length, see
// test/electron/previewServer/styleBlockScan.test.ts):
//   - a `<style>` element, its name in lower case, in the template;
//   - not one inside a `{…}` expression, an attribute value included;
//   - not one with an `is:inline`, `set:html` or `set:text` attribute;
//   - not one under an `<svg>`, `<template>` or `<noscript>` element;
//   - not a self-closing `<style … />`, nor one whose body is only white space.
// `<script>` and `<style>` bodies, and the children of an `is:raw` element, are
// raw text; `<textarea>` and `<title>` are not. The compiler is strict about
// nesting (an unclosed `<p>` is an error), and so is this scan: anything it
// cannot match is uncertain, never guessed at.
//
// The scan is one forward pass with an explicit element stack: no recursion of
// its own, no backtracking regular expression, every loop bounded by the
// source's length (STYLE_SCAN_LIMITS).
import { assert } from '../../shared/core/assert';
import { readFence } from '../parse/astroFence';
import { findMatchingBrace, skipStringOrComment } from '../parse/astroLexical';

export const STYLE_SCAN_LIMITS = {
  /** Characters in one file; a longer file is not scanned (uncertain). */
  sourceCharsMax: 32 * 1024 * 1024,
  /** Elements open at once; a deeper template is not scanned (uncertain). */
  elementDepthMax: 1024,
} as const satisfies Record<string, number>;

export interface StyleElementSpan {
  /** Offset of the element's `<`. */
  readonly start: number;
  /** Offset just past its closing tag, or past `/>` for a self-closing one. */
  readonly end: number;
  /** The CSS text: [bodyStart, bodyEnd) in the file; empty for a self-closing tag. */
  readonly bodyStart: number;
  readonly bodyEnd: number;
  /** Its attribute names as written (`is:global`, `lang`, `define:vars`). */
  readonly attributes: readonly string[];
  /** Astro extracts it into a stylesheet module of its own. */
  readonly extracted: boolean;
}

export type StyleBlockScan =
  | {
      readonly kind: 'certain';
      /** The extracted blocks: Astro's css.length for this text. */
      readonly count: number;
      /** Every `<style>` element of the template outside expressions, in order. */
      readonly elements: readonly StyleElementSpan[];
    }
  | { readonly kind: 'uncertain'; readonly reason: string };

/** The `<style>` blocks Astro extracts from `source`, or uncertain when the text could be read more than one way. */
export function scanStyleBlocks(source: string): StyleBlockScan {
  if (source.length > STYLE_SCAN_LIMITS.sourceCharsMax) {
    return uncertain('the file is longer than the scan reads');
  }
  const fence = readFence(source);
  if (fence.kind === 'unreadable') {
    return uncertain(fence.what);
  }
  const bom = source.startsWith('\uFEFF') ? 1 : 0;
  const scan = scanTemplate(source, fence.kind === 'fence' ? fence.length : bom);
  if (scan.kind === 'certain') {
    assert(scan.count === scan.elements.filter((element) => element.extracted).length, 'scanStyleBlocks: the count is the extracted elements');
    assert(scan.count <= scan.elements.length, 'scanStyleBlocks: no more blocks than elements');
  }
  return scan;
}

// Elements that never have children or a closing tag.
const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
// A `<style>` under one of these stays in the markup.
const MARKUP_STYLE_PARENTS: ReadonlySet<string> = new Set(['svg', 'template', 'noscript']);
// Attributes that keep a `<style>` in the markup.
const MARKUP_STYLE_ATTRIBUTES: readonly string[] = ['is:inline', 'set:html', 'set:text'];
// The compiler trims a block with Unicode White_Space (Rust's `trim`): JavaScript's
// `\s` differs in U+0085 (white space there, not here) and U+FEFF (here, not there).
const WHITE_SPACE_ONLY = /^[\t\n\v\f\r \u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]*$/;
const TAG_NAME = /[A-Za-z][\w:.$-]*/y;
const NEXT_MARKUP = /[<{}]/g;

interface OpenElement {
  readonly name: string;
  /** Under an svg, template or noscript element, itself included. */
  readonly markupStyles: boolean;
}

interface OpeningTag {
  readonly name: string;
  readonly attributes: readonly string[];
  /** Offset just past the tag's `>`. */
  readonly end: number;
  readonly selfClosing: boolean;
}

type TagRead = { readonly kind: 'tag'; readonly tag: OpeningTag } | { readonly kind: 'uncertain'; readonly reason: string };

// One pass over the template from `start`. Text is skipped to the next `<`, `{`
// or `}`; comments, raw-text bodies and expressions are skipped whole.
function scanTemplate(source: string, start: number): StyleBlockScan {
  const elements: StyleElementSpan[] = [];
  const open: OpenElement[] = [];
  let index = start;
  // Each pass moves `index` forward by at least one character.
  for (let pass = 0; pass <= source.length + 1; pass += 1) {
    NEXT_MARKUP.lastIndex = index;
    const found = NEXT_MARKUP.exec(source);
    if (found === null) {
      return open.length === 0 ? certain(elements) : uncertain(`<${open.at(-1)?.name ?? ''}> is never closed`);
    }
    const at = found.index;
    assert(at >= index, 'scanTemplate: the search moves forward');
    const step = scanMarkupAt(source, at, open, elements);
    if (typeof step === 'string') {
      return uncertain(step);
    }
    assert(step > at, 'scanTemplate: every step consumes text');
    index = step;
  }
  assert(false, 'scanTemplate: the pass bound is the source length');
}

// The construct at `at` (a `<`, `{` or `}`): where scanning continues, or why the text is uncertain.
function scanMarkupAt(source: string, at: number, open: OpenElement[], elements: StyleElementSpan[]): number | string {
  const char = source.charAt(at);
  if (char === '}') {
    return 'a } outside any expression';
  }
  if (char === '{') {
    // Nothing inside an expression is extracted, whatever markup it holds.
    const close = findMatchingBrace(source, at);
    return close === -1 ? 'an expression that is never closed' : close + 1;
  }
  assert(char === '<', 'scanMarkupAt: markup starts at <');
  if (source.startsWith('<!--', at)) {
    const close = source.indexOf('-->', at + 4);
    return close === -1 ? 'a comment that is never closed' : close + 3;
  }
  if (source.startsWith('<!', at)) {
    // A doctype; a CDATA section is an error to the compiler.
    if (source.startsWith('<![CDATA[', at)) {
      return 'a CDATA section';
    }
    const close = source.indexOf('>', at);
    return close === -1 ? 'a declaration that is never closed' : close + 1;
  }
  if (source.startsWith('</', at)) {
    return closeElement(source, at, open);
  }
  if (source.startsWith('<>', at)) {
    return pushElement(open, '') ?? at + 2;
  }
  TAG_NAME.lastIndex = at + 1;
  if (!TAG_NAME.test(source)) {
    return at + 1; // A `<` in text, as in `a < b`.
  }
  const read = readOpeningTag(source, at);
  if (read.kind === 'uncertain') {
    return read.reason;
  }
  return enterElement(source, { at, tag: read.tag }, open, elements);
}

// An opening tag just read: a raw-text body is skipped, a `<style>` recorded, any other element opened.
function enterElement(
  source: string,
  { at, tag }: { readonly at: number; readonly tag: OpeningTag },
  open: OpenElement[],
  elements: StyleElementSpan[],
): number | string {
  const lower = tag.name.toLowerCase();
  if (lower === 'style' || lower === 'script') {
    if (tag.name !== lower) {
      return `<${tag.name}> in capitals, which the compiler does not read as <${lower}>`;
    }
    const insideMarkupStyles = open.at(-1)?.markupStyles ?? false;
    if (tag.selfClosing) {
      if (lower === 'style') {
        elements.push({ start: at, end: tag.end, bodyStart: tag.end, bodyEnd: tag.end, attributes: tag.attributes, extracted: false });
      }
      return tag.end;
    }
    const close = rawTextClose(source, tag.end, lower);
    if (typeof close === 'string') {
      return close;
    }
    if (lower === 'style') {
      const body = source.slice(tag.end, close.bodyEnd);
      const kept = insideMarkupStyles || MARKUP_STYLE_ATTRIBUTES.some((name) => tag.attributes.includes(name));
      elements.push({
        start: at,
        end: close.end,
        bodyStart: tag.end,
        bodyEnd: close.bodyEnd,
        attributes: tag.attributes,
        extracted: !kept && !WHITE_SPACE_ONLY.test(body),
      });
    }
    return close.end;
  }
  if (tag.selfClosing || VOID_ELEMENTS.has(tag.name)) {
    return tag.end;
  }
  if (tag.attributes.includes('is:raw')) {
    const close = rawTextClose(source, tag.end, tag.name);
    if (typeof close === 'string') {
      return close;
    }
    if (source.slice(tag.end, close.bodyEnd).includes(`<${tag.name}`)) {
      return `an is:raw <${tag.name}> that holds another <${tag.name}>`;
    }
    return close.end;
  }
  return pushElement(open, tag.name) ?? tag.end;
}

// Opens an element; the reason when it cannot be opened.
function pushElement(open: OpenElement[], name: string): string | undefined {
  if (open.length >= STYLE_SCAN_LIMITS.elementDepthMax) {
    return 'elements nested deeper than the scan reads';
  }
  const parent = open.at(-1)?.markupStyles ?? false;
  open.push({ name, markupStyles: parent || MARKUP_STYLE_PARENTS.has(name) });
  assert(open.length <= STYLE_SCAN_LIMITS.elementDepthMax, 'pushElement: the stack stays inside its bound');
  return undefined;
}

// A closing tag: it must close the innermost open element, as the compiler requires.
function closeElement(source: string, at: number, open: OpenElement[]): number | string {
  const close = source.indexOf('>', at);
  if (close === -1) {
    return 'a closing tag that is never finished';
  }
  const name = source.slice(at + 2, close).trim();
  const innermost = open.at(-1);
  if (innermost === undefined) {
    return `</${name}> with no element open`;
  }
  if (innermost.name !== name) {
    return `</${name}> closes <${innermost.name}>`;
  }
  open.pop();
  return close + 1;
}

// Where a raw-text body (`<script>`, `<style>`, an `is:raw` element) ends: the
// first `</name` in any case, which must be written in the opening tag's case
// and finish with `>`. The search runs from `from` only, so a file of many
// blocks is still read once.
function rawTextClose(source: string, from: number, name: string): { readonly bodyEnd: number; readonly end: number } | string {
  const closing = new RegExp(`</${name.replace(/[.$]/g, '\\$&')}`, 'gi');
  closing.lastIndex = from;
  const found = closing.exec(source);
  if (found === null) {
    return `<${name}> is never closed`;
  }
  const bodyEnd = found.index;
  const nameEnd = bodyEnd + found[0].length;
  if (source.slice(bodyEnd + 2, nameEnd) !== name) {
    return `</${name}> written in another case`;
  }
  let end = nameEnd;
  while (end < source.length && /\s/.test(source.charAt(end))) {
    end += 1;
  }
  if (source.charAt(end) !== '>') {
    return `</${name}> followed by something other than >`;
  }
  assert(bodyEnd >= from, 'rawTextClose: the body ends after it starts');
  assert(end > bodyEnd, 'rawTextClose: the closing tag follows the body');
  return { bodyEnd, end: end + 1 };
}

// An opening tag at `start`: its name, its attribute names, and where it ends.
// Quoted values, template literals and `{…}` expressions may hold `>` or `/>`.
function readOpeningTag(source: string, start: number): TagRead {
  TAG_NAME.lastIndex = start + 1;
  const match = TAG_NAME.exec(source);
  assert(match !== null, 'readOpeningTag: called on a tag name');
  const name = match[0];
  const attributes: string[] = [];
  let index = start + 1 + name.length;
  // Each pass moves `index` forward by at least one character.
  for (let pass = 0; pass <= source.length; pass += 1) {
    if (index >= source.length) {
      return { kind: 'uncertain', reason: `<${name}> is never finished` };
    }
    const char = source.charAt(index);
    if (char === '>') {
      return { kind: 'tag', tag: { name, attributes, end: index + 1, selfClosing: false } };
    }
    if (char === '/' && source.charAt(index + 1) === '>') {
      return { kind: 'tag', tag: { name, attributes, end: index + 2, selfClosing: true } };
    }
    const next = attributeEnd(source, index, attributes);
    if (typeof next === 'string') {
      return { kind: 'uncertain', reason: `<${name}>: ${next}` };
    }
    assert(next > index, 'readOpeningTag: every attribute step consumes text');
    index = next;
  }
  return { kind: 'uncertain', reason: `<${name}> is longer than the scan reads` };
}

// One step inside an opening tag at `index`: white space, an `{…}` attribute, or
// a name with its optional value. Attribute names are collected as written.
function attributeEnd(source: string, index: number, attributes: string[]): number | string {
  const char = source.charAt(index);
  if (/\s/.test(char) || char === '/') {
    return index + 1;
  }
  if (char === '{') {
    const close = findMatchingBrace(source, index);
    return close === -1 ? 'an expression that is never closed' : close + 1;
  }
  if (char === '"' || char === "'" || char === '`' || char === '=') {
    return `a stray ${char}`;
  }
  let nameEnd = index;
  while (nameEnd < source.length && !/[\s"'`=<>/{}]/.test(source.charAt(nameEnd))) {
    nameEnd += 1;
  }
  if (nameEnd === index) {
    return `a stray ${char}`;
  }
  attributes.push(source.slice(index, nameEnd));
  let cursor = nameEnd;
  while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
    cursor += 1;
  }
  if (source.charAt(cursor) !== '=') {
    return nameEnd;
  }
  cursor += 1;
  while (cursor < source.length && /\s/.test(source.charAt(cursor))) {
    cursor += 1;
  }
  return attributeValueEnd(source, cursor);
}

function attributeValueEnd(source: string, start: number): number | string {
  const char = source.charAt(start);
  if (char === '"' || char === "'") {
    // HTML values have no escapes: the value ends at the next matching quote.
    const close = source.indexOf(char, start + 1);
    return close === -1 ? 'a quoted value that is never closed' : close + 1;
  }
  if (char === '`') {
    const end = skipStringOrComment(source, start);
    return end <= start || end > source.length || source.charAt(end - 1) !== '`' ? 'a template value that is never closed' : end;
  }
  if (char === '{') {
    const close = findMatchingBrace(source, start);
    return close === -1 ? 'an expression value that is never closed' : close + 1;
  }
  let end = start;
  while (end < source.length && !/[\s>"'`=<]/.test(source.charAt(end))) {
    if (source.charAt(end) === '/' && source.charAt(end + 1) === '>') {
      break;
    }
    end += 1;
  }
  return end === start ? 'an attribute with no value after =' : end;
}

function certain(elements: readonly StyleElementSpan[]): StyleBlockScan {
  return { kind: 'certain', count: elements.filter((element) => element.extracted).length, elements };
}

function uncertain(reason: string): StyleBlockScan {
  assert(reason.length > 0, 'uncertain: a reason is given');
  return { kind: 'uncertain', reason };
}
