// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the pointer on the canvas.
//
// The canvas hears every pointer itself (a frame's iframe takes none), so one place decides what a gesture is:
// a press on a frame's name selects the frame and a drag moves it; a press in a frame's page selects the element
// under it; Option-drag anywhere on a frame drags a copy out of it; the space between frames pans, and so does any
// drag with Space held or the middle button. A selected frame is also dragged by its page.
import { useCallback, useEffect, useRef, useState, type PointerEvent, type RefObject } from 'react';
import { parseDesignFrameId, type DesignFrameId, type DesignPlace } from '../../../shared/ipc/designSession';
import type { DesignNodeAt } from '../../../shared/ipc/designSnapshot';
import { nodeAtFramePoint } from './designFrameDom';
import {
  clearSelection,
  clampPlace,
  duplicateFrame,
  mayDuplicate,
  moveFrame,
  nextFrameId,
  selectElement,
  selectFrame,
  type DesignOpsContext,
} from './designFrameOps';
import { designView, updateDesignView, type DesignCamera } from './designStore';

/** A press that moves this far is a drag. */
const DRAG_PX = 4;

export type DesignDrag =
  | { readonly kind: 'move'; readonly frame: DesignFrameId; readonly at: DesignPlace }
  /** A copy on its way out of `source`, already keyed by the id it will have. */
  | { readonly kind: 'copy'; readonly source: DesignFrameId; readonly id: DesignFrameId; readonly at: DesignPlace };

export interface DesignHover {
  readonly frame: DesignFrameId;
  readonly node: DesignNodeAt;
}

interface Press {
  readonly pointer: number;
  readonly x: number;
  readonly y: number;
  readonly target: 'board' | { readonly frame: DesignFrameId; readonly part: 'title' | 'body' };
  readonly intent: 'pan' | 'pick' | 'copy';
  readonly camera: DesignCamera;
  state: 'pressed' | 'dragging';
}

interface PressedTile {
  readonly frame: DesignFrameId;
  readonly part: 'title' | 'body';
  readonly element: HTMLElement;
}

export function tileAt(target: unknown): PressedTile | undefined {
  if (!(target instanceof Element)) {
    return undefined;
  }
  const part = target.closest<HTMLElement>('[data-dm-part]');
  const tile = part?.closest<HTMLElement>('[data-dm-tile]');
  if (part === null || tile === null || tile === undefined || tile.dataset['dmGhost'] !== undefined) {
    return undefined;
  }
  return {
    frame: parseDesignFrameId(tile.dataset['dmTile']),
    part: part.dataset['dmPart'] === 'title' ? 'title' : 'body',
    element: part,
  };
}

/** The element under a screen point of a frame's page. */
function nodeUnder(pressed: PressedTile, clientX: number, clientY: number): DesignNodeAt | undefined {
  // The shown document: a replacement still loading over it is hidden.
  const frame = [...pressed.element.querySelectorAll('iframe')].find((entry) => entry.style.visibility !== 'hidden');
  const document = frame?.contentDocument ?? undefined;
  const camera = designView().camera;
  if (document === undefined || camera === undefined) {
    return undefined;
  }
  const box = pressed.element.getBoundingClientRect();
  return nodeAtFramePoint(document, (clientX - box.left) / camera.zoom, (clientY - box.top) / camera.zoom);
}

function framePlace(frame: DesignFrameId): DesignPlace | undefined {
  const session = designView().session;
  return session.kind === 'on' ? session.frames.find((entry) => entry.id === frame)?.at : undefined;
}

