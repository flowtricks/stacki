// The editor for one background layer: its type switch, the fields for its
// kind, its raw value and tiling (BackgroundSection.tsx).

import SegmentedControl from './components/SegmentedControl';
import { blankLayer, layerKind, serializeLayers, type BgLayer, type LayerKind } from './model/background';
import { blankGradientOf, parseGradient, serializeGradient, type GradientType } from './model/gradient';
import GradientEditor from './GradientEditor';
import { type WriteOptions, replaceLayer } from './BackgroundKit';
import {
  LayerLonghandField,
  TYPE_OPTIONS,
  type LayerFieldProps,
  LayerSizeField,
  LayerPositionField,
  TILE_OPTIONS,
  FIXED_OPTIONS,
  LayerImageField,
  LayerColorField,
} from './BackgroundLayerFields';

export type LayerEditorProps = LayerFieldProps & { applyLayers: (layers: BgLayer[]) => void };

export function LayerEditor(props: LayerEditorProps) {
  const { layers, index, busy, setProp, liveSetProp } = props;
  const layer = layers[index];
  if (!layer) {
    return undefined;
  }
  const kind = layerKind(layer.image);
  const displayKind = displayKindOf(kind);
  const typeRow = (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Type</span>
      <SegmentedControl
        options={TYPE_OPTIONS}
        value={displayKind}
        onChange={(next) => setLayerKind({ next, displayKind, props })}
        ariaLabel="Layer type"
        disabled={busy}
      />
    </div>
  );

  // A colour overlay is a solid fill — just Type + Colour (no size/position/tile).
  if (displayKind === 'color') {
    return (
      <div className="embed-editor_bg-editor">
        {typeRow}
        <div className="embed-editor_size-row">
          <span className="embed-editor_size-label embed-editor_bg-caption">Color</span>
          <LayerColorField layers={layers} index={index} busy={busy} setProp={setProp} liveSetProp={liveSetProp} />
        </div>
      </div>
    );
  }

  // A gradient layer gets Webflow's visual editor (position grid, size presets,
  // stops bar, repeat) — its Size/Position edit the gradient's INTERNAL geometry,
  // not the background-size/position longhands. A gradient we can't parse falls
  // back to the raw text fields below.
  const isGradient = kind === 'linear' || kind === 'radial' || kind === 'conic';
  const gradient = isGradient ? parseGradient(layer.image) : undefined;
  const writeImage = (image: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { image })).image;
    if (options.live) {
      liveSetProp('background-image', list, false);
    } else {
      setProp('background-image', list, false);
    }
  };

  return (
    <div className="embed-editor_bg-editor">
      {typeRow}
      {gradient ? (
        <GradientEditor gradient={gradient} busy={busy} onChange={(next, live) => writeImage(serializeGradient(next), { live })} />
      ) : (
        <LayerRawFields displayKind={displayKind} props={props} />
      )}
      {/* Tile (background-repeat) + Fixed (background-attachment) apply to image
          layers only — Webflow omits them for gradients (which have their own
          repeat toggle inside the gradient editor). */}
      {!isGradient ? <LayerTileFields layer={layer} props={props} /> : undefined}
    </div>
  );
}

// The Type buttons show four kinds; a conic/unknown value maps to the nearest.
export function displayKindOf(kind: ReturnType<typeof layerKind>): LayerKind {
  if (kind === 'color' || kind === 'linear' || kind === 'radial') {
    return kind;
  }
  return kind === 'conic' ? 'linear' : 'image';
}

export const isGradientType = (value: LayerKind): value is GradientType => value === 'linear' || value === 'radial' || value === 'conic';

// Switch a layer's kind. Switching between gradient kinds keeps the colours.
//
// The stops are the work — picked, positioned, adjusted — and the kind is just how
// they are painted. Seeding a blank layer threw them away, so trying radial to see how
// it looked cost the whole gradient and there was no way back to it.
//
// The geometry does NOT carry, because it does not mean the same thing: an angle is a
// direction for a linear gradient and nothing at all for a radial one, and a centre
// point is the reverse. Each kind starts on its own defaults and keeps the colours.
export function setLayerKind({ next, displayKind, props }: { next: LayerKind; displayKind: LayerKind; props: LayerEditorProps }) {
  const { layers, index, applyLayers } = props;
  const layer = layers[index];
  if (next === displayKind || layer === undefined) {
    return;
  }
  if (isGradientType(next) && isGradientType(displayKind)) {
    const current = parseGradient(layer.image);
    if (current?.stops?.length) {
      const carried = serializeGradient({
        ...blankGradientOf(next),
        repeating: current.repeating,
        stops: current.stops,
      });
      applyLayers(replaceLayer(layers, index, { image: carried }));
      return;
    }
  }
  const seeded = blankLayer(next);
  applyLayers(replaceLayer(layers, index, { image: seeded.image }));
}

// An image layer's picker, or an unparsed gradient's raw text; then Size and Position.
export function LayerRawFields({ displayKind, props }: { displayKind: LayerKind; props: LayerEditorProps }) {
  const { applyLayers, ...fieldProps } = props;
  return (
    <>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">{displayKind === 'image' ? 'Image' : 'Gradient'}</span>
        {displayKind === 'image' ? (
          <LayerImageField layers={fieldProps.layers} index={fieldProps.index} busy={fieldProps.busy} applyLayers={applyLayers} />
        ) : (
          <LayerLonghandField {...fieldProps} field="image" prop="background-image" label="Layer value" placeholder="gradient(…)" />
        )}
      </div>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">Size</span>
        <LayerSizeField {...fieldProps} />
      </div>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <span className="embed-editor_size-label embed-editor_bg-caption">Position</span>
        <LayerPositionField {...fieldProps} />
      </div>
    </>
  );
}

// Tile (background-repeat) and Fixed (background-attachment); each default is written
// as an empty value.
export function LayerTileFields({ layer, props }: { layer: BgLayer; props: LayerEditorProps }) {
  const { layers, index, busy, applyLayers } = props;
  return (
    <>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Tile</span>
        <SegmentedControl
          options={TILE_OPTIONS}
          value={['repeat-x', 'repeat-y', 'no-repeat'].includes(layer.repeat.trim()) ? layer.repeat.trim() : 'repeat'}
          onChange={(next) => applyLayers(replaceLayer(layers, index, { repeat: next === 'repeat' ? '' : next }))}
          ariaLabel="Layer tile"
          disabled={busy}
        />
      </div>
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Fixed</span>
        <SegmentedControl
          options={FIXED_OPTIONS}
          value={layer.attachment.trim() === 'fixed' ? 'fixed' : 'scroll'}
          onChange={(next) => applyLayers(replaceLayer(layers, index, { attachment: next === 'scroll' ? '' : next }))}
          ariaLabel="Layer fixed"
          disabled={busy}
        />
      </div>
    </>
  );
}
