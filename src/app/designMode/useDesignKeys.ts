// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the keys of the canvas.
//
// They act only while the canvas has the keyboard (the last press was on it), so Delete in a panel never removes a
// frame. With a frame selected, Delete removes it and ⌘D duplicates it; Escape steps from an element out to its
// frame, then to nothing. With an element selected, Delete is the editor's own and removes the element.
import { useEffect, useRef, type RefObject } from 'react';
import { clearSelection, duplicateFrame, placeBeside, removeFrame, selectFrame, type DesignOpsContext } from './designFrameOps';
import { designView, updateDesignView } from './designStore';
import { zoomAt } from './designCamera';
import { EMPTY_FRAME } from './DesignFrameTile';

const ZOOM_STEP = 1.25;

function typing(target: unknown): boolean {
  return target instanceof HTMLElement && (target.matches('input, textarea, select') || target.isContentEditable);
}

/** Zooms about the middle of the canvas. */
function zoomCanvas(plane: HTMLDivElement | undefined, next: (zoom: number) => number): void {
  if (plane === undefined) {
    return;
  }
  updateDesignView((view) =>
    view.camera === undefined ? view : { ...view, camera: zoomAt(view.camera, next(view.camera.zoom), plane.clientWidth / 2, plane.clientHeight / 2) },
  );
}

export function useDesignKeys(context: DesignOpsContext, plane: RefObject<HTMLDivElement>, fit: () => void) {
  const space = useRef<'held' | 'up'>('up');
  const latest = useRef(fit);
  latest.current = fit;
  useEffect(() => {
    const onCanvas = (): boolean => plane.current !== null && document.activeElement === plane.current;
    const take = (event: KeyboardEvent): void => {
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    /**
     * The canvas's zoom keys, from anywhere outside a field: ⌘+ and ⌘- zoom, ⌘0 shows full size, ⇧1 fits every
     * frame. The editor's breakpoint keys (plain digits) act on controls the mode puts away, so they are held.
     */
    const windowKey = (event: KeyboardEvent): boolean => {
      const command = event.metaKey || event.ctrlKey;
      if (command && !event.altKey) {
        const factor = event.key === '=' || event.key === '+' ? ZOOM_STEP : event.key === '-' ? 1 / ZOOM_STEP : undefined;
        if (factor !== undefined) {
          zoomCanvas(plane.current ?? undefined, (zoom) => zoom * factor);
          return true;
        }
        if (event.key === '0') {
          zoomCanvas(plane.current ?? undefined, () => 1);
          return true;
        }
        return false;
      }
      if (command || event.altKey) {
        return false;
      }
      if (event.shiftKey && event.code === 'Digit1') {
        latest.current();
        return true;
      }
      return !event.shiftKey && /^[1-9]$/.test(event.key);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      plane.current?.classList.toggle('is-copying', event.altKey);
      if (!typing(event.target) && windowKey(event)) {
        take(event);
        return;
      }
      if (!onCanvas()) {
        return;
      }
      const view = designView();
      const selection = view.selection;
      const command = event.metaKey || event.ctrlKey;
      if (event.code === 'Space' && !command) {
        space.current = 'held';
        plane.current?.classList.add('is-panning');
        take(event);
      } else if (event.key === 'Escape') {
        if (plane.current?.hasAttribute('data-dm-dragging') === true) {
          return;
        }
        if (selection.kind === 'element') {
          take(event);
          selectFrame(context, selection.frame);
        } else if (selection.kind === 'frame') {
          take(event);
          clearSelection(context);
        }
      } else if (selection.kind !== 'frame' || view.session.kind !== 'on') {
        return;
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && !event.altKey) {
        take(event);
        if (!event.repeat) {
          removeFrame(context, selection.frame);
        }
      } else if (command && event.code === 'KeyD') {
        take(event);
        const width = view.snapshots.get(selection.frame)?.viewportWidthPx ?? EMPTY_FRAME.widthPx;
        if (!event.repeat) {
          duplicateFrame(context, selection.frame, placeBeside(view.session, selection.frame, width));
        }
      }
    };
    const release = (): void => {
      space.current = 'up';
      plane.current?.classList.remove('is-panning', 'is-copying');
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      plane.current?.classList.toggle('is-copying', event.altKey);
      if (event.code === 'Space') {
        release();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', release);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', release);
    };
  }, [context, plane]);
  return space;
}
