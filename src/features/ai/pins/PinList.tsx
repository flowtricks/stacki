// Every pin on the board, on every page: its number and crop, its words (or that it has none yet), where it is,
// and how it stands (a pin sent shows its work live on a line of its own, PinLiveLine.tsx). The list opens upward
// from the pins' bar, centred on it. A row takes the person to the pin (its page, its width, its element, its popover open); a
// draft's switch includes it in or leaves it out of the next "Send all"; the end of each row deletes it (asking
// first only when it holds words or added images). A pin whose work finished well is deleted by itself (pinStore.ts),
// so the list holds only pins still to send or still at work. Deleting a row keeps the list open while a pin remains,
// with the keyboard on the next row's delete.
import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { trashCanSimple as centralTrash } from '../../../ui/central/centralGeometry';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import Popup from '../../../ui/Popup';
import { POPUP_MOTION_MS } from '../../../ui/popupLifecycle';
import { Switch } from '../../../ui/Switch';
import { TipButton } from '../sessions/TipButton';
import { ChipWords } from '../mentions/ChipWords';
import { commentLine, hasContentToLose, workingCopy } from './pinModel';
import { PinBadge } from './PinBadge';
import { PinLiveLine } from './PinLiveLine';
import { useAiState } from '../aiStore';
import type { ChatView } from '../chatReducer';
import { DetachedPill, UnsavedPill } from './PinProgressPill';
import { deletePin, jumpToPin, progressOf, setPinIncluded, setPinListOpen, usePinState } from './pinStore';
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import type { Translator } from '../../../lib/i18n/localeContext';

const TrashGlyph = centralIcon(centralTrash);

/** Characters of a comment a row shows before its ellipsis. */
const ROW_COMMENT_CHARS_MAX = 90;

export function PinList({ anchor }: { readonly anchor: HTMLElement | undefined }) {
  const translate = useTranslate();
  const pins = usePinState();
  // The rows show live work read from the chats.
  const ai = useAiState();
  const ordered = [...pins.board.pins].sort((left, right) => left.number - right.number);
  const position = useAboveBar(anchor);
  return (
    <Popup
      mode="popover"
      anchor={anchor}
      role="dialog"
      label={translate('ai.pins.listLabel')}
      className="ai-pin-list"
      style={position}
      // The chat scrolls by itself while agents work, and the list stays up through it.
      keepOnScroll
      onClose={() => setPinListOpen('closed')}
    >
      {ordered.length === 0 ? (
        <div className="ai-pin-list-empty">{translate('ai.pins.empty')}</div>
      ) : (
        <ul className="ai-pin-rows">
          {ordered.map((pin) => (
            <PinRow
              key={pin.id}
              pin={pin}
              index={ordered.indexOf(pin)}
              image={firstImage(pin, pins.images)}
              detached={pins.detached.has(pin.id)}
              view={pin.delivery.kind === 'sent' ? ai.views.get(pin.delivery.chat) : undefined}
              translate={translate}
            />
          ))}
        </ul>
      )}
    </Popup>
  );
}

