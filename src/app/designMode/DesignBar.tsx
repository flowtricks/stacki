// Design mode (experimental, removable: docs/design-mode/REMOVE.md): the bar over the canvas while the mode is on.
//
// One compact bar, as comment pins' is: the mode's mark and name, start over (which asks first: it throws every
// frame away), Send to AI, and close. The canvas zooms by pinch, ⌘ scroll and the zoom keys, so the bar shows no
// zoom. It sits over the canvas column's foot, and over the window when there is no column, so close is always in
// reach; in a narrow column the name goes first.
import { centralIcon } from '../../ui/central/CentralIcon';
import { arrowRotateCounterClockwise, brush, close, sparkle } from '../../ui/central/centralGeometry';
import { confirmDialog } from '../../ui/ConfirmDialog';
import TipAnchor from '../../ui/TipAnchor';
import { exitDesignMode, type DesignHostSource } from './designActions';
import { startOver, type DesignOpsContext } from './designFrameOps';
import { useDesignView } from './designStore';
import { useDesignWords } from './i18n/designWords';
import { useCanvasColumn } from './useCanvasColumn';

const ModeIcon = centralIcon(brush);
const CloseIcon = centralIcon(close);
const SendIcon = centralIcon(sparkle);
const StartOverIcon = centralIcon(arrowRotateCounterClockwise);

export function DesignBar({ app, context }: { readonly app: DesignHostSource; readonly context: DesignOpsContext }) {
  const words = useDesignWords();
  const view = useDesignView();
  const column = useCanvasColumn('.main > .center');
  const busy = view.phase === 'leaving';
  const askStartOver = async (): Promise<void> => {
    const answer = await confirmDialog({
      title: words('reset.title'),
      body: words('reset.body'),
      confirmLabel: words('bar.startOver'),
      danger: true,
    });
    if (answer !== false) {
      startOver(context);
    }
  };
  return (
    <div className="dm-bar" data-design-mode="" style={column.style}>
      <div className="dm-shell" role="toolbar" aria-label={words('bar.label')}>
        <TipAnchor text={words('bar.tip')}>
          <span className="dm-name">
            <ModeIcon size={16} />
            <span className="dm-name-text">{words('bar.label')}</span>
          </span>
        </TipAnchor>
        <TipAnchor text={words('bar.startOverTip')}>
          <button type="button" className="dm-icon dm-start-over" aria-label={words('bar.startOver')} disabled={busy} onClick={() => void askStartOver()}>
            <StartOverIcon size={16} />
          </button>
        </TipAnchor>
        <TipAnchor text={words('bar.sendTip')}>
          <button type="button" className="dm-send" disabled={busy} onClick={() => void exitDesignMode(app, context.words(), 'send')}>
            <SendIcon size={16} />
            <span>{words('bar.send')}</span>
          </button>
        </TipAnchor>
        <TipAnchor text={words('bar.close')}>
          <button
            type="button"
            className="dm-icon dm-exit"
            aria-label={words('bar.close')}
            disabled={busy}
            onClick={() => void exitDesignMode(app, context.words(), 'keep')}
          >
            <CloseIcon size={16} />
          </button>
        </TipAnchor>
      </div>
    </div>
  );
}
