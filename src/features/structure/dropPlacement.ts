// What a drag over the Navigator may do where it is: the placement model's answer, in the three
// shapes the tree draws. A valid place shows its indicator as it always did; an invalid one with
// a valid neighbour (a doctype over a component: the top of the page) shows the indicator at the
// neighbour and drops there; an invalid one with none shows nothing, gets the not-allowed cursor
// and says why. Pure: the drag in, the verdict out, so the drag states are tested without a DOM.
import type { Drag } from '../../editor/dragState';
import { placementNodeOfItem, resolveTarget, type PlacementEnvironment, type PlacementSubject } from '../../editor/placementCheck';
import type { PlacementMessage } from '../../../shared/page/placement';
import type { TreeView } from '../../editor/treeView';
import type { DropLocation } from './structureModel';

export type DropPlacement =
  | { readonly kind: 'open' }
  | { readonly kind: 'valid'; readonly warning: PlacementMessage | undefined }
  | { readonly kind: 'snap'; readonly to: DropLocation; readonly reason: PlacementMessage }
  | { readonly kind: 'refused'; readonly reason: PlacementMessage };

/** The subject a drag carries, or undefined when nothing is known about it (a drag from another window). */
export function dragSubject(drag: Drag | undefined, environment: PlacementEnvironment): PlacementSubject | undefined {
  if (drag === undefined) {
    return undefined;
  }
  switch (drag.kind) {
    case 'node':
      return { kind: 'existing', id: drag.id };
    case 'component': {
      const node = placementNodeOfItem({ type: 'component', name: drag.name }, environment);
      return node === undefined ? undefined : { kind: 'new', node };
    }
    default: {
      const exhaustive: never = drag;
      return exhaustive;
    }
  }
}

export function dropPlacement(nodes: readonly TreeView[], drag: Drag | undefined, location: DropLocation, environment: PlacementEnvironment): DropPlacement {
  const subject = dragSubject(drag, environment);
  if (subject === undefined) {
    return { kind: 'open' };
  }
  const resolved = resolveTarget(nodes, subject, location, environment);
  switch (resolved.kind) {
    case 'placed':
      return { kind: 'valid', warning: resolved.warning };
    case 'snapped':
      return { kind: 'snap', to: { parentId: resolved.target.parentId, index: resolved.target.index }, reason: resolved.reason };
    case 'refused':
      return { kind: 'refused', reason: resolved.refusal };
    default: {
      const exhaustive: never = resolved;
      return exhaustive;
    }
  }
}
