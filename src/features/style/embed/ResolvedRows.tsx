import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { MessageKey } from '../../../../shared/properties/i18n/messageRef';
import { centralIcon } from '../../../ui/central/CentralIcon';
import { chevronDown as centralChevronDown } from '../../../ui/central/centralGeometry';
// How a resolved property is shown: the section block, the provenance
// popover, a resolved row with its label and value, and the display and
// vertical-align rows (EmbedEditor.tsx).

const ChevronDownGlyph = centralIcon(centralChevronDown, 12);

import { useRef } from 'react';
import Popup from '../../../ui/Popup';
import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import FieldLabel from '../components/FieldLabel';
import { PropTip, ProvenanceLabel } from '../components/CssPropertyTip';
import Select, { type SelectOption } from '../components/Select';
import DisplayControl, { DISPLAY_VALUES } from '../DisplayControl';
import { useAnchoredPosition } from '../components/provenancePosition';
export { useAnchoredPosition } from '../components/provenancePosition';
import { useHighlight } from '../model/computedStyle';
import ProvenanceList from '../ProvenanceList';
import { type ResolvedProp } from '../model/resolved';
import { splitTopLevelSpaces } from '../model/background';
import { type LiveSetProp } from './EditorBasics';
import { ValueField } from './AddProperty';
import { keepImportant } from '../model/styleDisplay';
import ImportantMark from '../components/ImportantMark';

// A collapsible section header (Webflow's chevron + label) wrapping a group of
// controls. Visibility is owned by the card so Shift-click can apply one
// header's next state to every section without a document-wide event channel.
export function SectionBlock({
  label,
  headerAction,
  open,
  mark,
  onToggle,
  children,
}: {
  readonly label: string;
  readonly headerAction?: ReactNode;
  readonly open: boolean;
  readonly mark?: 'own' | 'other' | undefined;
  readonly onToggle: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  readonly children: ReactNode;
}) {
  const translate = useTranslate();
  return (
    <div className={`embed-editor_section-block ${open ? '' : 'is-collapsed'}`}>
      {/* A row (not one big button) so an optional action can sit next to the chevron
          without nesting a button inside a button. */}
      <div className="embed-editor_section-header">
        <button type="button" className="embed-editor_section-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="embed-editor_section-title">{label}</span>
        </button>
        {headerAction}
        {/* Only while closed, and beside the chevron rather than the label, so the
            right edge of every header reads as one column: what is in here, then
            open/closed. Open, the property labels inside are already saying it in
            these same two colours — orange for anything reaching the element at
            all, blue once the picked selector is one of the things setting it —
            and the dot would only be repeating them. */}
        {!open && mark ? (
          <span
            className={`embed-editor_section-dot ${mark === 'own' ? 'is-own' : ''}`}
            role="img"
            aria-label={translate(mark === 'own' ? 'styleModel.embed.row.hasOwnStyles' : 'styleModel.embed.row.hasOtherStyles', { label })}
            title={translate(mark === 'own' ? 'styleModel.embed.row.setOnThis' : 'styleModel.embed.row.setOnOther')}
          />
        ) : undefined}
        <button
          type="button"
          className="embed-editor_section-chevron-btn"
          aria-expanded={open}
          aria-label={translate(open ? 'styleModel.embed.row.collapse' : 'styleModel.embed.row.expand', { label })}
          onClick={onToggle}
        >
          <ChevronDownGlyph className="embed-editor_section-chevron" />
        </button>
      </div>
      {open ? <div className="embed-editor_section-body">{children}</div> : undefined}
    </div>
  );
}

// ─────────────────────────── Provenance popover ───────────────────────────

