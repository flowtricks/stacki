// What the effects section's rows share: the writers they are handed, live
// writes and arrow-key steps, layered rows, the row label, the option lists
// (blend modes, cursors, outline, pointer events) and the custom and preset
// inputs (EffectsSection.tsx).

import { useEffect, useRef, useState } from 'react';
import { type Hideable } from './model/hideable';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import Select, { type SelectOption } from './components/Select';
import useScrub from './components/useScrub';
import { type SegOption } from './SegmentedField';
import { CURSOR_ICONS } from './cursorIcons';
import { useStyleHint, useHighlight } from './model/computedStyle';
import { handleArrowStep } from './model/numberStep';
import ProvenanceList from './ProvenanceList';
import VariableConnect from './VariableConnect';
import type { Contributor, ResolvedProp } from './model/resolved';
import { commitInPlace } from './model/commitInPlace';
import { openAfterRemoval, useExternalDraft } from './model/fieldHooks';
import { displayOf, parseImportant } from './model/styleDisplay';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
export type Read = (prop: string) => ResolvedProp | undefined;

export type Props = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
};

// How a write lands: live while typing or dragging, or committed.
export interface WriteOptions {
  readonly live: boolean;
}

// Debounces live writes while typing: the text reaches `liveNow` 100ms after the last
// keystroke; `cancel` drops a pending one.
export function useLiveTimer(liveNow: (text: string) => void) {
  const timer = useRef<number | undefined>(undefined);
  const cancel = () => {
    if (timer.current !== undefined) {
      window.clearTimeout(timer.current);
      timer.current = undefined;
    }
  };
  useEffect(() => cancel, []);
  const live = (text: string) => {
    cancel();
    timer.current = window.setTimeout(() => liveNow(text), 100);
  };
  return { live, cancel };
}

// Enter commits in place; ↑/↓ step the number under the caret (unit preserved) in the
// field itself. Returns the stepped text, or undefined when the key did not step.
export function stepInPlace(event: React.KeyboardEvent<HTMLInputElement>): string | undefined {
  const input = event.currentTarget;
  if (event.key === 'Enter') {
    commitInPlace(input);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// A draft field's own handlers, spread onto the input after the scrub's: typing
// schedules a live write, blur cancels it and commits, ↑/↓ step in place.
export function draftInputHandlers({
  focusedRef,
  setDraft,
  live,
  cancel,
  commit,
}: {
  focusedRef: React.MutableRefObject<boolean>;
  setDraft: (draft: string) => void;
  live: (text: string) => void;
  cancel: () => void;
  commit: () => void;
}) {
  return {
    onChange: (event: React.ChangeEvent<HTMLInputElement>) => {
      setDraft(event.target.value);
      live(event.target.value);
    },
    onFocus: () => {
      focusedRef.current = true;
    },
    onBlur: () => {
      focusedRef.current = false;
      cancel();
      commit();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
      const stepped = stepInPlace(event);
      if (stepped !== undefined) {
        setDraft(stepped);
        live(stepped);
      }
    },
  };
}

// Write a whole property value: live writes skip an empty value; a committed empty
// value clears the property.
export function writeValue(prop: string, value: string, options: WriteOptions, writers: Pick<Props, 'setProp' | 'clearProp' | 'liveSetProp'>) {
  if (options.live) {
    if (value) {
      writers.liveSetProp(prop, value, false);
    }
    return;
  }
  if (value) {
    writers.setProp(prop, value, false);
  } else {
    writers.clearProp(prop);
  }
}

// A layered effect's rows (see lib/hideable.ts) and which row's editor popover is open:
// add, remove, reorder, hide, and edit a row, each written back through `write`.
export function useLayerRows<T>({
  rows,
  blank,
  write,
}: {
  rows: Array<Hideable<T>>;
  blank: () => T;
  write: (next: Array<Hideable<T>>, options: WriteOptions) => void;
}) {
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const add = () => {
    const next = [...rows, { item: blank(), hidden: false }];
    write(next, { live: false });
    setOpenIndex(next.length - 1);
    // Its row is not drawn yet: no editor shows until it is clicked, never one
    // anchored under the row opened before it.
    setAnchorElement(undefined);
  };
  const remove = (i: number) => {
    write(
      rows.filter((_, other) => other !== i),
      { live: false },
    );
    setOpenIndex((previous) => openAfterRemoval(previous, i));
  };
  const reorder = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const next = [...rows];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    write(next, { live: false });
    setOpenIndex((previous) => (previous === from ? to : previous));
  };
  const update = (i: number, options: WriteOptions, change: (item: T) => T) =>
    write(
      rows.map((row, other) => (other === i ? { ...row, item: change(row.item) } : row)),
      options,
    );
  const toggle = (i: number) =>
    write(
      rows.map((row, other) => (other === i ? { ...row, hidden: !row.hidden } : row)),
      { live: false },
    );
  // A click on the open row closes it; on any other, or on a row marked open
  // with no editor showing yet (one just added: its row had not been drawn to
  // anchor to), it opens. Toggling on the index alone made a new layer's first
  // click close an editor that was never shown, so it took two to open.
  const open = (i: number, element: HTMLElement) => {
    const showing = openIndex === i && anchorElement === element;
    setOpenIndex(showing ? undefined : i);
    setAnchorElement(element);
  };
  const close = () => setOpenIndex(undefined);
  const isHidden = (i: number) => rows[i]?.hidden ?? false;
  return { openIndex, anchorElement, add, remove, reorder, update, toggle, open, close, isHidden };
}

// The property label: blue/active when the picked selector sets it (with a clear
// menu + provenance), orange when it's set through another selector.
export function EffLabel({ label, prop, props }: { label: string; prop: string; props: Props }) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read(prop));
  const contributors: Contributor[] = read(prop)?.contributors ?? [];
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
            close();
          }}
        />
      )}
    >
      {label}
    </FieldLabel>
  );
}

