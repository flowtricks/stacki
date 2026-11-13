import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { Translator } from '../../lib/i18n/localeContext';
import { GroupLabel } from './TypographySection';
import FieldLabel from './components/FieldLabel';
import { PropTip } from './components/CssPropertyTip';
import Select, { type SelectOption } from './components/Select';
import { HoverTooltip } from './components/SegmentedControl';
import GridSettings from './GridSettings';
import type { ResolvedProp } from './model/resolved';
import { useHighlight } from './model/computedStyle';
import { commitInPlace } from './model/commitInPlace';
import { countTracks, NEW_COLUMN, NEW_ROW, repeatTracks, isUniformTracks } from './gridTracks';
import { GRID_ITEM_ALIGN, gridKeyword, GridAlignIcon, X_ALIGN_ICONS, Y_ALIGN_ICONS, xAlignLabels, yAlignLabels, cap, CustomizeIcon } from './GridIcons';
import { GridDirectionControl, GridContentControl, CountField } from './GridFlowControls';
import { displayOf, displayText, parseImportant } from './model/styleDisplay';

// The grid controls in the Layout section (shown when Display is grid). Mirrors
// Webflow: Columns/Rows track counts, Direction (+ dense), Align (justify-items X /
// align-items Y), and Justify/Align CONTENT. Gap is the shared GapControl in the
// Layout section, so it isn't repeated here. Resolved-model API (blue when the
// picked selector sets it, clear menu on the label).

type SetProp = (prop: string, value: string, important: boolean) => void;
type LiveSetProp = (prop: string, value: string | undefined, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;
type Read = (prop: string) => ResolvedProp | undefined;

// The item-alignment preview box (Webflow's grid Align widget): a 3×3 grid of click
// targets under a single item that lays out with the real justify-items (screen X) and
// align-items (screen Y). Clicking a target sets both to start/center/end; Stretch is
// picked from the axis dropdowns and shows the item filling that axis. Reuses the flex
// AlignControl's box CSS (dots + well) with a grid preview.
function GridAlignBox({
  justifyItems,
  alignItems,
  busy,
  onSet,
}: {
  justifyItems: string;
  alignItems: string;
  busy: boolean;
  onSet: (prop: string, value: string) => void;
}) {
  const translate = useTranslate();
  const xLabels = xAlignLabels(translate);
  const yLabels = yAlignLabels(translate);
  // Grid's initial justify-items / align-items behave as stretch, so an unset control
  // shows a full-bleed item.
  const ji = justifyItems || 'stretch';
  const ai = alignItems || 'stretch';
  // A small fixed square (Webflow keeps it ~20px) so the surrounding dots stay visible;
  // a stretched axis drops to auto so the item fills that direction into a bar.
  const itemStyle: CSSProperties = {
    width: ji === 'stretch' ? 'auto' : '16px',
    height: ai === 'stretch' ? 'auto' : '16px',
  };
  const positions = ['start', 'center', 'end'];
  return (
    <div className="embed-editor_align-box">
      <div className="embed-editor_align-dots">
        {positions.map((ry) =>
          positions.map((cx) => (
            <button
              key={`${ry}-${cx}`}
              type="button"
              className="embed-editor_align-dot"
              disabled={busy}
              aria-label={translate('style.gridControls.alignAt', { horizontal: xLabels[cx] ?? cap(cx), vertical: yLabels[ry] ?? cap(ry) })}
              onClick={() => {
                onSet('justify-items', cx);
                onSet('align-items', ry);
              }}
            >
              <span />
            </button>
          )),
        )}
      </div>
      <div className="embed-editor_grid-align-preview" style={{ justifyItems: ji, alignItems: ai }} aria-hidden="true">
        <span className="embed-editor_grid-align-item" style={itemStyle} />
      </div>
    </div>
  );
}

const AXIS_CUSTOM = '__custom__';

// The free-text field shown in Custom mode: commits on blur, clears the property when
// emptied (mirrors the flex align axis; no live channel here).
function GridAxisCustomInput({
  value,
  busy,
  ariaLabel,
  autoFocus,
  onCommit,
  onClear,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  autoFocus: boolean;
  onCommit: (value: string) => void;
  onClear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed) {
      onCommit(trimmed);
    } else {
      onClear();
    }
  };
  return (
    <input
      className="u-select-custom-input"
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
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      placeholder="unset"
      aria-label={ariaLabel}
      autoFocus={autoFocus}
    />
  );
}

