import { cloneElement, isValidElement, useEffect, useRef, useState } from 'react';
import type { MutableRefObject, ReactElement, ReactNode, RefObject } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { flushSync } from 'react-dom';
import { type ProjectVariable } from './model/webflow';
import { SLOT_MARK, slotOfMarked, type ValueSlot } from '../../../shared/properties/valueSlot';
import { selectionOffsets, setCaretOffset } from './model/cssCode';
import CustomValue, { doesNotFit } from './CustomValueEditor';
import { insertBindingAt, type ValueSelection } from './model/insertBinding';
import { completeTypedVariable, fieldOffsetOf, replaceVariableAt, typedVariableAt, type TypedVariable } from './model/typedVariable';
import type { PickerNavigation } from './VariablePicker';
import { PlusIcon } from './VariableIcons';
import { varTypeAllowed, useSharedVars } from './sharedVars';
import { VariablePicker } from './VariablePicker';
import VariableHint from './VariableHint';
import { type Chip, CHIP_MARK, fieldText, type PressedChip, serializeTokens, TokenField } from './TokenField';
import './embedEditor.css';
import {
  childValue,
  childPlaceholder,
  bindingName,
  nativeVariableNames,
  setInputValue,
  type FieldRefValue,
  type ChildFieldProps,
  updateChildRef,
} from './connectFieldHelpers';

export { buildTokenHtml, serializeTokens } from './TokenField';

export { VariablePicker } from './VariablePicker';

export { useSharedVars } from './sharedVars';

type VariableConnectProps = {
  onPick: (binding: string) => void;
  /** Called with the value as it is typed, before it is committed. */
  onDraft?: (value: string) => void;
  disabled?: boolean;
  ariaLabel?: string;
  /** Layout modifier for the wrapper (e.g. 'is-fill' to grow inside a flex row). */
  className?: string;
  /** The CSS property being edited — filters the list to variable types that fit it
   *  (color props → Color only; font-family → FontFamily; else no color/font). */
  prop?: string;
  /** Edit the value as code: syntax colouring, and arrow keys that step the
   *  number under the caret. Implies the rich field even for a value with no
   *  variable in it — there is nothing to colour in a plain <input>. */
  code?: boolean;
  /** Floor for the rich field's arrow-stepping — passed through to the editor. */
  stepMin?: number;
  /** This field is already the room a long value needs — a multi-line editor
   *  given its own space in the panel. A long value opens the big editor from
   *  an ordinary field because a slot showing a third of what you are changing
   *  is the worst place to change it from; opening one over a field that is
   *  already that size just puts a box in front of the box. */
  expanded?: boolean;
  children: ReactNode;
};

/**
 * The custom-value editor's text field, connected to the variable picker.
 * What comes back is the finished value, not a bare binding: the field has
 * already decided whether the variable replaces what was there or goes in at
 * the caret (see insertBinding.ts). Running withBinding over it again was a
 * second opinion on a question already answered — and when the first answer
 * was "replace", it turned a picked variable into a wiped value.
 */
export function connectCustomField(field: ReactElement, prop: string | undefined, onDraft: (value: string) => void): ReactNode {
  // The property travels with the value: without it the chooser in the big box
  // offered every variable, colours in a gap and sizes in a background.
  return (
    <VariableConnect className="is-multiline" code onDraft={onDraft} onPick={onDraft} {...(prop === undefined ? {} : { prop })}>
      {field}
    </VariableConnect>
  );
}

