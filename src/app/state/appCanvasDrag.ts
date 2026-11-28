// The drag controller: turns what the canvas frame says about a drag (src/features/preview/canvasDragMessages.ts)
// into one published decision (src/editor/canvasDragSession.ts), and the drop into the same edit a Navigator drop
// makes (`moveNode`, `onDropComponent`: the placement gate, the atomic write, one undo step, the optimistic canvas).
//
// While a drag is under way the Navigator is open and shows the place too: if another left panel was showing, the
// Navigator takes its place for the drag and gives it back when the drag ends, however it ends.
//
// The frame starts a drag with a press on a node in select mode; a component dragged from the palette, or a row
// dragged from the Navigator, crosses into the frame as a native drag and is followed the same way. The editor
// knows what a native drag carries (src/editor/dragState.ts): the frame cannot read its payload.

import { useCallback, useEffect, useRef } from 'react';
import { canPanel } from '../../lib/roleAccess';
import { useCurrentRole } from '../../lib/useCurrentRole';
import { publishCanvasDrag, type CanvasDragView } from '../../editor/canvasDragSession';
import {
  dropActionOf,
  dropView,
  levelsOfPaths,
  stickyView,
  type ShownDrop,
  startDropSession,
  subjectOf,
  type DropInsertable,
  type DropSession,
} from '../../editor/canvasDropView';
import { getDrag } from '../../editor/dragState';
import { documentOfPath } from '../../editor/placementCheck';
import { nodeAtPath } from '../../editor/editorTree';
import { findEditorNodeById } from '../../editor/pageState';
import { trailOf } from '../model/pageGestures';
import type { CanvasDragMessage } from '../../features/preview/canvasDragMessages';
import type { LeftTab } from '../appTypes';
import type React from 'react';
import type { EditorNode } from '../../editor/pageView';
import type { InsertTarget } from '../../editor/insertTarget';
import type { InsertDragChoice } from '../../editor/insertDragData';

interface Active {
  readonly session: DropSession;
  readonly source: 'pointer' | 'native';
  /** The left panel to give back when the drag ends; `keep` when the Navigator was already showing. */
  readonly restore: { readonly kind: 'keep' } | { readonly kind: 'tab'; readonly tab: LeftTab };
  /** The place on screen: the drop writes exactly what it shows (stickyView may hold it near a boundary). */
  shown: ShownDrop | undefined;
  view: CanvasDragView | undefined;
  allowed: boolean | undefined;
}

export type CanvasDragHandler = (drag: CanvasDragMessage, reply: (message: unknown) => void) => void;

/** What the controller needs of the editor: the open file, the two drop edits, the selection and the left panel. */
export interface CanvasDragHost {
  readonly pageState: { readonly editable: true; readonly model: { readonly nodes: readonly EditorNode[] } } | { readonly editable: false } | undefined;
  readonly editedRel: string | undefined;
  readonly insertables: readonly DropInsertable[];
  readonly currentPage: { readonly path?: string | undefined } | undefined;
  readonly moveNode: (nodeId: string, target: InsertTarget) => void;
  readonly onDropComponent: (name: string, target: InsertTarget) => void;
  /** Inserts a tile from the Add elements panel at the drop's place (appShortcuts.ts, the click's path too). */
  readonly insertItemAt: (choice: InsertDragChoice, target: InsertTarget) => void;
  readonly setSelectedId: (id: string | undefined) => void;
  readonly setRevealTick: React.Dispatch<React.SetStateAction<number>>;
  readonly leftTab: LeftTab;
  readonly setLeftTab: React.Dispatch<React.SetStateAction<LeftTab>>;
  readonly pathFor: (id: string | undefined) => string | undefined;
}

export function useCanvasDrag(app: CanvasDragHost): CanvasDragHandler {
  const role = useCurrentRole();
  const latest = useRef({ app, role });
  latest.current = { app, role };
  const active = useRef<Active | undefined>(undefined);

  const end = useCallback((): void => {
    const ending = active.current;
    active.current = undefined;
    publishCanvasDrag(undefined);
    if (ending?.restore.kind === 'tab') {
      // Give the panel back only if the person has not picked another one during the drag.
      const restored = ending.restore.tab;
      latest.current.app.setLeftTab((tab) => (tab === 'navigator' ? restored : tab));
    }
  }, []);

  // A native drag that ends anywhere (dropped on a panel, or abandoned with Escape) ends the canvas's picture of it.
  useEffect(() => {
    const finish = (): void => {
      if (active.current?.source === 'native') {
        end();
      }
    };
    window.addEventListener('dragend', finish);
    window.addEventListener('drop', finish);
    return () => {
      window.removeEventListener('dragend', finish);
      window.removeEventListener('drop', finish);
    };
  }, [end]);

  return useCallback(
    (drag: CanvasDragMessage, reply: (message: unknown) => void): void => {
      const { app } = latest.current;
      switch (drag.kind) {
        case 'drag-start': {
          end();
          const started = startPointerDrag(latest.current, drag.path);
          if (started === undefined) {
            reply({ type: 'avb:drag-stop' });
            return;
          }
          active.current = started;
          return;
        }
        case 'drag-over': {
          if (active.current === undefined && drag.source === 'native' && !drag.outside) {
            active.current = startNativeDrag(latest.current);
          }
          const current = active.current;
          if (current === undefined) {
            return;
          }
          const levels = levelsOfPaths(drag.levels, current.session.tree, (path) => nodeIdOfPath(app, path));
          const next = dropView(current.session, { levels, pointer: { x: drag.x, y: drag.y }, dragged: drag.dragged, outside: drag.outside }, (id) =>
            app.pathFor(id),
          );
          current.shown = stickyView(current.shown, next);
          const view = current.shown.view;
          current.view = view;
          publishCanvasDrag(view);
          const allowed = view.verdict.kind === 'valid' || view.verdict.kind === 'snap' || view.verdict.kind === 'noop';
          if (allowed !== current.allowed && drag.source === 'pointer') {
            current.allowed = allowed;
            reply({ type: 'avb:drag-feedback', allowed });
          }
          return;
        }
        case 'drag-end': {
          const current = active.current;
          end();
          if (current?.view === undefined || drag.outside) {
            return; // Released outside the page, or before anything was measured: the drag is cancelled.
          }
          drop(app, current.session, current.view);
          return;
        }
        case 'drag-cancel':
          end();
          return;
        default: {
          const exhaustive: never = drag;
          return exhaustive;
        }
      }
    },
    [end],
  );
}

