// Pointing what is inside a loop at the item's new shape when its collection
// changes. An Astro entry keeps its fields under `data` (`item.data.title`); a
// Sanity document has them on itself (`item.title`). Every binding to the item
// is re-pointed at the field of the same name in the new collection, and a
// binding to a field the new collection does not have is unbound the way a
// collection list in a visual builder unbinds it: text becomes placeholder
// text, an attribute is dropped, a condition becomes false and a nested loop
// over it becomes empty. None of these can throw while the page renders, which
// `item.data.title` would once `item.data` no longer exists.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr } from '../../shared/page/pageNode';
import type { LoopSourceKind } from './loopQuery';
import type { EditorNode } from './pageView';
import { splitMapHead } from './loopBindings';

/** What an item of a collection holds: where its fields are, and which exist. */
export interface ItemShape {
  readonly kind: LoopSourceKind;
  readonly fields: ReadonlySet<string>;
}

/** The nodes with every binding to `item` re-pointed or unbound, and how many were unbound. */
export interface Rebound {
  readonly nodes: readonly EditorNode[];
  readonly unbound: number;
  /** The fields those bindings named, for the warning that says what was unlinked. */
  readonly lost: readonly string[];
}

// An Astro entry's own properties, beside its `data`.
const ASTRO_ENTRY_KEYS = new Set([
  'id',
  'collection',
  'body',
  'slug',
  'rendered',
  'filePath',
  'data',
]);
const UNBOUND_TEXT = 'content';

export function reboundItem(
  nodes: readonly EditorNode[],
  item: string,
  target: ItemShape,
): Rebound {
  assert(/^[A-Za-z_$][\w$]*$/.test(item), 'A loop item is named by an identifier');
  assert(target.fields.size <= LIMITS.treeNodesMax, 'A collection has a bounded number of fields');
  // The count is the one piece of state, owned here; the walk reports to it.
  let unbound = 0;
  const lost = new Set<string>();
  const lose = (): void => {
    unbound++;
  };
  const rewrite = (code: string): string | undefined =>
    reboundCode(code, item, target, (field) => {
      lost.add(field);
    });
  const out = nodes.map((node) => reboundNode(node, { item, depth: 0 }, rewrite, lose));
  assert(unbound >= 0, 'An unbound count is never negative');
  assert(
    lost.size <= unbound || unbound > 0 || lost.size === 0,
    'Lost fields come from unbound bindings',
  );
  return { nodes: out, unbound, lost: [...lost] };
}

/** The code with each `item.…` path re-pointed, or undefined when one has no field to point at. */
export function reboundCode(
  code: string,
  item: string,
  target: ItemShape,
  onLost?: (field: string) => void,
): string | undefined {
  const pattern = new RegExp(`(?<![.\\w$])${item}((?:\\??\\.[A-Za-z_$][\\w$]*)*)`, 'g');
  let lost = false;
  const next = code.replace(pattern, (whole: string, tail: string) => {
    const segments = tail.split(/\??\./).filter((segment) => segment !== '');
    const pointed = pointedPath(segments, target);
    if (pointed === undefined) {
      lost = true;
      onLost?.(
        segments[0] === 'data' || segments[0] === 'fields'
          ? (segments[1] ?? segments[0])
          : (segments[0] ?? item),
      );
      return whole;
    }
    return [item, ...pointed].join('.');
  });
  return lost ? undefined : next;
}

// The path into an item of the new shape, for a path written against either.
function pointedPath(
  segments: readonly string[],
  target: ItemShape,
): readonly string[] | undefined {
  const first = segments[0];
  if (first === undefined) {
    return segments; // The item itself.
  }
  // `data` (an Astro entry) and `fields` (an exported builder item) both hold the fields.
  const nested = first === 'data' || first === 'fields';
  const field = nested ? segments[1] : first;
  const rest = nested ? segments.slice(2) : segments.slice(1);
  if (nested && field === undefined) {
    // `item.data`: the fields themselves.
    return target.kind === 'astro' ? ['data'] : [];
  }
  if (field === undefined) {
    return undefined;
  }
  if (target.kind === 'astro') {
    if (!nested && ASTRO_ENTRY_KEYS.has(first)) {
      return segments;
    }
    return target.fields.has(field) ? ['data', field, ...rest] : undefined;
  }
  if (!nested && first.startsWith('_')) {
    return segments; // `_id`, `_type`: every document has them.
  }
  return target.fields.has(field) ? [field, ...rest] : undefined;
}

