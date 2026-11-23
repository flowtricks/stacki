import { useState } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import TipAnchor from '../../ui/TipAnchor';
import SegmentedControl from '../../ui/SegmentedControl';
import { GroupLabel } from './TypographySection';
import { CountField } from './GridFlowControls';
import GridTrackExpression from './GridTrackExpression';
import { confirmSwitchToCount, countValue } from './GridSwitchToCount';
import { classifyTrackCount } from './model/gridTemplate';
import { withImportant } from './model/styleDisplay';
import { repeatTracks } from './gridTracks';
import { type SetProp, type LabelProps, resolvedValue } from './GridSettingsKit';

// One axis (Columns or Rows) in the grid settings: its name, ONE segmented control
// for how the axis is written, and under it only the control for that mode.
//
//   Count    a stepper, for N equal tracks
//   Custom   the track list as text (auto-fit, minmax(), named lines, variables, …)
//   Subgrid  the tracks come from the parent grid; nothing to edit here
//
// The mode is the value's own (classifyTrackCount), so a complex value always opens as
// Custom and is never shown as a number. Choosing Count on a value that is not N equal
// tracks asks first; Custom on a count only opens the text, writing nothing. Subgrid
// remembers the value it replaces and puts it back when it is left.

export type AxisMode = 'count' | 'custom' | 'subgrid';

export interface GridAxisModeProps {
  readonly title: string;
  readonly prop: string;
  readonly axis: 'column' | 'row';
  readonly setProp: SetProp;
  readonly labels: LabelProps;
}

/** The mode a value is in: subgrid, N equal tracks, or anything else (custom). */
export function axisModeOf(value: string): AxisMode {
  const classified = classifyTrackCount(value);
  if (classified.kind === 'count') {
    return 'count';
  }
  return classified.subgrid ? 'subgrid' : 'custom';
}

export default function GridAxisMode({ title, prop, axis, setProp, labels }: GridAxisModeProps) {
  const translate = useTranslate();
  const { read, busy, clearProp, onProvenance, onSelectSelector } = labels;
  const resolved = read(prop);
  const important = !!(resolved?.selectedValue ?? resolved?.winner)?.important;
  const raw = resolvedValue(read, prop);
  const value = withImportant({ value: raw, important: important && raw !== '' });
  const cell = axis === 'column' ? 'minmax(0, 1fr)' : 'auto';
  // Custom asked for on a value that is N equal tracks: the text opens, nothing is written.
  const [textOpen, setTextOpen] = useState(false);
  // The value subgrid replaced, put back when subgrid is left.
  const [replaced, setReplaced] = useState<{ value: string; important: boolean } | undefined>(undefined);
  const derived = axisModeOf(value);
  const mode: AxisMode = derived === 'count' && textOpen ? 'custom' : derived;

  const leaveSubgrid = () => {
    if (replaced) {
      setProp(prop, replaced.value, replaced.important);
      setReplaced(undefined);
    } else {
      clearProp(prop);
    }
  };
  const choose = async (next: AxisMode) => {
    if (next === mode) {
      return;
    }
    if (next === 'subgrid') {
      setReplaced(raw ? { value: raw, important } : undefined);
      setTextOpen(false);
      setProp(prop, 'subgrid', important);
      return;
    }
    if (mode === 'subgrid') {
      leaveSubgrid();
    }
    if (next === 'custom') {
      setTextOpen(true);
      return;
    }
    // Count: from the text of N equal tracks nothing changes but the control; from a
    // value that is not, only an explicit yes replaces it.
    setTextOpen(false);
    if (mode === 'custom' && derived !== 'count' && (await confirmSwitchToCount({ value, translate }))) {
      setProp(prop, countValue({ value, cell }), false);
    }
  };
  const modeOptions = [
    { value: 'count', label: translate('style.gridSettings.modeCount') },
    { value: 'custom', label: translate('style.gridSettings.modeCustom') },
    { value: 'subgrid', label: translate('style.gridSettings.modeSubgrid') },
  ] satisfies ReadonlyArray<{ value: AxisMode; label: string }>;
  const classified = classifyTrackCount(value);
  return (
    <section className="embed-editor_grid-section">
      <div className="embed-editor_grid-section-head">
        <GroupLabel
          label={title}
          props={[prop]}
          read={read}
          busy={busy}
          onClear={() => clearProp(prop)}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
      </div>
      {/* What subgrid does is the mode control's tooltip: a row under it would shift the panel when the mode changes. */}
      <TipAnchor text={mode === 'subgrid' ? translate('style.gridSettings.subgridOn') : undefined}>
        <SegmentedControl
          options={modeOptions}
          value={mode}
          ariaLabel={translate('style.gridSettings.modeAria', { title })}
          disabled={busy}
          onChange={(next) => void choose(next)}
        />
      </TipAnchor>
      {mode === 'count' ? (
        <div className="embed-editor_grid-mode-body">
          <CountField
            value={classified.kind === 'count' ? classified.count : 0}
            busy={busy}
            ariaLabel={translate('style.gridSettings.countAria', { title })}
            onCommit={(count) => setProp(prop, repeatTracks(count, cell), false)}
          />
        </div>
      ) : undefined}
      {mode === 'custom' ? (
        <div className="embed-editor_grid-mode-body">
          <GridTrackExpression
            value={value}
            prop={prop}
            ariaLabel={translate('style.gridSettings.expressionAria', { title })}
            busy={busy}
            onCommit={(next, flag) => setProp(prop, next, flag)}
          />
        </div>
      ) : undefined}
    </section>
  );
}
