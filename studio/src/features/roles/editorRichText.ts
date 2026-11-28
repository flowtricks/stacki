// Words with inline formatting, for the editor content check (editorContent.ts).
// The canvas format bar adds bold, italics and links inside a text; it must not
// be a way to add a class, a style, a script or code. So a tag in the new text is
// either plain formatting, a link with a safe address, or a tag the text already
// had, written exactly as it was. Free of Node imports: the browser runs it too.
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { INLINE_TAGS } from '../../../vendor/stacki/src/features/props/richContentModel';
import { parsePage, type ParserNode } from '../source/source';
import { attributeSpans } from './editorImages';

const RICH_NODES_MAX = 10_000;
const FORMAT_TAGS: ReadonlySet<string> = new Set(['strong', 'em', 'b', 'i', 'u', 's', 'sup', 'sub', 'br', 'code', 'mark', 'small', 'span']);
const LINK_ATTRIBUTES: ReadonlySet<string> = new Set(['href', 'target', 'rel']);

export interface RichSide {
  readonly source: string;
  readonly node: ParserNode;
}

function inline(node: ParserNode): boolean {
  if (node.kind === 'text' || node.kind === 'comment') {
    return true;
  }
  if (node.kind === 'expr') {
    return /^\{[^{}<]*\}$/.test(node.value);
  }
  return node.kind === 'element' && INLINE_TAGS.has(node.name.toLowerCase());
}

// Every node under `node`, in document order, or undefined when one is not inline content.
function inlineNodes(node: ParserNode): readonly ParserNode[] | undefined {
  const found: ParserNode[] = [];
  const stack = [...(node.children ?? [])].reverse();
  while (stack.length > 0) {
    const next = stack.pop();
    assert(next !== undefined, 'A pending node exists');
    if (!inline(next) || found.length >= RICH_NODES_MAX) {
      return undefined;
    }
    found.push(next);
    stack.push(...[...(next.children ?? [])].reverse());
  }
  return found;
}

const hasWords = (node: ParserNode): boolean => (node.children ?? []).some((child) => child.kind === 'text' && child.value.trim() !== '');
const empty = (node: ParserNode): boolean => (node.children ?? []).length === 0;

/**
 * Whether both versions of an element are one text: inline content only, with words
 * of its own on one side (or empty on one side). A block that merely holds links or
 * badges is not a text: its elements are compared one by one.
 */
export function isTextBlock(before: ParserNode, after: ParserNode): boolean {
  if (inlineNodes(before) === undefined || inlineNodes(after) === undefined) {
    return false;
  }
  if (empty(before)) {
    return hasWords(after);
  }
  if (empty(after)) {
    return hasWords(before);
  }
  return hasWords(before) || hasWords(after);
}

// A link goes to a page, an anchor, a web address, mail or a phone: never to a script.
function safeHref(value: string): boolean {
  const scheme = /^[\s\u0000-\u001f]*([a-z][a-z0-9+.\-\t\r\n]*):/i.exec(value)?.[1]?.replace(/\s/g, '').toLowerCase();
  const safe = scheme === undefined || ['http', 'https', 'mailto', 'tel'].includes(scheme);
  // The browser decodes entities in an address, so one could spell a scheme this did not see (`javascript&colon;`).
  return safe && !/&(?!amp;)(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(value);
}

function signature(source: string, node: ParserNode): string | undefined {
  const attributes = attributeSpans(source, node);
  if (attributes === undefined) {
    return undefined;
  }
  return `${node.name ?? ''} ${[...attributes.values()].map((attribute) => attribute.text).join(' ')}`;
}

function plainTag(node: ParserNode): boolean {
  const name = node.name ?? '';
  const attributes = Object.entries(node.props ?? {});
  if (FORMAT_TAGS.has(name)) {
    return attributes.length === 0;
  }
  if (name !== 'a') {
    return false;
  }
  return attributes.every(([key, value]) => LINK_ATTRIBUTES.has(key) && value.type === 'string' && (key !== 'href' || safeHref(value.value)));
}

/** Whether the new text brings in anything but words and formatting. */
export function richTextRefusal(before: RichSide, after: RichSide): boolean {
  const was = inlineNodes(before.node);
  const now = inlineNodes(after.node);
  if (was === undefined || now === undefined) {
    return true;
  }
  const kept = new Set(was.filter((node) => node.kind === 'element').map((node) => signature(before.source, node)));
  const unsafeTag = now.some((node) => {
    if (node.kind !== 'element' || plainTag(node)) {
      return false;
    }
    const written = signature(after.source, node);
    return written === undefined || !kept.has(written);
  });
  // Code stays exactly as it was, and no new comment hides anything.
  const code = (nodes: readonly ParserNode[]): string => JSON.stringify(nodes.flatMap((node) => (node.kind === 'expr' ? [node.value] : [])));
  const comments = new Set(was.flatMap((node) => (node.kind === 'comment' ? [node.value] : [])));
  const newComment = now.some((node) => node.kind === 'comment' && !comments.has(node.value));
  return unsafeTag || newComment || code(was) !== code(now);
}

// A prop's HTML read as an element's content, so the same rule covers it.
function wrapped(html: string): RichSide | undefined {
  const source = `<p>${html}</p>`;
  const parsed = parsePage(source, { locs: true });
  if (!parsed.editable) {
    return undefined;
  }
  const [node, extra] = parsed.model.nodes;
  return node === undefined || extra !== undefined ? undefined : { source, node };
}

// A prop's value as the page renders it: the escaping a quoted attribute is written with, undone once.
const rendered = (written: string): string => written.replaceAll('&quot;', '"').replaceAll('&amp;', '&');

/** Whether HTML a component renders from a prop (`set:html`) changes only its words and formatting. Both are as written in the source. */
export function safeInlineHTML(before: string, after: string): boolean {
  // Any other entity in the source would turn into markup this never read (`&lt;img`).
  if (/&(?!(?:amp|quot|nbsp);)(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/i.test(after)) {
    return false;
  }
  const html = rendered(after);
  // Braces are not code in rendered HTML, but they would be to the parser reading it here.
  if (/[{}]/.test(html) || /<\s*\/?\s*(?:script|style|iframe|object|embed)/i.test(html)) {
    return false;
  }
  const left = wrapped(rendered(before).replace(/[{}]/g, ''));
  const right = wrapped(html);
  if (left === undefined || right === undefined || right.node.end !== right.source.length) {
    return false;
  }
  return !richTextRefusal(left, right);
}
