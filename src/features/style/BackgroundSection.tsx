import { useState } from 'react';
import { layerPreviewStyle, useResolvedCustomProperties } from './GradientCode';
import Select from './components/Select';
import { blankLayer, layerLabel, parseLayers, serializeLayers, splitBackgroundShorthand, type BgLayer } from './model/background';
import LayerList from './LayerList';
import { PlusIcon } from './components/MenuParts';
import { openAfterRemoval } from './model/fieldHooks';
import { displayOf } from './model/styleDisplay';
import ImportantMark from './components/ImportantMark';
import { type Props, BgLabel, BgField, LayerEditorModal } from './BackgroundKit';
import { imageUrlOf, assetSourceCandidates, FallbackImg } from './BackgroundLayerFields';
import { LayerEditor } from './BackgroundLayerEditor';

// The Backgrounds section — Webflow parity. `background` is a stack of layers
// (images + gradients) painted over a single background-color. The layer list
// reorders / adds / removes / edits layers; each layer edit re-serializes the
// five comma-separated longhands (see lib/background). Color and Clipping are
// single-value controls. Everything is driven by the resolved model (blue when
// the picked selector sets it, orange via another selector, clear menu, etc.).
//
// Deferred (still editable as raw text where relevant): the asset picker for
// images and a visual gradient editor — a layer's value is edited as its CSS.

// ─────────────────────────── Section ───────────────────────────

export default function BackgroundSection(props: Props) {
  const { read, busy, setProp, clearProp, onProvenance, onSelectSelector } = props;
  const stack = useLayerStack(props);
  const { layers, applyLayers, openLayer, setOpenLayer } = stack;
  // The layers come from the `background` shorthand when no `background-image`
  // is set (useLayerStack), so the label does too: `.divider::before { background:
  // radial-gradient(…) }` set the layers and left "Image & gradient" unlit.
  const labelProp = layerSourceProp(read);
  return (
    <div className="embed-editor_size embed-editor_background">
      {/* Image & gradient — the layer stack (top layer first). */}
      <div className="embed-editor_bg-layers-head">
        <BgLabel
          label="Image & gradient"
          prop={labelProp}
          d={displayOf(read(labelProp))}
          contributors={read(labelProp)?.contributors ?? []}
          busy={busy}
          onClear={() => applyLayers([])}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <button
          type="button"
          className="embed-editor_icon-btn"
          onClick={stack.addLayer}
          disabled={busy}
          title="Add a layer"
          aria-label="Add a background layer"
        >
          <PlusIcon />
        </button>
      </div>

      <LayerList
        count={layers.length}
        busy={busy}
        ariaLabel="Background layers"
        onOpen={(i) => setOpenLayer((current) => (current === i ? undefined : i))}
        onReorder={stack.reorder}
        onRemove={stack.removeLayer}
        renderRow={(i) => layerRow(layers, i)}
      />

      {openLayer !== undefined && layers[openLayer] ? (
        <LayerEditorModal onClose={() => setOpenLayer(undefined)}>
          <LayerEditor
            layers={layers}
            index={openLayer}
            busy={busy}
            setProp={setProp}
            clearProp={clearProp}
            liveSetProp={props.liveSetProp}
            applyLayers={applyLayers}
          />
        </LayerEditorModal>
      ) : undefined}

      {/* Colour — painted behind every layer. */}
      <div className="embed-editor_size-row">
        <BgField {...props} prop="background-color" label="Color" placeholder="transparent" swatchLabel="Background color" />
      </div>

      <ClippingRow {...props} />
    </div>
  );
}

// Clipping — background-clip. "None" writes border-box explicitly.
function ClippingRow(props: Props) {
  const { read, busy, setProp, clearProp } = props;
  const clipDisplay = displayOf(read('background-clip'));
  const clip = clipDisplay.present ? clipDisplay.value.trim() : 'border-box';
  return (
    <div className="embed-editor_size-row">
      <BgLabel
        label="Clipping"
        prop="background-clip"
        d={clipDisplay}
        contributors={read('background-clip')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp('background-clip')}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      {/* No custom field: a flagged value is marked, and picks keep the flag. */}
      <ImportantMark important={clipDisplay.important}>
        <Select
          value={clip}
          options={CLIP_OPTIONS}
          onChange={(next) => setProp('background-clip', next, clipDisplay.important)}
          onPreview={(next) => props.liveSetProp('background-clip', next ?? undefined, clipDisplay.important)}
          ariaLabel="Background clipping"
          disabled={busy}
        />
      </ImportantMark>
    </div>
  );
}

const CLIP_OPTIONS = [
  { value: 'border-box', label: 'None' },
  { value: 'padding-box', label: 'Clip background to padding' },
  { value: 'content-box', label: 'Clip background to content' },
  { value: 'text', label: 'Clip background to text' },
];

/** The property the layer stack is read from: `background-image`, or the
 *  `background` shorthand when only that sets the layers (as useLayerStack). */
export function layerSourceProp(read: Props['read']): 'background-image' | 'background' {
  const image = displayOf(read('background-image'));
  if (image.present && image.value.trim() !== '' && image.value.trim().toLowerCase() !== 'none') {
    return 'background-image';
  }
  return displayOf(read('background')).present ? 'background' : 'background-image';
}