// An align axis's dropdown options: the presets with their axis's labels and icons,
// then "Custom".
function alignAxisOptions(axis: 'X' | 'Y', translate: Translator): SelectOption<string>[] {
  const labels = axis === 'X' ? xAlignLabels(translate) : yAlignLabels(translate);
  const icons = axis === 'X' ? X_ALIGN_ICONS : Y_ALIGN_ICONS;
  const options: SelectOption<string>[] = GRID_ITEM_ALIGN.map((option) => ({
    value: option,
    label: labels[option] ?? cap(option),
    icon: <GridAlignIcon paths={icons[option] ?? []} />,
  }));
  options.push({ value: AXIS_CUSTOM, label: translate('style.gridControls.custom') });
  return options;
}

// One grid align axis (X = justify-items, Y = align-items): the icon dropdown plus a
// trailing "Custom" option that seeds `unset` and swaps in a free-value field for any
// keyword the presets don't cover (matching the flex Align axes). The X / Y label owns
// clear / provenance for that axis's property, so the two reset independently.
interface GridAlignAxisProps {
  axis: 'X' | 'Y';
  prop: string;
  value: string;
  busy: boolean;
  read: Read;
  onSet: (value: string) => void;
  /** Live-preview the hovered option; `undefined` restores the committed value. */
  onPreview: (value: string | undefined) => void;
  onClear: () => void;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}
function GridAlignAxis(props: GridAlignAxisProps) {
  const { axis, prop, value, busy, onSet, onPreview, onClear } = props;
  const translate = useTranslate();
  const [forceCustom, setForceCustom] = useState(false);
  const present = Boolean(value);
  const shown = gridKeyword(value);
  const known = GRID_ITEM_ALIGN.includes(shown);
  const customMode = forceCustom || (present && !known);
  // Unset → what the page computes for this element before falling back to grid's
  // own `stretch` default.
  const shownAlign = useHighlight('', present ? '' : prop, GRID_ITEM_ALIGN, 'stretch');
  const options = alignAxisOptions(axis, translate);
  // "Custom" has no value of its own to show, so landing on it reverts the preview.
  const preview = (option: string | undefined) => onPreview(option === AXIS_CUSTOM ? undefined : option);
  const pick = (choice: string) => {
    if (choice === AXIS_CUSTOM) {
      setForceCustom(true);
      onSet('unset');
      return;
    }
    setForceCustom(false);
    onSet(choice);
  };
  return (
    <div className="embed-editor_align-axis">
      <GroupLabel
        label={axis}
        props={[prop]}
        read={props.read}
        busy={busy}
        onClear={onClear}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      {/* Grid's initial justify-items / align-items behave as stretch, so an unset axis
          shows Stretch (Webflow's default). Clear via this axis's X / Y label. */}
      <Select
        value={customMode ? AXIS_CUSTOM : known ? shown : shownAlign}
        options={options}
        ariaLabel={translate('style.gridControls.alignAxis', { axis })}
        disabled={busy}
        hideTriggerIcon
        onChange={pick}
        onPreview={(option) => preview(option ?? undefined)}
        customInput={
          customMode ? (
            <GridAxisCustomInput
              value={value}
              busy={busy}
              ariaLabel={translate('style.gridControls.alignAxis', { axis })}
              autoFocus={forceCustom}
              onCommit={(next) => onSet(next)}
              onClear={() => {
                setForceCustom(false);
                onClear();
              }}
            />
          ) : undefined
        }
      />
    </div>
  );
}

interface GridControlsProps {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
  onProvenance: (prop: string, anchor: DOMRect) => void;
  onSelectSelector: (selector: string, prop?: string) => void;
}

// The value the picked selector sets, else the winning one — trimmed, '' when unset.
// What a preset control compares against its presets and seeds its custom field
// with: the value and its `!important`. A flagged value matches no preset, so
// the control opens its custom field, which shows the flag (the convention of
// every preset control in the panel).
function resolvedText(read: Read, prop: string): string {
  return displayText(displayOf(read(prop))).trim();
}

