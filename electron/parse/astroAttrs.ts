// The parser's ground floor: element kinds, node ids and path ids, and the
// attributes of a tag — scanned with their spans, read as props, and written
// back in the order and spelling they came in.

import type { Attr, AttrSpan } from '../../shared/page/pageNode';
import { toUtf16Span } from '../../shared/core/span';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { ParserNode } from './astroParserTypes';
import { findMatchingBrace } from './astroLexical';

export { HTML_VOID_TAGS as VOID_ELEMENTS } from '../../shared/page/htmlTags';
export const RAW_ELEMENTS = new Set(['style', 'script']);

// Node ids are structural paths — `n0`, `n0.2`, `n0.2.1` — assigned in one
// pass once a tree is complete (assignPathIds), so a parse is a pure function
// of its text: no counter survives between parses, and nothing can key on
// parse order (plan §4, §11.9). Nodes are built with this placeholder; the
// parser itself never reads an id.
const PENDING_ID = 'n0';
export const makeId = (): string => PENDING_ID;

// Give every node of a finished tree its path id; the layout wrapper keeps its
// well-known `layout`. The tree is the parser's own, just built, so this is
// the one place its ids are written. Depth is the tree's bound (asserted).
export function assignPathIds(nodes: readonly ParserNode[], prefix: string, depth: number): void {
  assert(depth <= LIMITS.treeDepthMax, 'Path ids are assigned within the depth bound');
  for (const [index, node] of nodes.entries()) {
    const path = prefix === '' ? String(index) : `${prefix}.${index}`;
    if (node.id !== 'layout') {
      node.id = `n${path}`;
    }
    if (Array.isArray(node.children)) {
      assignPathIds(node.children, path, depth + 1);
    }
  }
}

// ---------------------------------------------------------------------------
// Attribute (prop) parsing
// ---------------------------------------------------------------------------

// Attribute values stay opaque JavaScript; only their balanced source ranges
// are read. Nested objects, strings and templates must never become fake props.
export function parseAttrs(attrString: string): Record<string, Attr> {
  return propsOf(scanAttrs(attrString));
}

function propsOf(scanned: readonly ScannedAttr[]): Record<string, Attr> {
  // Object.fromEntries treats __proto__ as an ordinary attribute. Assigning
  // it on an object invokes the inherited setter and silently drops it.
  return Object.fromEntries(scanned.map((found) => [found.name, found.attr]));
}

// One attribute as written: its props entry plus where each part sits in the
// attribute string. The positions are relative to that string; attrSpansOf
// moves them into file offsets.
interface ScannedAttr {
  readonly name: string;
  readonly attr: Attr;
  readonly from: number;
  readonly to: number;
  readonly nameAt: readonly [number, number] | undefined;
  readonly valueAt: readonly [number, number] | undefined;
}

const ATTR_NAME = /[\w@:.-]+/y;

function scanAttrs(source: string): readonly ScannedAttr[] {
  const found: ScannedAttr[] = [];
  // Each pass consumes a full attribute or one character, bounded by source length.
  for (let position = 0; position < source.length;) {
    const attribute = scanAttr(source, position);
    if (attribute) {
      assert(attribute.to > position, 'An attribute scan advances');
      assert(attribute.to <= source.length, 'An attribute stays inside its source');
      found.push(attribute);
      position = attribute.to;
    } else {
      position++;
    }
  }
  return found;
}

function scanAttr(source: string, from: number): ScannedAttr | undefined {
  if (source.charAt(from) === '{') {
    return scanSpreadAttr(source, from);
  }
  ATTR_NAME.lastIndex = from;
  const match = ATTR_NAME.exec(source);
  if (!match) {
    return undefined;
  }
  const name = match[0];
  const end = from + name.length;
  const nameAt: readonly [number, number] = [from, end];
  const equalsAt = scanAttrSpace(source, end);
  if (source.charAt(equalsAt) !== '=') {
    return { name, attr: { type: 'bare' }, from, to: end, nameAt, valueAt: undefined };
  }
  const valueStart = scanAttrSpace(source, equalsAt + 1);
  const quote = source.charAt(valueStart);
  if (quote === '"' || quote === "'") {
    const close = source.indexOf(quote, valueStart + 1);
    if (close === -1) {
      return undefined;
    }
    return {
      name,
      attr: { type: 'string', value: source.slice(valueStart + 1, close) },
      from,
      to: close + 1,
      nameAt,
      valueAt: [valueStart + 1, close],
    };
  }
  if (quote !== '{') {
    return undefined;
  }
  const close = findMatchingBrace(source, valueStart);
  if (close === -1) {
    return undefined;
  }
  const valueAt = scanAttrTrim(source, valueStart + 1, close);
  return {
    name,
    attr: { type: 'expr', value: source.slice(...valueAt) },
    from,
    to: close + 1,
    nameAt,
    valueAt,
  };
}

