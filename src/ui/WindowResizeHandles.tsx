import { createPortal } from 'react-dom';
import './windowResizeHandles.css';
import { WINDOW_EDGES, type WindowEdge } from './windowGeometry';
import type { useWindowRectangle } from './useWindowRectangle';

const EDGE_LABELS: Readonly<Record<WindowEdge, string>> = {
  n: 'top',
  s: 'bottom',
  e: 'right',
  w: 'left',
  se: 'bottom right',
  sw: 'bottom left',
  ne: 'top right',
  nw: 'top left',
};

export function WindowResizeHandles({ windowState }: { readonly windowState: ReturnType<typeof useWindowRectangle> }) {
  return (
    <>
      {WINDOW_EDGES.map((edge) => (
        <div
          key={edge}
          className={`window-resize window-resize-${edge}`}
          role="separator"
          tabIndex={0}
          aria-label={`Resize window (${EDGE_LABELS[edge]})`}
          aria-orientation={edge === 'n' || edge === 's' ? 'horizontal' : 'vertical'}
          aria-valuemin={1}
          aria-valuemax={edge === 'n' || edge === 's' ? window.innerHeight : window.innerWidth}
          aria-valuenow={edge === 'n' || edge === 's' ? windowState.rectangle.height : windowState.rectangle.width}
          aria-valuetext={`${windowState.rectangle.width} × ${windowState.rectangle.height} px`}
          onPointerDown={(event) => windowState.start(event, edge)}
          onKeyDown={(event) => windowState.onKeyDown(event, edge)}
        />
      ))}
      {windowState.dragging && createPortal(<div className="window-drag-cover" />, document.body)}
    </>
  );
}
