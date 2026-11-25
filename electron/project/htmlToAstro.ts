// One plain HTML page as an Astro page: the same document, changed only where Astro would read it
// differently from a browser. Pure: text in, text out, so every rule is tested on exact strings.
//
// What Astro reads differently (each checked against the installed @astrojs/compiler, see
// test/electron/project/htmlToAstro.test.ts):
// - `{` and `}` in text start and end an expression, also inside <pre>, <title>, <textarea> and
//   <noscript>. They become the character references `&#123;` and `&#125;`, which every browser shows as
//   the same characters and which stay plain text for Stacki's text editing. Comments, CDATA, quoted
//   attribute values and the raw-text elements (<script>, <style>, <xmp>, <iframe>, <noembed>,
//   <noframes>, <plaintext>) are literal to Astro already and are left byte for byte.
// - An unquoted attribute value holding a brace (`data-x={a}`) is an expression: it gets quotes.
// - A tag name that starts with a capital (`<DIV>`, `<SCRIPT>`) is a component: HTML ignores case, so it
//   is lowercased. camelCase SVG names (`<linearGradient>`) start lowercase and are kept.
// - A bare <script> is bundled: relative imports would be looked for beside src/pages, where nothing
//   is. `is:inline` keeps every script exactly as written. JSON scripts (`application/ld+json`,
//   `importmap`) are never processed, so they are left alone.
// - A <style> is scoped to the page. `is:global` keeps it global, as it was. A style with `@import`
//   gets `is:inline` instead: Astro would resolve the import from src/pages and the build would fail.
//   Inside <svg> and <template> Astro leaves styles untouched and would print `is:global` into the
//   page, so those are left alone.
// - A <slot> is Astro's own slot; `is:inline` keeps it the web-component slot it was.
// - A file that begins with `---` would open a frontmatter fence; an empty frontmatter goes first.
// - A byte-order mark is dropped: it would hide that fence from the check above.

import { assert } from '../../shared/core/assert';

export interface HtmlToAstroChanges {
  /** Braces in text written as character references. */
  readonly bracesEscaped: number;
  readonly scriptsInlined: number;
  readonly stylesGlobal: number;
  readonly stylesInlined: number;
  readonly slotsInlined: number;
  readonly tagsLowercased: number;
  readonly attributesQuoted: number;
  readonly frontmatterAdded: boolean;
}

export interface HtmlToAstro {
  readonly text: string;
  readonly changes: HtmlToAstroChanges;
}

