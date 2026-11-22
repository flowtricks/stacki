// The bar that floats beside a region while it is recorded: a red dot, the elapsed capture time and Stop.
// It sits outside the region (below it, else above, else at the window's top) so it is never in a frame.
// It reads the recording's status from main every STATUS_POLL_MS; a recording that stopped by itself (a
// bound, a failed capture) ends the same way as Stop, with the reason. Escape stops too.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { RecordReply, RecordStopReason } from '../../../../shared/ipc/aiChat';
import type { WindowRect } from '../../../lib/screenshotSource';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { aiRecord } from '../aiBridge';

/** How often the bar asks main how the recording stands: often enough for the clock, cheap for main. */
const STATUS_POLL_MS = 250;
/** The bar's height and its gap from the region, for placing it outside the region. */
const BAR_HEIGHT_PX = 32;
const BAR_GAP_PX = 8;

type Status = Extract<RecordReply, { readonly kind: 'status' }>;

export function RecordingBar({
  projectPath,
  id,
  region,
  onStop,
}: {
  readonly projectPath: string;
  readonly id: string;
  readonly region: WindowRect;
  /** The person stopped (`person`) or the recording stopped by itself for `reason`. Called once. */
  readonly onStop: (reason: RecordStopReason) => void;
}) {
  const translate = useTranslate();
  const format = useFormat();
  const [status, setStatus] = useState<Status | undefined>(undefined);
  const done = useRef(false);
  const latest = useRef(onStop);
  latest.current = onStop;
  const finish = (reason: RecordStopReason): void => {
    if (!done.current) {
      done.current = true;
      latest.current(reason);
    }
  };
  useEffect(() => {
    const poll = setInterval(() => {
      void aiRecord({ projectPath, action: { kind: 'status', id } }).then((reply) => {
        if (!reply.ok) {
          finish('failed');
        } else if (reply.value.kind === 'status') {
          setStatus(reply.value);
          if (reply.value.stopReason !== undefined) {
            finish(reply.value.stopReason);
          }
        }
        return undefined;
      });
    }, STATUS_POLL_MS);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        finish('person');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => {
      clearInterval(poll);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [projectPath, id]);
  const seconds = format.formatNumber((status?.elapsedMs ?? 0) / 1000, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return createPortal(
    <div className="ai-record-bar" role="status" style={barPlace(region)}>
      <span className={`ai-record-dot${status?.state === 'paused' ? ' is-paused' : ''}`} aria-hidden="true" />
      <span className="ai-record-time">
        {status?.state === 'paused' ? translate('ai.record.paused') : `${translate('ai.record.recording')} · ${translate('ai.record.elapsed', { seconds })}`}
      </span>
      <button type="button" className="ai-record-stop" aria-keyshortcuts="Escape" onClick={() => finish('person')}>
        {translate('ai.record.stop')}
      </button>
    </div>,
    document.body,
  );
}

/** Below the region when there is room, else above it, else at the top of the window; centred on the region. */
export function barPlace(
  region: WindowRect,
  view: { readonly height: number } = { height: globalThis.innerHeight },
): { readonly top: number; readonly left: number } {
  const below = region.y + region.height + BAR_GAP_PX;
  const above = region.y - BAR_GAP_PX - BAR_HEIGHT_PX;
  const top = below + BAR_HEIGHT_PX <= view.height ? below : above >= 0 ? above : BAR_GAP_PX;
  return { top, left: region.x + Math.floor(region.width / 2) };
}
