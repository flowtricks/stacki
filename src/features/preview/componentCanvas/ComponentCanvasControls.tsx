// The component canvas's own controls outside the page: zoom, in the floating bar the all-breakpoints canvas draws
// (CanvasView.tsx CanvasControls) with the frame settings toggle, and the title bar's way back to where the canvas was
// opened from.
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { createPortal } from 'react-dom';
import { ChevronLeftIcon, GearIcon } from '../../../ui/Icons';
import FittedTooltip from '../../../ui/FittedTooltip';
import { useDelayedTooltip } from '../../../ui/delayedTooltip';
import type { ComponentCanvasControl } from './componentCanvasSession';
import { prettyComponentName } from './frameLabel';
import './componentCanvas.css';

export function ComponentCanvasZoom({ canvas }: { readonly canvas: ComponentCanvasControl }) {
  const translate = useTranslate();
  const state = canvas.state;
  if (state.kind !== 'open') {
    return undefined;
  }
  return (
    <div className="canvas-controls component-canvas-zoom" onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" aria-label={translate('componentCanvas.zoom.out')} onClick={() => canvas.zoom('out')}>
        −
      </button>
      <button type="button" className="pct" aria-label={translate('componentCanvas.zoom.reset')} onClick={() => canvas.zoom('reset')}>
        {translate('componentCanvas.zoom.percent', { percent: Math.round(state.scale * 100) })}
      </button>
      <button type="button" aria-label={translate('componentCanvas.zoom.in')} onClick={() => canvas.zoom('in')}>
        +
      </button>
      <button type="button" aria-label={translate('componentCanvas.zoom.fitAll')} onClick={() => canvas.zoom('fit')}>
        {translate('componentCanvas.zoom.fit')}
      </button>
      <FramePanelToggle canvas={canvas} shown={state.framePanel === 'shown'} />
    </div>
  );
}

// Frame settings, opened and closed from the bar: always there, so a closed popover is one press away at any depth,
// pressed while it is open. It speaks of the selected frame, whatever is selected inside one.
function FramePanelToggle({ canvas, shown }: { readonly canvas: ComponentCanvasControl; readonly shown: boolean }) {
  const translate = useTranslate();
  const tip = useDelayedTooltip();
  const label = translate(shown ? 'componentCanvas.framePanel.hide' : 'componentCanvas.framePanel.show');
  return (
    <>
      <button
        type="button"
        className={`component-canvas-panel-toggle${shown ? ' is-on' : ''}`}
        aria-label={label}
        aria-pressed={shown}
        onMouseEnter={tip.show}
        onMouseLeave={tip.hide}
        onClick={() => {
          tip.hide();
          if (shown) {
            canvas.hideFramePanel();
          } else {
            canvas.showFramePanel();
          }
        }}
      >
        <GearIcon size={14} />
      </button>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip anchor={tip.value} role="tooltip">
            {label}
          </FittedTooltip>,
          document.body,
        )}
    </>
  );
}

/** The title bar's back button while a canvas is open: one press returns to the file and selection it was opened from. */
export function ComponentCanvasBack({ canvas }: { readonly canvas: ComponentCanvasControl }) {
  const translate = useTranslate();
  const state = canvas.state;
  const name = state.kind === 'open' ? prettyComponentName(state.component.name) : '';
  return (
    <button
      type="button"
      className="page-switch-btn comp-back"
      aria-label={translate('componentCanvas.titleBar.close', { name })}
      disabled={state.kind !== 'open'}
      onClick={canvas.exit}
    >
      <ChevronLeftIcon size={13} />
      <span className="page-switch-label">{translate('componentCanvas.titleBar.close', { name })}</span>
    </button>
  );
}
