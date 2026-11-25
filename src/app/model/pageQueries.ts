// Facts about a page's nodes the app reads after an edit: which are empty,
// what a removal leaves, and what survives a page change (App.tsx).

import { isInlineRun } from '../../editor/treeSelection';
import { rendersOwnElement } from '../../editor/liveClasses';
import { LIMITS } from '../../../shared/core/limits';
import { assert } from '../../../shared/core/assert';
import { unusedDeclarations, withoutDeclarations } from '../../editor/frontmatterMove';
import { type HistoryEntry } from '../appTypes';
import { type EditorModel, type EditorNode } from '../../editor/pageView';
import { withPrunedImports } from './pageGestures';

// Which nodes put nothing on the page, as ids: see emptyNodeIds in App.
export function emptyNodeIdsOf(renderedPaths: readonly string[], nodes: readonly EditorNode[], editedRel: string | undefined): ReadonlySet<string> {
  const prefix = editedRel ? `${editedRel}|` : '';
  const live = new Set<string>();
  for (const path of renderedPaths) {
    const local = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
    const parts = local.split('.');
    for (let i = parts.length; i > 0; i--) {
      live.add(parts.slice(0, i).join('.'));
    }
  }
  // Only kinds where "renders nothing" is a fact about the page. A comment,
  // the frontmatter row or a doctype line never renders and saying so on
  // every one of them would be noise.
  const MARKABLE = new Set(['element', 'component', 'map']);
  // …and neither <Fragment> nor <slot> ever puts an element on the page, so
  // there is nothing for the page to report about them and nothing to carry
  // their path. What they hold answers for them: children of either are
  // marked, and a live child makes its ancestors live. `<Fragment set:html>`
  // has no children to speak up, which is exactly the case where the panel
  // cannot tell — and saying "renders nothing" is the wrong half to guess.
  const answers = (node: EditorNode): boolean => MARKABLE.has(node.kind) && rendersOwnElement(node);
  const ids = new Set<string>();
  // An inline run — words with <a>, <strong>, <span> among them — is written
  // as one line, and markers inside it would render as spaces, so nothing in
  // there carries one. The page therefore says nothing about those nodes,
  // which is not the same as saying they rendered nothing: `unmarked` keeps
  // a link sitting in a sentence from being reported as invisible.
  const walk = (list: readonly EditorNode[], trail: readonly number[], { unmarked }: { readonly unmarked: boolean }): void => {
    const depth = trail.length;
    assert(depth <= LIMITS.treeDepthMax, 'emptyNodeIdsOf: depth exceeds the tree cap');
    list.forEach((node, i) => {
      const nodeTrail = [...trail, i];
      if (!unmarked && answers(node) && !live.has(nodeTrail.join('.'))) {
        ids.add(node.id);
      }
      if (Array.isArray(node.children)) {
        const inline = unmarked || isInlineRun(node.children);
        walk(node.children, nodeTrail, { unmarked: inline });
      }
    });
  };
  walk(nodes, [], { unmarked: false });
  return ids;
}

// What a delete leaves unused: the imports and declarations only the removed
// nodes were reading (the legacy removeNode's rule). Pure: a new model.
export function prunedAfterRemoval(model: EditorModel): {
  readonly model: EditorModel;
  readonly dropped: readonly string[];
} {
  const next = withPrunedImports(model);
  // The code the deleted markup was the only reader of goes with it: a
  // `const jobs = […]` nothing lists any more is left behind otherwise, and a
  // page collects them one deletion at a time. Only what nothing else
  // mentions — another declaration included — and never an export, which is
  // the page's own interface to Astro.
  const dead = unusedDeclarations(next).map((declaration) => declaration.name);
  if (dead.length) {
    const extraFrontmatter = withoutDeclarations(next.extraFrontmatter, dead);
    return { model: { ...next, extraFrontmatter }, dropped: dead };
  }
  return { model: next, dropped: dead };
}

// What survives the page's history being dropped (dropPageHistory).
export function keepsAcrossPages(entry: HistoryEntry): boolean {
  switch (entry.kind) {
    case 'cmd':
      return true;
    case 'edits':
      // Only an applied one: its inverses are all it needs.
      if (entry.record.outcome.tag === 'applied') {
        return entry.record.outcome.applied.length > 0;
      }
      return false;
    default: {
      const exhaustive: never = entry;
      return exhaustive;
    }
  }
}
