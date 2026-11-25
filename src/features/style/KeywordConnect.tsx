// Connecting a keyword control to a variable: the dropdowns and segmented bars
// of the style panel (Align X / Y, Wrap, Display, Pointer events…), whose value
// is picked from a list rather than typed.
//
// A typed field gets the purple dot and the chip from VariableConnect, which
// wraps its <input>. A keyword control has no input to wrap while it shows a
// keyword, so this gives it the same two things from the outside: the dot in
// its top-left corner on hover, and a "Variable…" row at the top of its list,
// both opening the one variable picker every field uses. Picking writes
// `var(--name)` as the whole value, through the control's own write (the same
// path a keyword takes: instant, one undo step, in the picked breakpoint and
// state). Once the value is a variable the control shows its custom field, and
// that field (wrapped in VariableConnect) draws the chip; the control's own dot
// then steps aside, so one control never shows two.
//
// See docs/style-panel-variables.md for every input this covers.

import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { assert } from '../../../shared/core/assert';
import Select from './components/Select';
import type { Props as SelectProps, SelectOption } from './components/selectTypes';
import { MenuItem } from './components/MenuParts';
import { PlusIcon } from './VariableIcons';
import { VariablePicker } from './VariablePicker';
import { useSharedVars } from './sharedVars';
import { useFieldPreview } from './connectFieldHelpers';
import VariableConnect, { ConnectDot } from './VariableConnect';
import { commitInPlace } from './model/commitStyleInPlace';

/** The list row that opens the variable picker; never a value of the property. */
export const VARIABLE_OPTION = '__variable__';
type VariableOption = typeof VARIABLE_OPTION;

/** Who draws the purple dot: this wrapper, or the variable-aware field inside it. */
export type KeywordDot = 'wrapper' | 'field';

// The first var() reference in a value: the variable the picker marks as chosen.
const VAR_REFERENCE = /var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i;

/** The var() reference a keyword control's value holds, if it holds one. */
export function variableIn(value: string): string | undefined {
  return VAR_REFERENCE.exec(value)?.[0];
}

const OpenPickerContext = createContext<(() => void) | undefined>(undefined);

/** Opens the picker of the keyword control around the caller; undefined outside one. */
export function useOpenVariablePicker(): (() => void) | undefined {
  return useContext(OpenPickerContext);
}

type KeywordConnectProps = {
  /** The CSS property the control edits: the picker offers the variables that fit it. */
  readonly prop: string;
  /** The control's authored value, raw: a var() in it is marked in the picker. */
  readonly value: string;
  readonly ariaLabel: string;
  readonly disabled: boolean;
  readonly dot: KeywordDot;
  readonly className?: string;
  readonly children: ReactNode;
  /** Called with the picked `var(--name)`, to be written as the property's whole value. */
  readonly onPick: (binding: string) => void;
};

export default function KeywordConnect({ prop, value, ariaLabel, disabled, dot, className, children, onPick }: KeywordConnectProps) {
  const translate = useTranslate();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const dotRef = useRef<HTMLButtonElement>(null);
  const { vars, loading } = useSharedVars({ active: open });
  // A hovered variable shows on the canvas as the property, never written (useFieldPreview).
  const canvas = useFieldPreview(prop);
  const label = translate('styleModel.shared.connectVariable', { label: ariaLabel });
  const openPicker = (): void => {
    if (disabled) {
      return;
    }
    setOpen(true);
  };
  const closePicker = (): void => {
    canvas.takeBack();
    setOpen(false);
  };
  const pick = (binding: string): void => {
    assert(binding.length > 0, 'A picked variable has a binding');
    assert(binding.trim() === binding, 'A picked variable has no edge whitespace');
    canvas.handOver();
    setOpen(false);
    onPick(binding);
  };
  const selected = variableIn(value);
  const anchor = (dot === 'wrapper' ? dotRef.current : wrapRef.current) ?? wrapRef.current ?? undefined;
  return (
    <span ref={wrapRef} className={['embed-editor_varconnect', 'is-fill', 'is-keyword', className ?? ''].filter(Boolean).join(' ')}>
      <OpenPickerContext.Provider value={openPicker}>{children}</OpenPickerContext.Provider>
      {dot === 'wrapper' ? (
        <ConnectDot
          dotRef={dotRef}
          disabled={disabled}
          ariaLabel={label}
          open={open}
          onPress={() => undefined}
          onToggle={() => (open ? closePicker() : openPicker())}
        />
      ) : undefined}
      {open && anchor !== undefined ? (
        <VariablePicker
          anchor={anchor}
          within={wrapRef.current ?? undefined}
          vars={vars}
          loading={loading}
          prop={prop}
          {...(selected === undefined ? {} : { selectedBinding: selected })}
          onPreview={(binding) => canvas.show(binding)}
          onPreviewEnd={() => canvas.takeBack()}
          onPick={pick}
          onClose={closePicker}
        />
      ) : undefined}
    </span>
  );
}

/** The "Variable…" row of a segmented control's menu: closes the menu, then opens the picker. */
export function VariableMenuItem({ onClose }: { readonly onClose: () => void }) {
  const translate = useTranslate();
  const openPicker = useOpenVariablePicker();
  if (openPicker === undefined) {
    return undefined;
  }
  return (
    <MenuItem
      label={translate('style.keywordConnect.variable')}
      selected={false}
      onClick={() => {
        onClose();
        openPicker();
      }}
    />
  );
}

