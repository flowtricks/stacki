import { centralIcon } from '../../ui/central/CentralIcon';
import { more as centralMore } from '../../ui/central/centralGeometry';
import Popup from '../../ui/Popup';
// The field kit the style panel's sections are drawn with — first written for
// typography, now shared: the property and group labels, the live text input
// and its stacked field, and the segmented bar with its custom value and
// overflow menu (TypographySection.tsx).

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import { useComputedValue } from './model/computedStyle';
import { panelBounds } from './model/panelBox';
import ProvenanceList from './ProvenanceList';
import type { Contributor, ResolvedProp } from './model/resolved';
import SegmentPill from './components/SegmentPill';
import { ChevronIcon, MenuItem } from './components/MenuParts';
import { displayOf, type Display, withImportant } from './model/styleDisplay';
import { LiveInput } from './LiveTextInput';
import { useTranslate } from '../../lib/i18n/useTranslate';
export { LiveInput, type LiveInputProps, useLiveInputEditing, useDebouncedLive, stepLiveKey } from './LiveTextInput';

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

export const CUSTOM = '__custom__';

// ─────────────────────────── Label ───────────────────────────

// A typography control's label: blue (picked selector sets it) → FieldLabel with a
// clear menu; orange (another selector) → a button opening provenance; unset → a
// dim caption. Mirrors the Size section's SizeLabel.
export function PropLabel({
  label,
  prop,
  tipProps,
  display: display,
  contributors,
  busy,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  /** Properties named in the hover tooltip — defaults to the one `prop` shown. */
  tipProps?: readonly string[];
  display: Display;
  contributors: Contributor[];
  busy: boolean;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const tip = tipProps ?? [prop];
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={tip} anchorProp={prop} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={onClear}
      resetLabel={translate('style.typographyKit.clear')}
      tooltip={<PropTip props={tip} />}
      {...(display.overridden ? { title: translate('style.typographyKit.overriddenBy', { selector: display.winnerSelector }) } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={contributors}
          prop={prop}
          onSelect={(selector, selectorProp) => {
            onSelectSelector(selector, selectorProp);
            close();
          }}
        />
      )}
    >
      {label}
    </FieldLabel>
  );
}

