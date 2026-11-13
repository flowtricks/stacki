import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactElement, ReactNode, RefObject } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import Popup from '../../ui/Popup';
import { popupBox } from '../../ui/Dropdown';
import { usePopupScrollLock } from '../../ui/popupScrollLock';

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
const isLong = (value: string) => String(value).length > LONG_VALUE || String(value).includes('\n');

/** Is the value wider than the field showing it? */
function doesNotFit(container: Element, value: string) {
  // Nothing typed, nothing to fit: what overflows then is the placeholder, which
  // the field's scrollWidth counts the same as a value.
  if (value === '') {
    return false;
  }
  // The token editor first, and only then the plain input: with a code field
  // the input is always in the DOM, hidden behind the editor, and a selector
  // that took either would have measured the invisible one.
  const field = container.querySelector('.embed-editor_varconnect-editor') || container.querySelector('.var-input') || container.querySelector('input');
  // clientWidth is 0 before layout (and in jsdom); fall back to the count.
  if (!field || !field.clientWidth) {
    return isLong(value);
  }
  return field.scrollWidth > field.clientWidth + 1 || isLong(value);
}
// One custom-value box at a time. Each cell owns its own, so the sheet holds a
// pointer to whichever is open: opening another calls this first, and it closes
// the same way pressing outside does, keeping what was typed. The press that
// opens the new one is stopped at its own cell (so the chip under it does
// nothing), and that stop is also what keeps it from reaching the open box's
// outside-press handler — hence this rather than relying on the press.
let closeOpenCustom: (() => void) | undefined;

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
interface CustomValueProps {
  readonly value: string;
  readonly label?: string;
  /** The CSS property being edited, so the chooser offers only variables that fit it. */
  readonly prop?: string | undefined;
  readonly anchor?: DOMRect | undefined;
  readonly anchorEl?: HTMLElement | undefined;
  readonly onCancel: () => void;
  readonly onSave: (value: string) => void;
  /**
   * Wraps the text field in the variable picker (VariableConnect's
   * connectCustomField). Passed in rather than imported: the picker opens this
   * editor, so importing it back would make the two modules a cycle.
   */
  readonly connectField: (field: ReactElement, prop: string | undefined, onDraft: (value: string) => void) => ReactNode;
}
function CustomValue(props: CustomValueProps) {
  const state = useCustomValue(props);
  const translate = useTranslate();
  const { label } = props;
  return (
    <Popup
      mode="popover"
      anchor={props.anchorEl}
      onClose={() => props.onSave(state.commit())}
      onEscape={props.onCancel}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          props.onSave(state.commit());
        }
      }}
      ref={state.boxRef}
      className="var-custom"
      style={{
        left: state.position?.left ?? -9999,
        top: state.position?.top,
        bottom: state.position?.bottom,
        maxHeight: state.position?.maxHeight,
      }}
    >
      <div className="var-custom-head">
        <span>{translate('style.customValueEditor.customValue')}</span>
        <span className="var-custom-name">{label}</span>
      </div>
      {props.connectField(
        <textarea
          ref={state.fieldRef}
          className="var-custom-input"
          value={state.draft}
          spellCheck={false}
          rows={4}
          onChange={(event) => state.setDraft(event.target.value)}
          /* Enter is handled for the whole box (see the key listener above) — a
             CSS value has no need for a line break, and the field that actually
             has focus is usually the rich one in front of this. */
        />,
        props.prop,
        state.setDraft,
      )}
      <div className="var-custom-foot">
        <span>{translate('style.customValueEditor.hint')}</span>
      </div>
    </Popup>
  );
}

function useCustomValue({ value, anchor, onSave }: CustomValueProps) {
  const [draft, setDraft] = useState(value);
  const boxRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const position = useCustomPosition(boxRef, anchor);
  const commit = useCallback((): string => {
    const rich = boxRef.current?.querySelector<HTMLElement>('.embed-editor_varconnect-editor');
    // Blur commits synchronously; reading the draft first would discard the last keystroke.
    if (rich && (rich === document.activeElement || rich.contains(document.activeElement))) {
      rich.blur();
    }
    return draftRef.current;
  }, []);
  useCustomClose(boxRef, commit, onSave);
  useCustomFocus(boxRef, fieldRef);
  return { draft, setDraft, boxRef, fieldRef, position, commit };
}

function useCustomPosition(boxRef: RefObject<HTMLDivElement>, anchor: DOMRect | undefined) {
  const [position, setPosition] = useState<CSSProperties | undefined>(undefined);
  useLayoutEffect(() => {
    if (!anchor) {
      return;
    }
    const wanted = boxRef.current?.offsetHeight || 190;
    const box = popupBox(anchor, wanted, window.innerHeight);
    setPosition({
      left: Math.max(8, Math.min(anchor.left, window.innerWidth - 460)),
      top: box.top,
      bottom: box.bottom,
      maxHeight: box.maxHeight,
    });
  }, [anchor, boxRef]);
  return position;
}

function useCustomClose(boxRef: RefObject<HTMLDivElement>, commit: () => string, onSave: (value: string) => void): void {
  const saveRef = useRef(onSave);
  saveRef.current = onSave;
  useEffect(() => {
    const close = (): void => saveRef.current(commit());
    // The sheet may contain many cells, but only one owns a custom editor.
    closeOpenCustom?.();
    closeOpenCustom = close;
    return () => {
      if (closeOpenCustom === close) {
        closeOpenCustom = undefined;
      }
    };
  }, [commit]);
  usePopupScrollLock(boxRef);
}

function useCustomFocus(boxRef: RefObject<HTMLDivElement>, fieldRef: RefObject<HTMLTextAreaElement>) {
  useEffect(() => {
    const settled = (): boolean => !!boxRef.current?.contains(document.activeElement) || !!document.activeElement?.closest('.embed-editor_varpicker');
    if (settled()) {
      return;
    }
    // Check twice: the portaled picker may claim focus on this same tick.
    const timer = setTimeout(() => {
      if (settled()) {
        return;
      }
      const rich = boxRef.current?.querySelector<HTMLElement>('.embed-editor_varconnect-editor');
      if (!rich) {
        fieldRef.current?.select();
        return;
      }
      rich.focus();
      const range = document.createRange();
      range.selectNodeContents(rich);
      range.collapse(false);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    }, 0);
    return () => clearTimeout(timer);
  });
}

// Swapping a variable keeps the expression around it: picking a new one inside
// `calc(var(--a) + 10px)` replaces the reference, not the calc.
function withBinding(value: string, binding: string) {
  const existing = String(value).match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i);
  return existing ? value.replace(existing[0], binding) : binding;
}
export { CustomValue, isLong, doesNotFit, withBinding };
export default CustomValue;
