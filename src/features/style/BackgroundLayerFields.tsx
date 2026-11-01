// The fields one background layer is edited with: its longhands, type, size,
// position, tiling, image and colour, and the icons they show
// (BackgroundSection.tsx).

import { useEffect, useId, useState } from 'react';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import useScrub from './components/useScrub';
import { colorOverlayImage, colorOverlayOf, serializeLayers, splitTopLevelSpaces, type BgLayer, type LayerKind } from './model/background';
import VariableConnect from './VariableConnect';
import { requestAsset } from '../../ui/assetPick';
import { assetValueFor } from '../../ui/assetPath';
import { sourceCandidates } from '../../ui/AssetThumb';
import { getHost } from './model/host';
import ColorSwatch from './components/ColorSwatch';
import { commitInPlace } from './model/commitInPlace';
import { useExternalDraft } from './model/fieldHooks';
import { type SetProp, type ClearProp, type LiveSetProp, type WriteOptions, replaceLayer, stepInPlace } from './BackgroundKit';

// ─────────────────────────── Layer editor ───────────────────────────

// A field bound to one longhand of one layer. Recomputes that longhand's whole
// comma list from `layers` (with the edit applied) and writes it live / on blur.
export function LayerLonghandField({
  field,
  prop,
  label,
  placeholder,
  ...fieldProps
}: LayerFieldProps & {
  field: keyof BgLayer;
  prop: string;
  label: string;
  placeholder: string;
}) {
  const { layers, index, busy, setProp } = fieldProps;
  const { draft, setDraft, focused } = useExternalDraft(layers[index]?.[field] ?? '');

  const commit = (options: WriteOptions, text = draft) => {
    const trimmed = text.trim();
    const next = layers.map((layer, i) => (i === index ? { ...layer, [field]: trimmed } : layer));
    const list = serializeLayers(next)[field === 'image' ? 'image' : field];
    writeLayerList(prop, list, options, fieldProps);
  };
  const commitScrub = (text: string) => {
    setDraft(text);
    commit({ live: false }, text);
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: (text) => commit({ live: true }, text),
    onCommit: commitScrub,
  });

  return (
    <VariableConnect code ariaLabel={`Connect ${label} to a variable`} disabled={busy} prop={prop} onPick={(binding) => setProp(prop, binding, false)}>
      <input
        {...scrub.input}
        className="u-input embed-editor_size-input"
        value={draft}
        onChange={(event) => {
          setDraft(event.target.value);
          commit({ live: true }, event.target.value);
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commit({ live: false });
        }}
        onKeyDown={(event) => {
          const stepped = stepInPlace(event);
          if (stepped !== undefined) {
            setDraft(stepped);
          }
        }}
        disabled={busy}
        spellCheck={false}
        placeholder={placeholder}
        aria-label={label}
      />
    </VariableConnect>
  );
}

// Write one longhand's whole comma list: live writes skip an empty list; a committed
// empty list clears the property.
export function writeLayerList(prop: string, list: string, options: WriteOptions, writers: Pick<LayerFieldProps, 'setProp' | 'clearProp' | 'liveSetProp'>) {
  if (options.live) {
    if (list) {
      writers.liveSetProp(prop, list, false);
    }
    return;
  }
  if (list) {
    writers.setProp(prop, list, false);
  } else {
    writers.clearProp(prop);
  }
}

export const BACKGROUND_IMAGE_ICON_FIRST_PATH = 'M6 7C6.55228 7 7 6.55228 7 6C7 5.44772 6.55228 5 6 5C5.44772 5 5 5.44772 5 6' + 'C5 6.55228 5.44772 7 6 7Z';
export const BACKGROUND_IMAGE_ICON_SECOND_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' +
  'C2.44772 14 2 13.5523 2 13V3ZM13 3L3 3V12.2929L8 7.29289L13 12.2929V3ZM8 8.70711' +
  'L12.2929 13H3.70711L8 8.70711Z';

// Layer-type icons (Webflow's), currentColor-driven. Gradient icons use a useId
// gradient id so multiple instances never collide.
export function BgImageIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_IMAGE_ICON_FIRST_PATH} fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d={BACKGROUND_IMAGE_ICON_SECOND_PATH} fill="currentColor" />
    </svg>
  );
}
export const BACKGROUND_LINEAR_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' + 'C2.44772 14 2 13.5523 2 13V3Z';