// A PropLabel for a control backed by SEVERAL properties (Gap = row/column gaps,
// Direction = flex-direction/-wrap, …). Picks the representative property — one the
// picked selector sets first (blue), else any that's set at all (orange + provenance),
// else the first (grey/unset) — so these grouped labels get the same blue/orange/clear
// states as single-property ones. `onClear` clears the whole group.
export function GroupLabel({
  label,
  props,
  read,
  busy,
  onClear,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  props: readonly string[];
  read: (prop: string) => ResolvedProp | undefined;
  busy: boolean;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const prop = props.find((name) => read(name)?.source === 'selected') ?? props.find((name) => read(name) !== undefined) ?? props[0];
  if (prop === undefined) {
    throw new Error('Group label requires at least one property');
  }
  return (
    <PropLabel
      label={label}
      prop={prop}
      tipProps={props}
      display={displayOf(read(prop))}
      contributors={read(prop)?.contributors ?? []}
      busy={busy}
      onClear={onClear}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
}

// A label + text field bound to one property. An optional swatch (color field)
// renders inside the field to the left of the input.
export type TextFieldProps = {
  prop: string;
  label: string;
  placeholder?: string;
  swatch?: ReactNode;
  /** Render a colour swatch for this same property before the field. Owned here
   *  rather than passed in as `swatch` so a drag on it shows in the field: the
   *  drag writes to the canvas, not to the model this field reads. */
  swatchLabel?: string;
} & Props;

export function TextField(props: TextFieldProps) {
  const { prop, label, placeholder, swatch, swatchLabel, read, busy } = props;
  const { setProp, clearProp, liveSetProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read(prop));
  const external = display.present ? withImportant(display) : '';
  const [shown, noteLive] = useLiveColor(external);
  const computed = useComputedValue(swatchLabel && !shown ? prop : '');
  const ownSwatch = swatchLabel ? (
    <ColorSwatch
      value={shown || computed}
      busy={busy}
      ariaLabel={swatchLabel}
      onChange={(color, live) => {
        // The swatch picks a colour, not the flag: a flagged colour stays so.
        noteLive(live ? withImportant({ value: color, important: display.important }) : undefined);
        if (live) {
          liveSetProp(prop, color, display.important);
        } else {
          setProp(prop, color, display.important);
        }
      }}
    />
  ) : undefined;
  const input = (
    <LiveInput
      value={shown}
      busy={busy}
      {...(placeholder === undefined ? {} : { placeholder })}
      ariaLabel={label}
      className="u-input embed-editor_size-input"
      dataProp={prop}
      prop={prop}
      onCommit={(value, important) => setProp(prop, value, important)}
      onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
      onClear={() => clearProp(prop)}
    />
  );
  const fieldSwatch = ownSwatch ?? swatch;
  return (
    <>
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {fieldSwatch ? (
        <div className="embed-editor_type-field">
          {fieldSwatch}
          {input}
        </div>
      ) : (
        input
      )}
    </>
  );
}

// A stacked cell for the three-up bottom row: the input on top with its clickable
// label centered underneath (Webflow's Letter spacing / Text indent / Columns
// layout). DOM order (input, then label) doesn't affect the label's popup, which
// positions relative to its own wrap and clamps into the panel.
export function StackedField({
  prop,
  label,
  placeholder,
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  label: string;
  placeholder?: string;
} & Props) {
  const display = displayOf(read(prop));
  const external = display.present ? withImportant(display) : '';
  return (
    <div className="embed-editor_type-cell">
      <LiveInput
        value={external}
        busy={busy}
        {...(placeholder === undefined ? {} : { placeholder })}
        ariaLabel={label}
        className="u-input embed-editor_size-input"
        dataProp={prop}
        prop={prop}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
      <PropLabel
        label={label}
        prop={prop}
        display={display}
        contributors={read(prop)?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
    </div>
  );
}

// ─────────────────────────── Segmented bar (align / decor) ───────────────────────────

export type Seg = { value: string; icon: ReactNode; label: string };

// A segmented icon bar + a dropdown arrow whose menu offers Custom; a free value
// (anything outside the segments) shows an editable field. Mirrors the Size
// section's overflow bar, reusing the Display control's segmented-bar CSS.
export function SegBar(props: SegBarProps) {
  const { segs, current, ariaLabel, busy, onCommit, moreSegment, moreValue = 'unset' } = props;
  const supported = new Set(segs.map((segment) => segment.value));
  // `forceCustom` keeps the input open even when the seeded value happens to match a
  // segment (e.g. Order seeds `1`, which is also the "Last" preset) — the user
  // explicitly asked for a custom value, so don't collapse back to that segment.
  const [forceCustom, setForceCustom] = useState(false);
  // The just-seeded custom value. `current` derives from the committed style, which
  // lags a beat behind the write (and won't sync into the focused input), so the seed
  // drives the field until the user edits it or picks a segment.
  const [seed, setSeed] = useState<string | undefined>(undefined);
  const customMode = forceCustom || !supported.has(current);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const dropUp = useSegMenuClamp({ open, customMode, rootRef, menuRef });
  const { inputRef, requestFocus } = useSegCustomFocus({ customMode, busy });

  // Always commit — `current` may be a CSS default (unset) or an inherited value
  // from another selector, so clicking the shown segment must still apply it to the
  // picked selector (turning it blue), not be treated as a no-op.
  const pick = (next: string) => {
    setForceCustom(false);
    setSeed(undefined);
    setOpen(false);
    onCommit(next, false);
  };
  const enterCustom = (value: string) => {
    setOpen(false);
    requestFocus();
    setForceCustom(true);
    setSeed(value);
    onCommit(value, false);
  };

  return (
    <div ref={rootRef} className={`embed-editor_display ${customMode ? 'is-custom' : ''}`} role="group" aria-label={ariaLabel}>
      <SegmentPill />
      {customMode ? (
        <SegBarCustomInput bar={props} seed={seed} inputRef={inputRef} onSeedDone={() => setSeed(undefined)} onBackToBar={() => setForceCustom(false)} />
      ) : (
        <SegBarSegments
          segs={segs}
          current={current}
          ariaLabel={ariaLabel}
          busy={busy}
          onPick={pick}
          onMore={moreSegment ? () => enterCustom(moreValue) : undefined}
        />
      )}
      <SegBarMenu
        open={open}
        dropUp={dropUp}
        menuRef={menuRef}
        ariaLabel={ariaLabel}
        busy={busy}
        customMode={customMode}
        segs={segs}
        current={current}
        onToggle={() => setOpen((value) => !value)}
        onPick={pick}
        onEnterCustom={() => enterCustom(moreValue)}
      />
    </div>
  );
}

export type SegBarProps = {
  segs: readonly Seg[];
  /** The resolved value, already defaulted to a concrete segment when unset. */
  current: string;
  ariaLabel: string;
  /** The CSS property being edited — filters the custom-value variable picker. */
  prop: string;
  busy: boolean;
  onCommit: (value: string, important: boolean) => void;
  onLiveCommit: (value: string, important: boolean) => void;
  onClear: () => void;
  /** Append a full-size "…" segment that switches straight to a custom value
      (in addition to the dropdown arrow). */
  moreSegment?: boolean;
  /** Value seeded into the custom input when switching to custom — via the "…"
      segment or the dropdown's "Custom" item. Lets a control preset a sensible
      starting value (e.g. `2` for Order); defaults to `unset` (e.g. Align). */
  moreValue?: string;
};

// The free-value field of a bar in custom mode. Typing a value that matches a
// segment collapses back to the bar; clearing/emptying the field does too. Either
// way the seed override is done.
export function SegBarCustomInput({
  bar,
  seed,
  inputRef,
  onSeedDone,
  onBackToBar,
}: {
  bar: SegBarProps;
  seed: string | undefined;
  inputRef: React.RefObject<HTMLInputElement>;
  onSeedDone: () => void;
  onBackToBar: () => void;
}) {
  const translate = useTranslate();
  const supported = new Set(bar.segs.map((segment) => segment.value));
  return (
    <LiveInput
      value={seed ?? bar.current}
      busy={bar.busy}
      placeholder={translate('style.typographyKit.customValuePlaceholder')}
      ariaLabel={bar.ariaLabel}
      className="embed-editor_value-input embed-editor_display-input"
      prop={bar.prop}
      inputRef={inputRef}
      onCommit={(value, important) => {
        onSeedDone();
        if (supported.has(value.trim().toLowerCase())) {
          onBackToBar();
        }
        bar.onCommit(value, important);
      }}
      onLiveCommit={bar.onLiveCommit}
      onClear={() => {
        onBackToBar();
        onSeedDone();
        bar.onClear();
      }}
    />
  );
}

// The bar's segments, and the trailing "…" segment when the bar has one.
export function SegBarSegments({
  segs,
  current,
  ariaLabel,
  busy,
  onPick,
  onMore,
}: {
  segs: readonly Seg[];
  current: string;
  ariaLabel: string;
  busy: boolean;
  onPick: (value: string) => void;
  onMore: (() => void) | undefined;
}) {
  const translate = useTranslate();
  return (
    <>
      {segs.map((seg) => (
        <button
          key={seg.value}
          type="button"
          role="radio"
          aria-checked={current === seg.value}
          className={`embed-editor_display-seg ${current === seg.value ? 'is-selected' : ''}`}
          disabled={busy}
          aria-label={seg.label}
          title={seg.label}
          onClick={() => onPick(seg.value)}
        >
          {seg.icon}
        </button>
      ))}
      {onMore ? (
        <button
          type="button"
          className="embed-editor_display-seg"
          disabled={busy}
          aria-label={translate('style.typographyKit.customAria', { name: ariaLabel })}
          title={translate('style.typographyKit.customAria', { name: ariaLabel })}
          onClick={onMore}
        >
          <MoreIcon />
        </button>
      ) : undefined}
    </>
  );
}

// The dropdown arrow and its menu: "Custom" from the bar, or the segments to
// switch back to from a custom value.
export function SegBarMenu({
  open,
  dropUp,
  menuRef,
  ariaLabel,
  busy,
  customMode,
  segs,
  current,
  onToggle,
  onPick,
  onEnterCustom,
}: {
  open: boolean;
  dropUp: boolean;
  menuRef: React.RefObject<HTMLDivElement>;
  ariaLabel: string;
  busy: boolean;
  customMode: boolean;
  segs: readonly Seg[];
  current: string;
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
        aria-label={translate('style.typographyKit.moreOptions', { name: ariaLabel })}
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <Popup mode="popover" portal={false} onClose={onToggle} ref={menuRef} className={`embed-editor_display-menu ${dropUp ? 'is-up' : ''}`} role="menu">
          {customMode ? (
            segs.map((seg) => <MenuItem key={seg.value} label={seg.label} selected={current === seg.value} onClick={() => onPick(seg.value)} />)
          ) : (
            <MenuItem label={translate('style.typographyKit.custom')} selected={false} onClick={onEnterCustom} />
          )}
        </Popup>
      ) : undefined}
    </>
  );
}

// While the menu is open, a press outside the bar or Escape closes it.
export function useSegMenuClamp({
  open,
  customMode,
  rootRef,
  menuRef,
}: {
  open: boolean;
  customMode: boolean;
  rootRef: React.RefObject<HTMLDivElement>;
  menuRef: React.RefObject<HTMLDivElement>;
}): boolean {
  const [dropUp, setDropUp] = useState(false);
  useLayoutEffect(() => {
    const menu = menuRef.current;
    const root = rootRef.current;
    if (!open || !menu || !root) {
      return;
    }
    const margin = 8;
    const bounds = panelBounds(root);
    const rootRect = root.getBoundingClientRect();
    const naturalLeft = rootRect.right - menu.offsetWidth;
    const naturalRight = rootRect.right;
    const shift =
      naturalLeft < bounds.left + margin ? bounds.left + margin - naturalLeft : naturalRight > bounds.right - margin ? bounds.right - margin - naturalRight : 0;
    menu.style.transform = shift ? `translateX(${shift}px)` : '';
    const overflowsBelow = rootRect.bottom + menu.offsetHeight + margin > bounds.bottom;
    setDropUp(overflowsBelow && rootRect.top - bounds.top > bounds.bottom - rootRect.bottom);
  }, [open, customMode, rootRef, menuRef]);
  return dropUp;
}

// Focus the custom field after switching to Custom, once its seeded write
// settles: the request is remembered until the field exists and is enabled.
export function useSegCustomFocus({ customMode, busy }: { customMode: boolean; busy: boolean }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy]);
  return {
    inputRef,
    requestFocus: () => {
      wantFocus.current = true;
    },
  };
}

export const MoreIcon = centralIcon(centralMore);