export default function VariableConnect(props: VariableConnectProps) {
  const translate = useTranslate();
  const { onPick, disabled, ariaLabel = translate('style.variablePicker.connectToVariable'), prop } = props;
  const connect = useVariableConnect(props);
  const { open, setOpen, big, setBig, value, applied, showToken, field, wrapRef } = connect;
  const { editorRef, dotRef, chipText, liveValue, selectionRef, readCaret, hintValue } = connect;
  const { chipTarget, setChipTarget, suggest, setSuggest, navigationRef } = connect;
  const anchor = (showToken ? editorRef.current : dotRef.current) ?? undefined;
  const { openedRef } = connect;
  // The value as it would be with `chosen` picked, worked out from the value
  // the chooser opened on: previews change the field, and a pick after three
  // of them must still be one change from where it started.
  const withChosen = (chosen: string): string => {
    const base = openedRef.current?.value ?? liveValue();
    if (chipTarget !== undefined) {
      return replaceVariableAt(base, chipTarget.index, chosen);
    }
    return insertBindingAt(base, chosen, selectionRef.current);
  };
  // Shown, not written: the field's draft, the path typing takes, so the page
  // previews it the same way it previews a value being typed.
  const draftTo = (next: string): void => {
    if (props.onDraft === undefined) {
      pushDraft(field, next);
    } else {
      props.onDraft(next);
    }
  };
  const openChooser = (): void => {
    openedRef.current = { value: liveValue(), previewed: false };
    setOpen(true);
  };
  const closeChooser = (): void => {
    const opened = openedRef.current;
    openedRef.current = undefined;
    // Closed without a pick: whatever the arrows previewed goes back.
    if (opened !== undefined && opened.previewed) {
      draftTo(opened.value);
    }
    setChipTarget(undefined);
    setSuggest(undefined);
    setOpen(false);
  };
  // A pick from a pressed chip swaps that chip; a pick from typing completes
  // what was typed; any other pick replaces the selection or goes in at the caret.
  const pick = (chosen: string): void => {
    const current = liveValue();
    if (suggest !== undefined) {
      const completed = completeTypedVariable(current, suggest, chosen);
      setSuggest(undefined);
      onPick(completed.value);
      placeCaretAfterPick(editorRef, field.inputRef, completed);
      return;
    }
    const next = withChosen(chosen);
    openedRef.current = undefined;
    onPick(next);
    setChipTarget(undefined);
    setOpen(false);
  };
  // Where the pick would land in the field's expression: the filter judges each variable's
  // computed value there (valueSlot.ts), not against the property alone.
  const pickSlot = (): ValueSlot | undefined => {
    const base = openedRef.current?.value ?? liveValue();
    if (suggest !== undefined) {
      return slotOfMarked(completeTypedVariable(liveValue(), suggest, SLOT_MARK).value);
    }
    if (chipTarget !== undefined) {
      return slotOfMarked(replaceVariableAt(base, chipTarget.index, SLOT_MARK));
    }
    return slotOfMarked(insertBindingAt(base, SLOT_MARK, selectionRef.current));
  };
  const preview = (chosen: string): void => {
    const opened = openedRef.current;
    if (opened === undefined) {
      return;
    }
    openedRef.current = { ...opened, previewed: true };
    draftTo(withChosen(chosen));
  };
  // The pointer left the list, the window lost focus: the value goes back to what the
  // chooser opened on, and stays there until another row is previewed. Idempotent.
  // The preview is only ever a draft (draftTo), never a write, history entry or save.
  const endPreview = (): void => {
    const opened = openedRef.current;
    if (opened !== undefined && opened.previewed) {
      openedRef.current = { ...opened, previewed: false };
      draftTo(opened.value);
    }
  };
  // Unmounting with a preview still showing (the selection changed, the project switched)
  // puts the original back too. A ref holds the latest closure so the cleanup sees it.
  const endPreviewRef = useRef(endPreview);
  endPreviewRef.current = endPreview;
  useEffect(() => () => endPreviewRef.current(), []);
  const extraClassName = props.className ? ` ${props.className}` : '';
  const tokenClassName = showToken ? ' is-token' : '';
  return (
    <span
      ref={wrapRef}
      className={`embed-editor_varconnect${extraClassName}${tokenClassName}`}
      {...connectWrapperHandlers({ showToken, field, readCaret })}
      {...composeKeyDownCapture(
        bigEditorTriggers({
          disabled,
          big,
          expanded: props.expanded,
          open,
          wrapRef,
          liveValue,
          onOpen: setBig,
        }),
        (event) => suggestKeyDown(event, { suggest, navigationRef, onDismiss: () => setSuggest(undefined) }),
      )}
      onInput={(event) => {
        readCaret();
        // Only the field's own typing: the chooser's search and a big editor
        // opened from here are React children too, and their input bubbles here.
        if (disabled || !(event.target instanceof Node) || !wrapRef.current?.contains(event.target)) {
          return;
        }
        setSuggest(typedAtSelection(liveValue(), selectionRef.current));
      }}
    >
      {field.prepared}
      {showToken ? (
        <ConnectTokenField
          connect={props}
          ariaLabel={ariaLabel}
          value={value}
          chips={applied.chips}
          chipText={chipText}
          hintValue={hintValue}
          field={field}
          editorRef={editorRef}
          setActive={connect.setActive}
          onChip={(chip) => {
            // The chip is a toggle: pressing the one whose chooser is open closes it and leaves it
            // closed. The chip sits inside the chooser's anchor, so the dismiss logic does not also
            // treat the press as an outside press (popupDismiss.ts), which would reopen it.
            if (open && chipTarget?.index === chip.index) {
              closeChooser();
              return;
            }
            setSuggest(undefined);
            setChipTarget(chip);
            if (!open) {
              openChooser();
            }
          }}
        />
      ) : undefined}
      {/* A field that is one variable is changed through its chip, so it drops the
          dot. A code field is an expression a variable sits in (`calc(var(--a) * 2)`),
          and a pick goes in at the caret, so it keeps the dot to add another. */}
      {!applied.isVar || props.code === true ? (
        <ConnectDot
          dotRef={dotRef}
          disabled={disabled}
          ariaLabel={ariaLabel}
          open={open}
          onPress={readCaret}
          onToggle={() => {
            if (open) {
              closeChooser();
              return;
            }
            setChipTarget(undefined);
            setSuggest(undefined);
            openChooser();
          }}
        />
      ) : undefined}
      <ConnectPopups
        picker={pickerOf({ open, anchor, suggest, chipTarget, applied, navigationRef })}
        applied={applied}
        prop={prop}
        big={big}
        label={prop || ariaLabel}
        wrapRef={wrapRef}
        value={value}
        liveValue={liveValue}
        // A plain value is replaced; an expression has the variable put in where
        // the caret was, or over what was selected, so picking one inside a
        // calc() no longer throws the calc away. See insertBinding.ts.
        onPick={pick}
        slot={open || suggest !== undefined ? pickSlot() : undefined}
        onPreview={preview}
        onPreviewEnd={endPreview}
        onClosePicker={closeChooser}
        onCloseBig={() => setBig(undefined)}
        onSave={onPick}
      />
    </span>
  );
}