function PinRow({
  pin,
  index,
  image,
  detached,
  view,
  translate,
}: {
  readonly pin: CommentPin;
  /** The row's place in the list, so the keyboard moves to the row that takes it once this one is deleted. */
  readonly index: number;
  readonly image: string | undefined;
  readonly detached: boolean;
  /** The transcript of the chat the pin was sent to, when it is read here. */
  readonly view: ChatView | undefined;
  readonly translate: Translator;
}) {
  const progress = progressOf(pin);
  // Sent, or on its way: the row says what is happening on a line of its own.
  const live = progress.kind !== 'draft';
  // A pin never saved shows what its box holds; a saved one what it says.
  const shown = pin.savedAt === undefined ? workingCopy(pin) : pin;
  const words = shown.comment;
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
    deletePin(pin.id, translate);
    // The row that takes this one's place (or the one before, for the last) keeps the keyboard in the list: after the
    // confirm dialog's exit, which hands focus back to the button that is gone.
    window.setTimeout(() => {
      const deletes = document.querySelectorAll<HTMLElement>('.ai-pin-list .ai-pin-row-delete');
      deletes[Math.min(index, deletes.length - 1)]?.focus();
    }, POPUP_MOTION_MS);
  };
  return (
    <li className={`ai-pin-row${pin.included || pin.delivery.kind === 'sent' ? '' : ' is-excluded'}${live ? ' is-live' : ''}`}>
      <button type="button" className="ai-pin-row-open" onClick={() => jumpToPin(pin.id)} aria-label={translate('ai.pins.jump', { number: pin.number })}>
        <span className={`ai-pin-number is-${progress.kind}`}>{pin.number}</span>
        <span className="ai-pin-row-text">
          <span className={words.trim() === '' ? 'ai-pin-row-comment is-empty' : 'ai-pin-row-comment'}>
            {words.trim() === '' ? (
              translate('ai.pins.noComment')
            ) : shown.segments === undefined ? (
              commentLine(words, ROW_COMMENT_CHARS_MAX)
            ) : (
              <ChipWords segments={shown.segments} />
            )}
          </span>
          <span className="ai-pin-row-place">{translate('ai.pins.rowPlace', { page: pin.place.pageLabel, element: pin.place.elementLabel, width })}</span>
          {live && <PinLiveLine pin={pin} progress={progress} view={view} />}
        </span>
        {image !== undefined && <img className="ai-pin-thumb" src={image} alt="" />}
      </button>
      {detached && <DetachedPill />}
      {pin.savedAt === undefined ? <UnsavedPill /> : (!live || progress.kind === 'attention') && <PinBadge pin={pin} progress={progress} />}
      {pin.delivery.kind === 'draft' && pin.savedAt !== undefined && (
        <Switch
          label={translate('ai.pins.include', { number: pin.number })}
          checked={pin.included}
          onToggle={() => setPinIncluded(pin.id, pin.included ? 'exclude' : 'include')}
        />
      )}
      <TipButton className="ai-pin-row-delete" label={translate('ai.pins.delete')} onClick={() => void remove()}>
        <TrashGlyph size={16} />
      </TipButton>
    </li>
  );
}

/** The list's width (pins.css `.ai-pin-list`) and tallest height, and the room it keeps from the bar and the window's edge. */
const LIST_WIDTH_PX = 380;
const LIST_HEIGHT_PX_MAX = 520;
const LIST_EDGE_PX = 8;

/**
 * Where the list sits: above the pins' bar, centred on it, opening upward and kept inside the window. Measured again
 * when the bar changes size, the canvas does, or the window does.
 */
function useAboveBar(button: HTMLElement | undefined): CSSProperties | undefined {
  const bar = button?.closest<HTMLElement>('.ai-pin-bar') ?? undefined;
  const [, measureAgain] = useState(0);
  useEffect(() => {
    if (bar === undefined) {
      return undefined;
    }
    const again = (): void => measureAgain((count) => (count + 1) % Number.MAX_SAFE_INTEGER);
    const observer = new ResizeObserver(again);
    observer.observe(bar);
    const slot = bar.parentElement;
    if (slot !== null) {
      observer.observe(slot);
    }
    window.addEventListener('resize', again);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', again);
    };
  }, [bar]);
  return bar === undefined ? undefined : listPosition(bar.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight });
}

/** The list's fixed place above a bar at `bar`, in a window of `size` (the same in every writing direction: it is centred). */
export function listPosition(
  bar: { readonly left: number; readonly top: number; readonly width: number },
  size: { readonly width: number; readonly height: number },
): CSSProperties {
  const width = Math.min(LIST_WIDTH_PX, size.width - LIST_EDGE_PX * 2);
  const centred = bar.left + bar.width / 2 - width / 2;
  const left = Math.max(LIST_EDGE_PX, Math.min(centred, size.width - width - LIST_EDGE_PX));
  const room = bar.top - LIST_EDGE_PX * 2;
  return {
    position: 'fixed',
    left,
    width,
    bottom: size.height - bar.top + LIST_EDGE_PX,
    maxHeight: Math.max(0, Math.min(room, LIST_HEIGHT_PX_MAX)),
  };
}

function firstImage(pin: CommentPin, images: ReadonlyMap<string, string>): string | undefined {
  const first = pin.images[0];
  const data = first === undefined ? undefined : images.get(first.id);
  return first === undefined || data === undefined ? undefined : `data:${first.mimeType};base64,${data}`;
}
