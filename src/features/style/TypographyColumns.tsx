import Popup from '../../ui/Popup';
// Text columns and their advanced options: count and width, the rule's style,
// width and colour, the gap and span, in the popover the row opens
// (TypographySection.tsx).

import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import FieldLabel from './components/FieldLabel';
import { PropTip, ProvenanceLabel } from './components/CssPropertyTip';
import SegmentedControl from './components/SegmentedControl';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import ProvenanceList from './ProvenanceList';
import { useHighlight } from './model/computedStyle';
import { displayOf, displayText, withImportant } from './model/styleDisplay';
import ImportantMark from './components/ImportantMark';
import { DecorNoneIcon } from './TypographyIcons';
import { type Props, LiveInput, StackedField, type Seg, SegBar, MoreIcon } from './TypographyKit';

// ─────────────────────────── Columns advanced options ───────────────────────────

// The multi-column properties owned by the "…" popover — used to light the trigger
// when any is set on the picked selector (they're also excluded from the generic
// row list in EmbedEditor's TYPOGRAPHY_CONTROL_PROPS).
export const COLUMN_MORE_PROPS = ['column-gap', 'column-rule-style', 'column-rule-width', 'column-rule-color', 'column-span'] as const;
// column-rule-style glyphs — a vertical divider drawn solid / dashed / dotted.
export function RuleSolidIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="7.25" y="2" width="1.5" height="12" fill="currentColor" />
    </svg>
  );
}
export function RuleDashedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <rect x="7.25" y="2.5" width="1.5" height="4" fill="currentColor" />
      <rect x="7.25" y="9.5" width="1.5" height="4" fill="currentColor" />
    </svg>
  );
}
export function RuleDottedIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="3.5" r="1" fill="currentColor" />
      <circle cx="8" cy="8" r="1" fill="currentColor" />
      <circle cx="8" cy="12.5" r="1" fill="currentColor" />
    </svg>
  );
}

export const RULE_STYLE_SEGS: readonly Seg[] = [
  { value: 'none', icon: <DecorNoneIcon />, label: 'None' },
  { value: 'solid', icon: <RuleSolidIcon />, label: 'Solid' },
  { value: 'dashed', icon: <RuleDashedIcon />, label: 'Dashed' },
  { value: 'dotted', icon: <RuleDottedIcon />, label: 'Dotted' },
];

