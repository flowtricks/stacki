// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the keys of the canvas.
//
// They act only while the canvas has the keyboard (the last press was on it), so Delete in a panel never removes a
// frame. With a frame selected, Delete removes it and ⌘D duplicates it; Escape steps from an element out to its
// frame, then to nothing. With an element selected, Delete is the editor's own and removes the element.
import { useEffect, useRef, type RefObject } from 'react';
import { clearSelection, duplicateFrame, placeBeside, removeFrame, selectFrame, type DesignOpsContext } from './designFrameOps';
import { designView } from './designStore';
import { EMPTY_FRAME } from './DesignFrameTile';

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
    const onKeyDown = (event: KeyboardEvent): void => {
      plane.current?.classList.toggle('is-copying', event.altKey);
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
      } else if (event.shiftKey && !command && event.code === 'Digit1') {
        take(event);
        latest.current();
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
