// The root element of an Astro component's template, read from the file's text.
//
// A component instance selected on a page renders the component's root element:
// `<ContentWrapper>` on the home page draws `ContentWrapper.astro`'s
// `<div class:list={["layout", "theme-dark", className]}>`. The page's model holds
// only the instance tag, so what the component writes on that root is read here,
// from the source text the panel already loaded for the component's styles
// (EmbedDocument.code). Only a plain element root is read: a root that is another
// component, a slot, a fragment, an expression or text has no markup of its own to
// read, and the honest answer is none.

import { assert } from '../../../../shared/core/assert';
import type { HostNode } from './host';

/**
 * At most this many characters of a component file are scanned for its root tag.
 * The root sits after the frontmatter and any leading `<style>` or `<script>`;
 * past this the file is not a component worth reading for one tag.
 */
export const TEMPLATE_ROOT_SCAN_CHARS_MAX = 1_000_000;

/** At most this many comments, style and script blocks are skipped before the root. */
const LEADING_BLOCKS_MAX = 64;

/** At most this many attributes are read from the root tag. */
const ROOT_ATTRIBUTES_MAX = 256;

/**
 * The template's root element as a node the panel reads (`kind: 'element'`, its
 * attributes as string or `expr` props), or undefined when the template has no
 * plain element root this can read.
 */
export function templateRootNode(code: string): HostNode | undefined {
  const text = code.length <= TEMPLATE_ROOT_SCAN_CHARS_MAX ? code : code.slice(0, TEMPLATE_ROOT_SCAN_CHARS_MAX);
  let index = afterFrontmatter(text);
  for (let skipped = 0; skipped < LEADING_BLOCKS_MAX; skipped += 1) {
    index = afterWhitespace(text, index);
    const next = afterLeadingBlock(text, index);
    if (next === undefined) {
      return undefined;
    }
    if (next === index) {
      return rootTag(text, index);
    }
    assert(next > index, 'templateRootNode: a skipped block moves forward');
    index = next;
  }
  return undefined;
}

function afterFrontmatter(text: string): number {
  const start = afterWhitespace(text, 0);
  if (!text.startsWith('---', start)) {
    return 0;
  }
  const end = text.indexOf('\n---', start + 3);
  return end === -1 ? text.length : end + '\n---'.length;
}

function afterWhitespace(text: string, index: number): number {
  let at = index;
  while (at < text.length && /\s/.test(text.charAt(at))) {
    at += 1;
  }
  return at;
}

/**
 * Past one comment, `<style>` or `<script>` block at `index`; `index` itself when
 * something else starts there; undefined when a block never closes.
 */
function afterLeadingBlock(text: string, index: number): number | undefined {
  if (text.startsWith('<!--', index)) {
    const end = text.indexOf('-->', index + 4);
    return end === -1 ? undefined : end + 3;
  }
  for (const name of ['style', 'script']) {
    const opening = text.slice(index, index + name.length + 2).toLowerCase();
    if (opening === `<${name}>` || opening === `<${name} ` || opening === `<${name}\n`) {
      const end = text.toLowerCase().indexOf(`</${name}>`, index);
      return end === -1 ? undefined : end + name.length + 3;
    }
  }
  return index;
}

/** The plain element starting at `index`, or undefined for anything else. */
function rootTag(text: string, index: number): HostNode | undefined {
  const name = /^<([a-z][a-z0-9-]*)(?=[\s/>])/.exec(text.slice(index, index + 64))?.[1];
  if (name === undefined || name === 'slot') {
    return undefined;
  }
  const props: Record<string, { readonly type: string; readonly value?: string }> = {};
  let at = index + 1 + name.length;
  for (let read = 0; read < ROOT_ATTRIBUTES_MAX; read += 1) {
    at = afterWhitespace(text, at);
    if (at >= text.length) {
      return undefined;
    }
    if (text.startsWith('>', at) || text.startsWith('/>', at)) {
      assert(Object.keys(props).length <= ROOT_ATTRIBUTES_MAX, 'rootTag: the attributes are capped');
      return { id: 'template-root', kind: 'element', name, props };
    }
    if (text.charAt(at) === '{') {
      // A spread (`{...rest}`) may add anything, and names nothing this can read.
      const end = afterBraces(text, at);
      if (end === undefined) {
        return undefined;
      }
      at = end;
    } else {
      const attribute = /^[^\s=>/{"']+/.exec(text.slice(at, at + 256))?.[0];
      if (attribute === undefined) {
        return undefined;
      }
      at += attribute.length;
      const value = attributeValue(text, afterWhitespace(text, at));
      if (value === undefined) {
        props[attribute] = { type: 'string', value: '' };
      } else if (value.kind === 'broken') {
        return undefined;
      } else {
        props[attribute] = value.kind === 'string' ? { type: 'string', value: value.text } : { type: 'expr', value: value.text };
        at = value.end;
      }
    }
  }
  return undefined;
}

type AttributeValue =
  | { readonly kind: 'string'; readonly text: string; readonly end: number }
  | { readonly kind: 'expression'; readonly text: string; readonly end: number }
  | { readonly kind: 'broken' };

/** The value after `=` at `index`, or undefined when there is no `=` (a bare attribute). */
function attributeValue(text: string, index: number): AttributeValue | undefined {
  if (text.charAt(index) !== '=') {
    return undefined;
  }
  const start = afterWhitespace(text, index + 1);
  const quote = text.charAt(start);
  if (quote === '"' || quote === "'") {
    const end = text.indexOf(quote, start + 1);
    return end === -1 ? { kind: 'broken' } : { kind: 'string', text: text.slice(start + 1, end), end: end + 1 };
  }
  if (quote === '{') {
    const end = afterBraces(text, start);
    return end === undefined ? { kind: 'broken' } : { kind: 'expression', text: text.slice(start + 1, end - 1), end };
  }
  const bare = /^[^\s>]+/.exec(text.slice(start, start + 256))?.[0];
  return bare === undefined ? { kind: 'broken' } : { kind: 'string', text: bare, end: start + bare.length };
}

/** Past the `{…}` opening at `index`, skipping strings inside; undefined when it never closes. */
function afterBraces(text: string, index: number): number | undefined {
  assert(text.charAt(index) === '{', 'afterBraces: starts on a brace');
  let depth = 0;
  let quote = '';
  for (let at = index; at < text.length; at += 1) {
    const character = text.charAt(at);
    if (quote !== '') {
      if (character === '\\') {
        at += 1;
      } else if (character === quote) {
        quote = '';
      }
    } else if (character === '"' || character === "'" || character === '`') {
      quote = character;
    } else if (character === '{') {
      depth += 1;
    } else if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
  }
  return undefined;
}
