// Gestures in their intent form (plan §11 step 6; every .astro gesture since
// step 9): each is the edit requests it becomes against the page's origin,
// and its effect on the shown model — the prediction the page shows until the
// reply lands, and whose new nodes pair with the reply's (src/editor/nodeHandles.ts).
// The effect builds a new model and never edits one in place (the model is
// readonly, src/editor/pageView.ts). When specialized syntax has no request,
// the sender derives a minimal node rewrite from the effect instead
// (src/editor/pageEdits.ts).
import { assert } from '../../shared/core/assert';
import type { EditorModel, EditorNode } from './pageView';
import type { Edit, NodeRef } from '../../shared/engine/editRequest';
import { singleDeclarationChange } from '../../shared/engine/inlineStyle';
import { LIMITS } from '../../shared/core/limits';
import type { Attr } from '../../shared/page/pageNode';
import { renamedAttr } from './attrOrder';
import { loopVarsAt, parseLoopHead, renamedLoopVar, strippedBindings } from './loopBindings';
import type { EditGesture } from './pageEdits';
import type { CodeHunk } from '../../shared/engine/codePatch';
import { planVariableRename, predictedRename, type FileCode, type VariableRename } from './variableRename';
import {
  type Urgency,
  withNode,
  type InsertPlace,
  type Placement,
  withoutNodes,
  withInserted,
  withChildren,
  containsNode,
  besidePlace,
  blank,
  findNode,
} from './insertGestures';
export { withNode, type InsertPlace, insertGesture, duplicateGesture, removalGesture, withoutNodes, withInserted, withChildren } from './insertGestures';

/** Props to set (a value) or remove (undefined), by name. */
export type PropPatch = Readonly<Record<string, Attr | undefined>>;

/** Set or remove attributes and props of one node: string values and
 * removals (the attribute step), expressions and bare props (the prop step).
 * A spread is rewritten through the gesture's minimal-node fallback. */
export function propsGesture(nodeId: string, patch: PropPatch, options: { readonly coalesceKey: string | undefined; readonly urgency: Urgency }): EditGesture {
  const names = Object.keys(patch);
  const [only] = names;
  return {
    coalesceKey: options.coalesceKey,
    urgency: options.urgency,
    stream: names.length === 1 && only !== undefined ? `attribute:${nodeId}:${only}` : undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const edits: Edit[] = [];
      for (const [name, value] of Object.entries(patch)) {
        const edit = attributeEdit(target, name, value);
        if (edit === undefined) {
          return undefined; // All or nothing: one gesture, one way to disk.
        }
        edits.push(edit);
      }
      return edits;
    },
    apply: (model) => withNode(model, nodeId, (node) => Object.assign({}, node, { props: patchedProps(node.props, patch) })),
  };
}

function attributeEdit(target: NodeRef, name: string, value: Attr | undefined): Edit | undefined {
  if (value === undefined) {
    return { tag: 'remove-attribute', target, name };
  }
  switch (value.type) {
    case 'string':
    case 'expr':
      return { tag: 'set-attribute', target, name, value };
    case 'bare':
      return { tag: 'set-attribute', target, name, value: { type: 'bare' } };
    case 'spread':
      return undefined;
    default: {
      const exhaustive: never = value;
      return exhaustive;
    }
  }
}

/** Props in their order, patched: a set value keeps its slot, a new one goes
 * last, a removed one goes — what the legacy setProp did in place. */
