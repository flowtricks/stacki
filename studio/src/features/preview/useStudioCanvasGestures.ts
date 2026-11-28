// Which gestures the canvas frame takes, for the active role, and the drag that
// reorders elements on it. The frame measures and the shared drop model decides
// (Desktop's canvasDropView.ts, drawn by CanvasDropOverlay), so the canvas drags
// here exactly as on Desktop; the drop sends the same `move` action the Navigator
// sends, and the server holds it to the role (rooms.ts).
import { useCallback, useEffect, useRef } from 'react';
import { parsePreviewMessage } from '../../../vendor/stacki/src/features/preview/previewMessages';
import type { CanvasDragMessage } from '../../../vendor/stacki/src/features/preview/canvasDragMessages';
import { publishCanvasDrag, type CanvasDragView } from '../../../vendor/stacki/src/editor/canvasDragSession';
import {
  dropActionOf,
  dropView,
  levelsOfPaths,
  startDropSession,
  stickyView,
  subjectOf,
  type DropSession,
  type ShownDrop,
} from '../../../vendor/stacki/src/editor/canvasDropView';
import { documentOfPath } from '../../../vendor/stacki/src/editor/placementCheck';
import { planCanvasMove, type CanvasMove } from '../../../vendor/stacki/shared/page/canvasMove';
import { parsePageModel } from '../../../vendor/stacki/shared/page/pageNode';
import type { RoleView } from '../../../vendor/stacki/shared/properties/projectRoles';
import { dropTarget } from '../navigator/dropTarget';
import { pathFor } from '../project/previewSelection';
import { flatten, parsePage, type ParserNode, type TreeAction } from '../source/source';
import type { Component } from '../project/projectClient';
import { canvasGestures } from '../roles/canvasGestures';
import type { usePreview } from './usePreview';

export interface CanvasGestureHost {
  readonly role: RoleView;
  /** The open page's file, project relative. */
  readonly file: string;
  /** The source as it is now; undefined while the document is not ready. */
  readonly source: string | undefined;
  readonly nodes: readonly ParserNode[];
  readonly components: readonly Component[];
  readonly preview: Pick<ReturnType<typeof usePreview>, 'frame' | 'url' | 'send' | 'subscribeLoad'>;
  readonly select: (id: string) => void;
  readonly move: (action: TreeAction, canvasMove: CanvasMove | undefined) => void;
}

interface Active {
  readonly session: DropSession;
  shown: ShownDrop | undefined;
  view: CanvasDragView | undefined;
  allowed: boolean | undefined;
}

/** Tells the frame which gestures to take, and follows its drags. */
export function useStudioCanvasGestures(host: CanvasGestureHost): void {
  useGestureMessage(host);
  const latest = useRef(host);
  latest.current = host;
  const active = useRef<Active>();
  const end = useCallback(() => {
    active.current = undefined;
    publishCanvasDrag(undefined);
  }, []);
  const { frame, url } = host.preview;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>): void => {
      const element = frame.current;
      if (element === null || event.source !== element.contentWindow || !sameOrigin(url, event.origin)) {
        return;
      }
      const message = parsePreviewMessage(event.data);
      if (message?.kind === 'canvas-drag') {
        follow(latest.current, active, end, message.drag);
      }
    };
    window.addEventListener('message', receive);
    return () => {
      window.removeEventListener('message', receive);
      end();
    };
  }, [frame, url, end]);
}

/** Whether `origin` is the origin the canvas was loaded from. */
export function sameOrigin(url: string | undefined, origin: string): boolean {
  return url !== undefined && new URL(url, location.origin).origin === origin;
}

// The frame starts with every gesture off and hears what this role takes, after each load and each change.
function useGestureMessage(host: CanvasGestureHost): void {
  const gestures = canvasGestures(host.role);
  const send = useRef(host.preview.send);
  send.current = host.preview.send;
  const { subscribeLoad, url } = host.preview;
  useEffect(
    () => subscribeLoad(() => send.current({ type: 'studio:gestures', drag: gestures.drag, images: gestures.images })),
    [subscribeLoad, url, gestures.drag, gestures.images],
  );
}