export function BgLinearIcon() {
  const id = useId();
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_LINEAR_ICON_PATH} fill={`url(#${id})`} />
      <defs>
        <linearGradient id={id} x1="14" y1="2" x2="14" y2="14" gradientUnits="userSpaceOnUse">
          <stop stopColor="currentColor" />
          <stop offset="1" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
    </svg>
  );
}
export const BACKGROUND_RADIAL_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' + 'C2.44772 14 2 13.5523 2 13V3Z';

export function BgRadialIcon() {
  const id = useId();
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_RADIAL_ICON_PATH} fill={`url(#${id})`} />
      <defs>
        <radialGradient id={id} cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(8 8) rotate(90) scale(6)">
          <stop stopColor="currentColor" stopOpacity="0" />
          <stop offset="0.166246" stopColor="currentColor" stopOpacity="0" />
          <stop offset="1" stopColor="currentColor" />
        </radialGradient>
      </defs>
    </svg>
  );
}
export const BACKGROUND_COLOR_ICON_PATH =
  'M2 3C2 2.44772 2.44772 2 3 2H13C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3' + 'C2.44772 14 2 13.5523 2 13V3Z';

export function BgColorIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d={BACKGROUND_COLOR_ICON_PATH} fill="currentColor" />
    </svg>
  );
}

export const TYPE_OPTIONS: ReadonlyArray<SegmentedOption<LayerKind>> = [
  { value: 'image', label: <BgImageIcon />, ariaLabel: 'Image', tooltip: 'Image' },
  {
    value: 'linear',
    label: <BgLinearIcon />,
    ariaLabel: 'Linear gradient',
    tooltip: 'Linear gradient',
  },
  {
    value: 'radial',
    label: <BgRadialIcon />,
    ariaLabel: 'Radial gradient',
    tooltip: 'Radial gradient',
  },
  { value: 'color', label: <BgColorIcon />, ariaLabel: 'Color overlay', tooltip: 'Color overlay' },
];

export type LayerFieldProps = {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  liveSetProp: LiveSetProp;
};

// A small draft input (live-as-you-type + commit-on-blur) for one part of a compound
// longhand (Size's width/height, Position's left/top). The parent maps the part back
// into the full comma list; this just owns the field's local text + arrow-stepping.
export function BgPartInput({
  value,
  placeholder,
  label,
  busy,
  disabled,
  onLive,
  onCommit,
}: {
  value: string;
  placeholder: string;
  label: string;
  busy: boolean;
  disabled?: boolean;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  const { draft, setDraft, focused } = useExternalDraft(value);
  const commitScrub = (text: string) => {
    setDraft(text);
    onCommit(text.trim());
  };
  const scrub = useScrub({
    value: draft,
    disabled: busy || disabled === true,
    onPreview: setDraft,
    onInput: (text) => onLive(text.trim()),
    onCommit: commitScrub,
  });
  return (
    <input
      {...scrub.input}
      className={`u-input embed-editor_size-input ${disabled ? 'is-inactive' : ''}`}
      value={draft}
      placeholder={placeholder}
      aria-label={label}
      disabled={busy || disabled}
      spellCheck={false}
      onChange={(event) => {
        setDraft(event.target.value);
        onLive(event.target.value.trim());
      }}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
        onCommit(draft.trim());
      }}
      onKeyDown={(event) => {
        const stepped = stepInPlace(event);
        if (stepped !== undefined) {
          setDraft(stepped);
          onLive(stepped.trim());
        }
      }}
    />
  );
}