// A write from one of those controls: the flag is whatever its text says.
function writeText(setProp: SetProp, prop: string, text: string): void {
  const parsed = parseImportant(text);
  setProp(prop, parsed.value, parsed.important);
}

function resolvedValue(read: Read, prop: string): string {
  const resolved = read(prop);
  if (!resolved) {
    return '';
  }
  const source = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner;
  return source.value.trim();
}

export default function GridControls(props: GridControlsProps) {
  const { read, busy, setProp, clearProp } = props;
  const translate = useTranslate();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const labelProps = {
    read,
    busy,
    onProvenance: props.onProvenance,
    onSelectSelector: props.onSelectSelector,
  };
  return (
    <>
      <GridTracksRow props={props} onConfigure={() => setSettingsOpen(true)} />
      <div className="embed-editor_size-row">
        <GroupLabel label={translate('style.gridControls.direction')} props={['grid-auto-flow']} {...labelProps} onClear={() => clearProp('grid-auto-flow')} />
        <GridDirectionControl
          value={resolvedText(read, 'grid-auto-flow')}
          busy={busy}
          onSet={(next) => writeText(setProp, 'grid-auto-flow', next)}
          onCommitCustom={(next, important) => setProp('grid-auto-flow', next, important)}
        />
      </div>
      <GridAlignRow props={props} />
      <ContentRow label={translate('style.gridControls.columns')} prop="justify-content" vertical={false} props={props} />
      <ContentRow label={translate('style.gridControls.rows')} prop="align-content" vertical props={props} />
      {settingsOpen ? (
        <GridSettings
          read={read}
          busy={busy}
          setProp={setProp}
          clearProp={clearProp}
          onProvenance={props.onProvenance}
          onSelectSelector={props.onSelectSelector}
          onClose={() => setSettingsOpen(false)}
        />
      ) : undefined}
    </>
  );
}

// Columns / Rows track counts and the gear that opens the Configure-grid modal.
function GridTracksRow({ props, onConfigure }: { props: GridControlsProps; onConfigure: () => void }) {
  const { read, busy, setProp, clearProp } = props;
  const translate = useTranslate();
  const labelProps = {
    read,
    busy,
    onProvenance: props.onProvenance,
    onSelectSelector: props.onSelectSelector,
  };
  const columnsRaw = resolvedValue(read, 'grid-template-columns');
  const rowsRaw = resolvedValue(read, 'grid-template-rows');
  // The gear lights up when a track list isn't just N equal tracks — those can't be
  // represented as a count, so per-track sizing / reordering lives in the modal.
  const customTracks = (!!columnsRaw && !isUniformTracks(columnsRaw)) || (!!rowsRaw && !isUniformTracks(rowsRaw));
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top">
      <GroupLabel
        label={translate('style.gridControls.grid')}
        props={['grid-template-columns', 'grid-template-rows']}
        {...labelProps}
        onClear={() => clearProp(['grid-template-columns', 'grid-template-rows'])}
      />
      <div className="embed-editor_grid-tracks">
        <div className="embed-editor_gap-cell">
          {/* Always the track COUNT — changing it adds/removes tracks while keeping the
              earlier tracks' sizes. Per-track values live behind the configure gear. */}
          <CountField
            value={countTracks(columnsRaw)}
            busy={busy}
            ariaLabel={translate('style.gridControls.gridColumns')}
            onCommit={(count) => setProp('grid-template-columns', repeatTracks(count, NEW_COLUMN), false)}
          />
          <GroupLabel
            label={translate('style.gridControls.columns')}
            props={['grid-template-columns']}
            {...labelProps}
            onClear={() => clearProp('grid-template-columns')}
          />
        </div>
        <div className="embed-editor_gap-cell">
          <CountField
            value={countTracks(rowsRaw)}
            busy={busy}
            ariaLabel={translate('style.gridControls.gridRows')}
            onCommit={(count) => setProp('grid-template-rows', repeatTracks(count, NEW_ROW), false)}
          />
          <GroupLabel
            label={translate('style.gridControls.rows')}
            props={['grid-template-rows']}
            {...labelProps}
            onClear={() => clearProp('grid-template-rows')}
          />
        </div>
        <ConfigureGridButton busy={busy} customTracks={customTracks} onOpen={onConfigure} />
      </div>
    </div>
  );
}

