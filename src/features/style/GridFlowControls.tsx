import Popup from '../../ui/Popup';
// The grid's flow controls: direction and density, the custom value input and
// its menu, content distribution, and the column and row counts
// (GridControls.tsx).

import { useEffect, useRef, useState } from 'react';
import SegmentedControl from './components/SegmentedControl';
import { useHighlight } from './model/computedStyle';
import { commitInPlace } from './model/commitInPlace';
import { parseFlow, buildFlow, isPresetFlow } from './gridTracks';
import { GRID_FLOW, GRID_CONTENT, GRID_SYNONYMS, gridKeyword, LABELS, cap, contentOptions, ChevUp, ChevDown, DenseIcon } from './GridIcons';

export function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i);
  return match ? { value: input.slice(0, match.index).trim(), important: true } : { value: input.trim(), important: false };
}

// The grid Direction control: the row/column segments (with Horizontal/Vertical
// tooltips) + a dense toggle, plus a chevron menu with a "Custom" escape hatch that
// swaps the bar for a free-value grid-auto-flow field (mirrors the other button lists).
export interface GridDirectionControlProps {
  value: string;
  busy: boolean;
  onSet: (value: string) => void;
  onCommitCustom: (value: string, important: boolean) => void;
}
export function GridDirectionControl({ value, busy, onSet, onCommitCustom }: GridDirectionControlProps) {
  const { direction, dense } = value ? parseFlow(value) : { direction: 'row', dense: false };
  const [forceCustom, setForceCustom] = useState(false);
  const customMode = forceCustom || (!!value.trim() && !isPresetFlow(value));
  const menu = useCustomMenu({ customMode, busy });

  const enterCustom = () => {
    menu.setOpen(false);
    setForceCustom(true);
    menu.requestFocus();
    onCommitCustom('unset', false);
  };
  const pickPreset = (next: string) => {
    menu.setOpen(false);
    setForceCustom(false);
    onSet(buildFlow({ direction: next, dense }));
  };

  return (
    <div ref={menu.rootRef} className="embed-editor_grid-direction">
      {/* The segments (or custom field) + the dropdown arrow share one pill so the
          arrow belongs to the direction control; the dense toggle sits outside it. */}
      <div className={`embed-editor_grid-dir-bar ${customMode ? 'is-custom' : ''}`}>
        {customMode ? (
          <GridCustomInput
            value={value}
            busy={busy}
            inputRef={menu.inputRef}
            placeholder="e.g. row dense"
            ariaLabel="Grid auto flow"
            onCommitCustom={onCommitCustom}
          />
        ) : (
          <SegmentedControl
            value={direction}
            options={GRID_FLOW}
            ariaLabel="Grid direction"
            disabled={busy}
            onChange={(next) => onSet(buildFlow({ direction: next, dense }))}
          />
        )}
        <MenuArrow open={menu.open} busy={busy} ariaLabel="More direction options" onToggle={menu.toggle} />
        {menu.open ? (
          <DirectionMenu onClose={() => menu.setOpen(false)} customMode={customMode} pickPreset={pickPreset} enterCustom={enterCustom} />
        ) : undefined}
      </div>
      {!customMode ? <DenseToggle dense={dense} busy={busy} onToggle={() => onSet(buildFlow({ direction, dense: !dense }))} /> : undefined}
    </div>
  );
}

// From custom mode: back to Horizontal or Vertical; from the bar: on to Custom.
export function DirectionMenu({
  onClose,
  customMode,
  pickPreset,
  enterCustom,
}: {
  customMode: boolean;
  pickPreset: (direction: string) => void;
  enterCustom: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Popup mode="popover" portal={false} onClose={onClose} className="embed-editor_display-menu" role="menu">
      {customMode ? (
        <>
          <MenuButton label="Horizontal" onClick={() => pickPreset('row')} />
          <MenuButton label="Vertical" onClick={() => pickPreset('column')} />
        </>
      ) : (
        <MenuButton label="Custom" onClick={enterCustom} />
      )}
    </Popup>
  );
}

export function DenseToggle({ dense, busy, onToggle }: { dense: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`embed-editor_icon-btn ${dense ? 'is-active' : ''}`}
      disabled={busy}
      aria-pressed={dense}
      title="Dense — backfill earlier gaps in the grid"
      onClick={onToggle}
    >
      <DenseIcon />
    </button>
  );
}

// A custom-mode control's shared state: the chevron menu (closed again on an outside
// click or Escape), and the request to focus the free-value field once custom mode is
// on and the control is no longer busy.
export function useCustomMenu({ customMode, busy }: { customMode: boolean; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  // Focus the field after switching to Custom, once its `unset` write settles.
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy]);
  return {
    open,
    setOpen,
    toggle: () => setOpen((wasOpen) => !wasOpen),
    rootRef,
    inputRef,
    requestFocus: () => {
      wantFocus.current = true;
    },
  };
}

// The free-value field of custom mode: commits on blur (with !important parsed off).
// It mounts only in custom mode, starting from the current value, and mirrors external
// edits unless the user is typing.
export function GridCustomInput({
  value,
  busy,
  inputRef,
  placeholder,
  ariaLabel,
  onCommitCustom,
}: {
  value: string;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  placeholder: string;
  ariaLabel: string;
  onCommitCustom: (value: string, important: boolean) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const commitCustom = () => {
    const parsed = parseImportant(draft);
    if (parsed.value) {
      onCommitCustom(parsed.value, parsed.important);
    }
  };
  return (
    <input
      ref={inputRef}
      className="embed-editor_value-input embed-editor_display-input"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        commitCustom();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      placeholder={placeholder}
      aria-label={ariaLabel}
    />
  );
}

export function MenuArrow({ open, busy, ariaLabel, onToggle }: { open: boolean; busy: boolean; ariaLabel: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="embed-editor_display-arrow"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={ariaLabel}
      disabled={busy}
      onClick={onToggle}
    >
      <ChevDown />
    </button>
  );
}

export function MenuButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={onClick}>
      {label}
    </button>
  );
}

