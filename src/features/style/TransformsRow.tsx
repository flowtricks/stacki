// Layered 2D and 3D transforms — move, scale, rotate, skew — each axis a
// number with a unit, and the filters row beside them (EffectsSection.tsx).

import { useEffect, useRef, useState } from 'react';
import { parseHideable, serializeHideable, type Hideable } from './model/hideable';
import TransformSettings from './TransformSettings';
import { takeSelfPerspective, withSelfPerspective } from './model/transformSettings';
import DragSlider from './components/DragSlider';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import LayerList from './LayerList';
import LayerPopover from './LayerPopover';
import VariableConnect from './VariableConnect';
import {
  parseTransforms,
  serializeTransforms,
  blankTransform,
  retypeTransform,
  transformLabel,
  hasZ,
  IDENTITY,
  type Transform,
  type TransformPatch,
  type TransformType,
} from './model/transform';
import { transformAxisIcon, transformTypeIcon, LockIcon, UnlockIcon } from './transformIcons';
import { parseFilters, serializeFilters, blankFilter, filterLabel, type Filter } from './model/filter';
import FilterEditor from './FilterFields';
import { useExternalDraft } from './model/fieldHooks';
import { displayOf } from './model/styleDisplay';
import { type Props, type WriteOptions, useLiveTimer, draftInputHandlers, writeValue, useLayerRows, EffLabel } from './EffectsKit';

// ─────────────── 2D & 3D transforms (layered, mirrors text-shadow) ───────────────

export const TRANSFORM_TYPES: ReadonlyArray<SegmentedOption<TransformType>> = [
  { value: 'move', label: 'Move' },
  { value: 'scale', label: 'Scale' },
  { value: 'rotate', label: 'Rotate' },
  { value: 'skew', label: 'Skew' },
];

export const MoreIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="4" cy="8" r="1.15" fill="currentColor" />
    <circle cx="8" cy="8" r="1.15" fill="currentColor" />
    <circle cx="12" cy="8" r="1.15" fill="currentColor" />
  </svg>
);
export const TransformPlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export const FilterGlyph = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph">
    <path d="M2.5 4h11l-4.2 5v3.5L6.7 14V9L2.5 4Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
  </svg>
);

// The Filters / Backdrop filters row: a stack of filter functions (blur/brightness/…/
// drop-shadow) edited as one CSS `filter` value. Mirrors TransformsRow.
export function FiltersRow({ prop, label, props }: { prop: string; label: string; props: Props }) {
  const { read, busy } = props;
  const display = displayOf(read(prop));
  // Shared by Filters and Backdrop filters, so both get the eye from here.
  const rows = parseHideable(display.present ? display.value : '', ' ', parseFilters);
  const layers = rows.map((row) => row.item);
  const write = (next: Array<Hideable<Filter>>, options: WriteOptions) => writeValue(prop, serializeHideable(next, ' ', serializeFilters), options, props);
  const stack = useLayerRows({ rows, blank: blankFilter, write });
  const { openIndex } = stack;
  const openLayer = openIndex === undefined ? undefined : layers[openIndex];
  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <EffLabel label={label} prop={prop} props={props} />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={stack.add}
          disabled={busy}
          title={`Add a ${label.toLowerCase()} filter`}
          aria-label="Add a filter"
        >
          <TransformPlusIcon />
        </button>
      </div>
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel={label}
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => {
          const layer = layers[i];
          if (layer === undefined) {
            throw new Error(`Filter layer ${i} is missing`);
          }
          return { preview: <FilterGlyph />, label: filterLabel(layer) };
        }}
      />
      {openIndex !== undefined && stack.anchorElement && openLayer ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel={label} onClose={stack.close}>
          <FilterEditor filter={openLayer} busy={busy} onChange={(next, live) => stack.update(openIndex, { live }, () => next)} />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// Per-type slider config: the unit the slider re-attaches, its coarse range (in value
// units), and how many slider steps map to one unit. The slider is integer-only, so
// `scale` (0–2) runs in hundredths for sub-integer precision; the number field always
// allows a precise value outside the range.
export const AXIS_CONFIG: Record<TransformType, { unit: string; min: number; max: number; steps: number }> = {
  // Move is in rem unless the value itself says otherwise — `steps` is how many
  // slider notches make one unit, so 100 gives hundredths of a rem across a
  // range wide enough to push something off its own width.
  move: { unit: 'rem', min: -20, max: 20, steps: 100 },
  scale: { unit: '', min: 0, max: 2, steps: 100 },
  rotate: { unit: 'deg', min: -180, max: 180, steps: 1 },
  skew: { unit: 'deg', min: -90, max: 90, steps: 1 },
};

// Split "10px" / "1.5" / "45deg" into number + unit (bare number → the type's default
// unit); undefined for var()/calc()/… so the slider disables but the field stays editable.
export function parseAxis(value: string, fallbackUnit: string): { num: number; unit: string } | undefined {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*([a-z%]*)$/i);
  if (!match) {
    return undefined;
  }
  // `none` isn't a real axis unit — never re-attach it (that's what produces `1none`).
  const unit = match[2] ?? '';
  const raw = unit.toLowerCase() === 'none' ? '' : unit;
  return { num: parseFloat(match[1] ?? ''), unit: raw || fallbackUnit };
}