type Rewrite = (code: string) => string | undefined;

function reboundNode(
  node: EditorNode,
  at: { readonly item: string; readonly depth: number },
  rewrite: Rewrite,
  lose: () => void,
): EditorNode {
  const depth = at.depth;
  assert(depth <= LIMITS.treeDepthMax, `reboundItem: depth ${depth} exceeds the tree cap`);
  const withProps = reboundProps(node, rewrite, lose);
  const own = reboundOwn(withProps, at.item, rewrite, lose);
  if (own.shadowed) {
    return own.node;
  }
  const children = own.node.children;
  if (children === undefined) {
    return own.node;
  }
  const next = children.map((child) =>
    reboundNode(child, { item: at.item, depth: depth + 1 }, rewrite, lose),
  );
  assert(next.length === children.length, 'Rebinding keeps every child');
  return Object.assign({}, own.node, { children: next });
}

function reboundProps(node: EditorNode, rewrite: Rewrite, lose: () => void): EditorNode {
  const props = node.props;
  if (props === undefined) {
    return node;
  }
  const kept: [string, Attr][] = [];
  let changed = false;
  for (const [key, value] of Object.entries(props)) {
    if (value.type !== 'expr') {
      kept.push([key, value]);
      continue;
    }
    const code = rewrite(value.value);
    if (code === undefined) {
      lose();
      changed = true;
    } else {
      changed ||= code !== value.value;
      kept.push([key, { ...value, value: code }]);
    }
  }
  if (!changed) {
    return node;
  }
  // The source spans describe the attributes as they were; a node whose
  // attributes changed is written from its props, so the spans go, and the
  // order keeps only the names still there (pageEdits.ts does the same).
  const names = new Set(kept.map(([key]) => key));
  const { attrSpans: staleSpans, ...rest } = node;
  void staleSpans;
  const order = rest.attrOrder?.filter((name) => names.has(name));
  return {
    ...rest,
    props: Object.fromEntries(kept),
    ...(order === undefined ? {} : { attrOrder: order }),
  };
}

function reboundOwn(
  node: EditorNode,
  item: string,
  rewrite: Rewrite,
  lose: () => void,
): { readonly node: EditorNode; readonly shadowed: boolean } {
  switch (node.kind) {
    case 'expr': {
      const code = rewrite(node.value);
      if (code === undefined) {
        lose();
        return { node: { ...node, kind: 'text', value: UNBOUND_TEXT }, shadowed: false };
      }
      return { node: { ...node, value: code }, shadowed: false };
    }
    case 'text': {
      if (!node.value.includes('{')) {
        return { node, shadowed: false };
      }
      const value = node.value.replace(/\{([^{}]*)\}/g, (whole, inner: string) => {
        const code = rewrite(inner);
        if (code === undefined) {
          lose();
          return UNBOUND_TEXT;
        }
        return `{${code}}`;
      });
      return { node: { ...node, value }, shadowed: false };
    }
    case 'cond': {
      const test = rewrite(node.test);
      if (test === undefined) {
        lose();
      }
      return { node: { ...node, test: test ?? 'false' }, shadowed: false };
    }
    case 'map':
      return reboundLoop(node, item, rewrite, lose);
    case 'raw-line':
    case 'element':
    case 'component':
    case 'raw':
    case 'comment':
    case 'branch':
    case 'chunk-group':
      return { node, shadowed: false };
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
}

function reboundLoop(
  node: Extract<EditorNode, { readonly kind: 'map' }>,
  item: string,
  rewrite: Rewrite,
  lose: () => void,
): { readonly node: EditorNode; readonly shadowed: boolean } {
  const head = splitMapHead(node.head);
  if (head === undefined) {
    // A hand-written head is code the editor does not split; it is left whole.
    return { node, shadowed: false };
  }
  const data = rewrite(head.data);
  if (data === undefined) {
    lose();
  }
  const parameters = head.item + (head.index ? `, ${head.index}` : '');
  const rewritten = { ...node, head: `${data ?? '[]'}.map((${parameters}) => (` };
  // A nested loop naming its own item the same shadows ours below it.
  return { node: rewritten, shadowed: head.item === item || head.index === item };
}
