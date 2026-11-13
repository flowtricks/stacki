import { centralIcon } from '../../ui/central/CentralIcon';
import { crop as centralCrop, eye as centralEye, eyeOff as centralEyeOff } from '../../ui/central/centralGeometry';
import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useHighlight } from './model/computedStyle';
import type { Contributor } from './model/resolved';
import { ChevronIcon } from './components/MenuParts';
import { displayOf, displayText, type Display } from './model/styleDisplay';
import { type SetProp, type ClearProp, type LiveSetProp, type Props, SizeLabel, LivePropField, LENGTH_FIELDS } from './SizeKit';
import { type SegmentBarConfig, SegmentBar } from './SizeSegmentBar';
import { AspectRatioField } from './AspectRatioField';
import { ImageFitField } from './ObjectFitFields';
import { useTranslate, useTranslateRich } from '../../lib/i18n/useTranslate';
import type { MessageKey, Translator } from '../../lib/i18n/localeContext';
import type { RichTranslator } from '../../lib/i18n/translateRich';

export { RatioOtherInput } from './AspectRatioField';

// The Size section of the style panel. Every control is always rendered (Webflow
// parity), driven by the resolved model: a property is blue when the picked
// selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type
// (liveSetProp) and run the authoritative commit on blur. All writes target the
// picked selector (creating its rule on first edit, handled by the parent).

// ─────────────────────────── Overflow ───────────────────────────

const ShowIcon = centralIcon(centralEye);
const HideIcon = centralIcon(centralEyeOff);
const CropIcon = centralIcon(centralCrop);
const SCROLL_ICON_FOURTH_PATH = 'M12 11.2929L10.3536 9.64645L9.64645 10.3536L12.5 13.2071L15.3536 10.3536L14.6464 9.64645' + 'L13 11.2929V5H12V11.2929Z';

function ScrollIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path opacity="0.3" d="M3 3H8V11H3V3Z" fill="currentColor" />
      <g opacity="0.67">
        <path d="M1 2H15V3L1 3V2Z" fill="currentColor" />
        <path d="M1 11H8V12H1V11Z" fill="currentColor" />
        <path d={SCROLL_ICON_FOURTH_PATH} fill="currentColor" />
      </g>
    </svg>
  );
}

// Icon segments matching Webflow's overflow control (Auto is text). Reuses the
// display control's segmented-bar CSS.
const strongMark = (text: ReactNode) => <strong>{text}</strong>;

const OVERFLOW_SEGS: ReadonlyArray<{ value: string; icon?: ReactNode; labelKey: MessageKey; tooltipKey: MessageKey }> = [
  { value: 'visible', icon: <ShowIcon />, labelKey: 'style.sizeSection.visible', tooltipKey: 'style.sizeSection.tooltipVisible' },
  { value: 'hidden', icon: <HideIcon />, labelKey: 'style.sizeSection.hidden', tooltipKey: 'style.sizeSection.tooltipHidden' },
  { value: 'clip', icon: <CropIcon />, labelKey: 'style.sizeSection.clip', tooltipKey: 'style.sizeSection.tooltipClip' },
  { value: 'scroll', icon: <ScrollIcon />, labelKey: 'style.sizeSection.scroll', tooltipKey: 'style.sizeSection.tooltipScroll' },
  { value: 'auto', labelKey: 'style.sizeSection.auto', tooltipKey: 'style.sizeSection.tooltipAuto' },
];
const OVERFLOW_VALUES = OVERFLOW_SEGS.map((seg) => seg.value);
// Segmented icon bar (visible/hidden/clip/scroll/auto) + a dropdown arrow whose
// menu offers Custom; a free value shows the editable field. Mirrors DisplayControl.
// No overflow set → CSS defaults to `visible`, so that segment shows as active.
function overflowBar(translateRich: RichTranslator, translate: Translator): SegmentBarConfig {
  return {
    segments: OVERFLOW_SEGS.map((seg) => ({
      value: seg.value,
      content: seg.icon ?? translate(seg.labelKey),
      ariaLabel: translate(seg.labelKey),
      menuLabel: translate(seg.labelKey),
    })),
    fallback: 'visible',
    tooltips: Object.fromEntries(OVERFLOW_SEGS.map((seg) => [seg.value, translateRich(seg.tooltipKey, { strong: strongMark })])),
    groupLabel: translate('style.sizeSection.overflow'),
    moreLabel: translate('style.sizeSection.moreOverflowOptions'),
    customLabel: translate('style.sizeSection.overflowValue'),
  };
}

