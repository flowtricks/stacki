// What the rich text editor may open: a component's slot content, read as the bytes the file holds there. The editor
// shows HTML and writes HTML, so it opens only content it can give back unchanged in meaning: native rich text
// elements with plain attributes, nothing Astro reads as code. Anything else is shown as code instead (a component an
// agent wrote, an expression, a comment, a directive), so opening the editor can never drop or rewrite it.
//
// The decision is pure and runs on every render of the Content field; writes go through the panel's one writer
// (onSetInline for the editor's HTML, onSetContentSource for the code), so canvas edits, undo and redo reach both views
// as the model the page holds.
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';
import type { Attr } from '../../../shared/page/pageNode';
import { editableHTML } from '../../ui/htmlFieldModel';
import type { InlineNode } from './richContentModel';

/** Why content opens as code: each has its own tooltip on the `{}` toggle. */
export const RICH_TEXT_CODE_REASONS = ['expression', 'component', 'markup', 'size'] as const;
export type RichTextCodeReason = (typeof RICH_TEXT_CODE_REASONS)[number];

export type RichTextView = { readonly view: 'rich'; readonly html: string } | { readonly view: 'code'; readonly reason: RichTextCodeReason };

/** Content longer than this opens as code: the editor reads it into the DOM whole on every open. */
export const RICH_TEXT_SOURCE_CHARS_MAX = 200_000;

/**
 * Which view the content opens in. `source` is the slot content exactly as written (the node's inner source), or
 * undefined for an instance with nothing between its tags.
 */
export function richTextView(source: string | undefined, document: Document): RichTextView {
  const text = source ?? '';
  if (text.length > RICH_TEXT_SOURCE_CHARS_MAX) {
    return { view: 'code', reason: 'size' };
  }
  // Braces are an expression in Astro markup, even inside an attribute; the editor would write them as text.
  if (/[{}]/.test(text)) {
    return { view: 'code', reason: 'expression' };
  }
  // A capitalized tag, or a dotted one (`<Icons.Star>`), is a component.
  if (/<\/?(?:[A-Z]|[a-z][\w-]*\.)/.test(text)) {
    return { view: 'code', reason: 'component' };
  }
  // Comments, directives (`set:html`, `class:list`, `is:raw`), fragments and the Astro-only tags are markup the
  // editor cannot show; the browser would also drop a comment it parses.
  if (/<!--|<!|<\s*>|<(?:slot|script|style|template|fragment)\b|\s[a-z]+:[\w-]+\s*=?/i.test(text)) {
    return { view: 'code', reason: 'markup' };
  }
  const projection = editableHTML(text, document, { media: true });
  if (projection.restricted) {
    return { view: 'code', reason: 'markup' };
  }
  assert(projection.html.length <= text.length * 2 + 64, 'The editor projection is bounded by its source');
  return { view: 'rich', html: text };
}

/** Tags that never hold children, written self-closing: the page model says so with `children: undefined`. */
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'source']);

/**
 * The editor's HTML as the nodes the panel writes for the instance's content. The editor emits only the tags and
 * attributes `editableHTML` keeps, so every element and attribute here is one the rich text view accepted.
 */
export function richTextNodes(html: string, document: Document): InlineNode[] {
  assert(html.length <= LIMITS.ipcFieldCharsMax, 'Rich text content fits one field');
  const template = document.createElement('template');
  template.innerHTML = html;
  let count = 0;
  const read = (parent: Node, depth: number): InlineNode[] => {
    assert(depth <= LIMITS.treeDepthMax, 'Rich text depth is bounded');
    const out: InlineNode[] = [];
    for (const child of Array.from(parent.childNodes)) {
      count += 1;
      assert(count <= LIMITS.treeNodesMax, 'Rich text node count is bounded');
      if (child.nodeType === 3) {
        const value = child.textContent ?? '';
        if (value !== '') {
          out.push({ kind: 'text', value });
        }
        continue;
      }
      // A template's content lives in an inert document with no window, so the element type is the page's own.
      const ElementType = document.defaultView?.Element;
      if (ElementType === undefined || !(child instanceof ElementType)) {
        continue;
      }
      const element = child;
      const props = Object.fromEntries(
        Array.from(element.attributes).map((attribute): [string, Attr] => [
          attribute.name,
          attribute.value === '' ? { type: 'bare' } : { type: 'string', value: attribute.value },
        ]),
      );
      const name = element.localName;
      out.push({ kind: 'element', name, props, children: VOID_TAGS.has(name) ? undefined : read(element, depth + 1) });
    }
    return out;
  };
  const nodes = read(template.content, 0);
  assert(count <= LIMITS.treeNodesMax, 'Rich text conversion stays inside the tree bound');
  return nodes;
}

/**
 * An element's text with the bytes between its tags replaced: undefined when those bytes are not the content the
 * model read (the file moved on), so a stale view never writes over someone else's change. A self-closing tag opens
 * to hold the new content.
 */
export function withInnerSource(element: string, current: { readonly name: string; readonly inner: string }, next: string): string | undefined {
  assert(current.name.length > 0, 'A tag with content has a name');
  if (/\/>\s*$/.test(element)) {
    if (current.inner !== '') {
      return undefined;
    }
    return next === '' ? element : `${element.replace(/\s*\/>\s*$/, '')}>${next}</${current.name}>`;
  }
  const close = element.lastIndexOf('</');
  const start = close - current.inner.length;
  if (close < 0 || start < 0 || element.slice(start, close) !== current.inner || element.charAt(start - 1) !== '>') {
    return undefined;
  }
  const result = element.slice(0, start) + next + element.slice(close);
  assert(result.length === element.length - current.inner.length + next.length, 'Only the content changed');
  return result;
}

/** Whether two HTML texts hold the same rich content, whatever whitespace lies between their blocks. */
export function sameRichContent(left: string, right: string, document: Document): boolean {
  return JSON.stringify(richShape(richTextNodes(left, document), 0)) === JSON.stringify(richShape(richTextNodes(right, document), 0));
}

// The content with whitespace runs folded and text that is only whitespace left out: what a reader sees.
function richShape(nodes: readonly InlineNode[], depth: number): readonly unknown[] {
  assert(depth <= LIMITS.treeDepthMax, 'Rich text nesting is bounded');
  return nodes.flatMap((node): readonly unknown[] => {
    if (node.kind === 'text') {
      const value = node.value.replace(/\s+/g, ' ').trim();
      return value === '' ? [] : [value];
    }
    if (node.kind === 'expr') {
      return [node.value];
    }
    return [{ name: node.name, props: node.props, children: node.children === undefined ? undefined : richShape(node.children, depth + 1) }];
  });
}