// Size: Custom | Cover | Contain, with Width/Height when Custom.
export type SizeMode = 'custom' | 'cover' | 'contain';
export function parseSize(size: string): { mode: SizeMode; width: string; height: string } {
  const normalized = size.trim().toLowerCase();
  if (normalized === 'cover') {
    return { mode: 'cover', width: '', height: '' };
  }
  if (normalized === 'contain') {
    return { mode: 'contain', width: '', height: '' };
  }
  const parts = splitTopLevelSpaces(size.trim());
  return { mode: 'custom', width: parts[0] ?? '', height: parts[1] ?? '' };
}
export function serializeSize(mode: SizeMode, width: string, height: string): string {
  if (mode === 'cover') {
    return 'cover';
  }
  if (mode === 'contain') {
    return 'contain';
  }
  const widthPart = width.trim();
  const heightPart = height.trim();
  if (!widthPart && !heightPart) {
    return '';
  }
  return `${widthPart || 'auto'} ${heightPart || 'auto'}`;
}
export const SIZE_MODE_OPTIONS: ReadonlyArray<SegmentedOption<SizeMode>> = [
  { value: 'custom', label: 'Custom' },
  { value: 'cover', label: 'Cover' },
  { value: 'contain', label: 'Contain' },
];
export function LayerSizeField({ layers, index, busy, setProp, clearProp, liveSetProp }: LayerFieldProps) {
  const parsed = parseSize(layers[index]?.size ?? '');
  const writeSize = (value: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { size: value })).size;
    writeLayerList('background-size', list, options, { setProp, clearProp, liveSetProp });
  };
  // Cover / Contain size the image for you, so the Width/Height fields stay visible
  // but disabled (Webflow parity) — showing "Auto" since neither axis is authored.
  const isCustom = parsed.mode === 'custom';
  return (
    <div className="embed-editor_bg-stack">
      <SegmentedControl
        options={SIZE_MODE_OPTIONS}
        value={parsed.mode}
        onChange={(mode) => writeSize(serializeSize(mode, parsed.width, parsed.height), { live: false })}
        ariaLabel="Background size"
        disabled={busy}
      />
      <div className="embed-editor_bg-pair">
        <label className="embed-editor_bg-pair-field">
          <BgPartInput
            value={parsed.width}
            placeholder="Auto"
            label="Width"
            busy={busy}
            disabled={!isCustom}
            onLive={(next) => writeSize(serializeSize('custom', next, parsed.height), { live: true })}
            onCommit={(next) => writeSize(serializeSize('custom', next, parsed.height), { live: false })}
          />
          <span className="embed-editor_bg-pair-cap">Width</span>
        </label>
        <label className="embed-editor_bg-pair-field">
          <BgPartInput
            value={parsed.height}
            placeholder="Auto"
            label="Height"
            busy={busy}
            disabled={!isCustom}
            onLive={(next) => writeSize(serializeSize('custom', parsed.width, next), { live: true })}
            onCommit={(next) => writeSize(serializeSize('custom', parsed.width, next), { live: false })}
          />
          <span className="embed-editor_bg-pair-cap">Height</span>
        </label>
      </div>
    </div>
  );
}

// Position: a 3×3 preset grid + Left/Top offsets.
export function axisIndex(token: string): number {
  const normalized = token.trim().toLowerCase();
  if (normalized === '' || normalized === 'left' || normalized === 'top' || normalized === '0' || normalized === '0%' || normalized === '0px') {
    return 0;
  }
  if (normalized === 'center' || normalized === '50%') {
    return 1;
  }
  if (normalized === 'right' || normalized === 'bottom' || normalized === '100%') {
    return 2;
  }
  return -1;
}
export const AXIS_PERCENTS = ['0%', '50%', '100%'];
export function LayerPositionField({ layers, index, busy, setProp, clearProp, liveSetProp }: LayerFieldProps) {
  const parts = splitTopLevelSpaces((layers[index]?.position ?? '').trim());
  const x = parts[0] ?? '';
  const y = parts[1] ?? '';
  const writePosition = (value: string, options: WriteOptions) => {
    const list = serializeLayers(replaceLayer(layers, index, { position: value })).position;
    writeLayerList('background-position', list, options, { setProp, clearProp, liveSetProp });
  };
  const offset = (left: string, top: string) => `${left || '0%'} ${top || '0%'}`;
  return (
    <div className="embed-editor_bg-position">
      <PositionPresets x={x} y={y} busy={busy} writePosition={writePosition} />
      <div className="embed-editor_bg-posfields">
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Left</span>
          <BgPartInput
            value={x}
            placeholder="0px"
            label="Left"
            busy={busy}
            onLive={(next) => writePosition(offset(next, y), { live: true })}
            onCommit={(next) => writePosition(next || y ? offset(next, y) : '', { live: false })}
          />
        </label>
        <label className="embed-editor_bg-posfield">
          <span className="embed-editor_bg-posfield-cap">Top</span>
          <BgPartInput
            value={y}
            placeholder="0px"
            label="Top"
            busy={busy}
            onLive={(next) => writePosition(offset(x, next), { live: true })}
            onCommit={(next) => writePosition(x || next ? offset(x, next) : '', { live: false })}
          />
        </label>
      </div>
    </div>
  );
}