export function useDesignGestures(context: DesignOpsContext, plane: RefObject<HTMLDivElement>, space: RefObject<'held' | 'up'>) {
  const press = useRef<Press | undefined>(undefined);
  const [drag, setDrag] = useState<DesignDrag | undefined>(undefined);
  const dragRef = useRef<DesignDrag | undefined>(undefined);
  const [hover, setHover] = useState<DesignHover | undefined>(undefined);
  const showDrag = useCallback((next: DesignDrag | undefined) => {
    dragRef.current = next;
    setDrag(next);
  }, []);
  const unlisten = useRef<(() => void) | undefined>(undefined);
  const end = useCallback((): Press | undefined => {
    const held = press.current;
    press.current = undefined;
    unlisten.current?.();
    unlisten.current = undefined;
    return held;
  }, []);
  const cancel = useCallback(() => {
    end();
    showDrag(undefined);
  }, [end, showDrag]);
  useEffect(() => () => unlisten.current?.(), []);
  // Escape lets go of a drag without doing it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && press.current?.state === 'dragging') {
        event.preventDefault();
        event.stopImmediatePropagation();
        cancel();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cancel]);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.target instanceof Element && event.target.closest('input') !== null) {
      return;
    }
    const camera = designView().camera;
    if (camera === undefined) {
      return;
    }
    // A press whose release never arrived is let go of, so it is never finished by a later one.
    cancel();
    // The canvas takes the keyboard, so Delete and Escape act on what is picked here; a field being typed in commits.
    event.preventDefault();
    plane.current?.focus({ preventScroll: true });
    if (event.button !== 0 && event.button !== 1) {
      return;
    }
    const tile = tileAt(event.target);
    const panning = event.button === 1 || space.current === 'held' || tile === undefined;
    event.currentTarget.setPointerCapture(event.pointerId);
    setHover(undefined);
    press.current = {
      pointer: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      target: tile === undefined ? 'board' : { frame: tile.frame, part: tile.part },
      intent: panning ? 'pan' : event.altKey ? 'copy' : 'pick',
      camera,
      state: 'pressed',
    };
    unlisten.current = listenUntilRelease();
  };

  const dragTo = (held: Press, dx: number, dy: number): void => {
    if (held.intent === 'pan') {
      updateDesignView((view) => ({ ...view, camera: { ...held.camera, x: held.camera.x + dx, y: held.camera.y + dy } }));
      return;
    }
    if (held.target === 'board') {
      return;
    }
    const origin = framePlace(held.target.frame);
    if (origin === undefined) {
      return;
    }
    const at = clampPlace({ x: origin.x + dx / held.camera.zoom, y: origin.y + dy / held.camera.zoom });
    if (held.intent === 'copy') {
      const session = designView().session;
      const current = dragRef.current;
      if (current?.kind === 'copy') {
        showDrag({ ...current, at });
      } else if (session.kind === 'on' && mayDuplicate(context)) {
        showDrag({ kind: 'copy', source: held.target.frame, id: nextFrameId(session), at });
      } else {
        end();
      }
      return;
    }
    const selection = designView().selection;
    const selected = selection.kind === 'frame' && selection.frame === held.target.frame;
    if (held.target.part === 'title' || selected) {
      showDrag({ kind: 'move', frame: held.target.frame, at });
    }
  };

  /** The pointer over the canvas with nothing pressed: what a click would pick. */
  const onHover = (event: PointerEvent<HTMLDivElement>): void => {
    if (press.current === undefined) {
      const tile = tileAt(event.target);
      const node = tile?.part === 'body' && !event.altKey ? nodeUnder(tile, event.clientX, event.clientY) : undefined;
      const next = tile === undefined || node === undefined ? undefined : { frame: tile.frame, node };
      setHover((current) =>
        current?.frame === next?.frame && current?.node.path === next?.node.path && current?.node.copy === next?.node.copy ? current : next,
      );
    }
  };

  const onPressMove = (event: globalThis.PointerEvent): void => {
    const held = press.current;
    if (held === undefined || held.pointer !== event.pointerId) {
      return;
    }
    const dx = event.clientX - held.x;
    const dy = event.clientY - held.y;
    if (held.state === 'pressed') {
      if (Math.hypot(dx, dy) < DRAG_PX) {
        return;
      }
      held.state = 'dragging';
    }
    dragTo(held, dx, dy);
  };

  const click = (held: Press, event: globalThis.PointerEvent): void => {
    if (held.target === 'board') {
      clearSelection(context);
      return;
    }
    const tile = tileAt(document.elementFromPoint(event.clientX, event.clientY));
    if (held.target.part === 'body' && held.intent === 'pick' && tile !== undefined) {
      const node = nodeUnder(tile, event.clientX, event.clientY);
      if (node !== undefined) {
        selectElement(context, held.target.frame, node.path, node.copy);
        return;
      }
    }
    selectFrame(context, held.target.frame);
  };

  const onRelease = (event: globalThis.PointerEvent): void => {
    if (press.current?.pointer !== event.pointerId) {
      return;
    }
    const held = end();
    if (held === undefined) {
      return;
    }
    const done = dragRef.current;
    showDrag(undefined);
    if (held.state === 'pressed') {
      if (event.button === 0) {
        click(held, event);
      }
    } else if (done?.kind === 'copy') {
      duplicateFrame(context, done.source, done.at);
    } else if (done?.kind === 'move') {
      moveFrame(context, done.frame, done.at);
    }
  };

  // The rest of a press is heard on the window: a drag may leave the canvas, and its release must still arrive
  // there if the canvas loses the pointer's capture.
  const listeners = useRef({ onPressMove, onRelease });
  listeners.current = { onPressMove, onRelease };
  const listenUntilRelease = (): (() => void) => {
    const move = (event: globalThis.PointerEvent): void => listeners.current.onPressMove(event);
    const release = (event: globalThis.PointerEvent): void => listeners.current.onRelease(event);
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
    };
  };

  return {
    drag,
    hover,
    handlers: {
      onPointerDown,
      onPointerMove: onHover,
      onPointerLeave: () => setHover(undefined),
    },
  };
}
