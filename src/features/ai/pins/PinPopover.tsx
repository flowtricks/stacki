// A comment pin's popover: a small message box of its own beside the pin. The words are typed in the chat
// composer's own input (ComposerInput, as plain text) and dictated through the same microphone (MicButton,
// useComposerVoice); images are pasted, dropped or picked as in the composer and shown as its chips, and the crop
// Stacki took of the pinned area is the first of them, removable like any other and taken again on request.
//
// What is typed is the box's working copy, kept on the board (so a crash loses nothing) and never sent: Save (the
// blue button, or Enter as in the composer; Shift+Enter is a new line) makes it the pin's comment, the one "Send all"
// takes. Save waits for words or an image the person added (the crop alone is not a comment), for dictation to land
// and for an image to finish loading. The close button and Escape discard: a pin never saved goes, a saved pin keeps
// what was saved, and words or images that go with it come back from the toast's Undo. A press elsewhere, another
// pin, leaving the mode or the page keep the box instead (saved when it has content). Deleting a saved pin is the pin
// list's. A sent pin is read-only: it shows how it stands, with Reopen to make it a draft again.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { AI_LIMITS } from '../../../../shared/properties/ai/aiLimits';
import { PIN_LIMITS } from '../../../../shared/properties/ai/commentPinBrief';
import type { CommentPin, PinImageId } from '../../../../shared/properties/ai/commentPins';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { crop as centralCrop, image as centralImage, close as centralClose } from '../../../ui/central/centralGeometry';
import { reportErrorToast } from '../../../ui/errorNotices';
import Popup from '../../../ui/Popup';
import { draftFromText, draftText, preferredAgent, useAiState, type ChatDraft, type DraftAttachment } from '../aiStore';
import { prepareImage } from '../chatImages';
import { ComposerInput, type ComposerHandle } from '../composer/ComposerInput';
import { MicButton } from '../composer/MicButton';
import { DictationLine } from '../composer/VoiceLine';
import '../composer/composer.css';
import { useComposerVoice } from '../composer/useComposerVoice';
import { AttachmentChips } from '../screenshot/AttachmentChips';
import { hasPersonContent, workingCopy, type PinProgress } from './pinModel';
import { addImagesToPin, closePinBox, removePinImage, reopenSentPin, savePinBox, setPinComment, startMovingPin, usePinState } from './pinStore';
import { PinBadge } from './PinBadge';
import { PinModelPicker } from './PinModelPicker';
import { TipButton } from '../sessions/TipButton';

const CropGlyph = centralIcon(centralCrop);
const ImageGlyph = centralIcon(centralImage);
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
  /** The pin left the board (its work finished, or it was deleted): the box closes with the popups' exit motion. */
  readonly closing?: boolean;
}