// The gear, with a rich "Configure grid" tooltip shown after a short hover (matches the
// Direction / Content segmented tooltips instead of the OS-native `title`).
function ConfigureGridButton({ busy, customTracks, onOpen }: { busy: boolean; customTracks: boolean; onOpen: () => void }) {
  const translate = useTranslate();
  const gearRef = useRef<HTMLButtonElement>(null);
  const [gearTip, setGearTip] = useState(false);
  const gearTimer = useRef<number | undefined>(undefined);
  const clearGearTimer = () => {
    if (gearTimer.current !== undefined) {
      window.clearTimeout(gearTimer.current);
      gearTimer.current = undefined;
    }
  };
  useEffect(() => clearGearTimer, []);
  return (
    <>
      <button
        ref={gearRef}
        type="button"
        className={'embed-editor_icon-btn embed-editor_grid-gear ' + (customTracks ? 'is-active' : '')}
        disabled={busy}
        aria-label={translate('style.gridControls.configureGrid')}
        onMouseEnter={() => {
          clearGearTimer();
          gearTimer.current = window.setTimeout(() => setGearTip(true), 500);
        }}
        onMouseLeave={() => {
          clearGearTimer();
          setGearTip(false);
        }}
        onClick={() => {
          clearGearTimer();
          setGearTip(false);
          onOpen();
        }}
      >
        <CustomizeIcon />
      </button>
      {gearTip && gearRef.current ? <HoverTooltip anchor={gearRef.current}>{translate('style.gridControls.configureGrid')}</HoverTooltip> : undefined}
    </>
  );
}

// Align: the preview box and the X (justify-items) / Y (align-items) axis dropdowns.
function GridAlignRow({ props }: { props: GridControlsProps }) {
  const { read, busy, setProp, clearProp, liveSetProp } = props;
  const translate = useTranslate();
  const alignAxis = (axis: 'X' | 'Y', prop: string) => (
    <GridAlignAxis
      axis={axis}
      prop={prop}
      value={resolvedText(read, prop).toLowerCase()}
      busy={busy}
      read={read}
      onSet={(next) => writeText(setProp, prop, next)}
      onPreview={(next) => liveSetProp(prop, next, false)}
      onClear={() => clearProp(prop)}
      onProvenance={props.onProvenance}
      onSelectSelector={props.onSelectSelector}
    />
  );
  return (
    <div className="embed-editor_size-row embed-editor_bg-row-top embed-editor_align-row">
      {/* Inert caption — the X / Y labels below own clear / provenance per axis. */}
      <FieldLabel
        className="embed-editor_size-label"
        active={false}
        disabled={busy}
        onReset={() => {}}
        tooltip={<PropTip props={['justify-items', 'align-items']} />}
      >
        {translate('style.gridControls.align')}
      </FieldLabel>
      <div className="embed-editor_align">
        <GridAlignBox
          justifyItems={gridKeyword(resolvedValue(read, 'justify-items').toLowerCase())}
          alignItems={gridKeyword(resolvedValue(read, 'align-items').toLowerCase())}
          busy={busy}
          onSet={(prop, next) => setProp(prop, next, false)}
        />
        <div className="embed-editor_align-axes">
          {alignAxis('X', 'justify-items')}
          {alignAxis('Y', 'align-items')}
        </div>
      </div>
    </div>
  );
}

// Content distribution as a Webflow-style icon segmented control. `vertical` rotates
// the glyphs for the Rows (align-content) axis; the row's label owns clear/provenance.
function ContentRow({ label, prop, vertical, props }: { label: string; prop: string; vertical: boolean; props: GridControlsProps }) {
  const { read, busy, setProp, clearProp } = props;
  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label={label}
        props={[prop]}
        read={read}
        busy={busy}
        onClear={() => clearProp(prop)}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      <GridContentControl
        value={resolvedText(read, prop)}
        prop={prop}
        vertical={vertical}
        ariaLabel={label}
        busy={busy}
        onSet={(next) => writeText(setProp, prop, next)}
        onCommitCustom={(next, important) => setProp(prop, next, important)}
      />
    </div>
  );
}
