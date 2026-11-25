// A Stacki Apps insert (`node.insert`, src/app/shell/desktopAppHost.ts) as one edit
// gesture: the new node, the node it replaces leaving, and the frontmatter both
// change, in one undo step and one save. It is built from the same gestures the
// insert palette, delete and "create component" use (editGestures.ts), so the
// edit reaches disk exactly as theirs do.

import { assert } from '../../../shared/core/assert';
import type { Attr, ImportDecl } from '../../../shared/page/pageNode';
import { type InsertPlace, frontmatterGesture, insertGesture, removalGesture, sequence } from '../../editor/editGestures';
import { ancestorChain } from '../../editor/editorTree';
import type { EditGesture } from '../../editor/pageEdits';
import type { EditorModel, EditorNode } from '../../editor/pageView';
import { frontmatterOf } from './nodeFactory';
import { prunedAfterRemoval } from './pageQueries';

/** What one app insert does to the page. */
export interface AppInsertEdit {
  /** The new node, its attributes or props already on it. */
  readonly node: EditorNode;
  readonly place: InsertPlace;
  /** The node the new one takes the place of, when it replaces one. */
  readonly replacedId: string | undefined;
  /** The page's imports once the new node's are added; undefined when it needs none. */
  readonly imports: readonly ImportDecl[] | undefined;
}

/**
 * The insert as one gesture. A replacement is the insert before the replaced node and
 * that node's removal, as extracting a component swaps markup for an instance; what the
 * removal leaves unused in the frontmatter goes with it, as a delete prunes it, in the
 * same frontmatter write that adds the new node's imports.
 */
export function appInsertGesture(model: EditorModel, insert: AppInsertEdit): EditGesture {
  const { node, place, replacedId, imports } = insert;
  assert(node.id !== replacedId, 'A new node has an id of its own');
  assert(place.index >= 0, 'A new node goes at a place in a list');
  const urgent = { coalesceKey: undefined, urgency: true };
  const inserted = insertGesture(model, node, place, urgent);
  const nodes = replacedId === undefined ? inserted : replacement(model, inserted, replacedId);
  const after = nodes.apply(model);
  const frontmatter = (pageModel: EditorModel): EditorModel => {
    const imported = imports === undefined ? pageModel : { ...pageModel, imports };
    return replacedId === undefined ? imported : prunedAfterRemoval(imported).model;
  };
  return frontmatterOf(frontmatter(after)) === frontmatterOf(after) ? nodes : sequence(nodes, frontmatterGesture(after, urgent, frontmatter));
}

/** A new node with the app's string attributes or props set on it, over any defaults it starts with. */
export function withStringProps(node: EditorNode, given: Readonly<Record<string, string>>): EditorNode {
  const names = Object.keys(given);
  if (names.length === 0) {
    return node;
  }
  assert(node.kind === 'element' || node.kind === 'component', 'Only an element or a component takes attributes');
  // Built by construction, not by writing into a props index: the new node enters the page only through the insert gesture.
  const added = names.map((name): readonly [string, Attr] => {
    const value = given[name];
    assert(value !== undefined, 'Every named attribute has a value');
    return [name, { type: 'string', value }];
  });
  const props: Readonly<Record<string, Attr>> = { ...node.props, ...Object.fromEntries(added) };
  assert(Object.keys(props).length >= names.length, 'Every given attribute is on the new node');
  return { ...node, props };
}

// The insert, then the replaced node's removal: the requests of both, in order.
function replacement(model: EditorModel, inserted: EditGesture, replacedId: string): EditGesture {
  const swapped = sequence(inserted, removalGesture([replacedId], { urgency: true }));
  // A node inside a loop stands for every repeat, so main refuses to remove it on its
  // own once the new node has gone in beside it (pageGestures.ts, extractionGesture).
  // Stated as no request, the gesture goes out as a rewrite of the loop, in one piece.
  const inLoop = (ancestorChain(model.nodes, replacedId) ?? []).some((candidate) => candidate.kind === 'map');
  return inLoop ? { ...swapped, request: () => undefined } : swapped;
}
