// What's currently being dragged, shared across panels.
//
// dragover can't read dataTransfer payloads (only their type names), so the
// drop targets have no way to ask "is this a <p>?" while the pointer is
// moving — which is exactly when an invalid drop needs to be refused. Drags
// never leave this window, so a module-level record is enough.
//
// { kind: 'node' | 'component' | 'insert', tag?: string, nodeKind?: string, id?: string }
import type { InsertDragChoice } from './insertDragData';

export type Drag =
  /** `path` is the component's file, when the palette knows it: two components can share a name. */
  | { readonly kind: 'component'; readonly name: string; readonly path?: string }
  /** A new element or node type from the Add elements panel; `label` names it on the canvas's chip. */
  | { readonly kind: 'insert'; readonly choice: InsertDragChoice; readonly label: string }
  | {
      readonly kind: 'node';
      readonly id: string;
      readonly nodeKind: string;
      readonly tag?: string;
    };

// One window owns this single slot; `undefined` means nothing is being dragged.
let current: Drag | undefined;

export function setDrag(info: Drag | undefined): void {
  current = info;
}

export function clearDrag(): void {
  current = undefined;
}

export function getDrag(): Drag | undefined {
  return current;
}

/** What a drag may do where it lands. DataTransfer is the platform's record of
 * the drag, and the drag API takes the effect as an assignment on it. */
export function allowDragEffect(transfer: DataTransfer, effect: 'move' | 'copy'): void {
  // eslint-disable-next-line no-param-reassign -- The drag API is an assignment on DataTransfer.
  transfer.effectAllowed = effect;
}