/** The option list with the "Variable…" row first. */
export function withVariableOption<T extends string>(options: readonly SelectOption<T>[], label: string): SelectOption<T | VariableOption>[] {
  assert(
    options.every((option) => option.value !== VARIABLE_OPTION),
    'No keyword list already holds the variable row',
  );
  // The row's title holds the whole label for a narrow list that cuts it with an ellipsis.
  const row: SelectOption<VariableOption> = { value: VARIABLE_OPTION, label, title: label, icon: <PlusIcon /> };
  return [row, ...options];
}

type VariableSelectProps<T extends string> = SelectProps<T> & {
  /** The CSS property the dropdown edits. */
  readonly prop: string;
  /** The property's authored value, raw. */
  readonly rawValue: string;
  /** Writes the picked `var(--name)` as the property's whole value. */
  readonly onVariable: (binding: string) => void;
};

/**
 * A style-panel dropdown for a CSS keyword, connectable to a variable. The custom
 * field a dropdown shows for a value off its list (`customInput`) must itself be
 * variable-aware (VariableConnect): that field draws the chip and the dot then.
 */
export function VariableSelect<T extends string>({ prop, rawValue, onVariable, ...select }: VariableSelectProps<T>) {
  const dot: KeywordDot = select.customInput === undefined ? 'wrapper' : 'field';
  return (
    <KeywordConnect prop={prop} value={rawValue} ariaLabel={select.ariaLabel ?? prop} disabled={select.disabled ?? false} dot={dot} onPick={onVariable}>
      <VariableSelectList {...select} />
    </KeywordConnect>
  );
}

// The dropdown itself, inside the connect wrapper whose picker its first row opens.
function VariableSelectList<T extends string>(select: SelectProps<T>) {
  const translate = useTranslate();
  const openPicker = useOpenVariablePicker();
  assert(openPicker !== undefined, 'A variable dropdown sits inside its connect wrapper');
  const { onChange, onPreview, options, ...rest } = select;
  return (
    <Select<T | VariableOption>
      {...rest}
      options={withVariableOption(options, translate('style.keywordConnect.variable'))}
      onChange={(choice) => {
        if (choice === VARIABLE_OPTION) {
          openPicker();
          return;
        }
        onChange(choice);
      }}
      {...(onPreview === undefined
        ? {}
        : {
            // The variable row has no value of its own to show: landing on it puts the original back.
            onPreview: (choice: T | VariableOption | undefined) => onPreview(choice === VARIABLE_OPTION ? undefined : choice),
          })}
    />
  );
}

type KeywordSegmentsProps = {
  readonly prop: string;
  /** The property's authored value, raw. */
  readonly value: string;
  readonly important: boolean;
  readonly ariaLabel: string;
  readonly busy: boolean;
  /** The segmented control the property shows while its value is a keyword. */
  readonly children: ReactNode;
  readonly onWrite: (value: string, important: boolean) => void;
  readonly onClear: () => void;
};

/**
 * A two- or three-segment keyword bar with no custom mode of its own (Truncate,
 * Column span, Backface): the dot connects it to a variable, and while its value
 * is one the chip field stands in for the segments. Emptying the field (Backspace
 * over the chip) clears the property, and the segments come back.
 */
export function KeywordSegments({ prop, value, important, ariaLabel, busy, children, onWrite, onClear }: KeywordSegmentsProps) {
  const variable = variableIn(value) !== undefined;
  return (
    <KeywordConnect
      prop={prop}
      value={value}
      ariaLabel={ariaLabel}
      disabled={busy}
      dot={variable ? 'field' : 'wrapper'}
      onPick={(binding) => onWrite(binding, important)}
    >
      {variable ? (
        <KeywordVariableField prop={prop} value={value} busy={busy} ariaLabel={ariaLabel} onCommit={(next) => onWrite(next, important)} onClear={onClear} />
      ) : (
        children
      )}
    </KeywordConnect>
  );
}

type KeywordVariableFieldProps = {
  readonly prop: string;
  readonly value: string;
  readonly busy: boolean;
  readonly ariaLabel: string;
  readonly onCommit: (value: string) => void;
  readonly onClear: () => void;
};

/**
 * The free field a keyword control shows for a variable: the chip, with the caret
 * behind it, committed on blur and Enter; empty clears the property.
 */
export function KeywordVariableField({ prop, value, busy, ariaLabel, onCommit, onClear }: KeywordVariableFieldProps) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed === '') {
      onClear();
      return;
    }
    if (trimmed !== value.trim()) {
      onCommit(trimmed);
    }
  };
  return (
    <VariableConnect
      className="is-fill"
      prop={prop}
      canvasProperty={prop}
      disabled={busy}
      ariaLabel={translate('styleModel.shared.connectVariable', { label: ariaLabel })}
      onPick={(binding) => {
        setDraft(binding);
        onCommit(binding);
      }}
    >
      <input
        className="u-input embed-editor_size-input"
        value={draft}
        disabled={busy}
        spellCheck={false}
        aria-label={ariaLabel}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
      />
    </VariableConnect>
  );
}