function startPointerDrag(context: { readonly app: CanvasDragHost; readonly role: ReturnType<typeof useCurrentRole> }, path: string): Active | undefined {
  const { app } = context;
  const state = app.pageState;
  if (state === undefined || !state.editable || context.role.editorOff.has('drag')) {
    return undefined;
  }
  const id = nodeIdOfPath(app, path);
  const node = id === undefined ? undefined : nodeAtPath(state.model.nodes, trailOf(path));
  if (node === undefined) {
    return undefined;
  }
  // The rows the Navigator never lets go of: a chunk group and a condition's branch move with their owner.
  if (node.kind === 'chunk-group' || node.kind === 'branch') {
    return undefined;
  }
  const session = startDropSession(state.model.nodes, subjectOf(node, node.name ?? node.kind), environmentOf(app));
  return { session, source: 'pointer', restore: openNavigator(context), shown: undefined, view: undefined, allowed: undefined };
}

function startNativeDrag(context: { readonly app: CanvasDragHost; readonly role: ReturnType<typeof useCurrentRole> }): Active | undefined {
  const { app } = context;
  const state = app.pageState;
  const native = getDrag();
  if (state === undefined || !state.editable || native === undefined) {
    return undefined;
  }
  // A row dragged from the Navigator moves an element; a component or an Add elements tile inserts one.
  if (context.role.editorOff.has(native.kind === 'node' ? 'drag' : 'insert')) {
    return undefined;
  }
  switch (native.kind) {
    case 'component': {
      const session = startDropSession(
        state.model.nodes,
        { kind: 'new', label: native.name, ...(native.path === undefined ? {} : { path: native.path }) },
        environmentOf(app),
      );
      return { session, source: 'native', restore: openNavigator(context), shown: undefined, view: undefined, allowed: undefined };
    }
    case 'insert': {
      // The Add elements panel shows the Navigator over itself for the drag (elementDragNavigator.ts), so the left
      // panel stays as it is: switching it would take the dragged tile out of the page and lose the drag's end.
      const session = startDropSession(state.model.nodes, { kind: 'new', label: native.label, choice: native.choice }, environmentOf(app));
      return { session, source: 'native', restore: { kind: 'keep' }, shown: undefined, view: undefined, allowed: undefined };
    }
    case 'node': {
      const node = findEditorNodeById(state.model.nodes, native.id);
      if (node === undefined) {
        return undefined;
      }
      // Dragged from the Navigator: it is already showing, so nothing to open or give back.
      const session = startDropSession(state.model.nodes, subjectOf(node, node.name ?? node.kind), environmentOf(app));
      return { session, source: 'native', restore: { kind: 'keep' }, shown: undefined, view: undefined, allowed: undefined };
    }
    default: {
      const exhaustive: never = native;
      return exhaustive;
    }
  }
}

// The drop: the same edits a Navigator drop makes. The placement gate inside them asks the rule again; a refused
// place, a release over nothing and a drop where the node already stands write nothing.
function drop(app: CanvasDragHost, session: DropSession, view: CanvasDragView): void {
  const action = dropActionOf(session.subject, view);
  switch (action.kind) {
    case 'none':
      return;
    case 'insert':
      app.onDropComponent(action.component, action.place);
      return;
    case 'insertChoice':
      app.insertItemAt(action.choice, action.place);
      return;
    case 'move':
      app.moveNode(action.id, action.place);
      // The moved node stays the selection, and the Navigator brings its row into view.
      app.setSelectedId(action.id);
      app.setRevealTick((count) => count + 1);
      return;
    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function openNavigator(context: { readonly app: CanvasDragHost; readonly role: ReturnType<typeof useCurrentRole> }): Active['restore'] {
  const { app, role } = context;
  if (app.leftTab === 'navigator' || !canPanel(role, 'navigator')) {
    return { kind: 'keep' };
  }
  const tab = app.leftTab;
  app.setLeftTab('navigator');
  return { kind: 'tab', tab };
}

function environmentOf(app: CanvasDragHost) {
  return { insertables: app.insertables, document: documentOfPath(app.currentPage?.path) };
}

// A canvas path names a node of the open file: `0.2.1` on a page, `Card.astro|0.2` inside an open component.
function nodeIdOfPath(app: CanvasDragHost, path: string): string | undefined {
  const nodes = app.pageState?.editable === true ? app.pageState.model.nodes : undefined;
  if (nodes === undefined) {
    return undefined;
  }
  const scope = app.editedRel ? `${app.editedRel}|` : '';
  if (scope === '' ? path.includes('|') : !path.startsWith(scope)) {
    return undefined;
  }
  return nodeAtPath(nodes, trailOf(path))?.id;
}
