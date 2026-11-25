// Reading markup for the audit: an attribute's state as the source states it
// (absent, written, or decided at runtime), an element's accessible name as far
// as the source can tell, and an opening tag printed for a fix's preview.
//
// The source cannot always tell. An expression, a spread, a component or a
// <slot> may supply an attribute or a name only the render knows; those read as
// `dynamic` or `unknown`, and a static check never flags them. The rendered
// pass (auditRendered.ts) sees the final page and judges what is left.
import { assert } from '../core/assert';
import type { Attr, PageNode, PairedNode } from './pageNodeTypes';
import { textValue } from './htmlText';

/** An attribute as the source states it. */
export type AttrState = { readonly tag: 'absent' } | { readonly tag: 'dynamic' } | { readonly tag: 'value'; readonly value: string };

const ABSENT: AttrState = { tag: 'absent' };
const DYNAMIC: AttrState = { tag: 'dynamic' };

/** Nodes one accessible-name read visits before it answers `unknown`. */
const NAME_NODES_MAX = 2_000;

/** A node's attributes, whatever its kind; undefined for kinds that hold none. */
export function nodeProps(node: PageNode): Readonly<Record<string, Attr>> | undefined {
  if (node.kind === 'element' || node.kind === 'component' || node.kind === 'raw') {
    return node.props;
  }
  return undefined;
}

/** A node's children, whatever its kind; empty for leaves and self-closing tags. */
export function nodeChildren(node: PageNode): readonly PageNode[] {
  if ('children' in node && Array.isArray(node.children)) {
    const children: readonly PageNode[] = node.children;
    return children;
  }
  return [];
}

/** Whether the node writes `{...spread}`: any attribute may then come from it. */
export function hasSpread(props: Readonly<Record<string, Attr>> | undefined): boolean {
  return Object.values(props ?? {}).some((value) => value.type === 'spread');
}