// The field's state: the picker and the big editor, the variable its value
// holds, the input it wraps, and where the caret was last seen.
function useVariableConnect({ prop, code, children }: VariableConnectProps) {
  const [open, setOpen] = useState(false);
  // True while the token editor's contentEditable holds focus — keeps it mounted even if
  // the user edits the value down to a non-variable mid-type (so focus/caret aren't lost).
  const [active, setActive] = useState(false);
  const dotRef = useRef<HTMLButtonElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const value = childValue(children);
  const placeholder = childPlaceholder(children);
  // A variable hint uses the same catalog and chips, but stays outside the
  // editable value so reading or focusing it cannot create a local declaration.
  const hintValue = value === '' && /var\(/i.test(placeholder) ? placeholder : '';
  const applied = useAppliedVariable({ value: value || hintValue, open, prop });
  // Render the token editor while a variable is applied, or while it still has focus.
  const showToken = applied.isVar || active || !!code;
  const field = useWrappedField(children);
  const chipText = applied.binding ?? applied.varText;
  const liveValue = (): string => fieldLiveValue(editorRef, field.inputRef, chipText, value);
  const { selectionRef, readCaret } = useCaretTracker(editorRef, field.inputRef);
  // The chip a press opened the chooser for, and the reference being typed.
  const [chipTarget, setChipTarget] = useState<PressedChip | undefined>(undefined);
  const [suggest, setSuggest] = useState<TypedVariable | undefined>(undefined);
  const navigationRef = useRef<PickerNavigation | undefined>(undefined);
  // The value the chooser opened on, and whether the arrows have previewed another.
  const openedRef = useRef<{ readonly value: string; readonly previewed: boolean } | undefined>(undefined);
  const [big, setBig] = useState<DOMRect | undefined>(undefined);
  const wrapRef = useRef<HTMLSpanElement>(null);
  return {
    open,
    setOpen,
    setActive,
    dotRef,
    editorRef,
    value,
    applied,
    showToken,
    field,
    chipText,
    hintValue: applied.isVar ? hintValue : '',
    liveValue,
    selectionRef,
    readCaret,
    chipTarget,
    setChipTarget,
    suggest,
    setSuggest,
    navigationRef,
    openedRef,
    big,
    setBig,
    wrapRef,
  };
}

// The rich token editor over the wrapped input, wired to stand in for it.
function ConnectTokenField({
  connect,
  ariaLabel,
  value,
  chips,
  chipText,
  hintValue,
  field,
  editorRef,
  setActive,
  onChip,
}: {
  connect: VariableConnectProps;
  ariaLabel: string;
  value: string;
  chips: Chip[];
  chipText: string;
  hintValue: string;
  field: WrappedField;
  editorRef: RefObject<HTMLDivElement>;
  setActive: (active: boolean) => void;
  onChip: (chip: PressedChip) => void;
}) {
  const { disabled, code, stepMin } = connect;
  return (
    <>
      <TokenField
        value={value}
        chips={hintValue ? [] : chips}
        chipBare={chipText}
        chipVar={chipText}
        onDraft={connect.onDraft ?? ((next) => pushDraft(field, next))}
        className={`${field.childClass} embed-editor_varconnect-editor`}
        ariaLabel={ariaLabel}
        placeholder={hintValue ? '' : childPlaceholder(connect.children)}
        {...(disabled === undefined ? {} : { disabled })}
        editorRef={editorRef}
        {...tokenFieldHandlers({ field, setActive, disabled, onChip })}
        {...(code === undefined ? {} : { code })}
        {...(stepMin === undefined ? {} : { stepMin })}
      />
      {hintValue ? (
        <VariableHint
          value={hintValue}
          chips={chips}
          className={field.childClass}
          disabled={disabled ?? false}
          onPick={() => onChip({ index: 0, binding: chips[0]?.text ?? '' })}
        />
      ) : undefined}
    </>
  );
}

// The two popups a field opens: the variable picker, and the big value editor.
function ConnectPopups({
  picker,
  applied,
  prop,
  big,
  label,
  wrapRef,
  value,
  liveValue,
  onPick,
  slot,
  onPreview,
  onPreviewEnd,
  onClosePicker,
  onCloseBig,
  onSave,
}: {
  picker: PickerOpening | undefined;
  applied: ReturnType<typeof useAppliedVariable>;
  prop: string | undefined;
  big: DOMRect | undefined;
  label: string;
  wrapRef: RefObject<HTMLSpanElement>;
  value: string;
  liveValue: () => string;
  onPick: (binding: string) => void;
  slot: ValueSlot | undefined;
  onPreview: (binding: string) => void;
  onPreviewEnd: () => void;
  onClosePicker: () => void;
  onCloseBig: () => void;
  onSave: (value: string) => void;
}) {
  return (
    <>
      {picker ? (
        <VariablePicker
          anchor={picker.anchor}
          vars={applied.vars}
          loading={applied.loading}
          {...(prop === undefined ? {} : { prop })}
          {...(picker.selectedBinding === undefined ? {} : { selectedBinding: picker.selectedBinding })}
          {...(picker.typing === undefined ? {} : { typing: picker.typing })}
          {...(slot === undefined ? {} : { slot })}
          onPreview={onPreview}
          onPreviewEnd={onPreviewEnd}
          onPick={onPick}
          onClose={onClosePicker}
        />
      ) : undefined}
      {big ? (
        <CustomValue
          connectField={connectCustomField}
          value={liveValue()}
          label={label}
          prop={prop}
          anchor={big}
          anchorEl={wrapRef.current ?? undefined}
          onCancel={onCloseBig}
          onSave={(next: string) => {
            onCloseBig();
            // The same path a picked variable takes — one way in and out of a
            // field, whether the value came from the picker or was typed.
            if (next !== value) {
              onSave(next);
            }
          }}
        />
      ) : undefined}
    </>
  );
}

// The variable the field's value holds, if any, and the chips it draws.
//
// A variable is applied when the value contains a var(…) — pure, or inside an expression
// like calc(var(…) + 10px) — or when a bare value equals a project variable's NAME (a
// native binding reads back as its "group/leaf" name). Load the shared list only when
// the value could carry a variable (so numbers, lengths, colors don't trigger it).
function useAppliedVariable({ value, open, prop }: { value: string; open: boolean; prop: string | undefined }) {
  const raw = value.replace(/!\s*important\s*$/i, '').trim();
  const embedVar = raw.match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i)?.[0];
  // Native size variables may read back as `group/name (resolved value)`. Match using
  // the name portion while keeping the complete raw text as the replaceable token.
  const nativeNames = nativeVariableNames(raw);
  const nameLike = !embedVar && nativeNames.some((name) => name !== '' && /[A-Za-z]/.test(name) && !name.includes('(') && !/^[#.\d]/.test(name));
  const { vars, loading } = useSharedVars({ active: open || !!embedVar || nameLike });
  const current = resolveVariable({ vars, embedVar, nameLike, nativeNames, prop });
  const isVar = !!embedVar || !!current;
  const binding = current?.binding ?? embedVar;
  // The exact substring of the value that IS the variable — the token editor splits
  // around it. For a native binding the whole (bare) value is the variable.
  const varText = embedVar ?? (current ? raw : '');
  const chips = valueChips({ raw, varText, vars, current, embedVar });
  return { vars, loading, isVar, binding, varText, chips };
}

// Resolve the applied variable — by its var() binding, or by NAME / "group/leaf" path.
function resolveVariable({
  vars,
  embedVar,
  nameLike,
  nativeNames,
  prop,
}: {
  vars: ProjectVariable[];
  embedVar: string | undefined;
  nameLike: boolean;
  nativeNames: string[];
  prop: string | undefined;
}): ProjectVariable | undefined {
  if (embedVar) {
    return vars.find((variable) => variable.binding === embedVar);
  }
  if (!nameLike) {
    return undefined;
  }
  const fullPath = (variable: ProjectVariable) => (variable.group ? `${variable.group}/${variable.name}` : variable.name);
  return vars.find((variable) => {
    if (!varTypeAllowed(prop, variable.type)) {
      return false;
    }
    const catalogNames = [...nativeVariableNames(variable.name), ...nativeVariableNames(fullPath(variable))];
    return nativeNames.some((name) => catalogNames.includes(name));
  });
}

// Every variable in the value, as chips. An expression built out of tokens — a
// clamp() of four of them — is the normal case in a variables sheet, and showing
// only the first as a chip left the rest looking like text that happens to say
// `var(`.
function valueChips({
  raw,
  varText,
  vars,
  current,
  embedVar,
}: {
  raw: string;
  varText: string;
  vars: ProjectVariable[];
  current: ProjectVariable | undefined;
  embedVar: string | undefined;
}): Chip[] {
  if (!varText) {
    return [];
  }
  const chips = [...raw.matchAll(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/gi)].map((match) => {
    const known = vars.find((variable) => variable.binding === match[0]);
    return {
      text: match[0],
      name: known?.name ?? bindingName(match[0]),
      type: known?.type ?? 'Size', // i18n-ignore: a variable type id.
    };
  });
  if (chips.length) {
    return chips;
  }
  const chipName = current?.name ?? (embedVar ? bindingName(embedVar) : raw);
  return [{ text: varText, name: chipName, type: current?.type ?? 'Size' }]; // i18n-ignore: a variable type id.
}

// The wrapped child: an <input> in a panel field, a <textarea> in the big editor.
//
// Hand the token editor a ref to the real <input> so it can push serialized edits back
// through the field's own onChange/commit; merge with any ref the child already carries.
function useWrappedField(children: ReactNode) {
  const inputRef = useRef<FieldRefValue>(null);
  const child = isValidElement<ChildFieldProps>(children) ? children : undefined;
  const attachRef = (element: FieldRefValue) => {
    inputRef.current = element;
    if (child) {
      updateChildRef(child, element);
    }
  };
  const prepared = child ? cloneElement(child, { ref: attachRef }) : children;
  const childClass = child?.props.className ?? 'u-input';
  // The wrapped input's own focus/blur handlers (draft guard + commit). We call them
  // directly from the token editor rather than dispatching synthetic focus events —
  // React's focusin/focusout delegation isn't a reliable target, and missing the blur
  // would leave the edit uncommitted. On commit we first push the finished value into the
  // input via the native setter (flushSync so the parent's draft state is up to date),
  // then invoke its onBlur so commit() reads the final value.
  const childHandlers = child?.props;
  // …but onBlur's commit() closes over the input's `draft`. Our flushSync push re-renders
  // the input with a NEW closure (draft = the serialized value); the handler we captured
  // this render still sees the PRE-edit draft and would commit that (e.g. the bare
  // variable name, dropping the calc() we just typed). Read the LATEST handler via a ref,
  // updated after the flushSync re-render, so commit() reads the pushed value.
  const childHandlersRef = useRef(childHandlers);
  childHandlersRef.current = childHandlers;
  const fakeEvent = () => ({
    preventDefault() {},
    stopPropagation() {},
    target: inputRef.current,
    currentTarget: inputRef.current,
  });
  return { inputRef, prepared, childClass, childHandlers, childHandlersRef, fakeEvent };
}

type WrappedField = ReturnType<typeof useWrappedField>;

// What the field says RIGHT NOW, rather than what the parent last heard.
//
// No caller passes `onDraft`, so text typed into the rich token editor never
// reaches the parent's state — the child's `value` prop still holds whatever
// was there before the edit began. Reading that was how picking a variable
// wiped an expression: the field showed `calc(2rem + )`, the prop still said
// `70rem`, and a plain value is one a variable is supposed to replace.
//
// (Pressing the dot used to blur the field, which committed the draft and
// hid this by accident. Keeping focus so the caret survives took that
// accident away, which is what made the wipe show up every time.)
function fieldLiveValue(editorRef: RefObject<HTMLDivElement>, inputRef: MutableRefObject<FieldRefValue>, chipText: string, value: string): string {
  const editor = editorRef.current;
  if (editor) {
    return serializeTokens(editor, chipText, chipText);
  }
  return inputRef.current?.value ?? value;
}

// Every edit, into the field this stands in for. Without it the rich editor is a
// different field with the same look: the input behind it keeps the value from
// before the edit, and whatever live preview that input drives while you type never
// runs. A caller that wants the drafts itself (the big value editor) passes its own.
function pushDraft(field: WrappedField, next: string): void {
  const input = field.inputRef.current;
  if (!input) {
    return;
  }
  setInputValue(input, next);
  field.childHandlersRef.current?.onChange?.(field.fakeEvent());
}

// The token editor's focus and commit, handed over to the input it stands for,
// and a chip press that opens the picker.
function tokenFieldHandlers({
  field,
  setActive,
  disabled,
  onChip,
}: {
  field: WrappedField;
  setActive: (active: boolean) => void;
  disabled: boolean | undefined;
  onChip: (chip: PressedChip) => void;
}) {
  return {
    onFocusField: () => {
      setActive(true);
      field.childHandlers?.onFocus?.(field.fakeEvent());
    },
    onCommit: (final: string) => {
      const input = field.inputRef.current;
      if (input) {
        // Drive the controlled field directly. This guarantees its draft becomes
        // the serialized expression before the latest blur closure commits it;
        // a synthetic DOM input event could remain batched and commit the original
        // bare variable instead.
        flushSync(() => {
          setInputValue(input, final);
          field.childHandlersRef.current?.onChange?.(field.fakeEvent());
        });
      }
      field.childHandlersRef.current?.onBlur?.(field.fakeEvent());
      setActive(false);
    },
    onChipClick: (chip: PressedChip) => {
      if (!disabled) {
        onChip(chip);
      }
    },
  };
}

// The wrapper's own listeners. Every way a caret can end up somewhere: typing,
// clicking into the field, dragging a selection, arrowing about — including the
// focus the big value editor puts there itself when it opens, since nothing has
// been typed or clicked at that point, so without it the first thing you do in it
// has no recorded position.
//
// The token editor covers the input it stands for, so the pointer never reaches
// it — a field that lights something up while hovered (gap's bands on the canvas)
// stayed dark unless it also had focus. Hand enter and leave over the same way
// focus and blur are handed over, and only while the editor is the thing on top;
// otherwise the input hears them itself.
function connectWrapperHandlers({ showToken, field, readCaret }: { showToken: boolean; field: WrappedField; readCaret: () => void }) {
  return {
    onMouseEnter: showToken ? (event: React.MouseEvent) => field.childHandlersRef.current?.onMouseEnter?.(event) : undefined,
    onMouseLeave: showToken ? (event: React.MouseEvent) => field.childHandlersRef.current?.onMouseLeave?.(event) : undefined,
    onKeyUp: readCaret,
    onMouseUp: readCaret,
    onSelect: readCaret,
    onFocus: readCaret,
  };
}

// The whole value, in a box big enough to read it.
//
// The variables sheet has had this for a while and the style panel had
// nothing: a `calc()` of three variables in a 90px field is edited through a
// slot showing a third of itself. Both now open it the same two ways — a
// press on a field whose value does not fit, and `=` in any field at all —
// and it is the same box, so it behaves identically wherever it appears.
//
// Here rather than on each field because this wraps nearly every input in
// the panel, and `onPick` is already the path a value takes to be written.
function bigEditorTriggers({
  disabled,
  big,
  expanded,
  open,
  wrapRef,
  liveValue,
  onOpen,
}: {
  disabled: boolean | undefined;
  big: DOMRect | undefined;
  expanded: boolean | undefined;
  open: boolean;
  wrapRef: RefObject<HTMLSpanElement>;
  liveValue: () => string;
  onOpen: (rect: DOMRect) => void;
}) {
  const openBig = () => {
    const wrap = wrapRef.current;
    if (wrap) {
      onOpen(wrap.getBoundingClientRect());
    }
  };
  return {
    onKeyDownCapture: (event: React.KeyboardEvent) => {
      // `=` is not something a CSS value starts with, and it is what the
      // variables sheet already uses — one key, the same everywhere.
      if (event.key === '=' && !disabled && !big && !expanded) {
        event.preventDefault();
        event.stopPropagation();
        openBig();
      }
    },
    onMouseDownCapture: (event: React.MouseEvent) => {
      // …or while the picker is up. It portals to <body>, but a portal is still a
      // React CHILD, so its presses capture through here: on a value long enough to
      // open the big editor, choosing a variable was taken as a press on the field —
      // the pick never landed and the big editor opened over it instead.
      if (disabled || big || expanded || open) {
        return;
      }
      // The dot and the swatch are their own controls; a press on those means
      // what it has always meant.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('.embed-editor_varconnect-dot, .embed-editor_varconnect-hint, ' + '.u-color-swatch, .embed-editor_varpicker, .var-custom')
      ) {
        return;
      }
      // Only when the value has outgrown the field. Putting the caret in a
      // slot showing a third of what is being changed is the worst place in
      // the app to edit from, and it is exactly where a long value lands you.
      if (!wrapRef.current || !doesNotFit(wrapRef.current, liveValue())) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openBig();
    },
  };
}

// The dot is how a value with no variable in it reaches the picker. It used to be
// the token field's alternative, which was the same thing while the token field
// only ever appeared for a value that HAD one — but a field editing code shows for
// every value, and without this a plain number had no way to connect. A chip is
// its own way in, so it stays the one case with no dot. The code editors draw
// the same dot over a whole value (components/CodeVariables.tsx).
export function ConnectDot({
  dotRef,
  disabled,
  ariaLabel,
  open,
  onPress,
  onToggle,
}: {
  dotRef: React.RefObject<HTMLButtonElement>;
  disabled: boolean | undefined;
  ariaLabel: string;
  open: boolean;
  onPress: () => void;
  onToggle: () => void;
}) {
  return (
    <button
      ref={dotRef}
      type="button"
      className="embed-editor_varconnect-dot"
      disabled={disabled}
      title={ariaLabel}
      aria-label={ariaLabel}
      aria-haspopup="dialog"
      aria-expanded={open}
      onMouseDown={(event) => {
        // Don't let the press move focus off the field. The picker takes
        // focus for its search box a moment later either way, but the
        // caret stays put — and stays visible — rather than the field
        // going dark the instant the dot is touched.
        event.preventDefault();
        onPress();
      }}
      onClick={onToggle}
    >
      <PlusIcon />
    </button>
  );
}

// Where the caret was when the picker was opened, recorded as it moves rather
// than grabbed when the dot is pressed.
//
// Reading it on the press alone was too late to be reliable: the picker's
// search field takes focus the moment it opens, and a field that has lost
// focus has no selection to ask about. Keeping the last known position means
// the answer is already in hand before anything moves.
//
// The token editor's own offset counts a chip as ONE character, while the
// value it serializes to spells that chip out as `var(--x)`. An offset from
// one measured against the other lands in the wrong place, so the marks
// before the caret are expanded to the length they serialize to.
function useCaretTracker(editorRef: RefObject<HTMLDivElement>, inputRef: MutableRefObject<FieldRefValue>) {
  const selectionRef = useRef<ValueSelection | undefined>(undefined);
  const readCaret = () => {
    const editor = editorRef.current;
    if (!editor) {
      const input = inputRef.current;
      const start = input?.selectionStart;
      const end = input?.selectionEnd;
      selectionRef.current = typeof start === 'number' && typeof end === 'number' ? { start: Math.min(start, end), end: Math.max(start, end) } : undefined;
      return;
    }
    const selection = selectionOffsets(editor);
    // Nothing selected IN THE FIELD at this moment — the wrapper hears focus and
    // select events from everything inside it, and the field itself goes quiet the
    // instant the picker takes focus. Keep the last position we knew rather than
    // forgetting it: recording the caret as it moves is only worth anything if the
    // answer survives until the pick, and a forgotten one puts the variable at the
    // end of the value.
    if (selection === undefined) {
      return;
    }
    selectionRef.current = { start: serializedOffset(editor, selection.start), end: serializedOffset(editor, selection.end) };
  };
  return { selectionRef, readCaret };
}

// The caret offset `at` (chips counted as one character) as an offset into the
// serialized value. Each chip serializes to its OWN binding — a value can hold
// several, and they need not be the same variable — so the lengths are read off
// the chips themselves rather than assumed equal.
function serializedOffset(editor: HTMLElement, at: number): number {
  const bindings = Array.from(editor.querySelectorAll<HTMLElement>('[data-chip]')).map((node) => node.dataset['binding'] ?? '');
  let length = 0;
  let chip = 0;
  for (const ch of fieldText(editor).slice(0, at)) {
    if (ch === CHIP_MARK) {
      length += (bindings[chip++] ?? '').length;
    } else {
      length += 1;
    }
  }
  return length;
}

// How the chooser opens: from where, with which variable marked, and, while a
// reference is being typed, the name typed so far and the keys it answers.
interface PickerOpening {
  readonly anchor: HTMLElement;
  readonly selectedBinding: string | undefined;
  readonly typing: { readonly query: string; readonly navigationRef: MutableRefObject<PickerNavigation | undefined> } | undefined;
}

// Typing outranks the dot: a reference being typed shows the chooser even with
// the dot's own chooser closed. A pressed chip marks its own variable; the dot
// marks the field's variable when the field is one.
function pickerOf({
  open,
  anchor,
  suggest,
  chipTarget,
  applied,
  navigationRef,
}: {
  open: boolean;
  anchor: HTMLElement | undefined;
  suggest: TypedVariable | undefined;
  chipTarget: PressedChip | undefined;
  applied: ReturnType<typeof useAppliedVariable>;
  navigationRef: MutableRefObject<PickerNavigation | undefined>;
}): PickerOpening | undefined {
  if (anchor === undefined) {
    return undefined;
  }
  if (suggest !== undefined) {
    return { anchor, selectedBinding: undefined, typing: { query: suggest.query, navigationRef } };
  }
  if (!open) {
    return undefined;
  }
  if (chipTarget !== undefined) {
    return { anchor, selectedBinding: chipTarget.binding || undefined, typing: undefined };
  }
  return { anchor, selectedBinding: applied.isVar ? applied.binding : undefined, typing: undefined };
}

// The reference being typed at a collapsed caret; a selection is not typing.
function typedAtSelection(value: string, selection: ValueSelection | undefined): TypedVariable | undefined {
  if (selection === undefined) {
    return undefined;
  }
  if (selection.start !== selection.end) {
    return undefined;
  }
  if (selection.end > value.length) {
    return undefined;
  }
  return typedVariableAt(value, selection.end);
}

// While the chooser follows typing, the field's arrow keys move through it,
// Enter and Tab take the marked variable, and Escape puts it away. Caught on the
// way down so the field never sees them: Enter would commit, and an arrow in a
// code field steps the number under the caret.
function suggestKeyDown(
  event: React.KeyboardEvent,
  {
    suggest,
    navigationRef,
    onDismiss,
  }: { suggest: TypedVariable | undefined; navigationRef: MutableRefObject<PickerNavigation | undefined>; onDismiss: () => void },
): void {
  if (suggest === undefined) {
    return;
  }
  const navigation = navigationRef.current;
  if (navigation === undefined) {
    return;
  }
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation();
    navigation.move(event.key === 'ArrowDown' ? 1 : -1);
  } else if (event.key === 'Enter' || event.key === 'Tab') {
    if (navigation.pick()) {
      event.preventDefault();
      event.stopPropagation();
    } else {
      onDismiss();
    }
  } else if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    onDismiss();
  }
}

