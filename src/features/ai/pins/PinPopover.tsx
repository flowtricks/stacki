// A comment pin's popover: a small message box of its own beside the pin. The words are typed in the chat
// composer's own input (ComposerInput, as plain text) and dictated through the same microphone (MicButton,
// useComposerVoice); images are pasted, dropped or picked as in the composer and shown as its chips, and the crop
// Stacki took of the pinned area is the first of them, removable like any other and taken again on request.
// Nothing to save: every change is on the board at once, and the board saves itself after a pause.
//
// Enter closes the popover (the words are kept), Shift+Enter is a new line, Escape closes it. Delete asks first
// only when the pin holds words or images the person added (hasContentToLose). A sent pin is read-only: it shows
// how it stands, with Reopen to make it a draft again.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import { PIN_LIMITS } from '../../../../shared/properties/ai/commentPinBrief';
import type { CommentPin, PinImageId } from '../../../../shared/properties/ai/commentPins';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { crop as centralCrop, image as centralImage, trashCanSimple as centralTrash, close as centralClose } from '../../../ui/central/centralGeometry';
import { confirmDialog } from '../../../ui/ConfirmDialog';
import { reportErrorToast } from '../../../ui/errorNotices';
import Popup from '../../../ui/Popup';
import { draftFromText, draftText, preferredAgent, useAiState, type ChatDraft, type DraftAttachment } from '../aiStore';
import { prepareImage } from '../chatImages';
import { ComposerInput, type ComposerHandle } from '../composer/ComposerInput';
import { MicButton } from '../composer/MicButton';
import { useComposerVoice } from '../composer/useComposerVoice';
import { AttachmentChips } from '../screenshot/AttachmentChips';
import { hasContentToLose, type PinProgress } from './pinModel';
import { addImagesToPin, deletePin, openPin, removePinImage, reopenSentPin, setPinComment, startMovingPin, usePinState } from './pinStore';
import { PinProgressPill } from './PinProgressPill';
import { TipButton } from '../sessions/TipButton';

const CropGlyph = centralIcon(centralCrop);
const ImageGlyph = centralIcon(centralImage);
const TrashGlyph = centralIcon(centralTrash);
const CloseGlyph = centralIcon(centralClose);

/** The popover's width; the canvas and the window keep it on screen. */
const POPOVER_WIDTH_PX = 300;
/** Space between the pin and the popover, and between the popover and the window's edge. */
const POPOVER_GAP_PX = 10;

export interface PinPopoverProps {
  readonly pin: CommentPin;
  readonly progress: PinProgress;
  /** The pin's marker on the canvas: the popover sits beside it. */
  readonly anchor: HTMLElement | undefined;
  /** Whether the pin's element is on this canvas; a detached pin offers to be moved. */
  readonly detached: boolean;
  /** Takes the crop again, of the area as it is now. */
  readonly onRecapture: (() => void) | undefined;
  /** A version that changes whenever the canvas measured again, so the popover follows its pin. */
  readonly layout: number;
}

