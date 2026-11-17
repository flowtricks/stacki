// Which pseudo-elements a page node can have. A pseudo-element is a box CSS
// generates for one real element, so only a node that IS one HTML element can
// own it: a loop, an if, a Fragment, a slot, text and expressions put no element
// of their own on the page, and a component instance's root is whatever its file
// renders, which Stacki does not know from the page. The canvas, asked about such
// a node's path, measures the first element between its markers (a loop's first
// `<li>`), and read that element's ::before as the loop's: the bug this table
// closes. Replaced and void elements (`img`, `input`, `br`, `video`) draw no
// ::before or ::after even though the browser still computes `content` for them.
//
// The table answers per tag, as the tag renders by default. Where CSS display
// can change the answer (`div { display: list-item }` gets a ::marker), the
// answer is `display-dependent`: only the page's computed style can settle it.

import { assert } from '../core/assert';
import type { Brand } from '../core/brand';
import { err, ok, type AppError, type Result } from '../core/result';
import { HTML_VOID_TAGS } from './htmlTags';
import type { PseudoLayer } from './pseudoPath';

export const PSEUDO_ELEMENTS = ['before', 'after', 'marker', 'placeholder', 'first-line', 'first-letter'] as const;
export type PseudoElementName = (typeof PSEUDO_ELEMENTS)[number];

/** Whether a node can own a pseudo-element: always, never, or as its computed display decides. */
export type PseudoValidity = 'valid' | 'invalid' | 'display-dependent';

/** What the table reads of a node: its kind and, for a tag, its name. */
export interface PseudoHostNode {
  readonly kind: string;
  readonly name?: string | undefined;
  readonly dynamicTag?: boolean | undefined;
}

/** A ::before or ::after of one HTML element, built only by parsePseudoLayerTarget. */
export type PseudoLayerTarget = Brand<{ readonly nodeId: string; readonly pseudo: PseudoLayer }, 'PseudoLayerTarget'>;

// Elements that generate no ::before or ::after box: void, replaced, or never
// rendered. Their contents (if any) are not laid out as a CSS box of their own.
const NO_GENERATED_CONTENT_TAGS: ReadonlySet<string> = new Set([
  ...HTML_VOID_TAGS,
  'audio',
  'canvas',
  'head',
  'iframe',
  'math',
  'meter',
  'noscript',
  'object',
  'progress',
  'script',
  'select',
  'slot',
  'style',
  'svg',
  'template',
  'textarea',
  'title',
  'video',
]);

// SVG's own elements: lowercase like HTML, but they draw no CSS boxes, so no pseudo-element.
const SVG_TAGS: ReadonlySet<string> = new Set([
  'circle',
  'clippath',
  'defs',
  'desc',
  'ellipse',
  'filter',
  'foreignobject',
  'g',
  'image',
  'line',
  'mask',
  'path',
  'pattern',
  'polygon',
  'polyline',
  'rect',
  'stop',
  'symbol',
  'text',
  'tspan',
  'use',
  'view',
]);

// Elements whose default display is list-item: they draw a ::marker as written.
const LIST_ITEM_TAGS: ReadonlySet<string> = new Set(['li', 'summary']);

// Elements that take a ::placeholder: text fields.
const PLACEHOLDER_TAGS: ReadonlySet<string> = new Set(['input', 'textarea']);

// Elements whose default display makes them block containers: ::first-line and
// ::first-letter apply as written.
const BLOCK_CONTAINER_TAGS: ReadonlySet<string> = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'body',
  'caption',
  'dd',
  'details',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'legend',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'summary',
  'td',
  'th',
  'ul',
]);

// An HTML tag name as written in markup: lowercase, or a custom element (`my-card`).
const HTML_TAG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9-]+)?$/;