// Two capture-phase key listeners on one element, the first given the first word.
function composeKeyDownCapture<T extends { onKeyDownCapture: (event: React.KeyboardEvent) => void }>(
  handlers: T,
  first: (event: React.KeyboardEvent) => void,
): T {
  return {
    ...handlers,
    onKeyDownCapture: (event: React.KeyboardEvent) => {
      first(event);
      if (!event.isPropagationStopped()) {
        handlers.onKeyDownCapture(event);
      }
    },
  };
}

// After a typed reference is completed, the caret goes just past the variable,
// ready for whatever comes next in the expression. The field rebuilds from the
// new value first, so this waits a frame.
function placeCaretAfterPick(
  editorRef: RefObject<HTMLDivElement>,
  inputRef: MutableRefObject<FieldRefValue>,
  completed: { readonly value: string; readonly caret: number },
): void {
  requestAnimationFrame(() => {
    const editor = editorRef.current;
    if (editor !== null && editor.isConnected) {
      editor.focus();
      setCaretOffset(editor, fieldOffsetOf(completed.value, completed.caret));
      return;
    }
    const input = inputRef.current;
    if (input !== null && 'setSelectionRange' in input && input.isConnected) {
      input.focus();
      input.setSelectionRange(completed.caret, completed.caret);
    }
  });
}
