// How text breaks and wraps: word-break and white-space, overflow-wrap, and
// truncation with text-overflow (TypographySection.tsx).

import { useState } from 'react';
import Select, { type SelectOption } from './components/Select';
import SegmentedControl from './components/SegmentedControl';
import { useHighlight } from './model/computedStyle';
import { displayOf } from './model/styleDisplay';
import { type Props, joinImportant, CUSTOM, PropLabel, LiveInput, useSegCustomFocus } from './TypographyKit';

// ─────────────── Breaking (word-break / white-space) ───────────────

// One "Breaking" row holds two dropdowns — Word (word-break) and Line
// (white-space) — each stacked over its own clickable label (mirrors Webflow).
export type BreakDefinition = {
  prop: string;
  label: string;
  ariaLabel: string;
  /** CSS default shown selected when unset (the label stays dim until set). */
  fallback: string;
  /** [css value, menu label] pairs, in Webflow's order. */
  options: ReadonlyArray<readonly [string, string]>;
};

export const WORD_BREAK: BreakDefinition = {
  prop: 'word-break',
  label: 'Word',
  ariaLabel: 'Word breaking',
  fallback: 'normal',
  options: [
    ['normal', 'Normal'],
    ['break-all', 'Break all'],
    ['keep-all', 'Keep all'],
  ],
};
export const WHITE_SPACE: BreakDefinition = {
  prop: 'white-space',
  label: 'Line',
  ariaLabel: 'Line breaking',
  fallback: 'normal',
  options: [
    ['normal', 'Normal'],
    ['nowrap', 'No wrap'],
    ['pre', 'Pre'],
    ['pre-wrap', 'Pre wrap'],
    ['pre-line', 'Pre line'],
    ['break-spaces', 'Break spaces'],
  ],
};

// A single-property value dropdown with the shared blue/orange resolved model: it
// shows the matched option (or the CSS default when unset), and drops into Custom
// mode with a free-text field for an unknown value (mirrors WeightField). Writes
// target the picked selector; the caller owns `forceCustom` so its label's Clear
// can also drop out of custom mode.
export type EnumSelectProps = {
  prop: string;
  ariaLabel: string;
  fallback: string;
  options: ReadonlyArray<readonly [string, string]>;
  forceCustom: boolean;
  setForceCustom: (value: boolean) => void;
} & Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp'>;

export function EnumSelect(props: EnumSelectProps) {
  const { prop, ariaLabel, fallback, options: choices, forceCustom, setForceCustom } = props;
  const { read, busy, setProp, clearProp, liveSetProp } = props;
  const display = displayOf(read(prop));
  const values = new Set(choices.map(([value]) => value));
  const current = display.present ? display.value.trim().toLowerCase() : '';
  const matched = values.has(current) ? current : undefined;
  // Unset → show what the page computes for this element (an inherited value, a rule
  // the panel's matcher can't see), and only then the CSS default.
  const shownComputed = useHighlight(
    '',
    matched ? '' : prop,
    choices.map(([value]) => value),
    fallback,
  );
  const customMode = forceCustom || (display.present && !matched);

  const options: SelectOption<string>[] = [...choices.map(([value, optionLabel]) => ({ value, label: optionLabel })), { value: CUSTOM, label: 'Custom…' }];

  // Focus + select the custom field once its `unset` write settles (busy clears), so
  // its draft has synced to `unset` — autoFocus would grab it before the write lands.
  const { inputRef, requestFocus } = useSegCustomFocus({ customMode, busy });

  const pick = (value: string) => {
    if (value === CUSTOM) {
      // Always seed Custom with `unset` — a valid default that applies immediately and
      // that the user can type over (selected on focus), rather than a blank/stale field.
      requestFocus();
      setForceCustom(true);
      setProp(prop, 'unset', false);
      return;
    }
    setForceCustom(false);
    setProp(prop, value, false);
  };

  return (
    <Select
      value={customMode ? CUSTOM : (matched ?? shownComputed)}
      options={options}
      onChange={pick}
      onPreview={(value) => liveSetProp(prop, value === CUSTOM ? undefined : (value ?? undefined), false)}
      ariaLabel={ariaLabel}
      disabled={busy}
      customInput={
        customMode ? (
          <LiveInput
            inputRef={inputRef}
            value={display.present ? joinImportant(display) : 'unset'}
            busy={busy}
            placeholder={prop}
            ariaLabel={ariaLabel}
            className="u-select-custom-input"
            prop={prop}
            onCommit={(value, important) => setProp(prop, value, important)}
            onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
            onClear={() => {
              setForceCustom(false);
              clearProp(prop);
            }}
          />
        ) : undefined
      }
    />
  );
}

