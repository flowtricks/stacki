import { Fragment, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useHighlight } from './model/computedStyle';
import { type SegmentedOption } from './components/SegmentedControl';
import type { Contributor } from './model/resolved';
import { ChevronIcon } from './components/MenuParts';
import { displayOf, displayText, type Display } from './model/styleDisplay';
import { type SetProp, type ClearProp, type LiveSetProp, type Props, SizeLabel, LivePropField, LENGTH_FIELDS } from './SizeKit';
import { type SegmentBarConfig, SegmentBar } from './SizeSegmentBar';
import { AspectRatioField } from './AspectRatioField';
import { ImageFitField } from './ObjectFitFields';

export { RatioOtherInput } from './AspectRatioField';

// The Size section of the style panel. Every control is always rendered (Webflow
// parity), driven by the resolved model: a property is blue when the picked
// selector sets it, orange when another selector does (click the label for
// provenance), or empty when unset. Text fields update the CSS live as you type
// (liveSetProp) and run the authoritative commit on blur. All writes target the
// picked selector (creating its rule on first edit, handled by the parent).

// ─────────────────────────── Overflow ───────────────────────────

const SHOW_ICON_FIRST_PATH =
  'M8 9.5C8.82843 9.5 9.5 8.82843 9.5 8C9.5 7.17157 8.82843 6.5 8 6.5' + 'C7.17157 6.5 6.5 7.17157 6.5 8C6.5 8.82843 7.17157 9.5 8 9.5Z';
const SHOW_ICON_SECOND_PATH =
  'M8.00004 4C5.37598 4 3.11613 5.55492 2.08964 7.79148' +
  'C2.02887 7.92388 2.02888 8.07621 2.08965 8.20861C3.11615 10.4451 5.37597 12 8.00001 12' +
  'C10.6241 12 12.8839 10.4451 13.9104 8.20852' +
  'C13.9712 8.07612 13.9712 7.92379 13.9104 7.79139C12.8839 5.55488 10.6241 4 8.00004 4Z' +
  'M8.00001 11C5.86346 11 4.01048 9.78173 3.09961 8.00004C4.01047 6.21831 5.86347 5 8.00004 5' +
  'C10.1366 5 11.9896 6.21827 12.9004 7.99996C11.9896 9.78169 10.1366 11 8.00001 11Z';

function ShowIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={SHOW_ICON_FIRST_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={SHOW_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
const HIDE_ICON_FIRST_PATH =
  'M10.705 11.4122L13.6465 14.3536L14.3536 13.6465L2.35356 1.64648L1.64645 2.35359' +
  'L4.3881 5.09524C3.39355 5.76124 2.5932 6.69436 2.08965 7.79152' +
  'C2.02888 7.92392 2.02888 8.07624 2.08965 8.20865C3.11616 10.4452 5.37598 12 8.00001 12' +
  'C8.9654 12 9.8815 11.7896 10.705 11.4122ZM9.94073 10.6479L5.11152 5.81865' +
  'C4.25765 6.3466 3.55888 7.10172 3.09962 8.00007C4.01049 9.78177 5.86347 11 8.00001 11' +
  'C8.68308 11 9.33716 10.8755 9.94073 10.6479Z';
const HIDE_ICON_SECOND_PATH =
  'M13.9104 8.20856C13.5777 8.93353 13.1154 9.58688 12.5531 10.1389L11.846 9.43184' +
  'C12.2702 9.01685 12.6276 8.5337 12.9004 8C11.9896 6.21831 10.1366 5.00004 8.00005 5.00004' +
  'C7.81174 5.00004 7.62562 5.0095 7.44217 5.02798L6.57167 4.15749' +
  'C7.03127 4.05443 7.50929 4.00004 8.00005 4.00004' +
  'C10.6241 4.00004 12.8839 5.55491 13.9104 7.79143' +
  'C13.9712 7.92383 13.9712 8.07616 13.9104 8.20856Z';

function HideIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={HIDE_ICON_FIRST_PATH} fill="currentColor" />
      <path d={HIDE_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
const CROP_ICON_PATH = 'M12 12C12.5523 12 13 11.5523 13 11V5H15.5V4H13V1.5H12V4H5C4.44772 4 4 4.44772 4 5V11H1.5' + 'V12H4V14.5H5V12H12ZM5 11H12V5H5V11Z';

function CropIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d={CROP_ICON_PATH} fill="currentColor" />
    </svg>
  );
}
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
const OVERFLOW_SEGS: ReadonlyArray<{ value: string; icon?: ReactNode; label: string }> = [
  { value: 'visible', icon: <ShowIcon />, label: 'Visible' },
  { value: 'hidden', icon: <HideIcon />, label: 'Hidden' },
  { value: 'clip', icon: <CropIcon />, label: 'Clip' },
  { value: 'scroll', icon: <ScrollIcon />, label: 'Scroll' },
  { value: 'auto', label: 'Auto' },
];
const OVERFLOW_VALUES = OVERFLOW_SEGS.map((seg) => seg.value);
const OVERFLOW_TOOLTIPS: Record<string, ReactNode> = {
  visible: (
    <>
      <strong>Visible</strong> shows content that overflows its container.
    </>
  ),
  hidden: (
    <>
      <strong>Hidden</strong> hides overflowing content without adding a scrollbar.
    </>
  ),
  clip: (
    <>
      <strong>Clip</strong> clips content to the element's padding box, similar to <strong>hidden</strong>, but it also prevents any scrolling of the overflowed
      content, including programmatic scrolling.
    </>
  ),
  scroll: (
    <>
      <strong>Scroll</strong> always displays a scrollbar for overflowing content.
    </>
  ),
  auto: (
    <>
      <strong>Auto</strong> only displays a scrollbar when content overflows.
    </>
  ),
};

// Segmented icon bar (visible/hidden/clip/scroll/auto) + a dropdown arrow whose
// menu offers Custom; a free value shows the editable field. Mirrors DisplayControl.
// No overflow set → CSS defaults to `visible`, so that segment shows as active.
const OVERFLOW_BAR: SegmentBarConfig = {
  segments: OVERFLOW_SEGS.map((seg) => ({
    value: seg.value,
    content: seg.icon ?? seg.label,
    ariaLabel: seg.label,
    menuLabel: seg.label,
  })),
  fallback: 'visible',
  tooltips: OVERFLOW_TOOLTIPS,
  groupLabel: 'Overflow',
  moreLabel: 'More overflow options',
  customLabel: 'Overflow value',
};

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
        config={OVERFLOW_BAR}
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
      aria-label={expanded ? 'Hide overflow X and Y' : 'Show overflow X and Y'}
      title="Per-axis overflow (X / Y)"
    >
      <ChevronIcon />
    </button>
  );

  return (
    <>
      <OverflowRow
        label="Overflow"
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
            label="Overflow X"
            prop="overflow-x"
            display={x}
            contributors={read('overflow-x')?.contributors ?? []}
            fallback={mainValue}
            {...rowProps}
          />
          <OverflowRow
            label="Overflow Y"
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

const BOX_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  {
    value: 'border-box',
    label: <BorderBoxIcon />,
    ariaLabel: 'Border box',
    tooltip: (
      <>
        <strong>Border-box</strong> makes the width and height of the element include the content, padding, and border. The overall dimensions of the box do not
        increase regardless of padding and border sizes.
      </>
    ),
  },
  {
    value: 'content-box',
    label: <ContentBoxIcon />,
    ariaLabel: 'Content box',
    tooltip: (
      <>
        <strong>Content-box</strong> makes the width and height of the element include only the content. Padding and border sizes are added to the outside of
        the box's dimensions.
      </>
    ),
  },
];
// Segmented icon bar (border-box / content-box) + a dropdown arrow whose menu offers
// Custom; a free value (`inherit`, `unset`, var(…)…) shows the editable field — the
// same bar as Overflow, so box-sizing matches the Overflow / Display controls. No
// box-sizing set → Webflow assumes border-box, so that segment shows as active.
const BOX_SIZING_BAR: SegmentBarConfig = {
  segments: BOX_OPTIONS.map((option) => ({
    value: option.value,
    content: option.label,
    ariaLabel: option.ariaLabel ?? option.value,
    menuLabel: option.ariaLabel ?? option.value,
  })),
  fallback: 'border-box',
  tooltips: Object.fromEntries(BOX_OPTIONS.map((option) => [option.value, option.tooltip])),
  groupLabel: 'Box sizing',
  moreLabel: 'More box-sizing options',
  customLabel: 'Box sizing value',
};

function BoxSizingField({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: Props) {
  const display = displayOf(read('box-sizing'));
  return (
    <div className="embed-editor_size-row">
      <SizeLabel
        label="Box size"
        prop="box-sizing"
        display={display}
        contributors={read('box-sizing')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('box-sizing')}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegmentBar
        config={BOX_SIZING_BAR}
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
  return (
    <div className="embed-editor_size">
      <div className="embed-editor_size-grid">
        {LENGTH_FIELDS.map((field) => (
          <Fragment key={field.prop}>
            <LivePropField prop={field.prop} label={field.label} placeholder={field.placeholder} {...props} />
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