// One overflow control row bound to a single property. `fallback` is the value it
// shows when its own longhand isn't set (the main `overflow` value), so Overflow
// X / Y mirror the shorthand until overridden.
function OverflowRow({
  label,
  prop,
  display,
  contributors,
  fallback,
  toggle,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: {
  label: string;
  prop: string;
  display: Display;
  contributors: Contributor[];
  fallback: string;
  /** Optional disclosure control rendered next to the label (main row only). */
  toggle?: ReactNode;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  // Nothing authored here → the page's own computed overflow, then the caller's
  // fallback (the shorthand's value, for the X / Y rows).
  // A flagged value carries its `!important` in the text, so the bar opens its
  // custom field and shows it, as every segmented bar does (SizeSegmentBar.tsx).
  const value = useHighlight(display.present ? displayText(display).toLowerCase() : fallback || '', prop, OVERFLOW_VALUES, '');
  const labelElement = (
    <SizeLabel
      label={label}
      prop={prop}
      display={{ ...display, value, important: false }}
      contributors={contributors}
      busy={busy}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
  return (
    <div className="embed-editor_size-row">
      {toggle ? (
        <div className="embed-editor_overflow-head">
          {labelElement}
          {toggle}
        </div>
      ) : (
        labelElement
      )}
      <SegmentBar
        config={overflowBar(translateRich, translate)}
        value={value}
        busy={busy}
        onCommit={(next, important) => setProp(prop, next, important)}
        onLiveCommit={(next, important) => liveSetProp(prop, next, important)}
        onClear={() => clearProp(prop)}
      />
    </div>
  );
}

function OverflowField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const translate = useTranslate();
  const shorthand = displayOf(read('overflow'));
  const x = displayOf(read('overflow-x'));
  const y = displayOf(read('overflow-y'));
  // The main overflow value drives Overflow X / Y until they're individually set.
  const mainValue = shorthand.present ? shorthand.value.toLowerCase() : '';
  const rowProps = { busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector };

  // Overflow X / Y hide behind a disclosure, opened by default when either is set.
  const [expanded, setExpanded] = useState(x.present || y.present);
  useEffect(() => {
    if (x.present || y.present) {
      setExpanded(true);
    }
  }, [x.present, y.present]);

  const toggle = (
    <button
      type="button"
      className={`embed-editor_overflow-toggle ${expanded ? 'is-open' : ''}`}
      onClick={() => setExpanded((open) => !open)}
      aria-expanded={expanded}
      aria-label={expanded ? translate('style.sizeSection.hideAxes') : translate('style.sizeSection.showAxes')}
      title={translate('style.sizeSection.perAxis')}
    >
      <ChevronIcon />
    </button>
  );

  return (
    <>
      <OverflowRow
        label={translate('style.sizeSection.overflow')}
        prop="overflow"
        display={shorthand}
        contributors={read('overflow')?.contributors ?? []}
        fallback=""
        toggle={toggle}
        {...rowProps}
      />
      {expanded ? (
        <>
          <OverflowRow
            label={translate('style.sizeSection.overflowX')}
            prop="overflow-x"
            display={x}
            contributors={read('overflow-x')?.contributors ?? []}
            fallback={mainValue}
            {...rowProps}
          />
          <OverflowRow
            label={translate('style.sizeSection.overflowY')}
            prop="overflow-y"
            display={y}
            contributors={read('overflow-y')?.contributors ?? []}
            fallback={mainValue}
            {...rowProps}
          />
        </>
      ) : undefined}
    </>
  );
}

// ─────────────────────────── Box sizing ───────────────────────────

const BORDER_BOX_ICON_FIRST_PATH =
  'M4 5C3.44772 5 3 5.44772 3 6V10C3 10.5523 3.44772 11 4 11H12C12.5523 11 13 10.5523 13 10V6' + 'C13 5.44772 12.5523 5 12 5H4ZM12 6H4V10H12V6Z';
const BORDER_BOX_ICON_SECOND_PATH =
  'M4 2C3.44772 2 3 2.44772 3 3V13C3 13.5523 3.44772 14 4 14H12C12.5523 14 13 13.5523 13 13V3' + 'C13 2.44772 12.5523 2 12 2H4ZM12 3H4V13H12V3Z';

function BorderBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={BORDER_BOX_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={BORDER_BOX_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
const CONTENT_BOX_ICON_FIRST_PATH =
  'M3 5C2.44772 5 2 5.44772 2 6V10C2 10.5523 2.44772 11 3 11H13C13.5523 11 14 10.5523 14 10V6' + 'C14 5.44772 13.5523 5 13 5H3ZM13 6H3L3 10H13V6Z';
const CONTENT_BOX_ICON_SECOND_PATH =
  'M3 2C2.44772 2 2 2.44772 2 3V13C2 13.5523 2.44772 14 3 14H10C10.5523 14 11 13.5523 11 13V3' + 'C11 2.44772 10.5523 2 10 2H3ZM10 3H3L3 13H10V3Z';

function ContentBoxIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={CONTENT_BOX_ICON_FIRST_PATH} fill="currentColor" />
      <path opacity="0.4" fillRule="evenodd" clipRule="evenodd" d={CONTENT_BOX_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}

const BOX_OPTIONS: ReadonlyArray<{ value: string; icon: ReactNode; labelKey: MessageKey; tooltipKey: MessageKey }> = [
  { value: 'border-box', icon: <BorderBoxIcon />, labelKey: 'style.sizeSection.borderBox', tooltipKey: 'style.sizeSection.tooltipBorderBox' },
  { value: 'content-box', icon: <ContentBoxIcon />, labelKey: 'style.sizeSection.contentBox', tooltipKey: 'style.sizeSection.tooltipContentBox' },
];
// Segmented icon bar (border-box / content-box) + a dropdown arrow whose menu offers
// Custom; a free value (`inherit`, `unset`, var(…)…) shows the editable field — the
// same bar as Overflow, so box-sizing matches the Overflow / Display controls. No
// box-sizing set → Webflow assumes border-box, so that segment shows as active.
function boxSizingBar(translateRich: RichTranslator, translate: Translator): SegmentBarConfig {
  return {
    segments: BOX_OPTIONS.map((option) => ({
      value: option.value,
      content: option.icon,
      ariaLabel: translate(option.labelKey),
      menuLabel: translate(option.labelKey),
    })),
    fallback: 'border-box',
    tooltips: Object.fromEntries(BOX_OPTIONS.map((option) => [option.value, translateRich(option.tooltipKey, { strong: strongMark })])),
    groupLabel: translate('style.sizeSection.boxSizing'),
    moreLabel: translate('style.sizeSection.moreBoxSizingOptions'),
    customLabel: translate('style.sizeSection.boxSizingValue'),
  };
}

function BoxSizingField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const translate = useTranslate();
  const translateRich = useTranslateRich();
  const display = displayOf(read('box-sizing'));
  return (
    <div className="embed-editor_size-row">
      <SizeLabel
        label={translate('style.sizeSection.boxSize')}
        prop="box-sizing"
        display={display}
        contributors={read('box-sizing')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('box-sizing')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentBar
        config={boxSizingBar(translateRich, translate)}
        value={displayText(display)}
        busy={busy}
        onCommit={(next, important) => setProp('box-sizing', next, important)}
        onLiveCommit={(next, important) => liveSetProp('box-sizing', next, important)}
        onClear={() => clearProp('box-sizing')}
      />
    </div>
  );
}

// ─────────────────────────── Section ───────────────────────────

export default function SizeSection(props: Props) {
  const translate = useTranslate();
  return (
    <div className="embed-editor_size">
      <div className="embed-editor_size-grid">
        {LENGTH_FIELDS.map((field) => (
          <Fragment key={field.prop}>
            <LivePropField prop={field.prop} label={translate(field.labelKey)} placeholder={field.placeholder} {...props} />
          </Fragment>
        ))}
      </div>
      <OverflowField {...props} />
      <AspectRatioField {...props} />
      <BoxSizingField {...props} />
      <ImageFitField {...props} />
    </div>
  );
}
