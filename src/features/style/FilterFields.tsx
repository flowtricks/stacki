import Select, { type SelectOption } from './components/Select';
import { ShadowColorRow, ShadowLength } from './ShadowFields';
import { AngleControl } from './GradientEditor';
import { FILTER_GROUPS, FILTER_META, retypeFilter, type Filter, type FilterPatch, type FilterType } from './model/filter';

// The per-filter editor (Webflow's Filters): a grouped Filter-type dropdown, then the
// controls for that type — Amount (%/px/…, any unit), Hue rotate's Angle dial, or Drop
// shadow's X / Y / Blur / Color. Reuses the shadow number/color rows (value + unit shown
// inline, any unit accepted) and the gradient angle control.

const TYPE_OPTIONS = FILTER_GROUPS.flatMap<SelectOption<string>>((group) => [
  { value: `__h_${group.heading}`, label: group.heading, heading: true },
  ...group.types.map((type) => ({ value: type, label: FILTER_META[type].label, indent: true })),
]);

function isFilterType(value: string): value is FilterType {
  return value in FILTER_META;
}

// How a change reaches the panel: live while dragging or typing, or committed.
interface SetOptions {
  readonly live: boolean;
}
type SetFilter = (patch: FilterPatch, options: SetOptions) => void;

export default function FilterEditor({ filter, busy, onChange }: { filter: Filter; busy: boolean; onChange: (next: Filter, live: boolean) => void }) {
  const meta = FILTER_META[filter.type];
  const set: SetFilter = (patch, options) => onChange({ ...filter, ...patch }, options.live);
  return (
    <div className="embed-editor_filter-editor">
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Filter</span>
        <Select
          value={filter.type}
          options={TYPE_OPTIONS}
          onChange={(value) => {
            if (isFilterType(value)) {
              onChange(retypeFilter(value), false);
            }
          }}
          ariaLabel="Filter type"
          disabled={busy}
          searchable
        />
      </div>

      {meta.control === 'amount' ? (
        <ShadowLength
          label="Amount"
          value={filter.amount}
          range={{ min: meta.min, max: meta.max }}
          defaultUnit={meta.unit}
          busy={busy}
          onLive={(value) => set({ amount: value }, { live: true })}
          onCommit={(value) => set({ amount: value }, { live: false })}
        />
      ) : meta.control === 'angle' ? (
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Angle</span>
          <AngleControl angle={filter.amount || '0deg'} busy={busy} onChange={(angle, live) => set({ amount: angle }, { live })} />
        </div>
      ) : (
        <DropShadowFields filter={filter} busy={busy} set={set} />
      )}
    </div>
  );
}

// Drop shadow's X / Y / Blur / Color rows.
function DropShadowFields({ filter, busy, set }: { filter: Filter; busy: boolean; set: SetFilter }) {
  return (
    <>
      <ShadowLength
        label="X"
        value={filter.x}
        busy={busy}
        onLive={(value) => set({ x: value }, { live: true })}
        onCommit={(value) => set({ x: value }, { live: false })}
      />
      <ShadowLength
        label="Y"
        value={filter.y}
        busy={busy}
        onLive={(value) => set({ y: value }, { live: true })}
        onCommit={(value) => set({ y: value }, { live: false })}
      />
      <ShadowLength
        label="Blur"
        value={filter.blur}
        busy={busy}
        onLive={(value) => set({ blur: value }, { live: true })}
        onCommit={(value) => set({ blur: value }, { live: false })}
      />
      <ShadowColorRow color={filter.color} busy={busy} onChange={(color, live) => set({ color }, { live })} />
    </>
  );
}
