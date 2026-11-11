import { centralIcon } from '../../ui/central/CentralIcon';
import { clock as centralClock } from '../../ui/central/centralGeometry';
// Layered transitions: the property, duration and easing of each, with the
// curve drawn (EffectsSection.tsx).

import { useState } from 'react';
import { parseHideable, serializeHideable, type Hideable } from './model/hideable';
import Select, { type SelectOption } from './components/Select';
import DragSlider from './components/DragSlider';
import LiveInput from './components/LiveInput';
import LayerList from './LayerList';
import LayerPopover from './LayerPopover';
import EasingEditor from './EasingEditor';
import {
  parseTransitions,
  serializeTransitions,
  blankTransition,
  transitionLabel,
  easingToBezier,
  TRANSITION_GROUPS,
  type Transition,
  type TransitionPatch,
} from './model/transition';
import { PlusIcon } from './components/MenuParts';
import { displayOf } from './model/styleDisplay';
import { type Props, type WriteOptions, writeValue, useLayerRows, EffLabel } from './EffectsKit';

// ─────────────────────────── Transitions ───────────────────────────

export const ClockIcon = centralIcon(centralClock);
export function EaseCurveIcon({ timing }: { timing: string }) {
  const bezier = easingToBezier(timing || 'ease');
  const size = 16;
  const pt = (x: number, y: number) => `${(x * size).toFixed(1)} ${(size - y * size).toFixed(1)}`;
  return (
    <svg viewBox={`-2 -5 ${size + 4} ${size + 10}`} width="16" height="16" aria-hidden="true">
      <path d={`M ${pt(0, 0)} C ${pt(bezier[0], bezier[1])} ${pt(bezier[2], bezier[3])} ${pt(1, 1)}`} fill="none" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  );
}

export function durationToMs(value: string): number {
  const match = value
    .trim()
    .toLowerCase()
    .match(/^(-?[\d.]+)(ms|s)?$/);
  if (!match) {
    return 0;
  }
  const amount = parseFloat(match[1] ?? '');
  return match[2] === 's' ? Math.round(amount * 1000) : Math.round(amount);
}
// The value's current time unit (so the slider keeps writing seconds when the value
// is in seconds instead of silently rewriting 1.2s → 1200ms). Non-time values → ms.
export function durationUnit(value: string): 'ms' | 's' {
  return /^-?[\d.]+s$/i.test(value.trim()) ? 's' : 'ms';
}
// Format a slider's ms value back into the given unit (seconds rounded to 2 dp).
export function fmtDuration(ms: number, unit: 'ms' | 's'): string {
  return unit === 's' ? `${parseFloat((ms / 1000).toFixed(2))}s` : `${Math.round(ms)}ms`;
}

// Duration: a slider (numeric ms) alongside a free-text input holding the raw value,
// so the unit lives inside the field and you can type 0.2s, var(), inherit, unset, etc.
export function DurationField({ value, busy, onCommit, onLive }: { value: string; busy: boolean; onCommit: (v: string) => void; onLive: (v: string) => void }) {
  const ms = durationToMs(value);
  const unit = durationUnit(value);
  // While the slider is being dragged the field shows where it is; the rest of
  // the time it shows what is set. The field is the panel's own (components/
  // LiveInput), so a duration can be a variable here like anywhere else.
  const [preview, setPreview] = useState<string | undefined>(undefined);
  return (
    <div className="embed-editor_trans-duration">
      <DragSlider
        value={ms}
        min={0}
        max={2000}
        disabled={busy}
        ariaLabel="Duration"
        onPreview={(milliseconds) => setPreview(fmtDuration(milliseconds, unit))}
        onInput={(milliseconds) => onLive(fmtDuration(milliseconds, unit))}
        onCommit={(milliseconds) => {
          setPreview(undefined);
          onCommit(fmtDuration(milliseconds, unit));
        }}
      />
      <LiveInput
        value={preview ?? value}
        busy={busy}
        ariaLabel="Duration"
        placeholder="0ms"
        prop="transition-duration"
        onLive={(next) => onLive(next.trim() || '0ms')}
        onCommit={(next) => onCommit(next.trim() || '0ms')}
      />
    </div>
  );
}