// A row of the layer list: its thumbnail and its label.
function layerRow(layers: BgLayer[], i: number) {
  const layer = layers[i];
  if (layer === undefined) {
    throw new Error(`Background layer ${i} is missing`);
  }
  return { preview: <LayerPreview layer={layer} />, label: layerLabel(layer.image) };
}

// A layer's thumbnail in the list.
function LayerPreview({ layer }: { layer: BgLayer }) {
  const url = imageUrlOf(layer.image);
  // A gradient is CSS this window paints, with the variables it reads filled in
  // from the selected element (this document defines none of them, so a
  // `var(--divider-size)` gradient painted nothing), at the layer's own size
  // and tiling when it has them.
  const values = useResolvedCustomProperties([layer.image, layer.size, layer.position]);
  if (!url) {
    return (
      <span
        className="embed-editor_bg-layer-preview"
        style={{ backgroundSize: 'cover', backgroundPosition: 'center', ...layerPreviewStyle(layer, values) }}
        aria-hidden="true"
      />
    );
  }
  // An image comes off disk, and through an <img> rather than a CSS
  // background — the file can be reached by more than one url scheme
  // and only an element can try the next one when the first does not
  // load. A background that fails just paints nothing, with no way to
  // tell that from an image that is genuinely blank.
  return (
    <span className="embed-editor_bg-layer-preview is-image" aria-hidden="true">
      <FallbackImg srcs={assetSourceCandidates(url)} />
    </span>
  );
}

// The layer stack, which layer's editor is open, and the edits that write the stack
// back to the longhands.
function useLayerStack({ read, setProp, clearProp }: Props) {
  const valueOf = (prop: string) => displayOf(read(prop)).value;

  // Prefer the individual longhands; if the background is set via the `background`
  // SHORTHAND (Webflow emits it that way after adding a colour-overlay layer), fall
  // back to parsing that so the layers still load. Editing then migrates to
  // longhands (the shorthand is cleared) so writes are unambiguous.
  const rawImage = valueOf('background-image').trim();
  const shorthand = valueOf('background').trim();
  const fromShorthand = (!rawImage || rawImage.toLowerCase() === 'none') && !!shorthand;
  const longhands = fromShorthand
    ? splitBackgroundShorthand(shorthand)
    : {
        image: valueOf('background-image'),
        size: valueOf('background-size'),
        position: valueOf('background-position'),
        repeat: valueOf('background-repeat'),
        attachment: valueOf('background-attachment'),
        color: '',
      };
  const layers = parseLayers(longhands);

  // When sourced from the shorthand, replace it: clear `background` and preserve its
  // colour into background-color.
  const applyLayers = (next: BgLayer[]) => {
    writeLonghands(serializeLayers(next), { read, setProp, clearProp });
    if (fromShorthand) {
      clearProp('background');
      if (longhands.color && !valueOf('background-color').trim()) {
        setProp('background-color', longhands.color, false);
      }
    }
  };

  const [openLayer, setOpenLayer] = useState<number | undefined>(undefined);
  const addLayer = () => {
    // Default a new layer to an image (Webflow parity) — switch to a gradient via Type.
    applyLayers([blankLayer('image'), ...layers]);
    setOpenLayer(0);
  };
  const removeLayer = (index: number) => {
    applyLayers(layers.filter((_, i) => i !== index));
    setOpenLayer((current) => openAfterRemoval(current, index));
  };
  const reorder = (from: number, to: number) => {
    if (from === to) {
      return;
    }
    const next = [...layers];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) {
      return;
    }
    next.splice(to, 0, moved);
    applyLayers(next);
    setOpenLayer((current) => (current === from ? to : current));
  };
  return { layers, applyLayers, openLayer, setOpenLayer, addLayer, removeLayer, reorder };
}

// Write the stack back to the five longhands, but only those whose value actually
// changed on the picked selector. Each setProp/clearProp is a separate native op that
// toggles busy + re-reads from Webflow, so rewriting all five longhands on every change
// flashes the panel and echoes unchanged values back to Webflow.
function writeLonghands(serialized: ReturnType<typeof serializeLayers>, { read, setProp, clearProp }: Pick<Props, 'read' | 'setProp' | 'clearProp'>) {
  // The value the PICKED selector itself sets for `prop` (undefined when it doesn't set
  // it — a value inherited from another selector doesn't count).
  const ownValue = (prop: string): string | undefined => {
    const display = displayOf(read(prop));
    return display.present && display.isSelected ? display.value.trim() : undefined;
  };
  const write = (prop: string, value: string) => {
    const own = ownValue(prop);
    const trimmed = value.trim();
    if (trimmed) {
      if (own !== trimmed) {
        setProp(prop, trimmed, false);
      }
    } else if (own !== undefined) {
      clearProp(prop);
    }
  };
  write('background-image', serialized.image);
  write('background-size', serialized.size);
  write('background-position', serialized.position);
  write('background-repeat', serialized.repeat);
  write('background-attachment', serialized.attachment);
}
