// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the bar over the canvas while the mode is on.
//
// It names the mode (and says nothing is saved) and holds the session's actions: fit the canvas, start over, send
// the frames to the AI, and leave. Frames are worked on the canvas itself. The bar sits over the canvas column's
// foot, and over the window when there is no column, so Exit is always in reach.
import { useEffect, useState } from 'react';
import { centralIcon } from '../../ui/central/CentralIcon';
import { arrowRotateCounterClockwise, sparkle } from '../../ui/central/centralGeometry';
import TipAnchor from '../../ui/TipAnchor';
import { exitDesignMode, type DesignHostSource } from './designActions';
import { startOver, type DesignOpsContext } from './designFrameOps';
import { updateDesignView, useDesignView } from './designStore';
import { useDesignWords } from './i18n/designWords';
import { useCanvasColumn } from './useCanvasColumn';

const SendIcon = centralIcon(sparkle);
const StartOverIcon = centralIcon(arrowRotateCounterClockwise);

export function DesignBar({ app, context }: { readonly app: DesignHostSource; readonly context: DesignOpsContext }) {
  const words = useDesignWords();
  const view = useDesignView();
  const column = useCanvasColumn('.main > .center');
  const [confirming, setConfirming] = useState<'no' | 'yes'>('no');
  const busy = view.phase === 'leaving';
  useEffect(() => {
    if (confirming === 'no') {
      return undefined;
    }
    const timer = window.setTimeout(() => setConfirming('no'), 4_000);
    return () => window.clearTimeout(timer);
  }, [confirming]);
  return (
    <div className="dm-bar" data-design-mode="" style={column.style} role="toolbar" aria-label={words('bar.label')}>
      <TipAnchor text={words('bar.tip')}>
        <span className="dm-badge">{words('bar.label')}</span>
      </TipAnchor>
      <TipAnchor text={words('bar.fitTip')}>
        {/* A camera left unset is fitted again by the canvas. */}
        <button type="button" className="dm-button dm-zoom" onClick={() => updateDesignView((current) => ({ ...current, camera: undefined }))}>
          {`${String(Math.round((view.camera?.zoom ?? 1) * 100))}%`}
        </button>
      </TipAnchor>
      <TipAnchor text={confirming === 'yes' ? undefined : words('bar.startOverTip')}>
        <button
          type="button"
          className={confirming === 'yes' ? 'dm-button is-confirming' : 'dm-icon'}
          aria-label={words('bar.startOver')}
          disabled={busy}
          onClick={() => {
            if (confirming === 'yes') {
              setConfirming('no');
              startOver(context);
            } else {
              setConfirming('yes');
            }
          }}
        >
          <StartOverIcon size={16} />
          {confirming === 'yes' && <span>{words('bar.startOverConfirm')}</span>}
        </button>
      </TipAnchor>
      <TipAnchor text={words('bar.sendTip')}>
        <button type="button" className="dm-button is-primary" disabled={busy} onClick={() => void exitDesignMode(app, context.words(), 'send')}>
          <SendIcon size={16} />
          <span>{words('bar.send')}</span>
        </button>
      </TipAnchor>
      <TipAnchor text={words('bar.exitTip')}>
        <button type="button" className="dm-button dm-exit" disabled={busy} onClick={() => void exitDesignMode(app, context.words(), 'keep')}>
          <span>{words('bar.exit')}</span>
        </button>
      </TipAnchor>
    </div>
  );
}