export function patchedProps(props: Readonly<Record<string, Attr>> | undefined, patch: PropPatch): Record<string, Attr> {
  const next: Record<string, Attr> = {};
  for (const [name, value] of Object.entries(props ?? {})) {
    if (Object.hasOwn(patch, name)) {
      const patched = patch[name];
      if (patched !== undefined) {
        Object.defineProperty(next, name, {
          value: patched,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
    } else {
      Object.defineProperty(next, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value !== undefined && !Object.hasOwn(next, name)) {
      Object.defineProperty(next, name, {
        value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
  }
  return next;
}

// --- Inline CSS (the §11.6 inline CSS step) ---------------------------------------------

/** A Style field edit: when it changes exactly one declaration, the request
 * edits that declaration in place (set-inline-style) and every other byte of
 * the attribute stays as written; otherwise — several changes, a reformatted
 * list, a quote in the new text — the whole value is set (the attribute step).
 * The effect on the model is the same either way: the new style string. */
export function inlineStyleGesture(
  nodeId: string,
  styles: { readonly before: string; readonly after: string },
  options: { readonly coalesceKey: string | undefined; readonly urgency: Urgency },
): EditGesture {
  const whole = propsGesture(nodeId, { style: { type: 'string', value: styles.after } }, options);
  const change = singleDeclarationChange(styles.before, styles.after);
  const single = change !== undefined && !/["']/.test(styles.after);
  return {
    ...whole,
    // One declaration is its own stream: coalescing it with another property's
    // edit would lose that one on disk.
    stream: single ? `style:${nodeId}:${change.property}` : whole.stream,
    request: (refOf, origin) => {
      if (!single) {
        return whole.request(refOf, origin);
      }
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const { property, declaration } = change;
      return [{ tag: 'set-inline-style', target, property, declaration }];
    },
  };
}

// --- Move (the §11.6 move step) ---------------------------------------------------------

/** What a move decides beside the relocation: whether the node's `slot`
 * still means anything where it lands (asked of the model after the move). */
export interface MoveRules {
  readonly keepsSlot: (model: EditorModel, nodeId: string) => boolean;
}

/** Move a node, and the note above it, to a place. The requests relocate the
 * original bytes (plan §3.4); leaving a loop, the planner turns what read the
 * loop's item into placeholder text, as the effect here does with
 * strippedBindings. A `slot` that means nothing where the node lands goes
 * first, while the node is still where the request names it. */
export function moveGesture(
  model: EditorModel,
  nodeId: string,
  place: InsertPlace | undefined,
  rules: MoveRules,
  options: { readonly urgency: Urgency },
): EditGesture | undefined {
  const found = findWithList(model.nodes, nodeId);
  if (found === undefined) {
    return undefined;
  }
  if (place?.parentId === nodeId || (place?.parentId !== undefined && containsNode(found.node.children ?? [], place.parentId))) {
    return undefined; // Into itself: nothing to do.
  }
  const previous = found.list[found.index - 1];
  const note = previous?.kind === 'comment' ? previous : undefined;
  const moving = note === undefined ? [nodeId] : [note.id, nodeId];
  const landing = relocated(model, found, moving, place);
  const slot = found.node.props?.['slot'];
  const dropSlot = slot?.type === 'string' ? !rules.keepsSlot(landing.model, nodeId) : false;
  const beside = besidePlace(model, place, new Set(moving));
  const lost = lostVariables(model, landing.model, nodeId);
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => moveRequest({ nodeId, noteId: note?.id, beside, dropSlot }, refOf),
    apply: (current) => {
      const again = findWithList(current.nodes, nodeId);
      if (again === undefined) {
        return current;
      }
      const moved = relocated(current, again, moving, place, (node) => {
        const props = dropSlot ? patchedProps(node.props, { slot: undefined }) : node.props;
        return strippedBindings(props === undefined ? node : { ...node, props }, lost).node;
      });
      return moved.model;
    },
  };
}

/** A move's requests against a parse: the `slot` removal first when it goes,
 * then the node and its note, in the order that lands them as they stood. */
function moveRequest(
  move: {
    readonly nodeId: string;
    readonly noteId: string | undefined;
    readonly beside: { readonly anchorId: string; readonly placement: Placement } | undefined;
    readonly dropSlot: boolean;
  },
  refOf: (nodeId: string) => NodeRef | undefined,
): readonly Edit[] | undefined {
  const { beside } = move;
  const target = refOf(move.nodeId);
  const noteRef = move.noteId === undefined ? undefined : refOf(move.noteId);
  const destination = beside === undefined ? undefined : refOf(beside.anchorId);
  if (target === undefined || beside === undefined || destination === undefined) {
    return undefined;
  }
  if (move.noteId !== undefined && noteRef === undefined) {
    return undefined;
  }
  const edits: Edit[] = [];
  if (move.dropSlot) {
    edits.push({ tag: 'remove-attribute', target, name: 'slot' });
  }
  const moveOf = (ref: NodeRef): Edit => ({
    tag: 'move-node',
    target: ref,
    destination,
    placement: beside.placement,
  });
  // Before a node, the note goes first and the node after it; after a node
  // or into a parent, the node goes first and the note lands in front of it.
  const order = noteRef === undefined ? [target] : beside.placement === 'before' ? [noteRef, target] : [target, noteRef];
  edits.push(...order.map(moveOf));
  assert(edits.length > 0, 'A move states at least one edit');
  return edits;
}

/** The loop variables the node reads at its old place and not at its new one. */
function lostVariables(before: EditorModel, after: EditorModel, nodeId: string): readonly string[] {
  const now = loopVarsAt(after.nodes, nodeId);
  return loopVarsAt(before.nodes, nodeId).filter((name) => !now.includes(name));
}

// The legacy moveNode's placement: the drop index counts the list as it was,
// so a drop past the node's own place in the same list moves back by what was
// taken out; a drop between a note and its node collapses onto the pair.
function relocated(
  model: EditorModel,
  found: {
    readonly list: readonly EditorNode[];
    readonly index: number;
    readonly node: EditorNode;
  },
  moving: readonly string[],
  place: InsertPlace | undefined,
  reshape: (node: EditorNode) => EditorNode = (node) => node,
): { readonly model: EditorModel } {
  const removeAt = found.index - (moving.length - 1);
  const without = withoutNodes(model, moving);
  const parentId = place?.parentId;
  const sameList = parentId === undefined ? found.list === model.nodes : findNode(model.nodes, parentId)?.children === found.list;
  let index = place?.index ?? Number.MAX_SAFE_INTEGER;
  if (sameList && index > removeAt) {
    index = Math.max(removeAt, index - moving.length);
  }
  const node = reshape(found.node);
  const landed = withInserted(without, node, place === undefined ? undefined : { parentId, index });
  if (moving.length === 1) {
    return { model: landed };
  }
  const noteNode = found.list[found.index - 1];
  assert(noteNode !== undefined, 'A moved note sits above its node');
  const at = findWithList(landed.nodes, node.id);
  assert(at !== undefined, 'The moved node landed');
  const noteParent = at.parentId;
  return { model: withInserted(landed, noteNode, { parentId: noteParent, index: at.index }) };
}

function findWithList(
  list: readonly EditorNode[],
  nodeId: string,
):
  | {
      readonly list: readonly EditorNode[];
      readonly index: number;
      readonly node: EditorNode;
      readonly parentId: string | undefined;
    }
  | undefined {
  const pending: { readonly list: readonly EditorNode[]; readonly parentId: string | undefined }[] = [{ list, parentId: undefined }];
  for (let visited = 0; visited < pending.length; visited++) {
    assert(visited < LIMITS.treeNodesMax, 'A model stays inside its node bound');
    const entry = pending[visited];
    assert(entry !== undefined, 'The visit index lies inside the list');
    for (const [index, node] of entry.list.entries()) {
      if (node.id === nodeId) {
        return { list: entry.list, index, node, parentId: entry.parentId };
      }
      if (Array.isArray(node.children)) {
        pending.push({ list: node.children, parentId: node.id });
      }
    }
  }
  return undefined;
}

// --- Frontmatter slots (the §11.6 frontmatter step) ------------------------------------

/** A change to what the frontmatter says — imports, declarations, the code
 * editor's text. The request carries the frontmatter the changed model
 * describes; main prints that block with the legacy printer and writes only
 * the slot where it differs from the block on disk (editRequests.ts), so a new
 * import touches its own line and nothing else. */
export function frontmatterGesture(
  model: EditorModel,
  options: { readonly coalesceKey: string | undefined; readonly urgency: Urgency },
  change: (model: EditorModel) => EditorModel,
): EditGesture {
  const after = change(model);
  return {
    coalesceKey: options.coalesceKey,
    urgency: options.urgency,
    stream: 'frontmatter',
    request: () => {
      // The block alone: main prints it from a model without nodes.
      const edit: Edit = { tag: 'set-frontmatter', model: { ...after, nodes: [] } };
      return [edit];
    },
    apply: change,
  };
}

/** Two gestures as one undo step: the requests of both, in order, or none
 * when either has no intent form; the effects one after the other. */
export function sequence(first: EditGesture, second: EditGesture): EditGesture {
  return {
    coalesceKey: first.coalesceKey,
    urgency: first.urgency,
    stream: undefined,
    request: (refOf, origin) => {
      const before = first.request(refOf, origin);
      const after = second.request(refOf, origin);
      if (before === undefined || after === undefined) {
        return undefined;
      }
      return [...before, ...after];
    },
    apply: (model) => second.apply(first.apply(model)),
  };
}

// --- Loop rename (multi-span, plan §3.3) ------------------------------------------------

export interface LoopRename {
  readonly from: string;
  readonly to: string;
}

/** The loop editor's rename: a new head that renames the loop's parameters and
 * nothing else becomes one rename-binding request per name — main finds every
 * site (shared/engine/loopScope.ts) — and the effect is the legacy one
 * (renamedLoopVar). A head that also changes its data or its shape has no
 * intent form yet and saves the whole model. */
export function loopRenameGesture(
  model: EditorModel,
  nodeId: string,
  change: { readonly head: string; readonly renames: readonly LoopRename[] },
  options: { readonly urgency: Urgency },
): EditGesture | undefined {
  const node = findNode(model.nodes, nodeId);
  if (node?.kind !== 'map' || node.head === undefined) {
    return undefined;
  }
  const renames = change.renames.filter((rename) => rename.from !== rename.to);
  if (!onlyRenames(node.head, change.head, renames)) {
    return undefined;
  }
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      return renames.map(({ from, to }): Edit => ({ tag: 'rename-binding', target, from, to }));
    },
    apply: (current) =>
      withNode(current, nodeId, (loop) => {
        const children = renames.reduce((list, { from, to }) => renamedLoopVar(list, from, to), loop.children ?? []);
        return withChildren({ ...loop, head: change.head }, children);
      }),
  };
}

// The new head is the old one with the parameters renamed, the data the same.
function onlyRenames(before: string, after: string, renames: readonly LoopRename[]): boolean {
  if (renames.length === 0) {
    return false;
  }
  const old = parseLoopHead(before);
  const next = parseLoopHead(after);
  if (old === undefined) {
    return false; // A hand-written head: the rename is best effort, in the model.
  }
  if (next === undefined) {
    return false;
  }
  const renamed = (name: string) => renames.find((rename) => rename.from === name)?.to ?? name;
  if (old.data !== next.data) {
    return false;
  }
  return renamed(old.item) === next.item && renamed(old.index) === next.index;
}

// --- A file's variable renamed ----------------------------------------------------------

/** A frontmatter variable renamed across the file, as one patch of its bytes: one
 * write and one undo step, however many places read it. The patch is stated
 * again against the bytes it is sent to, since an earlier gesture may have
 * changed them since the check. If that plan fails, the checked hunks go as they
 * are: main refuses them when the bytes they witness have moved, and the page's
 * conflict notice says so, which beats writing half a rename. */
export function variableRenameGesture(file: FileCode, rename: VariableRename, hunks: readonly CodeHunk[]): EditGesture {
  assert(rename.from !== rename.to, 'A rename changes the name');
  assert(hunks.length > 0, 'A rename changes the file');
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (_refOf, origin) => {
      const plan = origin.source === file.source ? undefined : planVariableRename(origin, rename);
      const edit: Edit = { tag: 'code-patch', hunks: plan?.ok === true ? plan.hunks : hunks };
      return [edit];
    },
    apply: (model) => predictedRename(model, rename),
  };
}

// --- Step 9: the gestures the whole-model save carried --------------------------------

/** A node restated: the request is the node as it should now read — main
 * places what the printer says changed on the node's own bytes (a
 * `rewrite-node`, never a reprint) — and the effect is that node in the shown
 * model. Rewording a note, typing a text, a loop head or a condition, the
 * style panel's `<style>` body, a branch added or removed. Restatements of one
 * node coalesce while unsent: each states the whole node, so the last wins. */
export function nodeGesture(nodeId: string, next: EditorNode, options: { readonly coalesceKey: string | undefined; readonly urgency: Urgency }): EditGesture {
  assert(next.id === nodeId, 'A restated node keeps its id');
  return {
    coalesceKey: options.coalesceKey,
    urgency: options.urgency,
    stream: `node:${nodeId}`,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const edit: Edit = { tag: 'replace-node', target, node: next };
      return [edit];
    },
    apply: (model) => withNode(model, nodeId, () => next),
  };
}

/** A prop renamed in place, keeping its value and its slot. A name the tag
 * already has gives up its slot to the rename (renamedAttr): its removal goes
 * first, since the engine never renames onto a name that is taken. */
export function attributeRenameGesture(model: EditorModel, nodeId: string, names: { readonly from: string; readonly to: string }): EditGesture | undefined {
  const node = findNode(model.nodes, nodeId);
  const renamed = node === undefined ? undefined : renamedAttr(node, names.from, names.to);
  if (node === undefined || renamed === undefined) {
    return undefined;
  }
  const taken = Object.hasOwn(node.props ?? {}, names.to);
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      const rename: Edit = { tag: 'rename-attribute', target, ...names };
      if (!taken) {
        return [rename];
      }
      const removal: Edit = { tag: 'remove-attribute', target, name: names.to };
      return [removal, rename];
    },
    apply: (current) =>
      withNode(current, nodeId, (found) => ({
        ...found,
        ...renamedAttr(found, names.from, names.to),
      })),
  };
}

/** A tag renamed: the name in its opening and closing tags (`rename-tag`),
 * the rest of its bytes untouched; `next` is the node as the model shows it
 * after (its kind may change with the name). A tag with no children on either
 * side — void or self-closing, before or after — is restated instead:
 * renaming `<img>` to `<Image />` must close it, and a `<div>` becoming an
 * `<img>` loses its content, which only the printer knows how to write. */
export function tagRenameGesture(node: EditorNode, next: EditorNode, options: { readonly urgency: Urgency }): EditGesture {
  const nodeId = node.id;
  assert(next.id === nodeId, 'A renamed node keeps its id');
  const name = next.name;
  assert(name !== undefined, 'A renamed tag has a name');
  if (!Array.isArray(node.children) || !Array.isArray(next.children)) {
    return nodeGesture(nodeId, next, { coalesceKey: undefined, urgency: options.urgency });
  }
  return {
    coalesceKey: undefined,
    urgency: options.urgency,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      return [{ tag: 'rename-tag', target, to: name }];
    },
    apply: (model) => withNode(model, nodeId, () => next),
  };
}

