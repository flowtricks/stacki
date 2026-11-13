import { assert } from '../../shared/core/assert';
// i18n-ignore-file: developer-facing refusals of the insert gesture (read by agents and logs), not interface text.
import { findWithParent } from './treeSelection';
import type { TreeView } from './treeView';
import { LIMITS } from '../../shared/core/limits';
import { thenBranch } from './branches';
interface Insertable {
  readonly name: string;
  readonly slots?: readonly string[];
  readonly renderTag?: { readonly tag?: string | undefined; readonly prop?: string | undefined } | undefined;
}
interface InsertItem {
  readonly type: string;
  readonly tag?: string;
  readonly name?: string;
}
export interface InsertTarget {
  /** The parent the node goes inside; undefined for the page's root list. */
  readonly parentId: string | undefined;
  readonly index: number;
}
import { canContainTag, VOID_TAGS } from './elementSchemas';

// Where a new node goes: inside the selection when it accepts children,
// otherwise right after it; with no selection, at the end of the page.
//
// Lives here rather than in App.tsx because the rule is the whole answer to a
// question users ask constantly — "why did that land NEXT to the section
// instead of in it?" — and the answer turns on things no glance at the panel
// can confirm: what a component renders as, and whether it takes default slot
// content at all. A component that reads its slot itself rather than writing
// `<slot />` was reported as taking none, and every insert with one selected
// landed beside it.

/**
 * What a component renders as. Fixed for most (`<Section>` is a `<section>`);
 * decided by a prop for the ones that take a `tag` (`<Heading tag="h1">`), in
 * which case an instance's own value wins over the component's default.
 * Undefined when it can't be told — several possible tags, or no root element.
 */
export function tagOfComponent(component: Insertable | undefined, node?: TreeView | undefined): string | undefined {
  const renderTag = component?.renderTag;
  if (!renderTag) {
    return undefined;
  }
  if (renderTag.prop && node) {
    const set = node.props?.[renderTag.prop];
    const value = set && set.type !== 'expr' ? String(set.value || '') : '';
    if (value) {
      return value.toLowerCase();
    }
  }
  return renderTag.tag || undefined;
}

const findNode = (nodes: readonly TreeView[], id: string): TreeView | undefined => findWithParent(nodes, id)?.node;
const findParentOf = (nodes: readonly TreeView[], id: string): InsertTarget | undefined => {
  const found = findWithParent(nodes, id);
  return found ? { parentId: found.parent?.id, index: found.index } : undefined;
};

/** Whether `node` can hold `childTag` (undefined when the tag can't be told). */
export function acceptsChildren(node: TreeView, childTag: string | undefined, insertables: readonly Insertable[] | undefined): boolean {
  if (node.id === 'layout') {
    return true;
  }
  if (node.kind === 'element') {
    const tag = String(node.name).toLowerCase();
    if (VOID_TAGS.has(tag)) {
      return false;
    }
    // A <p> inside an <h1> is invalid HTML the browser would reparent —
    // insert alongside instead of inside.
    return childTag ? canContainTag(tag, childTag) : true;
  }
  // A condition holds nothing itself — insertTargetFor resolves it to the
  // branch its row displays.
  if (node.kind === 'map' || node.kind === 'chunk-group' || node.kind === 'branch') {
    // Arbitrary callback roots are separate return sites. Insert within their
    // actual elements; inserting into the callback would choose a branch for the user.
    return node.bodyParts === undefined;
  }
  if (node.kind === 'component') {
    const component = (insertables || []).find((candidate) => candidate.name === node.name);
    if (!(component?.slots || []).includes('default')) {
      return false;
    }
    // …and what it renders as still has to be able to hold the child.
    const tag = tagOfComponent(component, node);
    return tag && childTag ? canContainTag(tag, childTag) : true;
  }
  return false;
}

