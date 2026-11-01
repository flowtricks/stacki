// Inline serialization preserves expression spelling and harmless markup while
// bounding source/DOM traversal. DOM reads produce fresh nodes without source IDs.
import { BIND_PATH_RE } from '../../editor/bindings';
import type { Attr } from '../../../shared/page/pageNode';
import { assert } from '../../../shared/core/assert';
import { textValueCanonical } from '../../../shared/page/htmlText';
import { LIMITS } from '../../../shared/core/limits';

export interface InlineCandidate {
  readonly kind: string;
  readonly name?: string;
  readonly value?: string;
  readonly props?: Readonly<Record<string, { readonly type: string; readonly value?: string } | undefined>>;
  readonly children?: readonly InlineCandidate[] | undefined;
}
export interface InlineExpression {
  readonly kind: 'expr';
  readonly value: string;
  readonly preview?: string;
}
export type InlineNode =
  | { readonly kind: 'text'; readonly value: string }
  | InlineExpression
  | {
      readonly kind: 'element';
      readonly name: string;
      readonly props?: Readonly<Record<string, Attr | undefined>>;
      readonly children: readonly InlineNode[] | undefined;
    };

export const INLINE_TAGS: ReadonlySet<string> = new Set(['strong', 'em', 'b', 'i', 'sup', 'sub', 'code', 'a', 'span', 'br', 'small', 'mark', 'u', 's']);

// A simple interpolation like {index + 1}: single braces, no JSX inside —
// editable as literal text (Astro re-parses braces as an expression anyway).
export const isSimpleExpr = (node: InlineCandidate): node is InlineExpression =>
  node.kind === 'expr' && typeof node.value === 'string' && /^\{[^{}]*\}$/.test(node.value) && !node.value.includes('<');

export function isInlineOnly<T extends InlineCandidate>(children: readonly T[] | undefined): children is readonly (T & InlineNode)[] {
  if (!children?.length) {
    return false;
  }
  const pending: { readonly node: InlineCandidate; readonly depth: number }[] = children.map((node) => ({ node, depth: 0 }));
  for (let index = 0; index < pending.length; index++) {
    assert(pending.length <= LIMITS.treeNodesMax, 'RichContent: node limit exceeded');
    const next = pending[index];
    assert(next !== undefined, 'RichContent: queued node exists');
    assert(next.depth <= LIMITS.treeDepthMax, 'RichContent: depth limit exceeded');
    const node = next.node;
    if ((node.kind === 'text' && typeof node.value === 'string') || isSimpleExpr(node)) {
      continue;
    }
    if (node.kind !== 'element' || !INLINE_TAGS.has(String(node.name).toLowerCase())) {
      return false;
    }
    if (
      !Object.values(node.props || {}).every(
        (value) => value === undefined || value.type === 'bare' || (value.type === 'string' && typeof value.value === 'string'),
      )
    ) {
      return false;
    }
    // A void element (`<br>`) carries `children: undefined`; a node with no
    // `children` key at all is malformed (shared/page/pageNode.ts: PairedNode).
    if (!('children' in node)) {
      return false;
    }
    assert(pending.length + (node.children?.length ?? 0) <= LIMITS.treeNodesMax, 'RichContent: node limit exceeded');
    for (const child of node.children ?? []) {
      pending.push({ node: child, depth: next.depth + 1 });
    }
  }
  return true;
}

const esc = (text: string | undefined) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Which expressions become chips: a PLAIN PATH does — `{post.data.title}` is
// one thing, and the way to change it is to choose another, not to retype it
// character by character. A computed expression stays literal, editable text,
// because a chip is atomic and turning `{index + 1}` into one would take away
// the only way to fix the "+ 1". The same rule the prop fields use, so a
// binding looks the same wherever it appears.
export function isChippable(inner: string | undefined) {
  const text = String(inner || '').trim();
  // `{true}`, `{0}`, `{" "}` — expressions, but nothing is bound in them, and
  // a chip would take away the only way to change what they say.
  if (/^(true|false|null|undefined)$/.test(text) || /^[-+]?(\d+\.?\d*|\.\d+)$/.test(text)) {
    return false;
  }
  return BIND_PATH_RE.test(text);
}