function scanSpreadAttr(source: string, from: number): ScannedAttr | undefined {
  const close = findMatchingBrace(source, from);
  if (close === -1) {
    return undefined;
  }
  const bodyAt = scanAttrSpace(source, from + 1);
  if (!source.startsWith('...', bodyAt)) {
    return undefined;
  }
  const valueAt = scanAttrTrim(source, bodyAt + 3, close);
  const value = source.slice(...valueAt);
  // Key spreads by their source so distinct spreads retain their authored order.
  return {
    name: `...${value}`,
    attr: { type: 'spread', value },
    from,
    to: close + 1,
    nameAt: undefined,
    valueAt,
  };
}

function scanAttrSpace(source: string, from: number): number {
  let position = from;
  while (position < source.length && /\s/.test(source.charAt(position))) {
    position++;
  }
  return position;
}

function scanAttrTrim(source: string, from: number, to: number): readonly [number, number] {
  const raw = source.slice(from, to);
  const start = from + raw.length - raw.trimStart().length;
  return [start, start + raw.trim().length];
}

// File offsets for every attribute of a tag whose attribute string starts at
// `base`. Built from the same scan as the props, so the two cannot disagree.
function attrSpansOf(scanned: readonly ScannedAttr[], base: number): AttrSpan[] {
  const at = ([start, end]: readonly [number, number]) => toUtf16Span(base + start, base + end);
  return scanned.map((found): AttrSpan => {
    const span = toUtf16Span(base + found.from, base + found.to);
    const { name, attr } = found;
    switch (attr.type) {
      case 'string':
      case 'expr':
        return {
          type: attr.type,
          name,
          span,
          nameSpan: at(required(found.nameAt, 'Named attribute has a name')),
          valueSpan: at(required(found.valueAt, 'Valued attribute has a value')),
        };
      case 'bare':
        return { type: 'bare', name, span, nameSpan: at(required(found.nameAt, 'Bare name')) };
      case 'spread':
        return {
          type: 'spread',
          name,
          span,
          valueSpan: at(required(found.valueAt, 'Spread body')),
        };
    }
  });
}

// A tag whose attributes were written across several lines keeps them there,
// as long as none of them has been edited. Compared with the whitespace taken
// out, so the question asked is "do these say the same thing", not "were they
// laid out the same way". Editing one attribute reflows the tag onto a line,
// which is the same bargain struck everywhere else here.
export function attrsAsWritten(node: ParserNode): string | undefined {
  if (!node.attrSource) {
    return undefined;
  }
  const flat = (text: string) => text.replace(/\s+/g, ' ').trim();
  return flat(node.attrSource) === flat(serializeAttrs(node.props, node.attrOrder)) ? node.attrSource : undefined;
}

// A tag's attributes and the order the file wrote them in. An object remembers
// the order its keys were added, which is the file's order right up until a
// prop is taken out and put back — clearing a field and typing into it again is
// exactly that — and then it returns at the end, behind everything it used to
// sit in front of. One line reordered against the four like it underneath is a
// diff about nothing. So the order is written down when the file is read.
//
// `attrsAt` is where the attribute string starts in the file, or undefined when no
// offsets were asked for; with it, every attribute also reports its spans.
export function tagProps(attrs: string, attrsAt: number | undefined): { props: Record<string, Attr>; attrOrder?: string[]; attrSpans?: AttrSpan[] } {
  // One scan serves both the props and their spans: scanning twice doubled the
  // cost of every tag with attributes.
  const scanned = scanAttrs(attrs);
  const props = propsOf(scanned);
  const attrOrder = Object.keys(props);
  const spans = attrsAt === undefined ? {} : { attrSpans: attrSpansOf(scanned, attrsAt) };
  // The props are always present — even empty — because writers mutate node.props
  // in place (e.g. fragment tests and panel edits). attrOrder only exists
  // when there is something to order.
  return attrOrder.length ? { props, attrOrder, ...spans } : { props, ...spans };
}

// What the file had, where it had it, then anything added since.
function orderedProps(props: Readonly<Record<string, Attr>> | undefined, order?: readonly string[]): ReadonlyArray<readonly [string, Attr]> {
  const entries = Object.entries(props || {});
  if (!order || !order.length) {
    return entries;
  }
  const held = new Map(entries);
  const out: [string, Attr][] = [];
  for (const name of order) {
    if (held.has(name)) {
      out.push([name, required(held.get(name), 'Ordered attribute exists')]);
    }
  }
  const known = new Set(order);
  for (const [name, attr] of entries) {
    if (!known.has(name)) {
      out.push([name, attr]);
    }
  }
  return out;
}

export function serializeAttrs(props: Readonly<Record<string, Attr>> | undefined, order?: readonly string[]): string {
  const parts = [];
  for (const [name, attr] of orderedProps(props, order)) {
    if (attr?.type === 'spread') {
      parts.push(`{...${attr.value}}`);
    } else if (attr === undefined || attr.type === 'bare') {
      parts.push(name);
    } else if (attr.type === 'expr') {
      parts.push(`${name}={${attr.value}}`);
    } else {
      parts.push(`${name}="${String(attr.value).replace(/"/g, '&quot;')}"`);
    }
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

// Regex captures and bounded array accesses are producer invariants, not user
// errors. A violated assumption must identify the failing parser operation.
export function required<T>(value: T | undefined, message: string): T {
  assert(value !== undefined, message);
  return value;
}
