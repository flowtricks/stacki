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
 *
 * `input` — `{ label, defaultValue, placeholder, validate }` — the same idea
 * for a question whose answer is a word rather than a yes. Naming the thing
 * you are about to make is part of deciding to make it, not a second dialog
 * afterwards. `validate(value)` returns a sentence to show and to hold the
 * confirm button closed with, or nothing when the value will do. The answer
 * carries `{ value }`, alongside `{ checked }` when both are asked at once.
 */
export function confirmDialog({
  title,
  body = null,
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  danger = false,
  checkbox = null,
  input = null,
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
    open({ title, body, confirmLabel, cancelLabel, danger, checkbox, input, resolve });
  });
}

/** Mounted once, near the root. Renders whatever question is being asked. */
export function ConfirmHost() {
  const [ask, setAsk] = useState(null);
  const [checked, setChecked] = useState(false);
  const [text, setText] = useState('');
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!ask) return;
    setChecked(ask.checkbox?.defaultChecked ?? false);
    setText(ask.input?.defaultValue ?? '');
  }, [ask]);

  // Whatever is wrong with what has been typed, or nothing.
  const problem = ask?.input ? ask.input.validate?.(text.trim()) || null : null;

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
    // A question with a field is answered in the field — focusing a button
    // there would ask for a name and put the caret somewhere else.
    if (ask.input) {
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
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
      } else if (e.key === 'Enter' && !ask.danger && !problem) {
        // Only where the answer is recoverable. On a destructive question
        // Return does nothing, and the button has to be chosen deliberately —
        // and a field the dialog is refusing is not an answer yet either.
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
    // With a tick box or a field the answer is not just yes or no — it is
    // yes-and-what. Both can be asked at once, so the two ride together.
    const asked = ask.checkbox || ask.input;
    const extras = {
      ...(ask.checkbox ? { checked } : {}),
      ...(ask.input ? { value: text.trim() } : {}),
    };
    ask.resolve(value && asked ? extras : value);
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
        {(ask.body || ask.checkbox || ask.input) && (
          <div className="modal-body confirm-body">
            {ask.body}
            {ask.input && (
              <label className="confirm-field">
                {ask.input.label && <span>{ask.input.label}</span>}
                <input
                  ref={inputRef}
                  value={text}
                  spellCheck={false}
                  placeholder={ask.input.placeholder || ''}
                  onChange={(e) => setText(e.target.value)}
                />
                {/* Held open once something has been typed, so the rule is not
                    an error thrown at an empty field the moment it appears. */}
                {problem && text.trim() ? <em className="confirm-field-problem">{problem}</em> : null}
              </label>
            )}
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
            disabled={!!problem}
            onClick={() => answer(true)}
          >
            {ask.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