/** How `pseudo` applies to `node` (see the file comment). */
export function pseudoElementValidity(node: PseudoHostNode, pseudo: PseudoElementName): PseudoValidity {
  assert(PSEUDO_ELEMENTS.includes(pseudo), 'pseudoElementValidity: a known pseudo-element');
  const tag = htmlTagOf(node);
  if (tag === undefined) {
    return 'invalid';
  }
  const validity = pseudoValidityForTag(tag, pseudo);
  assert(validity === 'invalid' || !SVG_TAGS.has(tag), 'pseudoElementValidity: an SVG element owns no pseudo-element');
  return validity;
}

/** How `pseudo` applies to an element rendered as `tag` (lowercase HTML). */
export function pseudoValidityForTag(tag: string, pseudo: PseudoElementName): PseudoValidity {
  assert(tag.length > 0, 'pseudoValidityForTag: a tag has a name');
  if (SVG_TAGS.has(tag)) {
    return 'invalid';
  }
  switch (pseudo) {
    case 'before':
    case 'after':
      return NO_GENERATED_CONTENT_TAGS.has(tag) ? 'invalid' : 'valid';
    case 'marker':
      if (LIST_ITEM_TAGS.has(tag)) {
        return 'valid';
      }
      return NO_GENERATED_CONTENT_TAGS.has(tag) ? 'invalid' : 'display-dependent';
    case 'placeholder':
      return PLACEHOLDER_TAGS.has(tag) ? 'valid' : 'invalid';
    case 'first-line':
    case 'first-letter':
      if (BLOCK_CONTAINER_TAGS.has(tag)) {
        return 'valid';
      }
      return NO_GENERATED_CONTENT_TAGS.has(tag) ? 'invalid' : 'display-dependent';
    default: {
      const exhaustive: never = pseudo;
      return exhaustive;
    }
  }
}

/** Whether the navigator may list `pseudo` as a layer of `node`: only where it always applies. */
export function pseudoLayerAllowed(node: PseudoHostNode | undefined, pseudo: PseudoLayer): boolean {
  if (node === undefined) {
    return false;
  }
  return pseudoElementValidity(node, pseudo) === 'valid';
}

/**
 * The ::before or ::after of `node`, or an error saying why the node has none.
 * The one way to build a PseudoLayerTarget, so a pick on a loop, a component
 * instance or an `img` cannot be represented past this point.
 */
export function parsePseudoLayerTarget(node: (PseudoHostNode & { readonly id: string }) | undefined, pseudo: PseudoLayer): Result<PseudoLayerTarget, AppError> {
  if (node === undefined) {
    return err({ code: 'pseudo-host-missing', message: `::${pseudo}: the node is not in the page` });
  }
  assert(node.id.length > 0, 'parsePseudoLayerTarget: a node has an id');
  if (pseudoLayerAllowed(node, pseudo)) {
    const target = { nodeId: node.id, pseudo } as PseudoLayerTarget;
    assert(target.nodeId === node.id, 'parsePseudoLayerTarget: the target names its node');
    return ok(target);
  }
  return err({ code: 'pseudo-host-invalid', message: `::${pseudo} belongs to an HTML element, not ${describeHost(node)}` });
}

/** Asserts that `node` may own the ::before or ::after layer `pseudo` (the consumer's half of the pair). */
export function assertPseudoLayerHost(node: PseudoHostNode, pseudo: PseudoLayer, where: string): void {
  assert(where.length > 0, 'assertPseudoLayerHost: the caller names itself');
  assert(pseudoLayerAllowed(node, pseudo), `${where}: ::${pseudo} belongs to an HTML element, not ${describeHost(node)}`);
}

// The lowercase HTML tag a node renders as itself, or undefined when it renders no single known element.
function htmlTagOf(node: PseudoHostNode): string | undefined {
  if (node.kind !== 'element') {
    return undefined;
  }
  if (node.dynamicTag === true) {
    return undefined; // `<Tag>`: which element it renders is decided at run time.
  }
  const name = node.name ?? '';
  return HTML_TAG_RE.test(name) ? name : undefined;
}

// How an error names the node a pseudo-element was refused on.
function describeHost(node: PseudoHostNode): string {
  if (node.kind === 'element' || node.kind === 'component') {
    return `${node.kind} <${node.name ?? ''}>`;
  }
  return `a ${node.kind} node`;
}