// A live text field bound to one property (raw CSS value editors).
export function LiveText({ prop, placeholder, props, dragging }: { prop: string; placeholder: string; props: Props; dragging?: string }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props;
  const display = displayOf(read(prop));
  // `dragging` is what a swatch beside this field is showing mid-drag.
  const written = display.important ? `${display.value} !important` : display.value;
  const external = dragging ?? (display.present ? written : '');
  const computed = useStyleHint(external ? '' : prop);
  const { draft, setDraft, focused } = useExternalDraft(external);
  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      const parsed = parseImportant(trimmed);
      liveSetProp(prop, parsed.value, parsed.important);
    }
  };
  const { live, cancel } = useLiveTimer(liveNow);
  const commit = (text = draft) => {
    const trimmed = text.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  return (
    <VariableConnect
      code
      className="is-fill"
      ariaLabel={`Connect ${prop} to a variable`}
      disabled={busy}
      prop={prop}
      onPick={(binding) => setProp(prop, binding, false)}
    >
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input embed-editor_eff-value"
        data-prop={prop}
        value={draft}
        {...draftInputHandlers({ focusedRef: focused, setDraft, live, cancel, commit })}
        disabled={busy}
        spellCheck={false}
        placeholder={computed || placeholder}
        aria-label={prop}
      />
    </VariableConnect>
  );
}

// ─────────────────────────── Option lists ───────────────────────────

export const BLEND_MODES: SelectOption<string>[] = [
  'normal',
  'darken',
  'multiply',
  'color-burn',
  'lighten',
  'screen',
  'color-dodge',
  'overlay',
  'soft-light',
  'hard-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
].map((mode) => ({
  value: mode,
  label:
    mode === 'color-burn'
      ? 'Color burn'
      : mode === 'color-dodge'
        ? 'Color dodge'
        : mode === 'soft-light'
          ? 'Soft light'
          : mode === 'hard-light'
            ? 'Hard light'
            : (mode[0] ?? '').toUpperCase() + mode.slice(1),
}));

// Grouped like Webflow's cursor menu: a non-selectable heading per group, each
// cursor indented and shown with its Webflow glyph.
export const CURSOR_GROUPS: ReadonlyArray<{ heading: string; values: string[] }> = [
  { heading: 'General', values: ['auto', 'default', 'none'] },
  {
    heading: 'Links & Status',
    values: ['pointer', 'not-allowed', 'wait', 'progress', 'help', 'context-menu'],
  },
  { heading: 'Selection', values: ['cell', 'crosshair', 'text', 'vertical-text'] },
  { heading: 'Drag & Drop', values: ['grab', 'grabbing', 'alias', 'copy', 'move'] },
  { heading: 'Zoom', values: ['zoom-in', 'zoom-out'] },
  {
    heading: 'Resize',
    values: [
      'col-resize',
      'row-resize',
      'nesw-resize',
      'nwse-resize',
      'ew-resize',
      'ns-resize',
      'n-resize',
      'w-resize',
      's-resize',
      'e-resize',
      'nw-resize',
      'ne-resize',
      'sw-resize',
      'se-resize',
    ],
  },
];
export const CURSORS: SelectOption<string>[] = CURSOR_GROUPS.flatMap((group) => [
  { value: `__${group.heading}`, label: group.heading, heading: true },
  ...group.values.map((cursor) => ({
    value: cursor,
    label: cursor,
    icon: CURSOR_ICONS[cursor],
    indent: true,
  })),
]);

export const OUTLINE_OPTIONS: readonly SegOption[] = [
  { value: 'none', label: '✕', menuLabel: 'None', ariaLabel: 'None' },
  {
    value: 'solid',
    label: <span className="embed-editor_border-style-line is-solid" />,
    menuLabel: 'Solid',
    ariaLabel: 'Solid',
  },
  {
    value: 'dashed',
    label: <span className="embed-editor_border-style-line is-dashed" />,
    menuLabel: 'Dashed',
    ariaLabel: 'Dashed',
  },
  {
    value: 'dotted',
    label: <span className="embed-editor_border-style-line is-dotted" />,
    menuLabel: 'Dotted',
    ariaLabel: 'Dotted',
  },
];
export const EVENTS_OPTIONS: readonly SegOption[] = [
  { value: 'auto', label: 'Auto', menuLabel: 'Auto' },
  { value: 'none', label: 'None', menuLabel: 'None' },
];

