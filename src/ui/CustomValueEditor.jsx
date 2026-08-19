import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import VariableConnect from '../style-panel/VariableConnect';
import { registerPopupLayer } from '../style-panel/lib/popup-layer';
import { popupBox } from './Dropdown.jsx';

// The whole value, in a box big enough to read it.
//
// A style value that has outgrown its field is usually the one most worth
// reading: a clamp() of four variables, a calc() of three. Editing it through a
// slot showing a third of itself is the worst place in the app to be, and it is
// exactly where a long value puts you.
//
// This was written for the variables sheet and now serves the style panel too,
// because the problem is the same wherever a value is longer than the box drawn
// for it. Both open it the same two ways: pressing a field whose value does not
// fit, and `=` in any field at all.

const LONG_VALUE = 34;
const isLong = (value) => String(value).length > LONG_VALUE || String(value).includes('\n');

/** Is the value wider than the field showing it? */
function doesNotFit(container, value) {
  // The token editor first, and only then the plain input: with a code field
  // the input is always in the DOM, hidden behind the editor, and a selector
  // that took either would have measured the invisible one.
  const field =
    container.querySelector('.embed-editor_varconnect-editor') ||
    container.querySelector('.var-input') ||
    container.querySelector('input');
  // clientWidth is 0 before layout (and in jsdom); fall back to the count.
  if (!field || !field.clientWidth) return isLong(value);
  return field.scrollWidth > field.clientWidth + 1 || isLong(value);
}
// One custom-value box at a time. Each cell owns its own, so the sheet holds a
// pointer to whichever is open: opening another calls this first, and it closes
// the same way pressing outside does, keeping what was typed. The press that
// opens the new one is stopped at its own cell (so the chip under it does
// nothing), and that stop is also what keeps it from reaching the open box's
// outside-press handler — hence this rather than relying on the press.
let closeOpenCustom = null;

// The whole value, in a box big enough to read it. A long value is usually a
// long expression — a clamp() of four variables, a calc() of three — and the
// thing that makes it editable is seeing all of it at once, with the chips
// where they fall.
//
// The field inside is the same one the cell uses, so a chip is still a chip:
// click it to swap the variable, type around it. Opened by clicking a long
// value, or by pressing "=" in any field.
/**
 * `value` is what to edit, `label` the quiet name in the corner (a variable's
 * name in the sheet, a property's in the style panel), `anchor` the rectangle
 * of the field it came from.
 */