export function insertTargetFor(
  model: { readonly nodes: readonly TreeView[] },
  selectedId: string | undefined,
  item: InsertItem | undefined,
  insertables: readonly Insertable[] | undefined,
): InsertTarget {
  // The tag being inserted. A component counts too: <Paragraph> renders a
  // <p>, and a <p> is no more allowed inside a heading for being wrapped
  // in a component. Unknown when the tag depends on values only the page
  // knows (`const Tag = isLink ? "a" : "button"`), and unknown means
  // allowed — a wrong refusal is worse than a wrong nesting.
  const childTag =
    item && item.type === 'element'
      ? item.tag
      : item && item.type === 'component'
        ? tagOfComponent((insertables || []).find((candidate) => candidate.name === item.name))
        : undefined;
  const accepts = (node: TreeView) => acceptsChildren(node, childTag, insertables);
  if (selectedId && selectedId !== 'frontmatter') {
    const selected = findNode(model.nodes, selectedId);
    const host = selected?.kind === 'cond' ? thenBranch(selected) : selected;
    if (host && accepts(host)) {
      return { parentId: host.id, index: host.children?.length ?? 0 };
    }
    // Otherwise drop in as a sibling — climbing out of any ancestor that
    // can't legally hold it either (a <div> next to a <span> inside a <p>
    // still isn't valid, so it lands after the <p>).
    let childId = selectedId;
    for (let depth = 0; depth < LIMITS.treeDepthMax; depth++) {
      const place = findParentOf(model.nodes, childId);
      if (!place) {
        break;
      }
      if (place.parentId === undefined) {
        return { parentId: undefined, index: place.index + 1 };
      }
      const parent = findNode(model.nodes, place.parentId);
      if (!parent || accepts(parent)) {
        return { parentId: place.parentId, index: place.index + 1 };
      }
      childId = place.parentId;
    }
  }
  return { parentId: undefined, index: model.nodes.length };
}

/** Where an insert asked for a place of its own goes: beside or inside an anchor, or in a node's place. */
export interface AnchoredInsert {
  readonly position: 'before' | 'after' | 'inside' | 'replace';
  readonly anchorId: string;
  /** A child index, inside only: undefined puts the node last. */
  readonly index: number | undefined;
}

/**
 * The place an anchored insert names (Stacki Apps' `node.insert`), checked as the
 * palette's rule checks a selection: the parent must be able to hold the new node's
 * tag. Unlike the palette, nothing is climbed out of: the caller named the place, so a
 * place that cannot take the node is refused with the reason, never moved.
 * A replacement goes where the replaced node stands, before it.
 */
export function anchoredInsertTarget(
  model: { readonly nodes: readonly TreeView[] },
  insert: AnchoredInsert,
  item: InsertItem,
  insertables: readonly Insertable[] | undefined,
): { readonly kind: 'placed'; readonly target: InsertTarget } | { readonly kind: 'refused'; readonly reason: string } {
  assert(insert.index === undefined || insert.position === 'inside', 'Only an insert inside its anchor takes an index');
  const childTag = item.type === 'element' ? item.tag : tagOfComponent((insertables ?? []).find((candidate) => candidate.name === item.name));
  const found = insert.anchorId === 'frontmatter' ? undefined : findWithParent(model.nodes, insert.anchorId);
  if (found === undefined) {
    return { kind: 'refused', reason: 'No element has that id on the open page' };
  }
  if (insert.position === 'inside') {
    if (!acceptsChildren(found.node, childTag, insertables)) {
      return { kind: 'refused', reason: `That ${found.node.kind} cannot hold ${childTag === undefined ? 'this node' : `a <${childTag}>`}` };
    }
    const count = found.node.children?.length ?? 0;
    const index = insert.index ?? count;
    if (index <= count) {
      return { kind: 'placed', target: { parentId: found.node.id, index } };
    }
    return { kind: 'refused', reason: `index is past the anchor's ${count} children` };
  }
  // The layout wraps the whole page, and a branch or a frontmatter section is part of the code around it: none is a node to stand beside or replace.
  if (found.node.id === 'layout' || found.node.kind === 'branch' || found.node.kind === 'chunk-group') {
    return { kind: 'refused', reason: `A new node cannot go ${insert.position === 'replace' ? 'in place of' : insert.position} that ${found.node.kind}` };
  }
  if (found.parent !== undefined) {
    if (!acceptsChildren(found.parent, childTag, insertables)) {
      return { kind: 'refused', reason: `The anchor's parent cannot hold ${childTag === undefined ? 'this node' : `a <${childTag}>`}` };
    }
  }
  const index = insert.position === 'after' ? found.index + 1 : found.index;
  assert(index <= found.siblings.length, 'A place beside the anchor is within its list');
  return { kind: 'placed', target: { parentId: found.parent?.id, index } };
}