/** The page's root nodes put inside a new wrapper (a layout picked for a page
 * without one): the request wraps the first through the last root node that
 * is not blank text, as they are written (`wrap-nodes`); the effect is the
 * wrapper holding every root node. A page with nothing to wrap has no request. */
export function wrapGesture(model: EditorModel, wrapper: EditorNode): EditGesture {
  const name = wrapper.name;
  assert(name !== undefined, 'A wrapper is a named tag');
  const standing = model.nodes.filter((node) => !blank(node));
  const first = standing[0];
  const last = standing[standing.length - 1];
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (refOf) => {
      const target = first === undefined ? undefined : refOf(first.id);
      const end = last === undefined ? undefined : refOf(last.id);
      if (target === undefined || end === undefined) {
        return undefined;
      }
      return [{ tag: 'wrap-nodes', target, last: end, name }];
    },
    apply: (current) => ({ ...current, nodes: [withChildren(wrapper, current.nodes)] }),
  };
}

/** A wrapper taken away, its children left in its place (a layout removed). */
export function unwrapGesture(nodeId: string): EditGesture {
  return {
    coalesceKey: undefined,
    urgency: true,
    stream: undefined,
    request: (refOf) => {
      const target = refOf(nodeId);
      if (target === undefined) {
        return undefined;
      }
      return [{ tag: 'unwrap-node', target }];
    },
    apply: (model) => {
      const nodes = unwrappedIn(model.nodes, nodeId, 0);
      return nodes === model.nodes ? model : { ...model, nodes };
    },
  };
}

// The list with the node replaced by its children; recursion bounded by the
// tree's depth bound, asserted.
function unwrappedIn(list: readonly EditorNode[], nodeId: string, depth: number): readonly EditorNode[] {
  assert(depth <= LIMITS.treeDepthMax, 'A model is no deeper than its bound');
  for (const [index, node] of list.entries()) {
    const children = node.children ?? [];
    if (node.id === nodeId) {
      return [...list.slice(0, index), ...children, ...list.slice(index + 1)];
    }
    const inner = unwrappedIn(children, nodeId, depth + 1);
    if (inner !== children) {
      return list.map((item, at) => (at === index ? withChildren(node, inner) : item));
    }
  }
  return list;
}
