import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { PageNode } from '../../shared/page/pageNode';
import { canContainTag } from './elementSchemas';
import { findWithParent } from './treeSelection';
import { treeBudget, type TreeView } from './treeView';
import { findEditorNodeById } from './pageState';

export type WrapperTag = 'div' | 'a';
export type TextTag = 'div' | 'span';

// Parents whose text is not markup: the browser shows a tag written in a
// <title> or <textarea> as words, and drops one in an <option>. An SVG <text>
// renders no HTML inside it.
const LITERAL_TEXT_PARENTS: ReadonlySet<string> = new Set(['option', 'text', 'textarea', 'title', 'tspan']);

/** Check both sides of the new wrapper so browsers do not repair invalid nesting. */
export function canWrapNode(nodes: readonly PageNode[], nodeId: string, name: WrapperTag): boolean {
  const found = findWithParent(nodes, nodeId);
  if (!found) {
    return false;
  }
  const node = findEditorNodeById(nodes, nodeId);
  assert(node !== undefined, 'A located node is present in the same tree');
  if (node.chunkFile || node.kind === 'chunk-group' || node.kind === 'branch') {
    return false;
  }
  if (node.kind !== 'element' && node.kind !== 'component') {
    return false;
  }
  if (node.name === 'html' || node.name === 'head' || node.name === 'body') {
    return false;
  }
  if (found.parent?.kind === 'element') {
    if (!canContainTag(found.parent.name, name)) {
      return false;
    }
  }
  if (node.kind === 'element') {
    if (!canContainTag(name, node.name)) {
      return false;
    }
  }
  if (name === 'a') {
    return !containsLinkContent(node);
  }
  return true;
}

/** Whether a bare text run can become `<name>text</name>` where it stands.
 * `canContainTag` keeps a <div> out of every phrasing-only parent, and this is
 * looser on purpose: the run is the user's own choice of tag, and a <div> in a
 * <code> or a <span> stays where it was written. What must be refused is the
 * nesting a browser repairs: a <div> closes any open <p>, splitting the page
 * away from its source, so a <p> anywhere above rules it out. */
export function canConvertText(nodes: readonly PageNode[], nodeId: string, name: TextTag): boolean {
  const found = findWithParent(nodes, nodeId);
  if (found?.node.kind !== 'text') {
    return false;
  }
  if (/^\s*$/.test(found.node.value ?? '')) {
    return false;
  }
  const parent = found.parent;
  if (parent === undefined) {
    return true;
  }
  if (parent.kind === 'element') {
    const tag = (parent.name ?? '').toLowerCase();
    if (LITERAL_TEXT_PARENTS.has(tag) || !canContainTag(tag, 'span')) {
      return false;
    }
  }
  return name === 'span' || !insideParagraph(nodes, parent);
}

function insideParagraph(nodes: readonly PageNode[], start: TreeView): boolean {
  let current: TreeView | undefined = start;
  for (let depth = 0; depth <= LIMITS.treeDepthMax; depth++) {
    if (current === undefined) {
      return false;
    }
    if (current.kind === 'element' && (current.name ?? '').toLowerCase() === 'p') {
      return true;
    }
    current = findWithParent(nodes, current.id)?.parent;
  }
  assert(current === undefined, 'A walk up the tree ends within its depth bound');
  return false;
}

function containsLinkContent(node: TreeView): boolean {
  const visit = treeBudget();
  const walk = (current: TreeView, depth: number): boolean => {
    assert(depth <= LIMITS.treeDepthMax, 'Link content stays within the tree depth limit');
    visit(depth);
    if (current.kind === 'element') {
      if (current.name === 'a' || current.name === 'button' || current.props?.['tabindex']) {
        return true;
      }
    }
    return (current.children ?? []).some((child) => walk(child, depth + 1));
  };
  return walk(node, 0);
}