function follow(host: CanvasGestureHost, active: { current: Active | undefined }, end: () => void, drag: CanvasDragMessage): void {
  switch (drag.kind) {
    case 'drag-start': {
      end();
      const session = canvasGestures(host.role).drag ? sessionFor(host, drag.path) : undefined;
      if (session === undefined) {
        host.preview.send({ type: 'avb:drag-stop' });
        return;
      }
      active.current = { session, shown: undefined, view: undefined, allowed: undefined };
      return;
    }
    case 'drag-over': {
      const current = active.current;
      if (current === undefined) {
        return;
      }
      const levels = levelsOfPaths(drag.levels, current.session.tree, (path) => nodeIdOfPath(host, path));
      const next = dropView(current.session, { levels, pointer: { x: drag.x, y: drag.y }, dragged: drag.dragged, outside: drag.outside }, pathFor);
      current.shown = stickyView(current.shown, next);
      current.view = current.shown.view;
      publishCanvasDrag(current.view);
      const kind = current.view.verdict.kind;
      const allowed = kind === 'valid' || kind === 'snap' || kind === 'noop';
      if (allowed !== current.allowed && drag.source === 'pointer') {
        current.allowed = allowed;
        host.preview.send({ type: 'avb:drag-feedback', allowed });
      }
      return;
    }
    case 'drag-end': {
      const current = active.current;
      end();
      if (current?.view !== undefined && !drag.outside) {
        drop(host, current.session, current.view);
      }
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
}

function sessionFor(host: CanvasGestureHost, path: string): DropSession | undefined {
  const parsed = host.source === undefined ? undefined : parsePage(host.source, { locs: true });
  const id = nodeIdOfPath(host, path);
  if (parsed === undefined || !parsed.editable || id === undefined) {
    return undefined;
  }
  const tree = parsePageModel(parsed.model).nodes;
  const raw = flatten(parsed.model.nodes).find((node) => node.id === id);
  // The rows the Navigator never lets go of: the layout, and a chunk group or a branch, which move with their owner.
  if (raw === undefined || id === 'layout' || raw.kind === 'chunk-group' || raw.kind === 'branch') {
    return undefined;
  }
  const node = findNode(tree, id);
  if (node === undefined) {
    return undefined;
  }
  return startDropSession(tree, subjectOf(node, raw.name ?? raw.kind), {
    insertables: host.components.map((component) => ({
      name: component.name,
      slots: component.slots,
      ...(component.renderTag === undefined ? {} : { renderTag: component.renderTag }),
    })),
    document: documentOfPath(`studio/${host.file}`),
  });
}

type TreeNodes = ReturnType<typeof parsePageModel>['nodes'];

function findNode(nodes: TreeNodes, id: string): TreeNodes[number] | undefined {
  const queue = [...nodes];
  for (let index = 0; index < queue.length && index < 20_000; index++) {
    const node = queue[index];
    if (node === undefined) {
      continue;
    }
    if (node.id === id) {
      return node;
    }
    if ('children' in node) {
      queue.push(...(node.children ?? []));
    }
  }
  return undefined;
}

// A canvas path names a node of the open file: `0.2.1` on a page, `src/components/Card.astro|0.2` inside an open component.
function nodeIdOfPath(host: CanvasGestureHost, path: string): string | undefined {
  const scope = `${host.file}|`;
  const local = path.startsWith(scope) ? path.slice(scope.length) : path;
  if (local.includes('|')) {
    return undefined;
  }
  const id = local === '0' && host.nodes[0]?.id === 'layout' ? 'layout' : `n${local}`;
  return flatten(host.nodes).some((node) => node.id === id) ? id : undefined;
}

function drop(host: CanvasGestureHost, session: DropSession, view: CanvasDragView): void {
  const action = dropActionOf(session.subject, view);
  if (action.kind !== 'move') {
    return;
  }
  const location = { parentId: action.place.parentId, index: action.place.index };
  const destination = dropTarget(host.nodes, location);
  if (destination.target === action.id) {
    return;
  }
  host.move({ kind: 'move', node: action.id, ...destination }, planCanvasMove(host.nodes, action.id, location, pathFor));
  host.select(action.id);
}