// The easing control: a curve-icon button opens the visual editor, and the text
// input takes any CSS timing value — keywords, cubic-bezier(), or inherit/unset/var().
export function EasingField({
  value,
  busy,
  onCommit,
  onEditEasing,
}: {
  value: string;
  busy: boolean;
  onCommit: (v: string) => void;
  onEditEasing: () => void;
}) {
  return (
    <div className="embed-editor_trans-easing">
      <button type="button" className="embed-editor_trans-easing-btn" onClick={onEditEasing} disabled={busy} title="Edit easing" aria-label="Edit easing">
        <EaseCurveIcon timing={value} />
      </button>
      <LiveInput
        value={value}
        busy={busy}
        ariaLabel="Easing"
        placeholder="ease"
        prop="transition-timing-function"
        onLive={() => {}}
        onCommit={(next) => onCommit(next.trim() || 'ease')}
      />
    </div>
  );
}

export function TransitionEditor({
  transition,
  busy,
  onChange,
  onEditEasing,
}: {
  transition: Transition;
  busy: boolean;
  onChange: (p: TransitionPatch, live: boolean) => void;
  onEditEasing: () => void;
}) {
  const options = TRANSITION_GROUPS.flatMap<SelectOption<string>>((group) => [
    { value: `__h_${group.heading}`, label: group.heading, heading: true },
    ...group.items.map((item) => ({ value: item.value, label: item.label, indent: true })),
  ]);
  return (
    <div className="embed-editor_trans-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <Select
          value={transition.property}
          options={options}
          onChange={(next) => onChange({ property: next }, false)}
          ariaLabel="Transition type"
          disabled={busy}
          searchable
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Duration</span>
        <DurationField
          value={transition.duration}
          busy={busy}
          onCommit={(next) => onChange({ duration: next }, false)}
          onLive={(next) => onChange({ duration: next }, true)}
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Easing</span>
        <EasingField value={transition.timing} busy={busy} onCommit={(next) => onChange({ timing: next }, false)} onEditEasing={onEditEasing} />
      </div>
    </div>
  );
}

export function TransitionsRow({ props }: { props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read('transition'));
  // `transition` is comma-separated, unlike transform and filter.
  const rows = parseHideable(display.present ? display.value : '', ',', parseTransitions);
  const list = rows.map((row) => row.item);
  const [easingOpen, setEasingOpen] = useState(false);
  const write = (next: Array<Hideable<Transition>>, options: WriteOptions) =>
    writeValue('transition', serializeHideable(next, ',', serializeTransitions), options, props);
  const stack = useLayerRows({ rows, blank: blankTransition, write });
  const { openIndex } = stack;
  const current = openIndex !== undefined ? list[openIndex] : undefined;
  const patch = (changes: TransitionPatch, options: WriteOptions) => {
    if (openIndex !== undefined) {
      stack.update(openIndex, options, (item) => ({ ...item, ...changes }));
    }
  };

  return (
    <div className="embed-editor_type-shadows embed-editor_transitions">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label="Transitions" prop="transition" props={props} />
        <button type="button" className="embed-editor_icon-btn" disabled={busy} title="Add transition" aria-label="Add transition" onClick={stack.add}>
          <PlusIcon />
        </button>
      </div>
      <LayerList
        count={list.length}
        busy={busy}
        ariaLabel="Transitions"
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => ({
          preview: (
            <span className="embed-editor_trans-clock" aria-hidden="true">
              <ClockIcon />
            </span>
          ),
          label: transitionLabel(list[i] ?? blankTransition()),
        })}
      />
      {openIndex !== undefined && stack.anchorElement && current ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel="Transition" onClose={stack.close}>
          <TransitionEditor transition={current} busy={busy} onChange={(changes, live) => patch(changes, { live })} onEditEasing={() => setEasingOpen(true)} />
        </LayerPopover>
      ) : undefined}
      {easingOpen && current ? (
        <EasingEditor value={current.timing || 'ease'} onClose={() => setEasingOpen(false)} onChange={(timing) => patch({ timing }, { live: false })} />
      ) : undefined}
    </div>
  );
}