// The 3×3 preset grid: left / center / right × top / center / bottom.
export function PositionPresets({
  x,
  y,
  busy,
  writePosition,
}: {
  x: string;
  y: string;
  busy: boolean;
  writePosition: (value: string, options: WriteOptions) => void;
}) {
  const activeCol = axisIndex(x);
  const activeRow = axisIndex(y);
  return (
    <div className="embed-editor_bg-posgrid" role="group" aria-label="Position preset">
      {[0, 1, 2].flatMap((row) =>
        [0, 1, 2].map((col) => (
          <button
            key={`${row}-${col}`}
            type="button"
            className={'embed-editor_bg-poscell ' + (activeCol === col && activeRow === row ? 'is-active' : '')}
            disabled={busy}
            aria-label={`${['Left', 'Center', 'Right'][col]} ${['top', 'center', 'bottom'][row]}`}
            onClick={() => writePosition(`${AXIS_PERCENTS[col]} ${AXIS_PERCENTS[row]}`, { live: false })}
          />
        )),
      )}
    </div>
  );
}

// Tile (background-repeat) + Fixed (background-attachment).
export const TileAllIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="2" y="2" width="5" height="5" rx="1" />
    <rect x="9" y="2" width="5" height="5" rx="1" />
    <rect x="2" y="9" width="5" height="5" rx="1" />
    <rect x="9" y="9" width="5" height="5" rx="1" />
  </svg>
);
export const TileXIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="1" y="5.5" width="4" height="5" rx="1" />
    <rect x="6" y="5.5" width="4" height="5" rx="1" />
    <rect x="11" y="5.5" width="4" height="5" rx="1" />
  </svg>
);
export const TileYIcon = () => (
  <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
    <rect x="5.5" y="1" width="5" height="4" rx="1" />
    <rect x="5.5" y="6" width="5" height="4" rx="1" />
    <rect x="5.5" y="11" width="5" height="4" rx="1" />
  </svg>
);
export const TileNoneIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
  </svg>
);
export const TILE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'repeat', label: <TileAllIcon />, ariaLabel: 'Tile', tooltip: 'Tile' },
  { value: 'repeat-x', label: <TileXIcon />, ariaLabel: 'Tile horizontally', tooltip: 'Tile X' },
  { value: 'repeat-y', label: <TileYIcon />, ariaLabel: 'Tile vertically', tooltip: 'Tile Y' },
  { value: 'no-repeat', label: <TileNoneIcon />, ariaLabel: 'No tile', tooltip: 'None' },
];
export const FIXED_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'fixed', label: 'Fixed' },
  { value: 'scroll', label: 'Not fixed' },
];

// Image: thumbnail + name + dimensions + Choose image (asset picker).
export function imageUrlOf(image: string): string | undefined {
  const match = image.match(/url\(\s*['"]?([^'")]+?)['"]?\s*\)/i);
  return match?.[1];
}