// The "Custom…" sentinel + preset value sets (values that ARE listed in the dropdown,
// so anything else counts as a custom value that opens the input).
export const CUSTOM = '__custom__';
export const BLEND_SET = new Set(BLEND_MODES.map((option) => option.value));
export const CURSOR_SET = new Set(CURSOR_GROUPS.flatMap((group) => group.values));

// The free-text input the Select swaps in when "Custom…" is picked (or the current
// value isn't a listed preset). Empty when just switched from a preset, so you type
// a fresh value; committing empty clears the property and returns to the dropdown.
export interface CustomInputProps {
  prop: string;
  value: string;
  placeholder: string;
  busy: boolean;
  autoFocus: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
  clearProp: ClearProp;
  onExit: () => void;
}
export function CustomInput(props: CustomInputProps) {
  const { prop, value, placeholder, busy, setProp, liveSetProp, clearProp, onExit } = props;
  const computed = useStyleHint(value ? '' : prop);
  const { draft, setDraft, focused } = useExternalDraft(value);
  const { live, cancel } = useLiveTimer((text) => {
    const trimmed = text.trim();
    if (trimmed) {
      const parsed = parseImportant(trimmed);
      liveSetProp(prop, parsed.value, parsed.important);
    }
  });
  const commit = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clearProp(prop);
      onExit();
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  return (
    <VariableConnect ariaLabel={`Connect ${prop} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
      <input
        className="u-input u-select-custom-input"
        value={draft}
        autoFocus={props.autoFocus}
        onChange={(event) => {
          setDraft(event.target.value);
          live(event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          cancel();
          commit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={computed || placeholder}
        aria-label={prop}
      />
    </VariableConnect>
  );
}

// A preset dropdown whose last option is "Custom…" — picking it (or an existing
// value not in the list) swaps the trigger for a free-text input.
export interface PresetSelectRowProps {
  prop: string;
  label: string;
  options: SelectOption<string>[];
  presets: Set<string>;
  fallback: string;
  placeholder: string;
  props: Props;
  /** Offer a "Custom…" free-value option. Off for enumerated props (e.g. cursor)
   *  where Webflow won't store arbitrary/CSS-wide values anyway. */
  allowCustom?: boolean;
}
export function PresetSelectRow(row: PresetSelectRowProps) {
  const { prop, label, options, presets, props, allowCustom = true } = row;
  const { read, busy, setProp, liveSetProp, clearProp } = props;
  const display = displayOf(read(prop));
  const current = display.present ? display.value.trim() : '';
  // Nothing authored → highlight what the page actually computes for this element,
  // falling back to the CSS initial value when there's no canvas to ask.
  const shown = useHighlight(
    current,
    prop,
    options.map((option) => option.value),
    row.fallback,
  );
  const isPreset = !current || presets.has(current);
  const [forceCustom, setForceCustom] = useState(false);
  const customMode = allowCustom && (forceCustom || (display.present && !isPreset));
  const pick = (choice: string) => {
    if (choice === CUSTOM) {
      setForceCustom(true);
      return;
    }
    setForceCustom(false);
    setProp(prop, choice, false);
  };
  // "Custom…" has no value of its own to show, so landing on it reverts the preview.
  const preview = (option: string | undefined) => liveSetProp(prop, option === CUSTOM ? undefined : option, false);
  const written = display.important ? `${display.value} !important` : display.value;
  const inputValue = forceCustom && isPreset ? '' : display.present ? written : '';
  const selectOptions = presetSelectOptions({
    options,
    allowCustom,
    stray: display.present && !isPreset ? current : undefined,
  });
  return (
    <div className="embed-editor_size-row">
      <EffLabel label={label} prop={prop} props={props} />
      <Select
        value={customMode ? CUSTOM : shown}
        options={selectOptions}
        onChange={pick}
        onPreview={(option) => preview(option ?? undefined)}
        ariaLabel={label}
        disabled={busy}
        customInput={
          customMode ? (
            <CustomInput
              prop={prop}
              value={inputValue}
              placeholder={row.placeholder}
              busy={busy}
              autoFocus={forceCustom}
              setProp={setProp}
              liveSetProp={liveSetProp}
              clearProp={clearProp}
              onExit={() => setForceCustom(false)}
            />
          ) : undefined
        }
      />
    </div>
  );
}

// The dropdown's options: the presets, then "Custom…". With Custom off, a pre-existing
// non-preset value (`stray`) is still surfaced so the trigger shows it (rather than
// silently falling back to the first option).
export function presetSelectOptions({
  options,
  allowCustom,
  stray,
}: {
  options: SelectOption<string>[];
  allowCustom: boolean;
  stray: string | undefined;
}): SelectOption<string>[] {
  if (allowCustom) {
    return [...options, { value: CUSTOM, label: 'Custom…' }];
  }
  if (stray !== undefined) {
    return [...options, { value: stray, label: stray }];
  }
  return options;
}
