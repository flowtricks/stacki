// Every pin on the board, on every page: its number and crop, its words (or that it has none yet), where it is,
// and how it stands. A row takes the person to the pin (its page, its width, its element, its popover open); a
// draft's switch includes it in or leaves it out of the next "Send all"; the end of each row deletes it (asking
// first only when it holds words or added images). The foot clears the sent pins and continues a held run.
import type { CSSProperties } from 'react';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { trashCanSimple as centralTrash } from '../../../ui/central/centralGeometry';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import Popup from '../../../ui/Popup';
import { Switch } from '../../../ui/Switch';
import { TipButton } from '../sessions/TipButton';
import { commentLine, hasContentToLose } from './pinModel';
import { DetachedPill, PinProgressPill } from './PinProgressPill';
import { cancelRun, clearSent, continueRun, deletePin, jumpToPin, progressOf, setPinIncluded, setPinListOpen, usePinState } from './pinStore';
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import type { Translator } from '../../../lib/i18n/localeContext';

const TrashGlyph = centralIcon(centralTrash);

/** Characters of a comment a row shows before its ellipsis. */
const ROW_COMMENT_CHARS_MAX = 90;

export function PinList({ anchor }: { readonly anchor: HTMLElement | undefined }) {
  const translate = useTranslate();
  const pins = usePinState();
  const ordered = [...pins.board.pins].sort((left, right) => left.number - right.number);
  const sent = ordered.filter((pin) => pin.delivery.kind === 'sent').length;
  const box = anchor?.getBoundingClientRect();
  return (
    <Popup
      mode="popover"
      anchor={anchor}
      role="dialog"
      label={translate('ai.pins.listLabel')}
      className="ai-pin-list"
      style={listPosition(box)}
      onClose={() => setPinListOpen('closed')}
    >
      {ordered.length === 0 ? (
        <div className="ai-pin-list-empty">{translate('ai.pins.empty')}</div>
      ) : (
        <ul className="ai-pin-rows">
          {ordered.map((pin) => (
            <PinRow key={pin.id} pin={pin} image={firstImage(pin, pins.images)} detached={pins.detached.has(pin.id)} translate={translate} />
          ))}
        </ul>
      )}
      {(pins.run?.held === 'paused' || sent > 0) && (
        <div className="ai-pin-list-foot">
          {pins.run?.held === 'paused' && (
            <>
              <button type="button" className="ai-pin-bar-button" onClick={() => void continueRun(translate)}>
                {translate('ai.pins.continue')}
              </button>
              <button type="button" className="ai-pin-bar-button" onClick={cancelRun}>
                {translate('ai.pins.cancelRun')}
              </button>
            </>
          )}
          <span className="ai-pin-tools-gap" />
          {sent > 0 && (
            <button type="button" className="ai-pin-bar-button" onClick={clearSent}>
              {translate('ai.pins.clearSent', { count: sent })}
            </button>
          )}
        </div>
      )}
    </Popup>
  );
}

function PinRow({
  pin,
  image,
  detached,
  translate,
}: {
  readonly pin: CommentPin;
  readonly image: string | undefined;
  readonly detached: boolean;
  readonly translate: Translator;
}) {
  const progress = progressOf(pin);
  const width = pin.place.breakpointPx === undefined ? translate('ai.pins.fluid') : translate('ai.pins.width', { width: pin.place.breakpointPx });
  const remove = async (): Promise<void> => {
    if (hasContentToLose(pin)) {
      const answer = await confirmDialog({
        title: translate('ai.pins.delete.title', { number: pin.number }),
        body: translate('ai.pins.delete.body'),
        confirmLabel: translate('ai.pins.delete.confirm'),
        danger: true,
      });
      if (answer !== true) {
        return;
      }
    }
    deletePin(pin.id);
  };
  return (
    <li className={`ai-pin-row${pin.included || pin.delivery.kind === 'sent' ? '' : ' is-excluded'}`}>
      <button type="button" className="ai-pin-row-open" onClick={() => jumpToPin(pin.id)} aria-label={translate('ai.pins.jump', { number: pin.number })}>
        <span className={`ai-pin-number is-${progress.kind}`}>{pin.number}</span>
        {image === undefined ? <span className="ai-pin-thumb is-empty" /> : <img className="ai-pin-thumb" src={image} alt="" />}
        <span className="ai-pin-row-text">
          <span className={pin.comment.trim() === '' ? 'ai-pin-row-comment is-empty' : 'ai-pin-row-comment'}>
            {pin.comment.trim() === '' ? translate('ai.pins.noComment') : commentLine(pin.comment, ROW_COMMENT_CHARS_MAX)}
          </span>
          <span className="ai-pin-row-place">{translate('ai.pins.rowPlace', { page: pin.place.pageLabel, element: pin.place.elementLabel, width })}</span>
        </span>
      </button>
      {detached && <DetachedPill />}
      <PinProgressPill progress={progress} />
      {pin.delivery.kind === 'draft' && (
        <Switch
          label={translate('ai.pins.include', { number: pin.number })}
          checked={pin.included}
          onToggle={() => setPinIncluded(pin.id, pin.included ? 'exclude' : 'include')}
        />
      )}
      <TipButton label={translate('ai.pins.delete')} onClick={() => void remove()}>
        <TrashGlyph size={16} />
      </TipButton>
    </li>
  );
}

/** The list's width (pins.css `.ai-pin-list`) and its distance from the window's edge. */
const LIST_WIDTH_PX = 380;
const LIST_EDGE_PX = 8;

// Under its button, starting where the button starts (its right edge in a right-to-left interface), kept in the window.
function listPosition(box: DOMRect | undefined): CSSProperties | undefined {
  if (box === undefined) {
    return undefined;
  }
  const top = box.bottom + LIST_EDGE_PX;
  if (document.documentElement.dir === 'rtl') {
    return { position: 'fixed', top, right: Math.max(LIST_EDGE_PX, window.innerWidth - box.right) };
  }
  return { position: 'fixed', top, left: Math.max(LIST_EDGE_PX, Math.min(box.left, window.innerWidth - LIST_WIDTH_PX - LIST_EDGE_PX)) };
}

function firstImage(pin: CommentPin, images: ReadonlyMap<string, string>): string | undefined {
  const first = pin.images[0];
  const data = first === undefined ? undefined : images.get(first.id);
  return first === undefined || data === undefined ? undefined : `data:${first.mimeType};base64,${data}`;
}
