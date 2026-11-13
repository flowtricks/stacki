import Popup from '../../ui/Popup';
// Float and clear as segmented icon bars: the segments, a custom value and
// the overflow menu; and the writers and reader the position section's
// controls are handed (PositionSection.tsx).

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import VariableConnect from './VariableConnect';
import type { ResolvedProp } from './model/resolved';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';
import { ChevronIcon, MenuItem } from './components/MenuParts';
import { useCustomFocus } from './model/fieldHooks';
import { keepImportant, parseImportant } from './model/styleDisplay';
import { CloseIcon, FloatLeftIcon, FloatRightIcon, ClearLeftIcon, ClearRightIcon, ClearBothIcon } from './PositionIcons';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';

export type SetProp = (prop: string, value: string, important: boolean) => void;
export type ClearProp = (prop: string | string[]) => void;
export type LiveSetProp = (prop: string | readonly string[], value: string | undefined, important: boolean) => void;
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

// ─────────────────────────── Float / Clear segmented controls ───────────────────────────

export type Seg = { value: string; icon: ReactNode; label: string };

// An icon segmented bar (Float / Clear) + a chevron menu whose only item enters a
// Custom free-value mode (var()/unset), and offers the presets to switch back —
// mirroring the Overflow / Display controls.
export type SegmentedIconControlProps = {
  prop: string;
  ariaLabel: string;
  segments: readonly Seg[];
  current: string;
} & Props & { read?: Read };

export function SegmentedIconControl({ prop, ariaLabel, segments, current, busy, setProp, liveSetProp, clearProp }: SegmentedIconControlProps) {
  const supported = new Set(segments.map((segment) => segment.value));
  const customMode = !supported.has(current);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const { inputRef, requestFocus } = useCustomFocus({ customMode, busy });

  const pick = (next: string) => {
    setOpen(false);
    if (next !== current) {
      setProp(prop, next, false);
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    setProp(prop, 'unset', false);
  };

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={ariaLabel}>
      <SegmentPill />
      {customMode ? (
        <SegmentCustomInput
          prop={prop}
          ariaLabel={ariaLabel}
          current={current}
          busy={busy}
          inputRef={inputRef}
          setProp={setProp}
          liveSetProp={liveSetProp}
          clearProp={clearProp}
        />
      ) : (
        <SegmentButtons segments={segments} current={current} busy={busy} onPick={pick} />
      )}
      <SegmentMenu
        open={open}
        ariaLabel={ariaLabel}
        busy={busy}
        customMode={customMode}
        current={current}
        segments={segments}
        onToggle={() => setOpen((value) => !value)}
        onPick={pick}
        onEnterCustom={enterCustom}
      />
    </div>
  );
}

// The free-value field of a segmented control in Custom mode: live as you type,
// committed (or cleared, when blank) on blur.
export function SegmentCustomInput({
  prop,
  ariaLabel,
  current,
  busy,
  inputRef,
  setProp,
  liveSetProp,
  clearProp,
}: Pick<SegmentedIconControlProps, 'prop' | 'ariaLabel' | 'current' | 'busy' | 'setProp' | 'liveSetProp' | 'clearProp'> & {
  inputRef: React.RefObject<HTMLInputElement>;
}) {
  const translate = useTranslate();
  const [draft, setDraft] = useState(current);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(current);
    }
  }, [current]);
  const commitCustom = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clearProp(prop);
      return;
    }
    const parsed = parseImportant(trimmed);
    setProp(prop, parsed.value, parsed.important);
  };
  return (
    <VariableConnect
      code
      ariaLabel={translate('style.positionSegments.connect', { name: ariaLabel })}
      disabled={busy}
      prop={prop}
      onPick={(binding) => {
        // `current` is the field's text, flag and all: a pick keeps the flag.
        const kept = keepImportant(binding, parseImportant(current));
        setProp(prop, kept.value, kept.important);
      }}
    >
      <input
        ref={inputRef}
        className="embed-editor_value-input embed-editor_display-input"
        value={draft}
        placeholder={translate('style.positionSegments.customValuePlaceholder')}
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
          const trimmed = event.target.value.trim();
          if (trimmed) {
            const parsed = parseImportant(trimmed);
            liveSetProp(prop, parsed.value, parsed.important);
          }
        }}
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
        aria-label={`${ariaLabel} value`}
      />
    </VariableConnect>
  );
}

// The icon segments of the bar, one per preset.
export function SegmentButtons({
  segments,
  current,
  busy,
  onPick,
}: {
  segments: readonly Seg[];
  current: string;
  busy: boolean;
  onPick: (value: string) => void;
}) {
  return segments.map((segment) => (
    <button
      key={segment.value}
      type="button"
      role="radio"
      aria-checked={current === segment.value}
      className={`embed-editor_display-seg ${current === segment.value ? 'is-selected' : ''}`}
      disabled={busy}
      title={segment.label}
      aria-label={segment.label}
      onClick={() => onPick(segment.value)}
    >
      {segment.icon}
    </button>
  ));
}

// The chevron and its menu: "Custom" from the bar, or the presets to switch back
// to from a custom value.
export function SegmentMenu({
  open,
  ariaLabel,
  busy,
  customMode,
  current,
  segments,
  onToggle,
  onPick,
  onEnterCustom,
}: {
  open: boolean;
  ariaLabel: string;
  busy: boolean;
  customMode: boolean;
  current: string;
  segments: readonly Seg[];
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
        aria-label={translate('style.positionSegments.moreOptions', { name: ariaLabel })}
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <Popup mode="popover" portal={false} onClose={onToggle} className="embed-editor_display-menu" role="menu">
          {customMode ? (
            segments.map((segment) => (
              <MenuItem key={segment.value} label={segment.label} selected={current === segment.value} onClick={() => onPick(segment.value)} />
            ))
          ) : (
            <MenuItem label={translate('style.positionSegments.custom')} selected={false} onClick={onEnterCustom} />
          )}
        </Popup>
      ) : undefined}
    </>
  );
}

export function floatSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'none', icon: <CloseIcon />, label: translate('style.positionSegments.floatNone') },
    { value: 'left', icon: <FloatLeftIcon />, label: translate('style.positionSegments.floatLeft') },
    { value: 'right', icon: <FloatRightIcon />, label: translate('style.positionSegments.floatRight') },
  ];
}
export function clearSegments(translate: Translator): readonly Seg[] {
  return [
    { value: 'none', icon: <CloseIcon />, label: translate('style.positionSegments.clearNone') },
    { value: 'left', icon: <ClearLeftIcon />, label: translate('style.positionSegments.clearLeft') },
    { value: 'right', icon: <ClearRightIcon />, label: translate('style.positionSegments.clearRight') },
    { value: 'both', icon: <ClearBothIcon />, label: translate('style.positionSegments.clearBoth') },
  ];
}