// A dropdown cell: the value Select stacked over its clickable label.
export function BreakSelect({
  definition,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: { definition: BreakDefinition } & Props) {
  const { prop, label, ariaLabel, fallback, options } = definition;
  const [forceCustom, setForceCustom] = useState(false);
  const display = displayOf(read(prop));
  const onClear = () => {
    setForceCustom(false);
    clearProp(prop);
  };
  return (
    <div className="embed-editor_type-cell">
      <EnumSelect
        prop={prop}
        ariaLabel={ariaLabel}
        fallback={fallback}
        options={options}
        forceCustom={forceCustom}
        setForceCustom={setForceCustom}
        read={read}
        busy={busy}
        setProp={setProp}
        clearProp={clearProp}
        liveSetProp={liveSetProp}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={onClear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// The Breaking row: a static "Breaking" label in the shared label column, then the
// Word + Line dropdowns sharing the control area.
export function BreakingRow(props: Props) {
  return (
    <div className="embed-editor_break-row">
      <span className="embed-editor_size-label embed-editor_break-title">Breaking</span>
      <div className="embed-editor_break-pair">
        <BreakSelect definition={WORD_BREAK} {...props} />
        <BreakSelect definition={WHITE_SPACE} {...props} />
      </div>
    </div>
  );
}

// ─────────────── Wrap (overflow-wrap) ───────────────

export const WRAP_OPTIONS: ReadonlyArray<readonly [string, string]> = [
  ['normal', 'Normal'],
  ['anywhere', 'Anywhere'],
  ['break-word', 'Break word'],
];

// A single full-width row: the "Wrap" label + the overflow-wrap dropdown.
export function WrapRow({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const [forceCustom, setForceCustom] = useState(false);
  const display = displayOf(read('overflow-wrap'));
  const onClear = () => {
    setForceCustom(false);
    clearProp('overflow-wrap');
  };
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Wrap"
        prop="overflow-wrap"
        display={display}
        contributors={read('overflow-wrap')?.contributors ?? []}
        busy={busy}
        onClear={onClear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <EnumSelect
        prop="overflow-wrap"
        ariaLabel="Text wrap"
        fallback="normal"
        options={WRAP_OPTIONS}
        forceCustom={forceCustom}
        setForceCustom={setForceCustom}
        read={read}
        busy={busy}
        setProp={setProp}
        clearProp={clearProp}
        liveSetProp={liveSetProp}
      />
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

// ─────────────── Truncate (text-overflow) ───────────────

export function TruncateRow({ read, busy, setProp, clearProp, onProvenance, onSelectSelector }: Props) {
  const display = displayOf(read('text-overflow'));
  const shownOverflow = useHighlight('', display.present ? '' : 'text-overflow', ['clip', 'ellipsis'], 'clip');
  const current = display.present ? (display.value.trim().toLowerCase() === 'ellipsis' ? 'ellipsis' : 'clip') : shownOverflow;
  return (
    <div className="embed-editor_size-row">
      <PropLabel
        label="Truncate"
        prop="text-overflow"
        display={display}
        contributors={read('text-overflow')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('text-overflow')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentedControl
        options={[
          { value: 'clip', label: 'Clip' },
          { value: 'ellipsis', label: 'Ellipsis' },
        ]}
        value={current}
        onChange={(value) => setProp('text-overflow', value, false)}
        ariaLabel="Truncate"
        disabled={busy}
      />
    </div>
  );
}
