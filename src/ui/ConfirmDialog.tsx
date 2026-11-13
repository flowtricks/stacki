import Popup from './Popup';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { useTranslate } from '../lib/i18n/useTranslate';

// A confirmation stays inside the app, with action-specific labels. Destructive
// questions focus Cancel so a stray Return key cannot authorize deletion.
interface Checkbox {
  readonly label: ReactNode;
  readonly hint?: ReactNode;
  readonly defaultChecked?: boolean;
}
interface ConfirmOptions {
  readonly title?: ReactNode;
  readonly body?: ReactNode;
  readonly confirmLabel?: string;
  readonly cancelLabel?: string;
  readonly danger?: boolean;
  readonly checkbox?: Checkbox | undefined;
}
type ConfirmAnswer = boolean | { readonly checked: boolean };
interface Question {
  readonly title: ReactNode;
  readonly body: ReactNode;
  /** Undefined: the window's own "Continue" and "Cancel", in the language on screen. */
  readonly confirmLabel: string | undefined;
  readonly cancelLabel: string | undefined;
  readonly danger: boolean;
  readonly checkbox: Checkbox | undefined;
  readonly resolve: (answer: ConfirmAnswer) => void;
}
let open: ((question: Question) => void) | undefined;

export function confirmDialog({ title, body, confirmLabel, cancelLabel, danger = false, checkbox }: ConfirmOptions = {}): Promise<ConfirmAnswer> {
  return new Promise((resolve) => {
    if (!open) {
      console.error('confirmDialog: no <ConfirmHost /> is mounted; answering no.');
      resolve(false);
      return;
    }
    open({ title, body, confirmLabel, cancelLabel, danger, checkbox, resolve });
  });
}

/** One host owns the window's single confirmation slot. */
export function ConfirmHost() {
  const [ask, setAsk] = useState<Question | undefined>(undefined);
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (ask) {
      setChecked(ask.checkbox?.defaultChecked ?? false);
    }
  }, [ask]);
  useEffect(() => {
    open = setAsk;
    return () => {
      if (open === setAsk) {
        open = undefined;
      }
    };
  }, []);
  useEffect(() => {
    if (ask) {
      (ask.danger ? cancelRef.current : confirmRef.current)?.focus();
    }
  }, [ask]);
  const answer = useCallback(
    (value: boolean) => {
      if (!ask) {
        return;
      }
      ask.resolve(value && ask.checkbox ? { checked } : value);
      setAsk(undefined);
    },
    [ask, checked],
  );
  if (!ask) {
    return undefined;
  }
  return <ConfirmSurface ask={ask} checked={checked} setChecked={setChecked} answer={answer} confirmRef={confirmRef} cancelRef={cancelRef} />;
}

interface SurfaceProps {
  readonly ask: Question;
  readonly checked: boolean;
  readonly setChecked: (checked: boolean) => void;
  readonly answer: (value: boolean) => void;
  readonly confirmRef: RefObject<HTMLButtonElement>;
  readonly cancelRef: RefObject<HTMLButtonElement>;
}
function ConfirmSurface({ ask, checked, setChecked, answer, confirmRef, cancelRef }: SurfaceProps) {
  const translate = useTranslate();
  return (
    <Popup className="modal confirm-dialog" role="alertdialog" onClose={() => answer(false)}>
      {({ close, finish }) => (
        <>
          <div className="modal-header">{ask.title}</div>
          {(ask.body || ask.checkbox) && (
            <div className="modal-body confirm-body">
              {ask.body && <div>{ask.body}</div>}
              {ask.checkbox && (
                <label className="confirm-check">
                  <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
                  <span>
                    {ask.checkbox.label}
                    {ask.checkbox.hint && <em className="confirm-check-hint">{ask.checkbox.hint}</em>}
                  </span>
                </label>
              )}
            </div>
          )}
          <div className="modal-footer">
            <button ref={cancelRef} onClick={close}>
              {ask.cancelLabel ?? translate('ui.cancel')}
            </button>
            <button ref={confirmRef} className={ask.danger ? 'danger' : 'primary'} onClick={() => finish(() => answer(true))}>
              {ask.confirmLabel ?? translate('ui.continue')}
            </button>
          </div>
        </>
      )}
    </Popup>
  );
}
