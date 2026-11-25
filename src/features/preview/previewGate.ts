// Which canvas events the editor acts on (plan §9, step 7; invariant 6 of §10:
// a stale preview cannot submit a silently remapped edit).
//
// A click names a node by its index path in the rendering the canvas shows. The
// editor selects that path in the model IT shows, and every edit after that is
// authored against the editor's page — so if the rendering came from other
// bytes, the click would select whatever node now sits at that path, and the
// edit would apply to it, silently. The gate accepts an event only when:
//
//   1. its token is the frame's latest rendering (the frame did not re-render
//      under the pointer);
//   2. the file open for editing rendered from the bytes the editor shows — a
//      clean page's own checksum, or, while edits are unsaved, the origin the
//      shown model was cloned from, as long as those edits left every path
//      meaning the same node (text typed, not a node moved);
//   3. every file that rendered — page, layouts, components — still holds the
//      bytes its stamp names on disk (main reads them: preview:check).
//
// Hover is a picture, not a selection: it needs (1) only, so it never waits.
import { assert } from '../../../shared/core/assert';
import type { Digest } from '../../../shared/core/brand';
import { LIMITS } from '../../../shared/core/limits';
import { judgeEventToken, judgeShownFile, type PreviewRender, type PreviewVerdict } from '../../../shared/page/previewToken';
import type { EditorPageState } from '../../editor/pageState';

/** The file open for editing, as the gate needs it. */
export interface ShownFile {
  /** Project-relative, `/`-separated — the path its stamp carries. */
  readonly file: string;
  readonly state: EditorPageState;
  /** Empty for a page; a component namespace while editing its source. */
  readonly scope?: string;
}

/** Ask main whether every stamped file still holds its stamped bytes. */
export type CheckRender = (render: PreviewRender) => Promise<PreviewVerdict>;

/** Judge a click or a double-click. `shown()` is read again after main answers:
 * the page can change while the disk is being read, and the answer must hold
 * for the page the selection will land in. */
export async function judgeCanvasEvent(
  token: Digest | undefined,
  render: PreviewRender | undefined,
  check: CheckRender,
  shown: () => ShownFile | undefined,
): Promise<PreviewVerdict> {
  const before = judgeLocally(token, render, shown());
  if (before.tag === 'stale') {
    return before;
  }
  assert(render !== undefined, 'A current token names a rendering');
  const disk = await check(render);
  if (disk.tag === 'stale') {
    return disk;
  }
  // The same rendering, judged against the page as it is now.
  return judgeLocally(token, render, shown());
}

/** Steps 1 and 2: no disk, no waiting. */
export function judgeLocally(token: Digest | undefined, render: PreviewRender | undefined, shown: ShownFile | undefined): PreviewVerdict {
  const latest = judgeEventToken(token, render);
  if (latest.tag === 'stale') {
    return latest;
  }
  assert(render !== undefined, 'A current token names a rendering');
  if (shown === undefined) {
    return latest; // Nothing open for editing: no node is selected from this.
  }
  if (shown.state.editable && shown.state.model.format !== undefined) {
    // A Markdown or MDX page carries no stamp: its markers come from the
    // Markdown processor's tree (markerConfig.ts, avbSatteriMarkers), which never sees
    // the file's bytes, so no marker can name them. Its layout's stamps are
    // still checked on disk, and every edit is stated against the editor's own
    // parse and checked by main (tracker, step 10: carried).
    return latest;
  }
  return judgeShownFile(render, shown.file, shownChecksum(shown.state));
}

/** The checksum of the bytes whose parse has the paths the editor's model has,
 * or undefined when no disk version does (a node added, moved or removed and
 * not yet saved). */
export function shownChecksum(state: EditorPageState): Digest | undefined {
  if (state.save.tag === 'clean') {
    return state.save.checksum;
  }
  if (!state.editable) {
    return undefined;
  }
  const origin = state.origin;
  if (origin === undefined) {
    return undefined;
  }
  return sameShape(origin.model.nodes, state.model.nodes) ? origin.checksum : undefined;
}

/** Whether two trees give every index path the same node: the same handles, kinds
 * and names at the same places, the same number of children under each. Text and
 * attribute values may differ — they do not move a path. */
export function sameShape(left: readonly ShapeNode[], right: readonly ShapeNode[]): boolean {
  const stack: [readonly ShapeNode[], readonly ShapeNode[]][] = [[left, right]];
  for (let visited = 0; visited <= LIMITS.treeNodesMax; visited++) {
    const pair = stack.pop();
    if (pair === undefined) {
      return true;
    }
    const [leftLevel, rightLevel] = pair;
    if (leftLevel.length !== rightLevel.length) {
      return false;
    }
    for (let index = 0; index < leftLevel.length; index++) {
      const x = leftLevel[index];
      const y = rightLevel[index];
      assert(x !== undefined, 'The index lies inside the left list');
      assert(y !== undefined, 'The index lies inside the right list');
      if (x.id !== y.id) {
        return false;
      }
      if (x.kind !== y.kind) {
        return false;
      }
      if (x.name !== y.name) {
        return false;
      }
      stack.push([x.children ?? [], y.children ?? []]);
    }
  }
  throw new Error('Assertion failed: a page tree stays inside its node bound');
}

/** The part of a page node its path depends on. */
export interface ShapeNode {
  readonly id: string;
  readonly kind: string;
  readonly name?: string | undefined;
  readonly children?: readonly ShapeNode[] | undefined;
}