export function nodesToHtml(nodes: readonly InlineNode[] | undefined, chippable: (text: string) => boolean = isChippable): string {
  return richSerialize(nodes ?? [], new Budget(LIMITS.treeNodesMax), 0, chippable);
}
// The node count one walk may still visit, shared by every level of that walk.
class Budget {
  private remaining: number;
  constructor(limit: number) {
    assert(Number.isSafeInteger(limit), 'RichContent: node budget is an integer');
    this.remaining = limit;
  }
  take(count: number, message: string): void {
    assert(count <= this.remaining, message);
    this.remaining -= count;
  }
}
function richSerialize(nodes: readonly InlineNode[], budget: Budget, depth: number, chippable: (text: string) => boolean): string {
  assert(depth <= LIMITS.treeDepthMax, 'RichContent: serialization depth limit exceeded');
  let out = '';
  for (const node of nodes) {
    budget.take(1, 'RichContent: serialization node limit exceeded');
    if (node.kind === 'text') {
      out += esc(node.value);
    } else if (node.kind === 'expr') {
      // An atomic chip: contentEditable=false makes the caret step over it
      // as one unit, so it can't be part-deleted into broken code, while
      // text either side stays editable. The braces live in data-expr; the
      // label reads better without them.
      const inner = node.value.replace(/^\{|\}$/g, '').trim();
      if (chippable(inner)) {
        out += `<span class="expr-chip" contenteditable="false" data-expr="${esc(node.value).replace(/"/g, '&quot;')}">${esc(node.preview ?? inner)}</span>`;
      } else {
        out += esc(node.value); // shown as literal {expr} text
      }
    } else {
      const attrs = Object.entries(node.props || {})
        .map(([key, value]) => (value === undefined || value.type === 'bare' ? ` ${key}` : ` ${key}="${esc(value.value).replace(/"/g, '&quot;')}"`))
        .join('');
      out +=
        node.children === undefined || node.children.length === 0
          ? node.name === 'br'
            ? '<br>'
            : `<${node.name}${attrs}></${node.name}>`
          : `<${node.name}${attrs}>` + richSerialize(node.children, budget, depth + 1, chippable) + `</${node.name}>`;
    }
    assert(out.length <= LIMITS.ipcFieldCharsMax, 'RichContent: HTML limit exceeded');
  }
  assert(out.length <= LIMITS.ipcFieldCharsMax, 'RichContent: HTML limit exceeded');
  return out;
}

export function domToNodes(element: HTMLElement): InlineNode[] {
  return richReadDOM(element, new Budget(LIMITS.treeNodesMax), 0);
}
function richReadDOM(element: Element, budget: Budget, depth: number): InlineNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'RichContent: DOM depth limit exceeded');
  const out: InlineNode[] = [];
  for (const node of element.childNodes) {
    budget.take(1, 'RichContent: DOM node limit exceeded');
    if (node.nodeType === 3) {
      if (node.textContent) {
        const textNodes = richReadText(node.textContent);
        budget.take(Math.max(0, textNodes.length - 1), 'RichContent: parsed node limit exceeded');
        out.push(...textNodes);
      }
    } else if (isDOMElement(node)) {
      if (node.classList.contains('expr-chip')) {
        out.push({
          kind: 'expr',
          value: node.getAttribute('data-expr') || `{${node.textContent}}`,
        });
      } else {
        out.push(...richReadElement(node, budget, depth));
      }
    }
    assert(out.length <= LIMITS.treeNodesMax, 'RichContent: parsed node limit exceeded');
  }
  return out;
}
// The text the field emits is the value the parser will hold once the save
// is written and read back (textValueCanonical): runs of whitespace squeeze
// to one space, one kept at either boundary, and a U+00A0 stays itself. The
// browser renders the same thing either way, but every save echoes back
// through the parser, and a value that comes back different from the last
// emission makes the field's sync rewrite the DOM and reset the caret.
function richReadText(raw: string): InlineNode[] {
  assert(raw.length <= LIMITS.nodeValueCharsMax, 'RichContent: text limit exceeded');
  const out: InlineNode[] = [];
  const expression = /\{[^{}]*\}/g;
  let last = 0;
  for (const match of raw.matchAll(expression)) {
    if (match.index > last) {
      out.push({ kind: 'text', value: textValueCanonical(raw.slice(last, match.index)) });
    }
    out.push({ kind: 'expr', value: match[0] });
    last = match.index + match[0].length;
    assert(out.length <= LIMITS.treeNodesMax, 'RichContent: text expression limit exceeded');
  }
  if (last < raw.length) {
    out.push({ kind: 'text', value: textValueCanonical(raw.slice(last)) });
  }
  return out;
}
function richReadElement(node: Element, budget: Budget, depth: number): InlineNode[] {
  let name = node.tagName.toLowerCase();
  if (name === 'b') {
    name = 'strong';
  }
  if (name === 'i') {
    name = 'em';
  }
  if (name === 'br') {
    return [{ kind: 'element', name: 'br', props: {}, children: undefined }];
  }
  const children = richReadDOM(node, budget, depth + 1);
  if (!INLINE_TAGS.has(name)) {
    return children;
  }
  const props = Object.fromEntries(
    ['href', 'class', 'target', 'rel'].flatMap((attribute): [string, Attr][] => {
      const value = node.getAttribute(attribute);
      if (value === null || value === '') {
        return [];
      }
      assert(value.length <= LIMITS.attrCharsMax, 'RichContent: attribute limit exceeded');
      return [[attribute, { type: 'string', value }]];
    }),
  );
  return [{ kind: 'element', name, props, children }];
}
export function isDOMElement(node: Node | undefined): node is Element {
  const ElementType = node?.ownerDocument?.defaultView?.Element;
  return !!ElementType && node instanceof ElementType;
}