/** The attribute named `name`, matched case-insensitively as HTML does. */
export function attrState(props: Readonly<Record<string, Attr>> | undefined, name: string): AttrState {
  assert(name.length > 0, 'attrState: an attribute has a name');
  assert(name === name.toLowerCase(), 'attrState: names are asked for in lower case');
  const entry = Object.entries(props ?? {}).find(([key]) => key.toLowerCase() === name);
  if (entry === undefined) {
    return hasSpread(props) ? DYNAMIC : ABSENT;
  }
  const value = entry[1];
  switch (value.type) {
    case 'string':
      return { tag: 'value', value: value.value };
    case 'bare':
      return { tag: 'value', value: '' };
    case 'expr':
    case 'spread':
      return DYNAMIC;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** The attribute's name as the file writes it, for an edit that replaces it in place. */
export function writtenName(props: Readonly<Record<string, Attr>> | undefined, name: string): string {
  const entry = Object.keys(props ?? {}).find((key) => key.toLowerCase() === name);
  return entry ?? name;
}

/** Whether a stated value is present and not blank. */
export function filled(state: AttrState): boolean {
  if (state.tag === 'value') {
    return state.value.trim().length > 0;
  }
  return state.tag === 'dynamic';
}

/** The class tokens a plain `class` attribute writes. */
export function classTokens(props: Readonly<Record<string, Attr>> | undefined): readonly string[] {
  const state = attrState(props, 'class');
  return state.tag === 'value' ? state.value.split(/\s+/).filter((token) => token.length > 0) : [];
}

/** What the source says an element's content names it. */
export type NameRead =
  /** Text, a labelled image or a labelled icon. */
  | { readonly tag: 'named'; readonly text: string }
  /** Nothing that names it. `icon` when an unlabelled svg is all there is. */
  | { readonly tag: 'unnamed'; readonly icon: boolean }
  /** An expression, component or slot: only the render knows. */
  | { readonly tag: 'unknown' };

/** An element's accessible name from its own label attributes and its content. */
export function accessibleName(element: PageNode): NameRead {
  assert(element.kind === 'element' || element.kind === 'component', 'accessibleName: asked of a tag');
  const props = nodeProps(element);
  for (const name of ['aria-label', 'aria-labelledby', 'title']) {
    const state = attrState(props, name);
    if (state.tag === 'dynamic') {
      return { tag: 'unknown' };
    }
    if (state.tag === 'value' && state.value.trim().length > 0) {
      return { tag: 'named', text: state.value.trim() };
    }
  }
  return contentName(nodeChildren(element));
}

/** The name an element's descendants give it, read in document order. */
function contentName(children: readonly PageNode[]): NameRead {
  const words: string[] = [];
  let icon = false;
  const pending = [...children].reverse();
  for (let visited = 0; pending.length > 0; visited++) {
    if (visited >= NAME_NODES_MAX) {
      return { tag: 'unknown' };
    }
    const node = pending.pop();
    assert(node !== undefined, 'contentName: the stack holds a node');
    const read = ownName(node);
    if (read.tag === 'unknown') {
      return read;
    }
    if (read.tag === 'named') {
      words.push(read.text);
    } else if (read.tag === 'icon') {
      icon = true;
    } else if (read.tag === 'descend') {
      pending.push(...[...nodeChildren(node)].reverse());
    }
  }
  const text = words.join(' ').replace(/\s+/g, ' ').trim();
  if (text.length > 0) {
    return { tag: 'named', text };
  }
  return { tag: 'unnamed', icon };
}

type OwnName =
  | { readonly tag: 'named'; readonly text: string }
  | { readonly tag: 'unknown' }
  | { readonly tag: 'icon' }
  | { readonly tag: 'descend' }
  | { readonly tag: 'none' };

// What one node contributes to its ancestor's name, without looking below it
// unless it says to descend.
function ownName(node: PageNode): OwnName {
  switch (node.kind) {
    case 'text':
      return { tag: 'named', text: textValue(node.value) };
    case 'expr':
    case 'component':
    case 'map':
    case 'cond':
    case 'chunk-group':
      return { tag: 'unknown' };
    case 'branch':
      return { tag: 'descend' };
    case 'comment':
    case 'raw':
    case 'raw-line':
      return { tag: 'none' };
    case 'element':
      return elementName(node);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function elementName(node: PairedNode): OwnName {
  const name = node.name.toLowerCase();
  if (name === 'slot') {
    return { tag: 'unknown' };
  }
  const props = node.props;
  const hidden = attrState(props, 'aria-hidden');
  if (hidden.tag === 'value' && hidden.value === 'true') {
    return { tag: 'none' };
  }
  const label = attrState(props, 'aria-label');
  if (label.tag === 'dynamic') {
    return { tag: 'unknown' };
  }
  if (label.tag === 'value' && label.value.trim().length > 0) {
    return { tag: 'named', text: label.value.trim() };
  }
  if (name === 'img') {
    const alt = attrState(props, 'alt');
    if (alt.tag === 'dynamic') {
      return { tag: 'unknown' };
    }
    return alt.tag === 'value' && alt.value.trim().length > 0 ? { tag: 'named', text: alt.value.trim() } : { tag: 'none' };
  }
  if (name === 'svg') {
    return svgName(node);
  }
  return { tag: 'descend' };
}

// An svg names its parent through a <title> child; otherwise it is an icon.
function svgName(node: PairedNode): OwnName {
  const title = nodeChildren(node).find((child) => child.kind === 'element' && child.name.toLowerCase() === 'title');
  if (title === undefined) {
    return { tag: 'icon' };
  }
  const read = contentName(nodeChildren(title));
  if (read.tag === 'named') {
    return read;
  }
  return read.tag === 'unknown' ? read : { tag: 'icon' };
}

/** An opening tag as a fix's preview prints it, attributes in their order. */
export function openingTag(name: string, props: Readonly<Record<string, Attr>> | undefined, options: { readonly selfClosing?: boolean } = {}): string {
  assert(name.length > 0, 'openingTag: a tag has a name');
  const attributes = Object.entries(props ?? {}).map(([key, value]) => printedAttribute(key, value));
  assert(attributes.length === Object.keys(props ?? {}).length, 'openingTag: one printed attribute per prop');
  const inner = [name, ...attributes].join(' ');
  return options.selfClosing === true ? `<${inner} />` : `<${inner}>`;
}

function printedAttribute(name: string, value: Attr): string {
  switch (value.type) {
    case 'string':
      return `${name}="${value.value}"`;
    case 'expr':
      return `${name}={${value.value}}`;
    case 'bare':
      return name;
    case 'spread':
      return `{...${value.value}}`;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** Props with `patch` applied the way the edit will: a set value keeps its slot, a new one goes last, undefined removes. */
export function patchedAttributes(
  props: Readonly<Record<string, Attr>> | undefined,
  patch: Readonly<Record<string, Attr | undefined>>,
): Readonly<Record<string, Attr>> {
  const next: Record<string, Attr> = {};
  for (const [key, value] of Object.entries(props ?? {})) {
    if (!Object.hasOwn(patch, key)) {
      next[key] = value;
    } else {
      const patched = patch[key];
      if (patched !== undefined) {
        next[key] = patched;
      }
    }
  }
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined && !Object.hasOwn(next, key)) {
      next[key] = value;
    }
  }
  assert(Object.keys(next).length <= Object.keys(props ?? {}).length + Object.keys(patch).length, 'patchedAttributes: no attribute appears from nowhere');
  return next;
}

/** 1-based line of each UTF-16 offset, from the line starts of `source`. */
export function lineStarts(source: string): readonly number[] {
  const starts = [0];
  for (let index = source.indexOf('\n'); index !== -1; index = source.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  assert(starts.length >= 1, 'lineStarts: a text has a first line');
  return starts;
}

/** The 1-based line holding `offset`. */
export function lineOf(starts: readonly number[], offset: number): number {
  assert(Number.isSafeInteger(offset), 'lineOf: an offset is an integer');
  assert(starts.length > 0, 'lineOf: the starts hold the first line');
  let low = 0;
  let high = starts.length - 1;
  // Binary search: each pass halves the range, so it ends within log2(lines) passes.
  for (let step = 0; low < high && step < 64; step++) {
    const middle = Math.ceil((low + high) / 2);
    if ((starts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return low + 1;
}
