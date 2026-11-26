// Design mode (experimental, removable: docs/design-mode/REMOVE.md): keeps the shown frame and the editor's canvas
// one width (designFrameWidth.ts says how).
import { useEffect, useRef } from 'react';
import { noteCanvasChange } from './designCaptureQueue';
import { adoptFrameWidth, type DesignOpsContext } from './designFrameOps';
import { syncFrameWidth, type WidthSync } from './designFrameWidth';
import { useDesignView } from './designStore';

export function useFrameWidthSync(context: DesignOpsContext): void {
  const view = useDesignView();
  const canvasPx = context.app().canvasWidthPx;
  const session = view.session;
  // While the copy is being rewritten, the person's page reopened, or the mode left, no frame is settled.
  const settled = session.kind === 'on' && view.switching === undefined && view.returning === 'there' && view.phase !== 'leaving';
  const frame = settled ? session.frames.find((entry) => entry.id === session.active) : undefined;
  const id = frame?.id;
  const widthPx = frame?.widthPx;
  const held = useRef<WidthSync | undefined>(undefined);
  useEffect(() => {
    const shown = id === undefined ? undefined : { id, widthPx };
    const { next, action } = syncFrameWidth(held.current, { shown, canvasPx });
    held.current = next;
    switch (action.kind) {
      case 'none':
        return;
      case 'request':
        context.app().requestCanvasWidth(action.widthPx);
        return;
      case 'picture':
        noteCanvasChange();
        return;
      case 'adopt':
        if (id !== undefined) {
          adoptFrameWidth(context, id, action.widthPx);
          noteCanvasChange();
        }
        return;
      default: {
        const exhaustive: never = action;
        throw new Error(`Assertion failed: useFrameWidthSync: ${JSON.stringify(exhaustive)}`);
      }
    }
  }, [context, id, widthPx, canvasPx]);
}