// One transform axis (X / Y / Z): a coarse drag slider beside a precise number field,
// mirroring text-shadow's ShadowLength. The slider drives the numeric part and re-attaches
// the value's unit; the field holds the full value (e.g. `10px`) so var()/calc() and any
// unit survive.
export interface AxisInputProps {
  type: TransformType;
  label: 'X' | 'Y' | 'Z';
  value: string;
  placeholder: string;
  busy: boolean;
  /** Per-frame during a slider drag (before the throttled onLive) — lets a linked pair
   *  mirror this axis smoothly, not just on the throttled write. */
  onPreview?: (value: string) => void;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}
export function AxisInput(props: AxisInputProps) {
  const { type, label, value, placeholder, busy, onPreview, onLive, onCommit } = props;
  const config = AXIS_CONFIG[type];
  const parsed = parseAxis(value, config.unit);
  const unit = parsed?.unit ?? config.unit;
  const fmt = (slider: number): string => `${Number((slider / config.steps).toFixed(4))}${unit}`;
  const { draft, setDraft, focused } = useExternalDraft(value);
  const field = useAxisField({
    draft,
    setDraft,
    focused,
    placeholder,
    busy,
    onPreview,
    onLive,
    onCommit,
  });
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption embed-editor_transform-axis" aria-hidden="true">
        {transformAxisIcon(type, label === 'X' ? 'x' : label === 'Y' ? 'y' : 'z')}
      </span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={Math.round((parsed?.num ?? 0) * config.steps)}
          min={config.min * config.steps}
          max={config.max * config.steps}
          disabled={busy || !parsed}
          ariaLabel={label}
          onPreview={(slider) => {
            const formatted = fmt(slider);
            if (!focused.current) {
              setDraft(formatted);
            }
            onPreview?.(formatted);
          }}
          onInput={(slider) => onLive(fmt(slider))}
          onCommit={(slider) => onCommit(fmt(slider))}
        />
        {/* The same wrapper every single-value field in the panel uses: a
            var() in the axis reads as a chip, a calc() around one tokenises
            like the custom value editor, and the dot picks or swaps the
            variable. Without it the axis was the one field that showed
            `var(--_offset)` as bare text. */}
        <VariableConnect
          code
          ariaLabel={`Connect ${label} to a variable`}
          disabled={busy}
          className="is-fill"
          prop="transform"
          onPick={(binding) => onCommit(binding)}
        >
          <input
            {...field.scrub.input}
            className="u-input embed-editor_size-input embed-editor_shadow-num"
            value={draft}
            {...field.handlers}
            disabled={busy}
            spellCheck={false}
            placeholder={placeholder}
            aria-label={label}
          />
        </VariableConnect>
      </div>
    </div>
  );
}