export function PinPopover({ pin, progress, anchor, detached, onRecapture, layout, closing = false }: PinPopoverProps) {
  const translate = useTranslate();
  const pins = usePinState();
  const ai = useAiState();
  const input = useRef<ComposerHandle>(null);
  const picker = useRef<HTMLInputElement>(null);
  const surface = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<CSSProperties>({ position: 'fixed', left: -10_000, top: 0, width: POPOVER_WIDTH_PX });
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(0);
  const editable = pin.delivery.kind === 'draft';
  const working = workingCopy(pin);
  // The box's words as a one-run draft, so dictation reads and writes them as it does the composer's.
  const latest = useRef(pin);
  latest.current = pin;
  const draft: ChatDraft = draftFromText(working.comment);
  // Dictation reads and writes up to the caret, so the words land where the person left it. With no editor in the box
  // (words arriving just after a send) they join the end.
  const dictation = useComposerVoice({
    read: () => ({ segments: input.current?.beforeCaret() ?? draftFromText(workingCopy(latest.current).comment).segments, attachments: [] }),
    write: (change) => {
      const editor = input.current ?? undefined;
      if (editor === undefined) {
        setPinComment(latest.current.id, draftText(change(draftFromText(workingCopy(latest.current).comment))));
      } else {
        editor.editBeforeCaret((before) => change({ segments: before, attachments: [] }).segments);
      }
    },
    // The spoken "send" saves, as Enter does.
    onSend: () => savePinBox(),
    draft,
  });
  const { voice } = dictation;
  const busy = voice.listening || voice.transcribing || loading > 0;
  const canSave = editable && !busy && hasPersonContent(working);
  const focusBox = (): void => focusComposer(input.current ?? undefined);
  // A box on its way out (it stays mounted for the exit motion), or one whose pin was sent, has no microphone button:
  // its session ends now. Unmounting ends one too (useDictation).
  const stopVoice = useRef(voice.stop);
  stopVoice.current = voice.stop;
  useEffect(() => {
    if (closing || !editable) {
      stopVoice.current();
    }
  }, [closing, editable]);
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
  }, [anchor, layout, working.images.length, working.comment, voice.listening, voice.transcribing]);
  // The box takes the keyboard when a pin opens, so the person can just type.
  const pinId = pin.id;
  // After the popup has placed its own focus, and out of the canvas frame the click left it in: the frame holds the
  // keyboard after a click on the page, so the window takes it back first (focusComposer), or the first keys
  // would land in the page.
  const hidden = pins.dragging === pin.id || pins.capturing;
  useEffect(() => {
    if (!editable || hidden) {
      return undefined;
    }
    const frame = requestAnimationFrame(() => focusComposer(input.current ?? undefined));
    return () => cancelAnimationFrame(frame);
  }, [pinId, editable, hidden]);
  // The microphone took the keyboard to be pressed; once the words have landed, the box has it again.
  const dictating = voice.listening || voice.transcribing;
  useEffect(() => {
    if (!dictating && editable) {
      focusComposer(input.current ?? undefined);
    }
  }, [dictating, editable]);
  const attach = async (files: readonly File[]): Promise<void> => {
    const images = [];
    setLoading((count) => count + 1);
    try {
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
    } finally {
      setLoading((count) => Math.max(0, count - 1));
      focusBox();
    }
  };
  const chips: readonly DraftAttachment[] = working.images.flatMap((image) => {
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
      open={!closing}
      keepOnScroll
      anchor={anchor}
      // A press on its own marker (a click to close it, or a drag to move it) is not a press elsewhere.
      within={anchor}
      role="dialog"
      label={translate('ai.pins.popover', { number: pin.number })}
      className={`ai-pin-popover${hidden ? ' is-capturing' : ''}${dragging ? ' is-dragging' : ''}`}
      style={position}
      // A press elsewhere keeps the box (saved when it has content); Escape discards, as the close button does.
      onClose={() => closePinBox('keep', translate)}
      onEscape={() => closePinBox('discard', translate)}
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
          {pin.delivery.kind === 'sent' && <PinBadge pin={pin} progress={progress} />}
          <TipButton
            label={editable && pin.savedAt === undefined ? translate('ai.pins.discard') : translate('ai.pins.close')}
            onClick={() => closePinBox('discard', translate)}
          >
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
            const image = working.images.find((entry) => entry.id === id);
            if (image !== undefined && editable) {
              removePinImage(pin.id, image.id satisfies PinImageId);
              focusBox();
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
              value={working.comment}
              onChange={(text) => setPinComment(pin.id, text)}
              // Enter saves, as Enter sends in the composer; Shift+Enter is a new line there and here.
              onSend={() => savePinBox()}
              dictationDraft={dictating ? { text: voice.interim, decoding: voice.decoding, place: 'caret' } : undefined}
            />
            {dictating && <DictationLine voice={voice} />}
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
                disabled={working.images.length >= PIN_LIMITS.imagesPerPinMax || chips.length >= AI_LIMITS.attachmentsMax}
                onClick={() => picker.current?.click()}
              >
                <ImageGlyph size={16} />
              </TipButton>
              {onRecapture !== undefined && (
                <TipButton
                  label={translate('ai.pins.recapture')}
                  onClick={() => {
                    onRecapture();
                    focusBox();
                  }}
                >
                  <CropGlyph size={16} />
                </TipButton>
              )}
              <span className="ai-pin-tools-gap" />
              <PinModelPicker pin={pin} />
              <MicButton dictation={dictation} />
              {/* The composer's primary action sits last in its row; the pin's is Save, blue at rest, hover and press. */}
              <button type="button" className="primary ai-pin-save" disabled={!canSave} onClick={() => savePinBox()}>
                {translate('ai.pins.save')}
              </button>
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

/**
 * Gives the box the keyboard. A click on the canvas leaves the keyboard in the canvas frame, where a key would reach
 * the page (and the frame's forwarded shortcuts: Backspace deletes the selection), so the window's own document
 * takes it back before the box does.
 */
function focusComposer(handle: ComposerHandle | undefined): void {
  if (handle === undefined) {
    return;
  }
  const holder = document.activeElement;
  if (holder instanceof HTMLIFrameElement) {
    holder.blur();
  }
  if (!document.hasFocus()) {
    window.focus();
  }
  handle.focus();
}