// Where on disk a CSS url points.
//
// A background's url is written for the SITE — `/lumos-background.svg` is
// served out of public/ by the dev server. The style panel is not the site: it
// runs in the app's own window, on the app's own origin, where that path is a
// 404 and every preview came up empty.
//
// The path is worked out rather than looked up. There is no list of the
// project's assets in the style panel (`host.files` is the STYLESHEETS), and
// fetching one would make a thumbnail wait on a round trip. A root-relative
// url is public/ or it is the project root, so both are offered and the img
// falls through to the next when one does not load — the same fallback
// AssetThumb already uses for its two url schemes.
export function assetSourceCandidates(url: string | undefined): string[] {
  if (!url) {
    return [];
  }
  const clean = url.split(/[?#]/)[0] ?? '';
  // Hosted elsewhere, or inline: not a file, and shown from where it points.
  if (/^(https?:)?\/\//.test(clean) || clean.startsWith('data:')) {
    return [clean];
  }
  const root = getHost().projectPath;
  if (!root) {
    return [clean];
  }
  const rel = clean.replace(/^\/+/, '');
  const base = root.replace(/[\\/]+$/, '');
  // public/ first: a leading-slash url is nearly always served from there.
  // The project root second, which is where `/src/...` lands.
  return [`${base}/public/${rel}`, `${base}/${rel}`].flatMap((abs) => sourceCandidates(abs));
}

// An <img> that works through a list of sources until one loads.
export function FallbackImg({ srcs, alt = '', onLoad }: { srcs: string[]; alt?: string; onLoad?: (size: { w: number; h: number }) => void }) {
  const [sourceIndex, setSourceIndex] = useState(0);
  // A new list starts again from its first source.
  const sourcesKey = srcs.join('|');
  useEffect(() => {
    setSourceIndex(0);
  }, [sourcesKey]);
  if (!srcs.length || sourceIndex >= srcs.length) {
    return undefined;
  }
  return (
    <img
      src={srcs[sourceIndex]}
      alt={alt}
      draggable={false}
      onLoad={(event) => onLoad?.({ w: event.currentTarget.naturalWidth, h: event.currentTarget.naturalHeight })}
      onError={() => setSourceIndex((previous) => previous + 1)}
    />
  );
}

export function LayerImageField({
  layers,
  index,
  busy,
  applyLayers,
}: {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  applyLayers: (layers: BgLayer[]) => void;
}) {
  const image = layers[index]?.image ?? '';
  const url = imageUrlOf(image);
  const name = url ? (url.split('?')[0] ?? '').split(/[\\/]/).pop() || url : '';
  const [dims, setDims] = useState('');
  const srcs = assetSourceCandidates(url);
  useEffect(() => {
    setDims('');
  }, [url]);
  const pick = (assetUrl: string) => {
    applyLayers(replaceLayer(layers, index, { image: `url("${assetUrl}")` }));
  };
  return (
    <div className="embed-editor_bg-image">
      <div className="embed-editor_bg-image-row">
        <span className="embed-editor_bg-thumb">
          <FallbackImg srcs={srcs} onLoad={(size) => setDims(`${size.w} × ${size.h}`)} />
        </span>
        <div className="embed-editor_bg-image-meta">
          <span className="embed-editor_bg-image-name" title={url ?? ''}>
            {name || 'No image'}
          </span>
          {dims ? <span className="embed-editor_bg-image-dim">{dims}</span> : undefined}
        </div>
      </div>
      {/* Asks the Assets panel, the same way every other "Choose…" in the app
          does (see assetPick.js). A grid of thumbnails crammed into a 320px
          style panel could show a handful at a time and had none of what makes
          the real panel usable — search, folders, uploading — so picking a
          background meant a different, worse version of a thing the app
          already had. */}
      <button
        type="button"
        className="u-button is-small embed-editor_bg-choose"
        disabled={busy}
        onClick={() =>
          requestAsset({
            mediaKind: 'image',
            current: url ?? '',
            onPick: (pickedRel: string) => pick(assetValueFor(pickedRel)),
          })
        }
      >
        {url ? 'Replace image…' : 'Choose image…'}
      </button>
    </div>
  );
}

// A colour field that reads/writes a color-overlay layer (a solid-fill gradient).
export function LayerColorField({
  layers,
  index,
  busy,
  setProp,
  liveSetProp,
}: {
  layers: BgLayer[];
  index: number;
  busy: boolean;
  setProp: SetProp;
  liveSetProp: LiveSetProp;
}) {
  const { draft, setDraft, focused } = useExternalDraft(colorOverlayOf(layers[index]?.image ?? '') ?? '');

  const listFor = (color: string): string => serializeLayers(replaceLayer(layers, index, { image: colorOverlayImage(color) })).image;
  // An empty colour writes the overlay's default tint.
  const write = (color: string, options: WriteOptions) => {
    const value = listFor(color.trim() || 'rgba(0, 0, 0, 0.5)');
    if (options.live) {
      liveSetProp('background-image', value, false);
    } else {
      setProp('background-image', value, false);
    }
  };

  return (
    <div className="embed-editor_bg-inline">
      <ColorSwatch
        value={draft}
        busy={busy}
        ariaLabel="Overlay color"
        onChange={(color, live) => {
          setDraft(color);
          write(color, { live });
        }}
      />
      <VariableConnect
        ariaLabel="Connect overlay color to a variable"
        disabled={busy}
        className="is-fill"
        prop="background-color"
        onPick={(binding) => {
          setDraft(binding);
          setProp('background-image', listFor(binding), false);
        }}
      >
        <OverlayColorInput draft={draft} busy={busy} focusedRef={focused} setDraft={setDraft} write={write} />
      </VariableConnect>
    </div>
  );
}

// The overlay colour as text. A keystroke live-writes the draft as it stood before that
// keystroke; blur commits the draft.
export function OverlayColorInput({
  draft,
  busy,
  focusedRef,
  setDraft,
  write,
}: {
  draft: string;
  busy: boolean;
  focusedRef: React.MutableRefObject<boolean>;
  setDraft: (draft: string) => void;
  write: (color: string, options: WriteOptions) => void;
}) {
  return (
    <input
      className="u-input embed-editor_size-input"
      value={draft}
      onChange={(event) => {
        setDraft(event.target.value);
        write(draft, { live: true });
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        write(draft, { live: false });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          commitInPlace(event.currentTarget);
        }
      }}
      disabled={busy}
      spellCheck={false}
      placeholder="rgba(0, 0, 0, 0.5)"
      aria-label="Overlay color"
    />
  );
}