function CustomValue({ value: initial, label, anchor, anchorEl, onCancel, onSave }) {
  const [draft, setDraft] = useState(initial);
  const [pos, setPos] = useState(null);
  const boxRef = useRef(null);
  const fieldRef = useRef(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const wanted = boxRef.current?.offsetHeight || 190;
    const box = popupBox(anchor, wanted, window.innerHeight);
    setPos({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - 460)),
      top: box.top,
      bottom: box.bottom,
      maxHeight: box.maxHeight,
    });
  }, [anchor]);

  // This box belongs to the field it opened from, so a popover holding that field
  // doesn't read a press in here — or the focus moving here — as leaving it. See
  // style-panel/lib/popup-layer.
  useLayoutEffect(() => registerPopupLayer(boxRef.current, anchorEl ?? null), [anchorEl]);

  // Whatever is in the box right now, for the two ways it can be closed from
  // outside itself: another box opening, and a press elsewhere.
  const draftRef = useRef(draft);
  draftRef.current = draft;

  // The field you type in is the rich one, and what it holds only reaches `draft`
  // when it commits — which it does on blur. Every way of closing this box has to
  // take it out of focus FIRST, or it saves the draft from before the last edit:
  // moving the `)` past a variable chip and then clicking away used to write the
  // value back exactly as it was. The commit runs flushSync, so `draftRef` is
  // current by the time this returns.
  const commit = () => {
    const rich = boxRef.current?.querySelector('.embed-editor_varconnect-editor');
    if (rich && (rich === document.activeElement || rich.contains(document.activeElement))) rich.blur();
    return draftRef.current;
  };

  useEffect(() => {
    const close = () => onSave(commit());
    closeOpenCustom?.(); // never two at once
    closeOpenCustom = close;
    return () => {
      if (closeOpenCustom === close) closeOpenCustom = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Nothing behind the box moves while it is open. It is anchored to the cell
  // it came from, so a panel scrolling underneath would slide that cell out
  // from under it — and the box is where the editing is happening anyway.
  // Every scroller in the app is covered by refusing the gesture itself,
  // rather than by hunting down each one and locking its overflow.
  useEffect(() => {
    const onWheel = (e) => {
      if (!boxRef.current?.contains(e.target)) e.preventDefault();
    };
    document.addEventListener('wheel', onWheel, { passive: false, capture: true });
    document.addEventListener('touchmove', onWheel, { passive: false, capture: true });
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true });
      document.removeEventListener('touchmove', onWheel, { capture: true });
    };
  }, []);

  useEffect(() => {
    const onDown = (e) => {
      if (!boxRef.current || boxRef.current.contains(e.target)) return;
      // The variable picker this box opens renders through a portal to the
      // body, so it is not INSIDE the box by the DOM's reckoning even though
      // it belongs to it. Without this, pressing a variable in that list read
      // as a press outside — the box closed and saved the draft it already
      // had, and the variable you just picked went nowhere. Which looked
      // exactly like the picker doing nothing at all.
      if (e.target instanceof Element && e.target.closest('.embed-editor_varpicker')) return;
      onSave(commit());
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      // Enter saves from the rich field too. It swallows the key itself (blurring
      // to commit), so the textarea's own Enter handler never hears it — and the
      // footer promising "Enter to save" was only true if you happened to be in
      // the plain field behind it.
      if (e.key === 'Enter' && !e.shiftKey && boxRef.current?.contains(e.target)) {
        e.preventDefault();
        onSave(commit());
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [draft, onCancel, onSave]);

  // It opened because you meant to edit this value, so it arrives focused with
  // the caret at the end. The field you can see is the rich one — the textarea
  // behind it only carries the value — so focus THAT; selecting the hidden one
  // left the box looking focused while every keystroke went nowhere.
  //
  // Every render, not just on mount — but a no-op the moment the caret is
  // anywhere inside the popup, so it never fights the caret as you type. The
  // rich field is redrawn when the variables it names resolve, and a redrawn
  // node is a new node: focus put on the old one goes to the document, and the
  // popup that opened because you meant to type in it sits there taking
  // nothing.
  // …and a no-op while the variable picker holds focus. That picker is portaled
  // elsewhere, so it isn't "inside" this popup — without this the effect took focus
  // straight back and collapsed the caret to the end, which is where the variable
  // then landed: picking one with the caret before the `)` of a calc() put it after.
  const focusIsSettled = () =>
    boxRef.current?.contains(document.activeElement) ||
    // The variable picker is portaled out of this popup, so it isn't "inside" it.
    !!document.activeElement?.closest?.('.embed-editor_varpicker');
  useEffect(() => {
    if (focusIsSettled()) return undefined;
    const t = setTimeout(() => {
      // Checked again here, not just above: the picker takes focus for its search
      // box a tick after it opens, which is this tick.
      if (focusIsSettled()) return;
      const rich = boxRef.current?.querySelector('.embed-editor_varconnect-editor');
      if (!rich) {
        fieldRef.current?.select();
        return;
      }
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      range.collapse(false); // the end: a long expression is edited, not replaced
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }, 0);
    return () => clearTimeout(t);
  });

  return createPortal(
    <div
      ref={boxRef}
      className="var-custom"
      style={{ left: pos?.left ?? -9999, top: pos?.top, bottom: pos?.bottom, maxHeight: pos?.maxHeight }}
    >
      <div className="var-custom-head">
        <span>Custom value</span>
        <span className="var-custom-name">{label}</span>
      </div>
      {/* What comes back is the finished value, not a bare binding: the field
          has already decided whether the variable replaces what was there or
          goes in at the caret (see insert-binding.ts). Running withBinding over
          it again was a second opinion on a question already answered — and
          when the first answer was "replace", it turned a picked variable into
          a wiped value. */}
      <VariableConnect className="is-multiline" code onDraft={setDraft} onPick={(next) => setDraft(next)}>
        <textarea
          ref={fieldRef}
          className="var-custom-input"
          value={draft}
          spellCheck={false}
          rows={4}
          onChange={(e) => setDraft(e.target.value)}
          /* Enter is handled for the whole box (see the key listener above) — a
             CSS value has no need for a line break, and the field that actually
             has focus is usually the rich one in front of this. */
        />
      </VariableConnect>
      <div className="var-custom-foot">
        <span>Enter to save · Escape to cancel</span>
      </div>
    </div>,
    document.body
  );
}

// Swapping a variable keeps the expression around it: picking a new one inside
// `calc(var(--a) + 10px)` replaces the reference, not the calc.
function withBinding(value, binding) {
  const existing = String(value).match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i);
  return existing ? value.replace(existing[0], binding) : binding;
}
export { CustomValue, isLong, doesNotFit, withBinding };
export default CustomValue;