// Elements whose content Astro (like a browser) treats as raw text.
const RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext']);
// Elements Astro leaves unprocessed, along with every <style> inside them.
const FOREIGN_CONTEXTS = new Set(['svg', 'template']);
const TAG_NAME = /^[A-Za-z][^\s/>]*/;
const ATTRIBUTE_NAME = /^[^\s"'>/=]+/;
const JSON_SCRIPT_TYPE = /json|^\s*importmap\s*$/i;
const EMPTY_FRONTMATTER = '---\n---\n';

type CounterName = Exclude<keyof HtmlToAstroChanges, 'frontmatterAdded'>;

// The pass's tally. Its counts are private and change only through `note`, so every helper can report
// what it changed without owning any state of its own.
class Counters {
  private readonly counts: Record<CounterName, number> = {
    bracesEscaped: 0,
    scriptsInlined: 0,
    stylesGlobal: 0,
    stylesInlined: 0,
    slotsInlined: 0,
    tagsLowercased: 0,
    attributesQuoted: 0,
  };

  note(name: CounterName, amount: number): void {
    assert(Number.isSafeInteger(amount), 'Counters.note: a whole number');
    assert(amount >= 0, 'Counters.note: counts only grow');
    this.counts[name] += amount;
  }

  snapshot(): Readonly<Record<CounterName, number>> {
    return { ...this.counts };
  }
}

interface Attribute {
  readonly name: string;
  /** The attribute exactly as written, from its leading whitespace to the end of its value. */
  readonly raw: string;
  /** The value as written, without quotes; undefined when there is none. */
  readonly value: string | undefined;
  /** How the value was written: a brace matters only in an unquoted one. */
  readonly quoting: 'none' | 'quoted' | 'unquoted';
}

interface StartTag {
  readonly name: string;
  readonly attributes: readonly Attribute[];
  /** Whatever stands between the last attribute and `>`: whitespace and a `/` of a self-closing tag. */
  readonly tail: string;
  /** The index just past the `>`, or the end of the text for a tag that never closes. */
  readonly end: number;
}

/** The page as Astro should read it, and what was changed to get there. */
export function htmlToAstro(source: string): HtmlToAstro {
  const counters = new Counters();
  const body = source.startsWith('﻿') ? source.slice(1) : source;
  const converted = convertMarkup(body, counters);
  const frontmatterAdded = /^\s*---/.test(converted);
  const text = frontmatterAdded ? EMPTY_FRONTMATTER + converted : converted;
  assert(!/^\s*---/.test(text) || text.startsWith(EMPTY_FRONTMATTER), 'htmlToAstro: a fence at the start is always the empty frontmatter');
  assert(text.length >= body.length, 'htmlToAstro: conversion only adds');
  return { text, changes: { ...counters.snapshot(), frontmatterAdded } };
}

// One pass over the markup. The parent keeps the control flow (which construct starts here) and the
// state (how deep inside <svg> or <template> it is); the helpers read one construct and return its end.
function convertMarkup(source: string, counters: Counters): string {
  const parts: string[] = [];
  const foreignDepth = new Map<string, number>([...FOREIGN_CONTEXTS].map((name) => [name, 0]));
  let index = 0;
  let textStart = 0;
  const flushText = (end: number): void => {
    parts.push(escapeBraces(source.slice(textStart, end), counters));
  };
  // Each turn moves `index` forward by at least one character, so the loop ends within source.length turns.
  while (index < source.length) {
    const next = source.indexOf('<', index);
    if (next < 0) {
      break;
    }
    const construct = markupAt(source, next);
    if (construct.kind === 'text') {
      index = next + 1;
      continue;
    }
    flushText(next);
    if (construct.kind === 'verbatim') {
      parts.push(source.slice(next, construct.end) + construct.closer);
      index = construct.end;
    } else if (construct.kind === 'end') {
      parts.push(endTagText(source.slice(next, construct.end), construct.name, counters));
      const lower = construct.name.toLowerCase();
      const depth = foreignDepth.get(lower);
      if (depth !== undefined && depth > 0) {
        foreignDepth.set(lower, depth - 1);
      }
      index = construct.end;
    } else {
      const tag = construct.tag;
      const lower = tag.name.toLowerCase();
      const insideForeign = [...foreignDepth.values()].some((depth) => depth > 0);
      const selfClosing = tag.tail.includes('/');
      if (RAW_TEXT_ELEMENTS.has(lower) && !selfClosing) {
        const contentEnd = rawTextEnd(source, tag.end, lower);
        const content = source.slice(tag.end, contentEnd);
        parts.push(startTagText(tag, directiveFor(lower, tag, content, { insideForeign }), counters));
        parts.push(content);
        // One the file ends inside of is closed there, as a browser reads it; Astro would refuse it open.
        if (contentEnd === source.length && lower !== 'plaintext') {
          parts.push(`</${lower}>`);
        }
        index = contentEnd;
      } else {
        parts.push(startTagText(tag, directiveFor(lower, tag, '', { insideForeign }), counters));
        const depth = foreignDepth.get(lower);
        if (depth !== undefined && !selfClosing) {
          foreignDepth.set(lower, depth + 1);
        }
        index = tag.end;
      }
    }
    assert(index > next, 'convertMarkup: every construct moves forward');
    textStart = index;
  }
  flushText(source.length);
  return parts.join('');
}

type Construct =
  | { readonly kind: 'text' }
  | { readonly kind: 'verbatim'; readonly end: number; readonly closer: string }
  | { readonly kind: 'end'; readonly name: string; readonly end: number }
  | { readonly kind: 'start'; readonly tag: StartTag };

// What the `<` at `at` opens. A `<` that opens nothing (`a < b`) is text, as it is to a browser.
function markupAt(source: string, at: number): Construct {
  assert(source[at] === '<', 'markupAt: called on a <');
  if (source.startsWith('<!--', at)) {
    return verbatim(source, '-->', at + 4);
  }
  if (source.startsWith('<![CDATA[', at)) {
    return verbatim(source, ']]>', at + 9);
  }
  if (source.startsWith('<!', at) || source.startsWith('<?', at)) {
    return verbatim(source, '>', at + 2);
  }
  if (source.startsWith('</', at)) {
    const name = TAG_NAME.exec(source.slice(at + 2, at + 2 + 256))?.[0];
    if (name === undefined) {
      return { kind: 'text' };
    }
    return { kind: 'end', name, end: endAfter(source, '>', at + 2 + name.length) };
  }
  const tag = readStartTag(source, at);
  return tag === undefined ? { kind: 'text' } : { kind: 'start', tag };
}

// A comment, CDATA section or declaration, kept as written. One the file ends inside of gains its closer:
// a browser hides the rest of the file in it, but Astro would read braces there as expressions.
function verbatim(source: string, closer: string, from: number): Construct {
  const found = source.indexOf(closer, from);
  return found < 0
    ? { kind: 'verbatim', end: source.length, closer: closer === '>' ? '>' : ` ${closer}` }
    : { kind: 'verbatim', end: found + closer.length, closer: '' };
}

/** The index just past the first `marker` at or after `from`, or the end of the text. */
function endAfter(source: string, marker: string, from: number): number {
  const found = source.indexOf(marker, from);
  return found < 0 ? source.length : found + marker.length;
}

// The start of the closing tag of a raw-text element, matched without regard to case as HTML does.
function rawTextEnd(source: string, from: number, name: string): number {
  if (name === 'plaintext') {
    return source.length; // Nothing closes it.
  }
  const closing = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
  closing.lastIndex = from;
  const found = closing.exec(source);
  return found === null ? source.length : found.index;
}

function readStartTag(source: string, at: number): StartTag | undefined {
  const name = TAG_NAME.exec(source.slice(at + 1, at + 1 + 256))?.[0];
  if (name === undefined) {
    return undefined;
  }
  const attributes: Attribute[] = [];
  let index = at + 1 + name.length;
  // Each turn reads at least one character of an attribute or ends the tag, so it ends within the text.
  while (index < source.length) {
    const whitespace = /^\s*/.exec(source.slice(index, index + 4096))?.[0] ?? '';
    const afterSpace = index + whitespace.length;
    const character = source[afterSpace];
    if (character === undefined || character === '>') {
      return { name, attributes, tail: whitespace, end: Math.min(afterSpace + 1, source.length) };
    }
    if (character === '/') {
      if (source[afterSpace + 1] === '>') {
        return { name, attributes, tail: whitespace + '/', end: afterSpace + 2 };
      }
      // A stray slash between attributes is ignored by browsers; keep it as written.
      attributes.push({ name: '', raw: whitespace + '/', value: undefined, quoting: 'none' });
      index = afterSpace + 1;
      continue;
    }
    const attribute = readAttribute(source, index, whitespace);
    assert(attribute.end > index, 'readStartTag: every attribute moves forward');
    attributes.push(attribute.attribute);
    index = attribute.end;
  }
  return { name, attributes, tail: '', end: source.length };
}

function readAttribute(source: string, start: number, whitespace: string): { readonly attribute: Attribute; readonly end: number } {
  const nameStart = start + whitespace.length;
  const name = ATTRIBUTE_NAME.exec(source.slice(nameStart, nameStart + 4096))?.[0] ?? source[nameStart] ?? '';
  let index = nameStart + name.length;
  const beforeEquals = /^\s*=\s*/.exec(source.slice(index, index + 4096))?.[0];
  if (beforeEquals === undefined) {
    return { attribute: { name, raw: source.slice(start, index), value: undefined, quoting: 'none' }, end: index };
  }
  index += beforeEquals.length;
  const quote = source[index];
  if (quote === '"' || quote === "'") {
    const close = source.indexOf(quote, index + 1);
    const end = close < 0 ? source.length : close + 1;
    const value = source.slice(index + 1, close < 0 ? source.length : close);
    return { attribute: { name, raw: source.slice(start, end), value, quoting: 'quoted' }, end };
  }
  const unquoted = /^[^\s>]*/.exec(source.slice(index))?.[0] ?? '';
  const end = index + unquoted.length;
  return { attribute: { name, raw: source.slice(start, end), value: unquoted, quoting: 'unquoted' }, end };
}

type Directive = 'is:inline' | 'is:global' | undefined;

// The directive a start tag gains, decided from its name, its attributes and (for a style) its content.
function directiveFor(lower: string, tag: StartTag, content: string, context: { readonly insideForeign: boolean }): Directive {
  const names = new Set(tag.attributes.map((attribute) => attribute.name.toLowerCase()));
  if (lower === 'script') {
    if (names.has('is:inline')) {
      return undefined;
    }
    const type = tag.attributes.find((attribute) => attribute.name.toLowerCase() === 'type')?.value;
    if (type !== undefined && JSON_SCRIPT_TYPE.test(type)) {
      return undefined;
    }
    return 'is:inline';
  }
  if (lower === 'style') {
    if (context.insideForeign) {
      return undefined;
    }
    if (names.has('is:inline') || names.has('is:global')) {
      return undefined;
    }
    return /@import\b/i.test(content) ? 'is:inline' : 'is:global';
  }
  if (lower === 'slot') {
    return names.has('is:inline') ? undefined : 'is:inline';
  }
  return undefined;
}

function startTagText(tag: StartTag, directive: Directive, counters: Counters): string {
  const name = lowercaseIfCapital(tag.name, counters);
  const attributes = tag.attributes.map((attribute) => quoteBracedValue(attribute, counters)).join('');
  const lower = tag.name.toLowerCase();
  if (directive !== undefined) {
    countDirective(lower, directive, counters);
  }
  const added = directive === undefined ? '' : ` ${directive}`;
  // A tag the file ends inside of gains its `>`: a browser drops such a tag, and Astro would refuse it.
  return `<${name}${added}${attributes}${tag.tail}>`;
}

function countDirective(lower: string, directive: 'is:inline' | 'is:global', counters: Counters): void {
  if (lower === 'script') {
    counters.note('scriptsInlined', 1);
  } else if (lower === 'slot') {
    counters.note('slotsInlined', 1);
  } else if (directive === 'is:global') {
    counters.note('stylesGlobal', 1);
  } else {
    counters.note('stylesInlined', 1);
  }
}

function endTagText(raw: string, name: string, counters: Counters): string {
  const lowered = lowercaseIfCapital(name, counters);
  return lowered === name ? raw : `</${lowered}${raw.slice(2 + name.length)}`;
}

function lowercaseIfCapital(name: string, counters: Counters): string {
  const first = name[0];
  assert(first !== undefined, 'lowercaseIfCapital: a tag has a name');
  if (first >= 'A' && first <= 'Z') {
    counters.note('tagsLowercased', 1);
    return name.toLowerCase();
  }
  return name;
}

// An unquoted value holding a brace is an expression to Astro; quoted, it is the literal text it was.
function quoteBracedValue(attribute: Attribute, counters: Counters): string {
  const value = attribute.value;
  if (value === undefined || !/[{}]/.test(value)) {
    return attribute.raw;
  }
  if (attribute.quoting !== 'unquoted') {
    return attribute.raw;
  }
  assert(attribute.raw.endsWith(value), 'quoteBracedValue: an unquoted value ends its attribute');
  const valueAt = attribute.raw.length - value.length;
  counters.note('attributesQuoted', 1);
  const quoted = value.includes('"') ? `'${value}'` : `"${value}"`;
  return attribute.raw.slice(0, valueAt) + quoted;
}

function escapeBraces(text: string, counters: Counters): string {
  let escaped = 0;
  const result = text.replace(/[{}]/g, (brace) => {
    escaped += 1;
    return brace === '{' ? '&#123;' : '&#125;';
  });
  counters.note('bracesEscaped', escaped);
  return result;
}
