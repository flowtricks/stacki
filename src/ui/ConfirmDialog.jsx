import React, { useEffect, useRef, useState } from 'react';

// Asking before something irreversible.
//
// The browser's own `confirm()` is a different application interrupting this
// one: system chrome, system typography, a title bar naming localhost, and two
// buttons that cannot say what they do beyond OK and Cancel. Next to a window
// this carefully drawn it reads as a bug.
//
// So this is the same question in the app's own modal, with two differences
// that matter beyond looks:
//
//   - The buttons say the action. "Delete branch" and "Cancel" can be told
//     apart at a glance; "OK" and "Cancel" have to be read back against a
//     question you have already stopped looking at.
//   - Anything destructive is marked as such and starts with the SAFE button
//     focused, so a stray Return key cannot delete anything.
//
// Called as a function, because a confirm is a question with an answer and
// reads best as one:
//
//   if (!(await confirmDialog({ title: '…', confirmLabel: 'Delete' }))) return;

let open = null; // set by the host below while it is mounted

/**
 * Ask, and resolve true if they agree.
 *
 * `body` may be a string or any node. `danger` colours the confirm button and
 * focuses Cancel instead of it.
 *
 * `checkbox` — `{ label, defaultChecked, hint }` — adds one tick box for a
 * decision that belongs WITH the question rather than after it. Given one, the
 * answer resolves as `{ checked }` instead of `true`, which is still truthy,
 * so `if (!(await confirmDialog(…))) return;` reads the same either way.
 */
export function confirmDialog({
  title,
  body = null,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
  checkbox = null,
} = {}) {
  return new Promise((resolve) => {
    if (!open) {
      // The host is always mounted in practice; if it somehow is not, answer
      // "no" rather than falling back to a system dialog or hanging. Nothing
      // that asks this question should proceed unasked.
      console.error('confirmDialog: no <ConfirmHost /> is mounted; answering no.');
      resolve(false);
      return;
    }
    open({ title, body, confirmLabel, cancelLabel, danger, checkbox, resolve });
  });
}

/** Mounted once, near the root. Renders whatever question is being asked. */
export function ConfirmHost() {
  const [ask, setAsk] = useState(null);
  const [checked, setChecked] = useState(false);
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  useEffect(() => {
    if (ask) setChecked(ask.checkbox?.defaultChecked ?? false);
  }, [ask]);

  useEffect(() => {
    open = setAsk;
    return () => {
      open = null;
    };
  }, []);

  // The safe button takes focus on a destructive question, so Return cannot
  // confirm something unrecoverable by accident.
  useEffect(() => {
    if (!ask) return;
    const el = ask.danger ? cancelRef.current : confirmRef.current;
    el?.focus();
  }, [ask]);

  useEffect(() => {
    if (!ask) return undefined;
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        answer(false);
      } else if (e.key === 'Enter' && !ask.danger) {
        // Only where the answer is recoverable. On a destructive question
        // Return does nothing, and the button has to be chosen deliberately.
        e.preventDefault();
        answer(true);
      }
    };
    // Capture, so the app's own Escape and Enter handling does not act on a
    // key that was meant for this.
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  });

  const answer = (value) => {
    if (!ask) return;
    // With a tick box the answer is not just yes or no — it is yes-and-what.
    ask.resolve(value && ask.checkbox ? { checked } : value);
    setAsk(null);
  };

  if (!ask) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && answer(false)}
    >
      <div className="modal confirm-dialog" role="alertdialog" aria-modal="true">
        <div className="modal-header">{ask.title}</div>
        {(ask.body || ask.checkbox) && (
          <div className="modal-body confirm-body">
            {ask.body}
            {ask.checkbox && (
              <label className="confirm-check">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span>
                  {ask.checkbox.label}
                  {ask.checkbox.hint && <em className="confirm-check-hint">{ask.checkbox.hint}</em>}
                </span>
              </label>
            )}
          </div>
        )}
        <div className="modal-footer">
          <button ref={cancelRef} onClick={() => answer(false)}>
            {ask.cancelLabel}
          </button>
          <button
            ref={confirmRef}
            className={ask.danger ? 'danger' : 'primary'}
            onClick={() => answer(true)}
          >
            {ask.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
