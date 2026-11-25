import { createPortal } from 'react-dom';
import './windowResizeHandles.css';
import { WINDOW_EDGES, type WindowEdge } from './windowGeometry';
import type { useWindowRectangle } from './useWindowRectangle';
import type { MessageKey } from '../lib/i18n/localeContext';
import { useTranslate } from '../lib/i18n/useTranslate';

const EDGE_LABELS = {
  n: 'ui.windowResize.n',
  s: 'ui.windowResize.s',
  e: 'ui.windowResize.e',
  w: 'ui.windowResize.w',
  se: 'ui.windowResize.se',
  sw: 'ui.windowResize.sw',
  ne: 'ui.windowResize.ne',
  nw: 'ui.windowResize.nw',
} as const satisfies Record<WindowEdge, MessageKey>;

export function WindowResizeHandles({ windowState }: { readonly windowState: ReturnType<typeof useWindowRectangle> }) {
  const translate = useTranslate();
  return (
    <>
      {WINDOW_EDGES.map((edge) => (
        <div
          key={edge}
          className={`window-resize window-resize-${edge}`}
          role="separator"
          tabIndex={0}
          aria-label={translate(EDGE_LABELS[edge])}
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
