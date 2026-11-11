// The editor's half of canvas click capture (canvasCapture.ts), shared by
// Desktop (src/app/shell/DesktopApps.tsx) and Studio (StudioApps.tsx). It
// installs the click handler the canvas asks before selecting
// (src/ui/canvasClickSlot.ts), cancels the capture on Escape — pressed in the
// editor or forwarded from the canvas frame, which both reach this window's
// keydown — and tells the canvas frame which cursor to show. It also installs
// the canvas hit test an overlay drag asks (overlayDrag.ts), which resolves a
// point to a node exactly as a captured click is resolved.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { AppCanvasCursor } from '../../../shared/properties/appsRpc';
import { setCanvasClickHandler } from '../../ui/canvasClickSlot';
import { queryCanvasPoint, type CanvasLayer } from '../../ui/canvasPointQuery';
import type { AppNodeLayer } from '../../../shared/properties/appsRpc';
import { appHostNode, appNodeRefHost, canvasCapture, setCanvasPageReader, setCanvasPointLocator, setInsertDropLocator } from './appsRuntime';
import { canvasClickPayload } from './canvasCapture';
import { nodeLayers } from './nodeRefs';

export interface CanvasCaptureHost {
  /** The open page's node id for a canvas path, or undefined over markup the open file does not own. */
  readonly nodeIdForPath: (path: string) => string | undefined;
  /** Shows the cursor over the canvas frame; undefined puts the editor's own back. */
  readonly sendCursor: (cursor: AppCanvasCursor | undefined) => void;
  /** The page the canvas renders, relative to the project: its markup's paths carry no file (node refs, nodeRefs.ts). */
  readonly canvasPage: () => string | undefined;
}

// The frame's layers as an app reads them; none without a host to name them in.
async function layersOf(frameLayers: readonly CanvasLayer[]): Promise<readonly AppNodeLayer[]> {
  const host = appNodeRefHost();
  return host === undefined || frameLayers.length === 0 ? [] : nodeLayers(host, frameLayers);
}

export function useCanvasCapture(host: CanvasCaptureHost): void {
  const latest = useRef(host);
  latest.current = host;
  const owner = useSyncExternalStore(canvasCapture.subscribe, canvasCapture.owner);
  useEffect(() => {
    setCanvasClickHandler({
      capturing: () => canvasCapture.owner()?.mode === 'capture',
      observing: () => canvasCapture.owner()?.mode === 'observe',
      take: (click) => {
        const nodeId = click.path === undefined ? undefined : latest.current.nodeIdForPath(click.path);
        // A frame that did not say where the pointer was (an older preload) still sends the element, with no point in it.
        const x = click.x ?? 0;
        const y = click.y ?? 0;
        const box = click.x === undefined || click.y === undefined ? undefined : click.box;
        // The layers through component instances: the frame's own hit test at the same point, named in each file.
        const point = click.x === undefined || click.y === undefined ? Promise.resolve(undefined) : queryCanvasPoint(x, y);
        void point
          .then((hit) => layersOf(hit?.layers ?? []))
          .catch(() => [])
          .then((layers) => canvasCapture.click(canvasClickPayload({ nodeId, x, y, box, layers })));
      },
    });
    setCanvasPointLocator(async (x, y) => {
      const hit = await queryCanvasPoint(x, y);
      const nodeId = hit?.path === undefined ? undefined : latest.current.nodeIdForPath(hit.path);
      const layers = await layersOf(hit?.layers ?? []).catch(() => []);
      return canvasClickPayload({ nodeId, x, y, box: hit?.box, layers });
    });
    setCanvasPageReader(() => latest.current.canvasPage());
    // A drag to insert lands where a click would select: the open file's element, never inside a closed component.
    setInsertDropLocator(async (x, y) => {
      const hit = await queryCanvasPoint(x, y);
      const nodeId = hit?.path === undefined ? undefined : latest.current.nodeIdForPath(hit.path);
      const node = nodeId === undefined ? undefined : appHostNode(nodeId);
      const box = hit?.box;
      return node === undefined || box === undefined ? undefined : { node, box: { x: box.x, y: box.y, width: box.w, height: box.h } };
    });
    return () => {
      setCanvasClickHandler(undefined);
      setCanvasPointLocator(undefined);
      setCanvasPageReader(undefined);
      setInsertDropLocator(undefined);
    };
  }, []);
  const cursor = owner?.cursor;
  useEffect(() => {
    latest.current.sendCursor(cursor);
  }, [cursor]);
  // Escape ends a capture; an observing app leaves Escape to the editor, which uses it to leave a component.
  const capturing = owner?.mode === 'capture';
  useEffect(() => {
    if (!capturing) {
      return undefined;
    }
    // Capture phase, before the editor's own Escape (leave a component, close the preview) sees it.
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && canvasCapture.cancel()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing]);
}