// The grid content control (justify-content / align-content): the preset icon
// segments + a dropdown arrow whose menu swaps to a free-value field (a value outside
// the presets — a CSS-wide keyword, var(), … — shows the field automatically).
// Mirrors GridDirectionControl.
export interface GridContentControlProps {
  value: string;
  /** The property this bar edits — its computed value highlights an unset control. */
  prop: string;
  vertical: boolean;
  ariaLabel: string;
  busy: boolean;
  onSet: (value: string) => void;
  onCommitCustom: (value: string, important: boolean) => void;
}
export function GridContentControl(props: GridContentControlProps) {
  const { value, prop, vertical, ariaLabel, busy, onSet, onCommitCustom } = props;
  const current = gridKeyword(value.trim().toLowerCase());
  const shownContent = gridKeyword(useHighlight('', current ? '' : prop, [...GRID_CONTENT, ...Object.keys(GRID_SYNONYMS)], 'stretch'));
  const [forceCustom, setForceCustom] = useState(false);
  const customMode = forceCustom || (!!current && !GRID_CONTENT.includes(current));
  const menu = useCustomMenu({ customMode, busy });

  const enterCustom = () => {
    menu.setOpen(false);
    setForceCustom(true);
    menu.requestFocus();
  };
  const pickPreset = (option: string) => {
    menu.setOpen(false);
    setForceCustom(false);
    onSet(option);
  };
  // Unset → show stretch selected (grid's default); a known value shows itself.
  const segValue = current ? (GRID_CONTENT.includes(current) ? current : '') : shownContent;

  return (
    <div ref={menu.rootRef} className={`embed-editor_grid-dir-bar ${customMode ? 'is-custom' : ''}`}>
      {customMode ? (
        <GridCustomInput value={value} busy={busy} inputRef={menu.inputRef} placeholder="custom value" ariaLabel={ariaLabel} onCommitCustom={onCommitCustom} />
      ) : (
        <SegmentedControl value={segValue} options={contentOptions({ vertical })} ariaLabel={ariaLabel} disabled={busy} onChange={onSet} />
      )}
      <MenuArrow open={menu.open} busy={busy} ariaLabel={`More ${ariaLabel} options`} onToggle={menu.toggle} />
      {menu.open ? (
        <GridContentMenu customMode={customMode} pickPreset={pickPreset} enterCustom={enterCustom} onClose={() => menu.setOpen(false)} />
      ) : undefined}
    </div>
  );
}

// From custom mode: every preset, to switch back to the bar.
export function ContentPresetItems({ pickPreset }: { pickPreset: (option: string) => void }) {
  return GRID_CONTENT.map((option) => <MenuButton key={option} label={LABELS[option] ?? cap(option)} onClick={() => pickPreset(option)} />);
}

// A track count stays between 1 and 500.
export const clampCount = (count: number) => Math.min(500, Math.max(1, count));

// A whole-number track-count field with ▲▼ steppers (Webflow's Columns/Rows inputs).
export function CountField({ value, busy, ariaLabel, onCommit }: { value: number; busy: boolean; ariaLabel: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(value > 0 ? String(value) : '');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setText(value > 0 ? String(value) : '');
    }
  }, [value]);
  const commit = (entered: string) => {
    const parsed = parseInt(entered, 10);
    if (Number.isNaN(parsed)) {
      setText(value > 0 ? String(value) : '');
      return;
    }
    onCommit(clampCount(parsed));
  };
  // Step from the DISPLAYED value and update it immediately: while the input is focused
  // (arrow-key stepping) the `value`→`text` sync is suppressed, so without this the field
  // would freeze on the old number even though the write went through. Basing the step on
  // `text` also keeps rapid presses correct while the native write round-trips.
  const step = (delta: number) => {
    const base = parseInt(text, 10);
    const next = clampCount((Number.isNaN(base) ? value || 0 : base) + delta);
    setText(String(next));
    onCommit(next);
  };
  return (
    <div className="embed-editor_grid-count">
      <input
        className="u-input embed-editor_size-input"
        value={text}
        inputMode="numeric"
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder="0"
        onChange={(event) => setText(event.target.value)}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit(text);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
            return;
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            step(1);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            step(-1);
          }
        }}
      />
      <CountSteppers busy={busy} step={step} />
    </div>
  );
}

export function CountSteppers({ busy, step }: { busy: boolean; step: (delta: number) => void }) {
  return (
    <div className="embed-editor_grid-count-steppers">
      <button type="button" tabIndex={-1} disabled={busy} aria-label="Increase" onClick={() => step(1)}>
        <ChevUp />
      </button>
      <button type="button" tabIndex={-1} disabled={busy} aria-label="Decrease" onClick={() => step(-1)}>
        <ChevDown />
      </button>
    </div>
  );
}

function GridContentMenu({
  customMode,
  pickPreset,
  enterCustom,
  onClose,
}: {
  readonly customMode: boolean;
  readonly pickPreset: (value: string) => void;
  readonly enterCustom: () => void;
  readonly onClose: () => void;
}) {
  return (
    <Popup mode="popover" portal={false} onClose={onClose} className="embed-editor_display-menu" role="menu">
      {customMode ? <ContentPresetItems pickPreset={pickPreset} /> : <MenuButton label="Custom" onClick={enterCustom} />}
    </Popup>
  );
}