export function PinPopover({ pin, progress, anchor, detached, onRecapture, layout }: PinPopoverProps) {
  const translate = useTranslate();
  const pins = usePinState();
  const ai = useAiState();
  const input = useRef<ComposerHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', left: -10_000, top: 0, width: POPOVER_WIDTH_PX });
  const [dragging, setDragging] = useState(false);
  const editable = pin.delivery.kind === 'draft';
  // The pin's words as a one-run draft, so dictation reads and writes them as it does the composer's.
  const latest = useRef(pin);
  latest.current = pin;
  const draft: ChatDraft = draftFromText(pin.comment);
  const dictation = useComposerVoice({
    read: () => draftFromText(latest.current.comment),
    write: (change) => setPinComment(latest.current.id, draftText(change(draftFromText(latest.current.comment)))),
    onSend: () => openPin(undefined),
    draft,
  });
  const { voice } = dictation;
  // Beside the pin, on the side with room, inside the window; measured again whenever the canvas is.
  useLayoutEffect(() => {
    const box = anchor?.getBoundingClientRect();
    const height = surface.current?.offsetHeight ?? 0;
    if (box === undefined) {
      return;
    }
    const roomRight = window.innerWidth - box.right - POPOVER_GAP_PX;
    const left =
      roomRight >= POPOVER_WIDTH_PX + POPOVER_GAP_PX ? box.right + POPOVER_GAP_PX : Math.max(POPOVER_GAP_PX, box.left - POPOVER_GAP_PX - POPOVER_WIDTH_PX);
    const top = Math.min(Math.max(POPOVER_GAP_PX, box.top - POPOVER_GAP_PX), Math.max(POPOVER_GAP_PX, window.innerHeight - height - POPOVER_GAP_PX));
    setPosition((previous) => (previous['left'] === left && previous['top'] === top ? previous : { position: 'fixed', left, top, width: POPOVER_WIDTH_PX }));
  }, [anchor, layout, pin.images.length, pin.comment]);
  // The box takes the keyboard when a pin opens, so the person can just type.
  const pinId = pin.id;
  // After the popup has placed its own focus, and out of the canvas frame the click left it in.
  useEffect(() => {
    if (!editable) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => input.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [pinId, editable]);
  const attach = async (files: readonly File[]): Promise<void> => {
    const images = [];
    for (const file of files.slice(0, PIN_LIMITS.imagesPerPinMax)) {
      try {
        const prepared = await prepareImage(file, translate);
        if (prepared.attachment.kind === 'image') {
          images.push({ kind: 'added' as const, name: prepared.attachment.name, mimeType: prepared.attachment.mimeType, data: prepared.attachment.data });
        }
      } catch (error: unknown) {
        reportErrorToast(error instanceof Error ? error.message : String(error));
      }
    }
    addImagesToPin(pin.id, images, translate);
  };
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
  const chips: readonly DraftAttachment[] = pin.images.flatMap((image) => {
    const data = pins.images.get(image.id);
    return data === undefined
      ? []
      : [
          {
            id: image.id,
            preview: `data:${image.mimeType};base64,${data}`,
            attachment: { kind: 'image' as const, name: image.name, mimeType: image.mimeType, data },
          },
        ];
  });
  const agent = ai.chats.find((chat) => chat.id === ai.open)?.agent ?? preferredAgent();
  const width = pin.place.breakpointPx === undefined ? translate('ai.pins.fluid') : translate('ai.pins.width', { width: pin.place.breakpointPx });
  return (
    <Popup
      ref={surface}
      mode="popover"
      keepOnScroll
      anchor={anchor}
      role="dialog"
      label={translate('ai.pins.popover', { number: pin.number })}
      className={`ai-pin-popover${pins.capturing ? ' is-capturing' : ''}${dragging ? ' is-dragging' : ''}`}
      style={position}
      onClose={() => openPin(undefined)}
    >
      <div
        className="ai-pin-popover-body"
        onDragOver={(event) => {
          if (editable) {
            event.preventDefault();
            setDragging(true);
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragging(false);
          if (editable) {
            void attach([...event.dataTransfer.files]);
          }
        }}
        onPaste={(event) => {
          const files = [...event.clipboardData.files];
          if (editable && files.length > 0) {
            event.preventDefault();
            void attach(files);
          }
        }}
      >
        <div className="ai-pin-popover-head">
          <span className="ai-pin-number">{pin.number}</span>
          <span className="ai-pin-popover-names">
            <span className="ai-pin-popover-element">{pin.place.elementLabel}</span>
            <span className="ai-pin-popover-page">{translate('ai.pins.where', { page: pin.place.pageLabel, width })}</span>
          </span>
          {pin.delivery.kind === 'sent' && <PinProgressPill progress={progress} />}
          <TipButton label={translate('ai.pins.delete')} onClick={() => void remove()}>
            <TrashGlyph size={16} />
          </TipButton>
          <TipButton label={translate('ai.pins.close')} onClick={() => openPin(undefined)}>
            <CloseGlyph size={16} />
          </TipButton>
        </div>
        {detached && (
          <button type="button" className="ai-pin-move" onClick={() => startMovingPin(pin.id)}>
            {translate('ai.pins.moveDetached')}
          </button>
        )}
        <AttachmentChips
          attachments={chips}
          onRemove={(id) => {
            const image = pin.images.find((entry) => entry.id === id);
            if (image !== undefined && editable) {
              removePinImage(pin.id, image.id satisfies PinImageId);
            }
          }}
        />
        {editable ? (
          <div className="ai-pin-composer">
            <ComposerInput
              agent={agent}
              commands={[]}
              placeholder={translate('ai.pins.placeholder')}
              inputRef={input}
              value={pin.comment}
              onChange={(text) => setPinComment(pin.id, text)}
              onSend={() => openPin(undefined)}
              dictationDraft={voice.listening || voice.transcribing ? { text: voice.interim, decoding: voice.decoding } : undefined}
            />
            <div className="ai-pin-tools">
              <input
                ref={picker}
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                hidden
                aria-label={translate('ai.composer.attach.images')}
                onChange={(event) => {
                  const element = event.currentTarget;
                  void attach([...(element.files ?? [])]);
                  element.value = '';
                }}
              />
              <TipButton
                label={translate('ai.pins.addImage')}
                disabled={pin.images.length >= PIN_LIMITS.imagesPerPinMax || chips.length >= AI_LIMITS.attachmentsMax}
                onClick={() => picker.current?.click()}
              >
                <ImageGlyph size={16} />
              </TipButton>
              {onRecapture !== undefined && (
                <TipButton label={translate('ai.pins.recapture')} onClick={onRecapture}>
                  <CropGlyph size={16} />
                </TipButton>
              )}
              <span className="ai-pin-tools-gap" />
              <MicButton dictation={dictation} />
            </div>
          </div>
        ) : (
          <div className="ai-pin-sent">
            <div className="ai-pin-sent-comment">{pin.comment.trim() === '' ? translate('ai.pins.noComment') : pin.comment}</div>
            <button type="button" className="ai-pin-reopen" onClick={() => reopenSentPin(pin.id)}>
              {translate('ai.pins.reopen')}
            </button>
          </div>
        )}
      </div>
    </Popup>
  );
}
