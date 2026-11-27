// How the canvas groups its frames, so a value is said once over all the frames that show it: frames that share the
// first split prop's value sit in one box headed with it, within it those that share the next, and so on. A value only
// one frame shows gets no box; a box that would hold nothing but one box takes its header into its own. Each frame is
// captioned with what the boxes around it do not already say. Frames keep the order the split makes them in (each
// prop's values in the order the component lists them). Pure; the canvas page and the Navigator both draw this tree.
import { assert } from '../../../../shared/core/assert';
import { CANVAS_LIMITS, frameKey, type CanvasFrame, type CanvasLevels, type FramePart } from '../../../../shared/properties/componentCanvas';

export interface CanvasFrameLeaf {
  readonly kind: 'frame';
  readonly key: string;
  /** What its caption says: the split values no box around it says. */
  readonly caption: readonly FramePart[];
}

export interface CanvasGroup {
  readonly kind: 'group';
  /** The split values every frame inside shows, as a frame key: the box's name, and its scope. */
  readonly key: string;
  /** What its header says: one split value, or more where a box held only another. */
  readonly header: readonly FramePart[];
  readonly children: readonly CanvasTreeItem[];
}

export type CanvasTreeItem = CanvasFrameLeaf | CanvasGroup;

type Grouped = Pick<CanvasFrame, 'key' | 'parts'>;

export function groupFrames(frames: readonly Grouped[]): readonly CanvasTreeItem[] {
  assert(frames.length <= CANVAS_LIMITS.framesMax, 'A canvas groups a bounded number of frames');
  const tree = level(frames, 0);
  assert(leafCount(tree) === frames.length, 'Every frame is in the tree once');
  return tree;
}

/** The levels a canvas can lay out (componentCanvas.ts CanvasLevels): its groups, and whether its top level goes down. */
export function canvasLevels(items: readonly CanvasTreeItem[], frames: readonly { readonly row: number }[]): CanvasLevels {
  const groups: string[] = [];
  const pending = [...items];
  for (let visited = 0; visited < CANVAS_LIMITS.framesMax * (CANVAS_LIMITS.splitPropsMax + 1); visited++) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    if (next.kind === 'group') {
      groups.push(next.key);
      pending.push(...next.children);
    }
  }
  assert(pending.length === 0, 'Every level is counted');
  return { groups, stacked: items.some((entry) => entry.kind === 'group') || frames.some((frame) => frame.row > 0) };
}

// The items of one level: the frames that share the part at `depth`, grouped. The depth is bounded by the split.
function level(frames: readonly Grouped[], depth: number): readonly CanvasTreeItem[] {
  assert(depth <= CANVAS_LIMITS.splitPropsMax, 'Groups nest no deeper than the split');
  const buckets = new Map<string, Grouped[]>();
  for (const frame of frames) {
    const part = frame.parts[depth];
    // A frame with no value left to share stands on its own.
    const shared = part === undefined ? `\u0000${frame.key}` : frameKey([part]);
    const bucket = buckets.get(shared);
    if (bucket === undefined) {
      buckets.set(shared, [frame]);
    } else {
      bucket.push(frame);
    }
  }
  return [...buckets.values()].map((bucket) => item(bucket, depth));
}

function item(bucket: readonly Grouped[], depth: number): CanvasTreeItem {
  const first = bucket[0];
  assert(first !== undefined, 'A bucket holds a frame');
  if (bucket.length === 1) {
    const rest = first.parts.slice(depth);
    // Every frame is captioned: one whose boxes say all it shows is named by the last of those values.
    return { kind: 'frame', key: first.key, caption: rest.length > 0 ? rest : first.parts.slice(-1) };
  }
  const shared = first.parts.slice(0, depth + 1);
  const part = shared[depth];
  assert(part !== undefined, 'Frames that share a box share its value');
  const children = level(bucket, depth + 1);
  const only = children.length === 1 ? children[0] : undefined;
  if (only?.kind === 'group') {
    return { ...only, header: [part, ...only.header] };
  }
  return { kind: 'group', key: frameKey(shared), header: [part], children };
}

function leafCount(items: readonly CanvasTreeItem[]): number {
  let count = 0;
  const pending = [...items];
  for (let visited = 0; visited < CANVAS_LIMITS.framesMax * (CANVAS_LIMITS.splitPropsMax + 1); visited++) {
    const next = pending.pop();
    if (next === undefined) {
      break;
    }
    if (next.kind === 'frame') {
      count += 1;
    } else {
      pending.push(...next.children);
    }
  }
  return count;
}
