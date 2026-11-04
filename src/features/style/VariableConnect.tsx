import { cloneElement, isValidElement, useRef, useState } from 'react';
import type { MutableRefObject, ReactElement, ReactNode, RefObject } from 'react';
import { flushSync } from 'react-dom';
import { type ProjectVariable } from './model/webflow';
import { caretOffset } from './model/cssCode';
import CustomValue, { doesNotFit } from './CustomValueEditor';
import { insertBinding } from './model/insertBinding';
import { PlusIcon } from './VariableIcons';
import { varTypeAllowed, useSharedVars } from './sharedVars';
import { VariablePicker } from './VariablePicker';
import VariableHint from './VariableHint';
import { type Chip, CHIP_MARK, fieldText, serializeTokens, TokenField } from './TokenField';
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
export function connectCustomField(field: ReactElement, onDraft: (value: string) => void): ReactNode {
  return (
    <VariableConnect className="is-multiline" code onDraft={onDraft} onPick={onDraft}>
      {field}
    </VariableConnect>
  );
}

export default function VariableConnect(props: VariableConnectProps) {
  const { onPick, disabled, ariaLabel = 'Connect to variable', prop } = props;
  const connect = useVariableConnect(props);
  const { open, setOpen, big, setBig, value, applied, showToken, field, wrapRef } = connect;
  const { editorRef, dotRef, chipText, liveValue, caretRef, readCaret, hintValue } = connect;
  const anchor = showToken ? editorRef.current : dotRef.current;
  const extraClassName = props.className ? ` ${props.className}` : '';
  const tokenClassName = showToken ? ' is-token' : '';
  return (
    <span
      ref={wrapRef}
      className={`embed-editor_varconnect${extraClassName}${tokenClassName}`}
      {...connectWrapperHandlers({ showToken, field, readCaret })}
      {...bigEditorTriggers({
        disabled,
        big,
        expanded: props.expanded,
        open,
        wrapRef,
        liveValue,
        onOpen: setBig,
      })}
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
          setOpen={setOpen}
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
          onToggle={() => setOpen((previous) => !previous)}
        />
      ) : undefined}
      <ConnectPopups
        picker={open && anchor ? { anchor } : undefined}
        applied={applied}
        prop={prop}
        big={big}
        label={prop || ariaLabel}
        wrapRef={wrapRef}
        value={value}
        liveValue={liveValue}
        // A plain value is replaced; an expression has the variable put in where
        // the caret was, so picking one inside a calc() no longer throws the calc
        // away. See insertBinding.ts.
        onPick={(chosen) => {
          onPick(insertBinding(liveValue(), chosen, caretRef.current));
          setOpen(false);
        }}
        onClosePicker={() => setOpen(false)}
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
  const { caretRef, readCaret } = useCaretTracker(editorRef, field.inputRef);
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
    caretRef,
    readCaret,
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
  setOpen,
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
  setOpen: (open: boolean) => void;
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
        {...tokenFieldHandlers({ field, setActive, disabled, setOpen })}
        {...(code === undefined ? {} : { code })}
        {...(stepMin === undefined ? {} : { stepMin })}
      />
      {hintValue ? (
        <VariableHint value={hintValue} chips={chips} className={field.childClass} disabled={disabled ?? false} onPick={() => setOpen(true)} />
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
  onClosePicker,
  onCloseBig,
  onSave,
}: {
  picker: { anchor: HTMLElement } | undefined;
  applied: ReturnType<typeof useAppliedVariable>;
  prop: string | undefined;
  big: DOMRect | undefined;
  label: string;
  wrapRef: RefObject<HTMLSpanElement>;
  value: string;
  liveValue: () => string;
  onPick: (binding: string) => void;
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
          {...(!applied.isVar || applied.binding === undefined ? {} : { selectedBinding: applied.binding })}
          onPick={onPick}
          onClose={onClosePicker}
        />
      ) : undefined}
      {big ? (
        <CustomValue
          connectField={connectCustomField}
          value={liveValue()}
          label={label}
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
      type: known?.type ?? 'Size',
    };
  });
  if (chips.length) {
    return chips;
  }
  const chipName = current?.name ?? (embedVar ? bindingName(embedVar) : raw);
  return [{ text: varText, name: chipName, type: current?.type ?? 'Size' }];
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
  setOpen,
}: {
  field: WrappedField;
  setActive: (active: boolean) => void;
  disabled: boolean | undefined;
  setOpen: (open: boolean) => void;
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
    onChipClick: () => {
      if (!disabled) {
        setOpen(true);
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
    onInput: readCaret,
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
// its own way in, so it stays the one case with no dot.
function ConnectDot({
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
  const caretRef = useRef<number | undefined>(undefined);
  const readCaret = () => {
    const editor = editorRef.current;
    if (!editor) {
      const input = inputRef.current;
      caretRef.current = typeof input?.selectionStart === 'number' ? input.selectionStart : undefined;
      return;
    }
    const at = caretOffset(editor);
    // Nothing selected IN THE FIELD at this moment — the wrapper hears focus and
    // select events from everything inside it, and the field itself goes quiet the
    // instant the picker takes focus. Keep the last position we knew rather than
    // forgetting it: recording the caret as it moves is only worth anything if the
    // answer survives until the pick, and a forgotten one puts the variable at the
    // end of the value.
    if (at === undefined) {
      return;
    }
    caretRef.current = serializedOffset(editor, at);
  };
  return { caretRef, readCaret };
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