// Lists every selector that sets an "orange" property (applied through a selector
// other than the picked one): its value + the cascade winner, so you can see who
// wins and where a style comes from.
export function ProvenancePopover({
  prop,
  anchor,
  resolved,
  onClose,
  onSelectSelector,
}: {
  prop: string;
  anchor: DOMRect;
  resolved: ResolvedProp;
  onClose: () => void;
  onAnchorReclick: (prop: string) => void;
  onSelectSelector: (selectorText: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement>(null);
  const headerLabel = prop;
  const position = useAnchoredPosition(ref, anchor);

  return (
    <Popup
      mode="popover"
      onClose={onClose}
      ref={ref}
      className="embed-editor_provenance"
      role="dialog"
      label={translate('styleModel.embed.row.selectorsSetting', { property: headerLabel })}
      style={{ left: position.left, top: position.top }}
    >
      <div className="embed-editor_provenance-head">
        <code>{headerLabel}</code>
        <button type="button" className="embed-editor_icon-btn" onClick={onClose} aria-label={translate('ui.close')}>
          ✕
        </button>
      </div>
      <ProvenanceList
        contributors={resolved.contributors}
        prop={prop}
        onSelect={(selector, selectedProp) => {
          onSelectSelector(selector, selectedProp);
          onClose();
        }}
      />
    </Popup>
  );
}

// ─────────────────────────── Resolved property row ───────────────────────────

// A generic property row from the resolved model: blue when the picked selector
// sets it (editable + removable), orange when another selector does (value from
// the cascade winner; clicking the label opens provenance; editing it adds the
// property to the picked selector — turning it blue).
export function ResolvedRow({
  prop,
  resolved,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  resolved: ResolvedProp;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const isSelected = resolved.source === 'selected';
  const display = isSelected && resolved.selectedValue ? resolved.selectedValue : { value: resolved.winner.value, important: resolved.winner.important };
  const isDisplay = prop === 'display';

  return (
    <div className={`embed-editor_decl ${isDisplay ? 'is-control' : ''}`}>
      <ResolvedRowLabel prop={prop} resolved={resolved} busy={busy} clearProp={clearProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      {isDisplay ? (
        <DisplayControl value={display.value} important={display.important} busy={busy} onCommit={(value, important) => setProp(prop, value, important)} />
      ) : (
        <ValueField
          prop={prop}
          value={display.value}
          important={display.important}
          busy={busy}
          onCommit={(value, important) => setProp(prop, value, important)}
          onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
          onPick={(binding) => {
            const kept = keepImportant(binding, display);
            setProp(prop, kept.value, kept.important);
          }}
        />
      )}
    </div>
  );
}

// A resolved row's label: blue and clearable when the picked selector sets the
// property, else an orange button that opens its provenance.
export function ResolvedRowLabel({
  prop,
  resolved,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  prop: string;
  resolved: ResolvedProp;
  busy: boolean;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  if (resolved.source !== 'selected') {
    return (
      <button
        type="button"
        className="embed-editor_prop-label embed-editor_prop-orange"
        disabled={busy}
        title={translate('styleModel.embed.row.setBy', { selector: resolved.winner.selectorText })}
        onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}
      >
        {prop}
      </button>
    );
  }
  return (
    <FieldLabel
      className={'embed-editor_prop-label is-blue ' + (resolved.overridden ? 'is-overridden' : '')}
      active
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel={translate('styleModel.embed.row.removeProperty')}
      {...(resolved.overridden ? { title: translate('styleModel.embed.row.overriddenBy', { selector: resolved.winner.selectorText }) } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved.contributors}
          prop={prop}
          onSelect={(selector, selectedProp) => {
            onSelectSelector(selector, selectedProp);
            close();
          }}
        />
      )}
    >
      {prop}
    </FieldLabel>
  );
}

// The size-row label for a property that is always shown: dim when nothing sets it,
// blue and clearable when the picked selector does (flagged when overridden), orange
// with provenance when another selector does.
export function SizeRowLabel({
  label,
  prop,
  resolved,
  busy,
  showOverride,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  resolved: ResolvedProp | undefined;
  busy: boolean;
  /** Mark (and title) the blue label when a more specific selector overrides it. */
  showOverride: boolean;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  if (!resolved) {
    return (
      <FieldLabel className="embed-editor_size-label" active={false} disabled={busy} onReset={() => {}} tooltip={<PropTip props={[prop]} />}>
        {label}
      </FieldLabel>
    );
  }
  if (resolved.source !== 'selected') {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  const overridden = showOverride && resolved.overridden;
  return (
    <FieldLabel
      className={overridden ? 'embed-editor_size-label is-overridden' : 'embed-editor_size-label'}
      active
      disabled={busy}
      onReset={() => clearProp(prop)}
      resetLabel={translate('styleModel.embed.row.removeProperty')}
      tooltip={<PropTip props={[prop]} />}
      {...(overridden ? { title: translate('styleModel.embed.row.overriddenBy', { selector: resolved.winner.selectorText }) } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved.contributors}
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

// The Display control is always shown (Webflow parity), even when no selector
// sets `display`. In that case it shows what the PAGE computes for the element —
// a `<span>` reads inline, a flex child of a component-authored rule reads what
// that rule says — falling back to `block` when there's no canvas to ask. The
// label stays dim either way, to signal it isn't set here.
export function DisplayRow({
  resolved,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  resolved: ResolvedProp | undefined;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const isSelected = resolved?.source === 'selected';
  // Nothing declared → what the page renders as, held steady while it is asked
  // rather than guessed at (see useHighlight).
  const shown = useHighlight('', resolved ? '' : 'display', DISPLAY_VALUES, 'block');
  const current = resolved
    ? isSelected && resolved.selectedValue
      ? resolved.selectedValue
      : { value: resolved.winner.value, important: resolved.winner.important }
    : { value: shown, important: false };
  return (
    <div className="embed-editor_size-row">
      <SizeRowLabel
        label={translate('styleModel.embed.row.display')}
        prop="display"
        resolved={resolved}
        busy={busy}
        showOverride={false}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <DisplayControl value={current.value} important={current.important} busy={busy} onCommit={(value, important) => setProp('display', value, important)} />
    </div>
  );
}

// Align Y = `vertical-align`. It only affects inline-level / table-cell boxes, so
// the whole row dims (but stays editable) when Display isn't one of those. Values
// mirror Webflow's dropdown.
// The labels stay English here (search, logs); VALIGN_LABEL_KEYS gives what the Select shows.
export const VALIGN_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'baseline', label: 'Baseline' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'sub', label: 'Sub' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'super', label: 'Super' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'top', label: 'Top' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'text-top', label: 'Text top' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'middle', label: 'Middle' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'bottom', label: 'Bottom' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
  { value: 'text-bottom', label: 'Text bottom' }, // i18n-ignore: English next to VALIGN_LABEL_KEYS.
];
export const VALIGN_LABEL_KEYS: Readonly<Record<string, MessageKey>> = {
  baseline: 'styleModel.embed.row.valign.baseline',
  sub: 'styleModel.embed.row.valign.sub',
  super: 'styleModel.embed.row.valign.super',
  top: 'styleModel.embed.row.valign.top',
  'text-top': 'styleModel.embed.row.valign.textTop',
  middle: 'styleModel.embed.row.valign.middle',
  bottom: 'styleModel.embed.row.valign.bottom',
  'text-bottom': 'styleModel.embed.row.valign.textBottom',
};
export const VALIGN_VALUES = new Set(VALIGN_OPTIONS.map((option) => option.value));
// Display values for which `vertical-align` actually applies (else the row dims).
export const VALIGN_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'table-cell']);

export function VerticalAlignRow({
  resolved,
  dimmed,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: {
  resolved: ResolvedProp | undefined;
  /** Display isn't inline/table-cell — fade the row but keep it editable. */
  dimmed: boolean;
  busy: boolean;
  setProp: (prop: string, value: string, important: boolean) => void;
  clearProp: (prop: string | string[]) => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const prop = 'vertical-align';
  const isSelected = resolved?.source === 'selected';
  const effective = resolved ? (isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner) : undefined;
  const raw = effective ? effective.value.trim() : '';
  const matched = VALIGN_VALUES.has(raw.toLowerCase()) ? raw.toLowerCase() : undefined;

  // Surface a pre-existing non-preset value (e.g. a length) as a trailing option so
  // the trigger reflects it instead of silently snapping back to Baseline.
  const shownOptions = VALIGN_OPTIONS.map((option) => {
    const key = VALIGN_LABEL_KEYS[option.value];
    return key === undefined ? option : { ...option, label: translate(key) };
  });
  const options: SelectOption<string>[] = matched === undefined && raw ? [...shownOptions, { value: raw, label: raw }] : [...shownOptions];
  // No custom field: a flagged value is marked, and a pick keeps the flag.
  const important = effective?.important ?? false;
  const pick = (value: string) => setProp(prop, value, important);

  return (
    <div className={`embed-editor_size-row ${dimmed ? 'is-inactive' : ''}`} title={dimmed ? translate('styleModel.embed.row.alignYApplies') : undefined}>
      <SizeRowLabel
        label={translate('styleModel.embed.row.alignY')}
        prop={prop}
        resolved={resolved}
        busy={busy}
        showOverride
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <ImportantMark important={important}>
        <Select value={matched ?? (raw || 'baseline')} options={options} onChange={pick} ariaLabel={translate('styleModel.embed.row.alignY')} disabled={busy} />
      </ImportantMark>
    </div>
  );
}

// The effective (winner, else selected) value of a resolved prop, lowercased.
// Whether a value is one the property will actually accept (via CSS.supports).
// Gates LIVE writes so a half-typed / invalid value is never pushed at Webflow's
// native style API (which errors and gets stuck). var()/custom props pass; fails
// open only when CSS.supports is unavailable.
export function isSupportedCssValue(prop: string, value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    return true;
  }
  try {
    return CSS.supports(prop, trimmed);
  } catch {
    return false;
  }
}

export function effectiveValue(resolved: ResolvedProp | undefined): string {
  if (!resolved) {
    return '';
  }
  const effective = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue.value : resolved.winner.value;
  return effective.trim().toLowerCase();
}

// The effective raw value + !important flag (not lowercased) — for free-value fields.
export function rawEffective(resolved: ResolvedProp | undefined): {
  value: string;
  important: boolean;
} {
  if (!resolved) {
    return { value: '', important: false };
  }
  const effective = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return { value: effective.value, important: effective.important };
}

// The current flex flow as a normalized `<direction> [wrap]` string (matching the
// Direction control's option values). Prefers the `flex-direction` / `flex-wrap`
// longhands (what the control writes), falling back to any legacy `flex-flow`
// shorthand for each axis. `nowrap` is omitted (e.g. just `row`).
export const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];
export const FLEX_WRAPS = ['nowrap', 'wrap', 'wrap-reverse'];
export function currentFlexFlow(read: (prop: string) => ResolvedProp | undefined): string {
  let direction = 'row';
  let wrap = 'nowrap';
  const flowTokens = splitTopLevelSpaces(effectiveValue(read('flex-flow')));
  const directionValue = effectiveValue(read('flex-direction'));
  const wr = effectiveValue(read('flex-wrap'));
  if (FLEX_DIRECTIONS.includes(directionValue)) {
    direction = directionValue;
  } else {
    const directionToken = flowTokens.find((token) => FLEX_DIRECTIONS.includes(token));
    if (directionToken) {
      direction = directionToken;
    }
  }
  if (FLEX_WRAPS.includes(wr)) {
    wrap = wr;
  } else {
    const wrapToken = flowTokens.find((token) => FLEX_WRAPS.includes(token));
    if (wrapToken) {
      wrap = wrapToken;
    }
  }
  return wrap === 'nowrap' ? direction : `${direction} ${wrap}`;
}

// Layout props owned by dedicated controls (Display + Direction + Gap) — kept out of the
// generic property-row list so they aren't shown twice. Gap covers all three spellings:
// the modern longhands, the legacy `grid-*` aliases, and the shorthand — otherwise a rule
// using `row-gap` got a second, generic row for it beside the Gap control.
export const LAYOUT_CONTROL_PROPS = new Set([
  'display',
  'vertical-align',
  'flex-flow',
  'flex-direction',
  'flex-wrap',
  'gap',
  'row-gap',
  'column-gap',
  'grid-gap',
  'grid-row-gap',
  'grid-column-gap',
]);

// Properties that can only apply as raw CSS — Webflow exposes no Designer API to
// populate its native Transitions UI, so `transition` (and its longhands) always
// write to the embed (custom code) rather than the native class.
export const EMBED_ONLY_PROPS = new Set(['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay']);
// Effects props owned by dedicated controls in EffectsSection — kept out of the
// generic fall-through rows (like TYPOGRAPHY_CONTROL_PROPS).
export const EFFECTS_CONTROL_PROPS = new Set([
  'mix-blend-mode',
  'opacity',
  'outline-style',
  'outline-width',
  'outline-offset',
  'outline-color',
  'box-shadow',
  'transform',
  'filter',
  'backdrop-filter',
  'clip-path',
  '-webkit-clip-path',
  'cursor',
  'pointer-events',
  // The Transitions layered editor owns the shorthand + all its longhands.
  'transition',
  'transition-property',
  'transition-duration',
  'transition-timing-function',
  'transition-delay',
  'transition-behavior',
]);

// Typography props owned by dedicated controls in TypographySection — kept out of the
// generic row list. Anything else in the section (text-shadow, -webkit-text-stroke,
// …) still renders as a generic row below.
export const TYPOGRAPHY_CONTROL_PROPS = new Set([
  'font-family',
  'font-weight',
  'font-size',
  'line-height',
  'color',
  'text-align',
  'letter-spacing',
  'text-indent',
  'column-count',
  'font-style',
  'text-transform',
  'direction',
  // The Decor bar + its "…" popover (line via the shorthand; thickness / skip-ink longhands).
  'text-decoration',
  'text-decoration-line',
  'text-decoration-style',
  'text-decoration-color',
  'text-decoration-thickness',
  'text-decoration-skip-ink',
  // The Breaking row (Word / Line dropdowns) + the Wrap row.
  'word-break',
  'white-space',
  'overflow-wrap',
  // The multi-column "…" popover (Gap / divider rule / span).
  'column-gap',
  'column-rule-style',
  'column-rule-width',
  'column-rule-color',
  'column-span',
  // The Truncate / Stroke / Text-shadows rows.
  'text-overflow',
  '-webkit-text-stroke',
  '-webkit-text-stroke-width',
  '-webkit-text-stroke-color',
  'text-shadow',
]);
