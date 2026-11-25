// The app UI kit's `<stacki-confirm>`: a question asked inside the app, never
// through the browser's `confirm()`. It is the editor's confirmation
// (src/ui/ConfirmDialog.tsx) on the editor's Popup: a modal centred in the
// app's frame, or, given an anchor, a popover beside the control that asked.
// Escape, Cancel and a click outside answer no; the confirm button answers yes.
//
// As in the editor, a destructive question (`tone: 'danger'`) starts on Cancel,
// so a stray Return cannot authorize it; any other question starts on its
// confirm button, so Return answers yes. Tab stays on the two buttons while the
// question is open, and focus goes back to the control that asked when it closes
// (Popup.tsx restores it).
import { useEffect, useId, useRef, type CSSProperties, type KeyboardEvent } from 'react';
import { assert } from '../../../../shared/core/assert';
import Popup from '../../../ui/Popup';
import { anchoredBox } from './KitMenu';

/** A question's tone: `danger` draws the confirm button red and starts on Cancel. */
export const KIT_CONFIRM_TONES = ['default', 'danger'] as const;
export type KitConfirmTone = (typeof KIT_CONFIRM_TONES)[number];

/** The panel's narrowest width beside an anchor; a question is a sentence or two. */
const CONFIRM_WIDTH_PX_MIN = 260;
/** The height asked of the flip before the panel is drawn: a heading, two lines and the buttons. */
const CONFIRM_HEIGHT_PX_WANTED = 150;

export interface KitConfirmQuestion {
  readonly heading: string;
  readonly message: string;
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  readonly tone: KitConfirmTone;
  /** The control the question is about; absent, the question is centred in the frame. */
  readonly anchor: HTMLElement | undefined;
}

export function KitConfirm(props: { readonly question: KitConfirmQuestion; readonly onAnswer: (confirmed: boolean) => void }) {
  const { question } = props;
  assert(question.confirmLabel.length > 0, 'A confirm button has a label');
  assert(question.cancelLabel.length > 0, 'A cancel button has a label');
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const headingId = useId();
  const danger = question.tone === 'danger';
  useEffect(() => {
    const start = danger ? cancelRef.current : confirmRef.current;
    assert(start !== null, 'The question has its buttons when it opens');
    start.focus();
  }, [danger]);
  const anchor = question.anchor;
  const box: CSSProperties | undefined =
    anchor === undefined ? undefined : anchoredBox(anchor.getBoundingClientRect(), { heightPx: CONFIRM_HEIGHT_PX_WANTED, widthPxMin: CONFIRM_WIDTH_PX_MIN });
  return (
    <Popup
      mode={anchor === undefined ? 'modal' : 'popover'}
      open={true}
      anchor={anchor}
      onClose={() => props.onAnswer(false)}
      className={anchor === undefined ? 'stacki-kit-confirm' : 'stacki-kit-confirm stacki-kit-confirm-anchored'}
      role="alertdialog"
      labelledBy={question.heading === '' ? undefined : headingId}
      label={question.heading === '' ? question.message : undefined}
      style={box}
      onKeyDown={(event) => trapFocus(event, [cancelRef.current ?? undefined, confirmRef.current ?? undefined])}
    >
      {({ close, finish }) => (
        <>
          {question.heading !== '' && (
            <div id={headingId} className="stacki-kit-confirm-heading">
              {question.heading}
            </div>
          )}
          {question.message !== '' && <div className="stacki-kit-confirm-message">{question.message}</div>}
          <div className="stacki-kit-confirm-actions">
            <button ref={cancelRef} type="button" onClick={close}>
              {question.cancelLabel}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className={danger ? 'primary stacki-kit-confirm-danger' : 'primary'}
              onClick={() => finish(() => props.onAnswer(true))}
            >
              {question.confirmLabel}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}

// Tab and Shift+Tab move between the question's buttons, wrapping, and never leave it.
function trapFocus(event: KeyboardEvent<HTMLElement>, buttons: ReadonlyArray<HTMLButtonElement | undefined>): void {
  if (event.key !== 'Tab') {
    return;
  }
  const present = buttons.filter((button): button is HTMLButtonElement => button !== undefined);
  assert(present.length === buttons.length, 'Both buttons are mounted while the question is open');
  event.preventDefault();
  const at = present.findIndex((button) => button === document.activeElement);
  const last = present.length - 1;
  let next: number;
  if (event.shiftKey) {
    next = at > 0 ? at - 1 : last;
  } else {
    next = at < last ? at + 1 : 0;
  }
  const target = present[next];
  assert(target !== undefined, 'The next button is one of the two');
  target.focus();
}
