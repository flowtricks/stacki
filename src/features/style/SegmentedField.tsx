import Popup from '../../ui/Popup';
import { useEffect, useRef, useState } from 'react';
import { useHighlight } from './model/computedStyle';
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import SegmentPill from './components/SegmentPill';
import { ChevronIcon, MenuItem } from './components/MenuParts';
import { useCustomFocus } from './model/fieldHooks';
import { parseImportant, withImportant } from './model/styleDisplay';

// A segmented button-list with a trailing dropdown arrow whose menu offers a
// "Custom" escape hatch (writes `unset` and reveals a focused text field), and —
// while custom — the built-in values to switch back. Mirrors DisplayControl's
// bar/menu/custom pattern (and reuses its CSS) so any button list gets the same
// custom affordance. Applying a value WRITES it (so the label stays blue) rather
// than clearing — clearing lives on the field label.

export type SegOption = { value: string; label: ReactNode; menuLabel: string; ariaLabel?: string };

// Editable text field for a custom value (defaults to `unset` when just entered).
function CustomField({
  value,
  important,
  busy,
  inputRef,
  onCommit,
}: {
  value: string;
  important: boolean;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  onCommit: (value: string, important: boolean) => void;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(withImportant({ value, important }));
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(withImportant({ value, important }));
    }
  }, [value, important]);
  const commit = () => {
    const parsed = parseImportant(draft);
    if (parsed.value && (parsed.value !== value.trim() || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important);
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
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.currentTarget.blur();
        }
      }}
      disabled={busy}
      spellCheck={false}
      aria-label={translate('style.segmentedField.value')}
      placeholder={translate('style.segmentedField.customValuePlaceholder')}
    />
  );
}

type SegmentedFieldProps = {
  value: string;
  important: boolean;
  options: readonly SegOption[];
  /** The CSS property this bar edits — when nothing is authored, the page's own
   *  computed value is highlighted (inherited, a `*` rule, a UA default). */
  prop?: string;
  /** Value selected/shown when the property is unset and the page can't be asked. */
  fallback: string;
  busy: boolean;
  onCommit: (value: string, important: boolean) => void;
  ariaLabel?: string;
};

export default function SegmentedField({ value, important, options, prop, fallback, busy, onCommit, ariaLabel }: SegmentedFieldProps) {
  const current = value.trim().toLowerCase();
  const supported = new Set(options.map((option) => option.value));
  // The bar represents a listed value with no !important; anything else is custom.
  const customMode = !((supported.has(current) || !current) && !important);
  const active = useHighlight(
    current,
    prop ?? '',
    options.map((option) => option.value),
    fallback,
  );

  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { inputRef, requestFocus } = useCustomFocus({ customMode, busy });

  const pick = (next: string) => {
    setOpen(false);
    if (next !== current || important) {
      onCommit(next, false);
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    onCommit('unset', false);
  };

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={ariaLabel}>
      <SegmentPill />
      {customMode ? (
        <CustomField value={value} important={important} busy={busy} inputRef={inputRef} onCommit={onCommit} />
      ) : (
        <SegmentButtons options={options} active={active} busy={busy} onPick={pick} />
      )}
      <SegmentMenu
        open={open}
        busy={busy}
        customMode={customMode}
        current={current}
        options={options}
        onToggle={() => setOpen((previous) => !previous)}
        onPick={pick}
        onEnterCustom={enterCustom}
      />
    </div>
  );
}

// The trailing arrow and its menu: "Custom" from the bar, or the built-in
// values to switch back to from a custom value.
function SegmentMenu({
  open,
  busy,
  customMode,
  current,
  options,
  onToggle,
  onPick,
  onEnterCustom,
}: {
  open: boolean;
  busy: boolean;
  customMode: boolean;
  current: string;
  options: readonly SegOption[];
  onToggle: () => void;
  onPick: (value: string) => void;
  onEnterCustom: () => void;
}) {
  const translate = useTranslate();
  return (
    <>
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={translate('style.segmentedField.moreOptions')}
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>

      {open ? (
        <Popup mode="popover" portal={false} onClose={onToggle} className="embed-editor_display-menu" role="menu">
          {customMode ? (
            options.map((option) => (
              <MenuItem key={option.value} label={option.menuLabel} selected={current === option.value} onClick={() => onPick(option.value)} />
            ))
          ) : (
            <MenuItem label={translate('style.segmentedField.custom')} selected={false} onClick={onEnterCustom} />
          )}
        </Popup>
      ) : undefined}
    </>
  );
}

// The bar's segments, one per listed value.
function SegmentButtons({ options, active, busy, onPick }: { options: readonly SegOption[]; active: string; busy: boolean; onPick: (value: string) => void }) {
  return options.map((option) => (
    <button
      key={option.value}
      type="button"
      role="radio"
      aria-checked={active === option.value}
      aria-label={option.ariaLabel ?? option.menuLabel}
      className={`embed-editor_display-seg ${active === option.value ? 'is-selected' : ''}`}
      disabled={busy}
      onClick={() => onPick(option.value)}
    >
      {option.label}
    </button>
  ));
}