// The clearable label for popover rows — same provenance behavior as the panel's
// PropLabel: orange (set via another selector) opens the provenance popover; blue
// (set on the picked selector) opens a reset menu that also lists every contributing
// selector + whether it's a Webflow style or an embed; unset is a dim caption.
// `active` / `onClear` can be overridden for a control that edits one facet of a
// shorthand (e.g. the divider Style within `text-decoration`).
export function PopLabel({
  label,
  prop,
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
  active,
  onClear,
}: {
  label: string;
  prop: string;
  active?: boolean;
  onClear?: () => void;
} & Pick<Props, 'read' | 'busy' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const resolved = read(prop);
  const display = displayOf(resolved);
  if (display.present && !display.isSelected) {
    return <ProvenanceLabel label={label} props={[prop]} busy={busy} onProvenance={onProvenance} />;
  }
  return (
    <FieldLabel
      className={`embed-editor_size-label ${display.overridden ? 'is-overridden' : ''}`}
      active={active ?? display.isSelected}
      {...(display.present ? {} : { inheritedProp: prop })}
      disabled={busy}
      onReset={onClear ?? (() => clearProp(prop))}
      resetLabel="Clear"
      tooltip={<PropTip props={[prop]} />}
      {...(display.overridden ? { title: `Overridden by ${display.winnerSelector}` } : {})}
      menuNote={(close) => (
        <ProvenanceList
          contributors={resolved?.contributors ?? []}
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

// A length-field row inside the popover (Gap / divider Width).
export function LengthRow({
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
  placeholder: string;
} & Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'>) {
  const display = displayOf(read(prop));
  const external = display.present ? withImportant(display) : '';
  return (
    <div className="embed-editor_size-row">
      <PopLabel label={label} prop={prop} read={read} busy={busy} clearProp={clearProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      <LiveInput
        value={external}
        busy={busy}
        placeholder={placeholder}
        ariaLabel={label}
        className="u-input embed-editor_size-input"
        dataProp={prop}
        prop={prop}
        onCommit={(value, important) => setProp(prop, value, important)}
        onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
        onClear={() => clearProp(prop)}
      />
    </div>
  );
}

export function RuleStyleRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'>) {
  const display = displayOf(read('column-rule-style'));
  const current = useHighlight(
    // The flag rides in the text, so a flagged value opens the bar's custom
    // field, which shows it (TypographyKit.tsx SegBar).
    displayText(display).trim().toLowerCase(),
    'column-rule-style',
    RULE_STYLE_SEGS.map((segment) => segment.value),
    'none',
  );
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Style"
        prop="column-rule-style"
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <SegBar
        segs={RULE_STYLE_SEGS}
        current={current}
        ariaLabel="Divider style"
        prop="column-rule-style"
        busy={busy}
        onCommit={(value, important) => setProp('column-rule-style', value, important)}
        onLiveCommit={(value, important) => liveSetProp('column-rule-style', value, important)}
        onClear={() => clearProp('column-rule-style')}
      />
    </div>
  );
}

export function RuleColorRow({
  read,
  busy,
  setProp,
  clearProp,
  liveSetProp,
  onProvenance,
  onSelectSelector,
}: Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'liveSetProp' | 'onProvenance' | 'onSelectSelector'>) {
  const display = displayOf(read('column-rule-color'));
  const external = displayText(display);
  // A live drag writes to the canvas, not to the model this row reads — so the
  // colour it emitted is what the swatch and the field show until the model
  // catches up. Without this the page moved under the pointer while the number
  // beside it sat still (see liveColor.ts).
  const [shown, noteLive] = useLiveColor(external);
  const swatch = (
    <ColorSwatch
      value={shown}
      busy={busy}
      ariaLabel="Divider color"
      onChange={(color, live) => {
        // The swatch picks a colour, not the flag: a flagged colour stays so.
        noteLive(live ? withImportant({ value: color, important: display.important }) : undefined);
        if (live) {
          liveSetProp('column-rule-color', color, display.important);
        } else {
          setProp('column-rule-color', color, display.important);
        }
      }}
    />
  );
  return (
    <div className="embed-editor_size-row">
      <PopLabel
        label="Color"
        prop="column-rule-color"
        read={read}
        busy={busy}
        clearProp={clearProp}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_type-field">
        {swatch}
        <LiveInput
          value={shown}
          busy={busy}
          placeholder="Set a color"
          ariaLabel="Divider color"
          className="u-input embed-editor_size-input"
          dataProp="column-rule-color"
          prop="column-rule-color"
          onCommit={(value, important) => setProp('column-rule-color', value, important)}
          onLiveCommit={(value, important) => liveSetProp('column-rule-color', value, important)}
          onClear={() => clearProp('column-rule-color')}
        />
      </div>
    </div>
  );
}

export function SpanRow({
  read,
  busy,
  setProp,
  clearProp,
  onProvenance,
  onSelectSelector,
}: Pick<Props, 'read' | 'busy' | 'setProp' | 'clearProp' | 'onProvenance' | 'onSelectSelector'>) {
  const display = displayOf(read('column-span'));
  const value = useHighlight(display.present ? display.value.trim().toLowerCase() : '', 'column-span', ['none', 'all'], 'none') === 'all' ? 'all' : 'none';
  return (
    <div className="embed-editor_size-row">
      <PopLabel label="Span" prop="column-span" read={read} busy={busy} clearProp={clearProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      {/* No custom field: a flagged value is marked, and picks keep the flag. */}
      <ImportantMark important={display.important}>
        <SegmentedControl
          options={[
            { value: 'none', label: "Don't" },
            { value: 'all', label: 'Do' },
          ]}
          value={value}
          onChange={(next) => setProp('column-span', next, display.important)}
          ariaLabel="Column span"
          disabled={busy}
        />
      </ImportantMark>
    </div>
  );
}

export function CloseIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

// A "…" trigger button that toggles an anchored options popover. The popover is
// absolutely positioned (left/right:0) against the nearest positioned ancestor —
// the caller's row wrapper — so it spans the full row and never overflows the
// panel. Reused by the Columns and Decoration advanced controls.
export function MorePopover({ title, active, busy, children }: { title: string; active: boolean; busy: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={rootRef} className="embed-editor_more">
      <button
        type="button"
        className={`embed-editor_more-btn ${open ? 'is-open' : ''} ${active ? 'is-set' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={title}
        disabled={busy}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <Popup mode="popover" portal={false} onClose={() => setOpen(false)} className="embed-editor_more-popover" role="dialog" label={title}>
          <div className="embed-editor_more-head">
            <span className="embed-editor_more-title">{title}</span>
            <button type="button" className="embed-editor_more-close" aria-label="Close" onClick={() => setOpen(false)}>
              <CloseIcon />
            </button>
          </div>
          {children}
        </Popup>
      ) : undefined}
    </div>
  );
}

// While the popover is open, a press outside it (other than in the provenance
// popover one of its labels opened) or Escape closes it.
// The advanced-columns popover body: multi-column Gap, the column-rule divider
// (style / width / color), and the child column-span. Every field reads/writes
// through the same resolved model as the rest of the panel; unset props read empty.
export function ColumnsPopover(props: Props) {
  return (
    <>
      <div className="embed-editor_more-group">
        <LengthRow prop="column-gap" label="Gap" placeholder="0px" {...props} />
      </div>
      <div className="embed-editor_more-group">
        <p className="embed-editor_more-heading">Divider settings</p>
        <RuleStyleRow {...props} />
        <LengthRow prop="column-rule-width" label="Width" placeholder="0px" {...props} />
        <RuleColorRow {...props} />
      </div>
      <div className="embed-editor_more-group">
        <p className="embed-editor_more-heading">Column child</p>
        <SpanRow {...props} />
      </div>
    </>
  );
}

// The Letter spacing / Text indent / Columns three-up row, with a trailing "…"
// button opening the advanced-columns popover (mirrors Webflow's Columns UI).
export function ColumnsRow(props: Props) {
  const anySet = COLUMN_MORE_PROPS.some((prop) => props.read(prop)?.source === 'selected');
  return (
    <div className="embed-editor_columns">
      <div className="embed-editor_type-triple">
        <StackedField prop="letter-spacing" label="Letter spacing" placeholder="0em" {...props} />
        <StackedField prop="text-indent" label="Text indent" placeholder="0px" {...props} />
        <StackedField prop="column-count" label="Columns" placeholder="Auto" {...props} />
      </div>
      <MorePopover title="Columns" active={anySet} busy={props.busy}>
        <ColumnsPopover {...props} />
      </MorePopover>
    </div>
  );
}
