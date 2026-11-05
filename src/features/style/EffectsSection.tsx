import SegmentedField from './SegmentedField';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import { displayOf, withImportant } from './model/styleDisplay';
import { type Props, EffLabel, LiveText, BLEND_MODES, CURSORS, OUTLINE_OPTIONS, EVENTS_OPTIONS, BLEND_SET, CURSOR_SET, PresetSelectRow } from './EffectsKit';
import { OpacityRow } from './OpacityRow';
import { FiltersRow, TransformsRow } from './TransformsRow';
import { TransitionsRow } from './TransitionsRow';
import { BoxShadowsRow } from './BoxShadowsRow';
import { ClipPathRow } from './ClipPathRow';

// The Effects section (Webflow parity): blending, opacity, outline, box shadows,
// transforms, transitions, filters, backdrop filters, cursor, and pointer-events.
// Each control is driven by the resolved model (blue when the picked selector sets
// it, orange via another selector, a clear menu on the label). The list-style
// effects (shadows/transforms/…) edit their raw CSS value for now.

// The outline's colour: the swatch and the field beside it, both showing a drag
// as it happens. The drag writes to the canvas, not to the model the field
// reads, so without this the page moves under the pointer while the number
// sits still (see liveColor.ts).
function OutlineColor({ props, value, important }: { props: Props; value: string; important: boolean }) {
  const { busy, setProp, liveSetProp } = props;
  const [shown, noteLive] = useLiveColor(value);
  return (
    <>
      <ColorSwatch
        value={shown}
        busy={busy}
        ariaLabel="Outline color"
        onChange={(color, live) => {
          noteLive(live ? color : undefined);
          // The swatch picks a colour, not the flag: a flagged colour stays so.
          if (live) {
            liveSetProp('outline-color', color, important);
          } else {
            setProp('outline-color', color, important);
          }
        }}
      />
      <LiveText
        prop="outline-color"
        placeholder="currentColor"
        props={props}
        {...(shown === value ? {} : { dragging: withImportant({ value: shown, important }) })}
      />
    </>
  );
}

export default function EffectsSection(props: Props) {
  const { read, busy, setProp } = props;
  const events = displayOf(read('pointer-events'));

  return (
    <div className="embed-editor_size embed-editor_effects">
      <PresetSelectRow
        prop="mix-blend-mode"
        label="Blending"
        options={BLEND_MODES}
        presets={BLEND_SET}
        fallback="normal"
        placeholder="mix-blend-mode"
        props={props}
      />

      <OpacityRow props={props} />
      <OutlineRows props={props} />

      <BoxShadowsRow props={props} />
      <TransformsRow props={props} />
      <TransitionsRow props={props} />
      <FiltersRow prop="filter" label="Filters" props={props} />
      <FiltersRow prop="backdrop-filter" label="Backdrop filters" props={props} />

      <ClipPathRow props={props} />

      <PresetSelectRow
        prop="cursor"
        label="Cursor"
        options={CURSORS}
        presets={CURSOR_SET}
        fallback="auto"
        placeholder="cursor"
        props={props}
        allowCustom={false}
      />

      <div className="embed-editor_size-row">
        <EffLabel label="Events" prop="pointer-events" props={props} />
        <SegmentedField
          value={events.present ? events.value : ''}
          important={events.important}
          options={EVENTS_OPTIONS}
          prop="pointer-events"
          fallback="auto"
          busy={busy}
          onCommit={(next, imp) => setProp('pointer-events', next, imp)}
          ariaLabel="Pointer events"
        />
      </div>
    </div>
  );
}

// Outline: its style, width and offset, and colour.
function OutlineRows({ props }: { props: Props }) {
  const { read, busy, setProp } = props;
  const outline = displayOf(read('outline-style'));
  const outlineColor = displayOf(read('outline-color'));
  return (
    <>
      <div className="embed-editor_size-row">
        <EffLabel label="Outline" prop="outline-style" props={props} />
        <SegmentedField
          value={outline.present ? outline.value : ''}
          important={outline.important}
          options={OUTLINE_OPTIONS}
          prop="outline-style"
          fallback="none"
          busy={busy}
          onCommit={(next, imp) => setProp('outline-style', next, imp)}
          ariaLabel="Outline style"
        />
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Width" prop="outline-width" props={props} />
        <div className="embed-editor_eff-outline-pair">
          <LiveText prop="outline-width" placeholder="0" props={props} />
          <EffLabel label="Offset" prop="outline-offset" props={props} />
          <LiveText prop="outline-offset" placeholder="0" props={props} />
        </div>
      </div>
      <div className="embed-editor_size-row">
        <EffLabel label="Color" prop="outline-color" props={props} />
        <div className="embed-editor_bg-inline">
          <OutlineColor props={props} value={outlineColor.present ? outlineColor.value : ''} important={outlineColor.important} />
        </div>
      </div>
    </>
  );
}