// The axis field's typing behavior: live writes 100ms after typing stops (undelayed for
// the scrub, which also previews every frame), commit on blur (an empty field commits
// the placeholder), and ↑/↓ stepping. The handlers spread after the scrub's.
export function useAxisField({
  draft,
  setDraft,
  focused,
  placeholder,
  busy,
  onPreview,
  onLive,
  onCommit,
}: {
  draft: string;
  setDraft: (draft: string) => void;
  focused: React.MutableRefObject<boolean>;
  placeholder: string;
  busy: boolean;
  onPreview: ((value: string) => void) | undefined;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const liveNow = (text: string) => {
    const trimmed = text.trim();
    if (trimmed) {
      onLive(trimmed);
    }
  };
  const { live, cancel } = useLiveTimer(liveNow);
  const commit = (text = draft) => {
    onCommit(text.trim() || placeholder);
  };
  const previewScrub = (text: string) => {
    setDraft(text);
    onPreview?.(text);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit(text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: previewScrub,
    onInput: liveNow,
    onCommit: commitScrub,
  });
  const handlers = draftInputHandlers({ focusedRef: focused, setDraft, live, cancel, commit });
  return { scrub, handlers };
}

// The per-layer editor: a Type toggle (Move/Scale/Rotate/Skew) + X/Y/Z fields (Z is
// hidden for Skew, which is 2D). Switching Type resets the axes to that type's identity.
export function TransformEditor({ layer, busy, onChange }: { layer: Transform; busy: boolean; onChange: (patch: TransformPatch, live: boolean) => void }) {
  const placeholder = IDENTITY[layer.type];
  // Scale defaults to linked X & Y (uniform scale, like Webflow); the lock toggles it.
  const [locked, setLocked] = useState(true);
  const linkXY = layer.type === 'scale' && locked;
  const { values, bump } = useAxisValues(layer);
  // An axis field's handlers, given the patch one of its edits makes.
  const emit = (patch: TransformPatch, options: WriteOptions) => {
    bump(patch);
    onChange(patch, options.live);
  };
  const handlersFor = (patchOf: (value: string) => TransformPatch) => ({
    onPreview: (value: string) => bump(patchOf(value)),
    onLive: (value: string) => emit(patchOf(value), { live: true }),
    onCommit: (value: string) => emit(patchOf(value), { live: false }),
  });
  const axes = axisFields({ values, linkXY, handlersFor });
  const retype = (type: TransformType) => emit(retypeTransform(type), { live: false });
  const shared = { placeholder, busy };
  return (
    <div className="embed-editor_type-shadow-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
        <SegmentedControl value={layer.type} options={TRANSFORM_TYPES} onChange={retype} ariaLabel="Transform type" />
      </div>
      {layer.type === 'scale' ? (
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="X" {...shared} {...axes.x} />
            <AxisInput type="scale" label="Y" {...shared} {...axes.y} />
          </div>
          <ScaleLock locked={locked} busy={busy} onToggle={() => setLocked((wasLocked) => !wasLocked)} />
        </div>
      ) : (
        <>
          <AxisInput type={layer.type} label="X" {...shared} {...axes.x} />
          <AxisInput type={layer.type} label="Y" {...shared} {...axes.y} />
        </>
      )}
      {!hasZ(layer.type) ? undefined : layer.type === 'scale' ? (
        // Z reserves the same right gutter the lock button occupies, so its slider +
        // number field line up with X and Y.
        <div className="embed-editor_transform-lock-group">
          <div className="embed-editor_transform-lock-rows">
            <AxisInput type="scale" label="Z" {...shared} {...axes.z} />
          </div>
          <span className="embed-editor_transform-lock-spacer" aria-hidden="true" />
        </div>
      ) : (
        <AxisInput type={layer.type} label="Z" {...shared} {...axes.z} />
      )}
    </div>
  );
}

// One axis edit → the axes it actually drives (X and Y move together when linked).
export function axisFields({
  values,
  linkXY,
  handlersFor,
}: {
  values: { x: string; y: string; z: string };
  linkXY: boolean;
  handlersFor: (patchOf: (value: string) => TransformPatch) => Omit<AxisField, 'value'>;
}): AxisFields {
  const xPatch = (value: string): TransformPatch => (linkXY ? { x: value, y: value } : { x: value });
  const yPatch = (value: string): TransformPatch => (linkXY ? { x: value, y: value } : { y: value });
  return {
    x: { value: values.x, ...handlersFor(xPatch) },
    y: { value: values.y, ...handlersFor(yPatch) },
    z: { value: values.z, ...handlersFor((value) => ({ z: value })) },
  };
}

// One axis field's value and the handlers its edits call.
export interface AxisField {
  value: string;
  onPreview: (value: string) => void;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}
export type AxisFields = Record<'x' | 'y' | 'z', AxisField>;

// Optimistic axis values so a LINKED drag moves BOTH sliders together, every frame. A
// live/preview write previews to the canvas but doesn't refresh the read model `layer`
// derives from, so the partner slider (driven by its value prop) would otherwise sit
// still until release. Every edit is mirrored here (`bump`) and these feed the fields.
export function useAxisValues(layer: Transform) {
  const [values, setValues] = useState<{ x: string; y: string; z: string }>({
    x: layer.x,
    y: layer.y,
    z: layer.z,
  });
  useEffect(() => {
    setValues({ x: layer.x, y: layer.y, z: layer.z });
  }, [layer.x, layer.y, layer.z]);
  const bump = (patch: TransformPatch) =>
    setValues((current) => {
      const next = { ...current, ...patch };
      return { x: next.x, y: next.y, z: next.z };
    });
  return { values, bump };
}

export function ScaleLock({ locked, busy, onToggle }: { locked: boolean; busy: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className={`embed-editor_transform-lock ${locked ? 'is-locked' : ''}`}
      onClick={onToggle}
      disabled={busy}
      aria-pressed={locked}
      title={locked ? 'Unlink X & Y' : 'Link X & Y'}
      aria-label={locked ? 'Unlink X and Y' : 'Link X and Y'}
    >
      {locked ? LockIcon : UnlockIcon}
    </button>
  );
}

// The transform stack: header + add, a reorderable/removable layer list, and the
// per-layer editor in a popup — the same layer + component functionality as text-shadow.
export function TransformsRow({ props }: { props: Props }) {
  const { read, busy, setProp, clearProp } = props;
  const display = displayOf(read('transform'));
  // A self perspective lives in this same value, as a perspective() function,
  // and parseTransforms drops every function it doesn't recognise — so lift it
  // out before the layers are read and put it back in front on the way out, or
  // it vanishes the next time any layer is touched. See lib/transform-settings.
  const { distance: selfPerspective, rest } = takeSelfPerspective(display.present ? display.value : '');
  // Rows rather than bare layers: a hidden one is still in the list and still
  // in the CSS, commented out (see lib/hideable.ts).
  const rows = parseHideable(rest, ' ', parseTransforms);
  const layers = rows.map((row) => row.item);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLButtonElement>(null);
  const put = (next: Array<Hideable<Transform>>, distance: string, options: WriteOptions) => {
    const value = withSelfPerspective(serializeHideable(next, ' ', serializeTransforms), distance);
    writeValue('transform', value, options, props);
  };
  const write = (next: Array<Hideable<Transform>>, options: WriteOptions) => put(next, selfPerspective, options);
  const stack = useLayerRows({ rows, blank: blankTransform, write });
  const { openIndex } = stack;
  const openLayer = openIndex === undefined ? undefined : layers[openIndex];
  return (
    <div className="embed-editor_type-shadows">
      <TransformsHead
        props={props}
        settingsOpen={settingsOpen}
        settingsRef={settingsRef}
        onToggleSettings={() => setSettingsOpen((wasOpen) => !wasOpen)}
        onAdd={stack.add}
      />
      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Transforms"
        onOpen={stack.open}
        onReorder={stack.reorder}
        onRemove={stack.remove}
        isHidden={stack.isHidden}
        onToggleHidden={stack.toggle}
        renderRow={(i) => transformRow(layers, i)}
      />
      {openIndex !== undefined && stack.anchorElement && openLayer ? (
        <LayerPopover anchorEl={stack.anchorElement} ariaLabel="Transform" onClose={stack.close}>
          <TransformEditor layer={openLayer} busy={busy} onChange={(patch, live) => stack.update(openIndex, { live }, (item) => ({ ...item, ...patch }))} />
        </LayerPopover>
      ) : undefined}
      {settingsOpen && settingsRef.current ? (
        <LayerPopover anchorEl={settingsRef.current} ariaLabel="Transform settings" onClose={() => setSettingsOpen(false)}>
          <TransformSettings
            read={read}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            selfPerspective={selfPerspective}
            onSelfPerspective={(distance, live) => put(rows, distance, { live })}
          />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// A row of the transform list: its type's glyph and its label.
export function transformRow(layers: Transform[], i: number) {
  const layer = layers[i];
  if (layer === undefined) {
    throw new Error(`Transform layer ${i} is missing`);
  }
  return { preview: transformTypeIcon(layer.type), label: transformLabel(layer) };
}

// The transforms header: the label, the settings (⋯) toggle, and add.
export function TransformsHead({
  props,
  settingsOpen,
  settingsRef,
  onToggleSettings,
  onAdd,
}: {
  props: Props;
  settingsOpen: boolean;
  settingsRef: React.RefObject<HTMLButtonElement>;
  onToggleSettings: () => void;
  onAdd: () => void;
}) {
  const { busy } = props;
  return (
    <div className="embed-editor_bg-layers-head">
      <EffLabel label="2D & 3D transforms" prop="transform" props={props} />
      <div className="embed-editor_bg-layers-actions">
        <button
          type="button"
          ref={settingsRef}
          className={`embed-editor_icon-btn ${settingsOpen ? 'is-active' : ''}`}
          onClick={onToggleSettings}
          disabled={busy}
          title="Transform settings"
          aria-label="Transform settings"
          aria-expanded={settingsOpen}
        >
          <MoreIcon />
        </button>
        <button type="button" className="embed-editor_icon-btn" onClick={onAdd} disabled={busy} title="Add a transform" aria-label="Add a transform">
          <TransformPlusIcon />
        </button>
      </div>
    </div>
  );
}
