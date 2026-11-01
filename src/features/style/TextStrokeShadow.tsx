// Text stroke (-webkit-text-stroke) and layered text shadows, each with its
// own editor (TypographySection.tsx).

import { useState } from 'react';
import ColorSwatch from './components/ColorSwatch';
import { ShadowLength, ShadowColorRow } from './ShadowFields';
import { parseShadows, serializeShadows, blankShadow, shadowLabel, type Shadow } from './model/textShadow';
import { parseHideable, serializeHideable, type Hideable } from './model/hideable';
import LayerList from './LayerList';
import LayerPopover from './LayerPopover';
import { displayOf, type Display } from './model/styleDisplay';
import { useComputedValue } from './model/computedStyle';
import { type Props, joinImportant, PropLabel, LiveInput } from './TypographyKit';

// ─────────────── Stroke (-webkit-text-stroke) ───────────────

export function StrokeRow(props: Props) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const widthDisplay = displayOf(read('-webkit-text-stroke-width'));
  const colorDisplay = displayOf(read('-webkit-text-stroke-color'));
  const computedColor = useComputedValue(colorDisplay.present ? '' : '-webkit-text-stroke-color');
  // The "Stroke" title reflects either longhand being set and clears both; each cell's
  // caption (Width/Color) owns its own provenance/clear.
  const combined = eitherDisplay(widthDisplay, colorDisplay);
  return (
    <div className="embed-editor_break-row">
      <PropLabel
        label="Stroke"
        prop="-webkit-text-stroke-width"
        display={combined}
        contributors={read('-webkit-text-stroke-width')?.contributors ?? []}
        busy={busy}
        onClear={() => clearProp(['-webkit-text-stroke-width', '-webkit-text-stroke-color'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <div className="embed-editor_break-pair embed-editor_stroke-pair">
        <div className="embed-editor_type-cell">
          <StrokeInput prop="-webkit-text-stroke-width" display={widthDisplay} placeholder="0px" ariaLabel="Stroke width" {...props} />
          <StrokeCaption label="Width" prop="-webkit-text-stroke-width" display={widthDisplay} {...props} />
        </div>
        <div className="embed-editor_type-cell">
          <div className="embed-editor_type-field">
            <ColorSwatch
              value={colorDisplay.present ? colorDisplay.value : computedColor}
              busy={busy}
              ariaLabel="Stroke color"
              onChange={(color, live) => {
                if (live) {
                  props.liveSetProp('-webkit-text-stroke-color', color, false);
                } else {
                  props.setProp('-webkit-text-stroke-color', color, false);
                }
              }}
            />
            <StrokeInput prop="-webkit-text-stroke-color" display={colorDisplay} placeholder="black" ariaLabel="Stroke color" {...props} />
          </div>
          <StrokeCaption label="Color" prop="-webkit-text-stroke-color" display={colorDisplay} {...props} />
        </div>
      </div>
    </div>
  );
}

// A label state for two longhands at once: set when either is, blue when either
// is set on the picked selector.
export function eitherDisplay(first: Display, second: Display): Display {
  return {
    present: first.present || second.present,
    isSelected: first.isSelected || second.isSelected,
    overridden: false,
    winnerSelector: '',
    value: '',
    important: false,
  };
}

// The field for one stroke longhand.
export function StrokeInput({
  prop,
  display,
  placeholder,
  ariaLabel,
  busy,
  setProp,
  clearProp,
  liveSetProp,
}: {
  prop: string;
  display: Display;
  placeholder: string;
  ariaLabel: string;
} & Props) {
  return (
    <LiveInput
      value={display.present ? joinImportant(display) : ''}
      busy={busy}
      placeholder={placeholder}
      ariaLabel={ariaLabel}
      className="u-input embed-editor_size-input"
      dataProp={prop}
      prop={prop}
      onCommit={(value, important) => setProp(prop, value, important)}
      onLiveCommit={(value, important) => liveSetProp(prop, value, important)}
      onClear={() => clearProp(prop)}
    />
  );
}

// The caption under one stroke cell, which owns that longhand's provenance/clear.
export function StrokeCaption({
  label,
  prop,
  display,
  read,
  busy,
  clearProp,
  onProvenance,
  onSelectSelector,
}: { label: string; prop: string; display: Display } & Props) {
  return (
    <PropLabel
      label={label}
      prop={prop}
      display={display}
      contributors={read(prop)?.contributors ?? []}
      busy={busy}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  );
}

// ─────────────── Text shadows (layered text-shadow) ───────────────

export const ShadowPlusIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M8 3.5v9M3.5 8h9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

export type ShadowPatch = { x?: string; y?: string; blur?: string; color?: string };

export function ShadowEditor({ shadow, busy, onChange }: { shadow: Shadow; busy: boolean; onChange: (patch: ShadowPatch, live: boolean) => void }) {
  return (
    <div className="embed-editor_type-shadow-editor">
      <ShadowLength
        label="X"
        value={shadow.x}
        busy={busy}
        onCommit={(value) => onChange({ x: value }, false)}
        onLive={(value) => onChange({ x: value }, true)}
      />
      <ShadowLength
        label="Y"
        value={shadow.y}
        busy={busy}
        onCommit={(value) => onChange({ y: value }, false)}
        onLive={(value) => onChange({ y: value }, true)}
      />
      <ShadowLength
        label="Blur"
        value={shadow.blur}
        busy={busy}
        onCommit={(value) => onChange({ blur: value }, false)}
        onLive={(value) => onChange({ blur: value }, true)}
      />
      <ShadowColorRow color={shadow.color} busy={busy} onChange={(color, live) => onChange({ color: color }, live)} />
    </div>
  );
}

// The transparency checkerboard drawn beneath each shadow's colour swatch.
export const SHADOW_PREVIEW_CHECKERBOARD = 'conic-gradient(#8883 25%, transparent 0 50%, #8883 0 75%, transparent 0) 0 0 / 10px 10px';

export function TextShadowsRow(props: Props) {
  const { read, busy, clearProp, onProvenance, onSelectSelector } = props;
  const display = displayOf(read('text-shadow'));
  const computed = useComputedValue(display.present ? '' : 'text-shadow');
  const rows = parseHideable(display.present ? display.value : computed, ',', parseShadows);
  const shadows = rows.map((row) => row.item);
  const [openIndex, setOpenIndex] = useState<number | undefined>(undefined);
  const [anchorElement, setAnchorElement] = useState<HTMLElement | undefined>(undefined);
  const edit = shadowRowEdits({ rows, props, setOpenIndex });
  const openShadow = openIndex === undefined ? undefined : shadows[openIndex];

  return (
    <div className="embed-editor_type-shadows">
      <div className="embed-editor_bg-layers-head">
        <PropLabel
          label="Text shadows"
          prop="text-shadow"
          display={display}
          contributors={read('text-shadow')?.contributors ?? []}
          busy={busy}
          onClear={() => clearProp('text-shadow')}
          onProvenance={onProvenance}
          onSelectSelector={onSelectSelector}
        />
        <button type="button" className="embed-editor_icon-btn" onClick={edit.add} disabled={busy} title="Add a shadow" aria-label="Add a text shadow">
          <ShadowPlusIcon />
        </button>
      </div>
      <LayerList
        count={shadows.length}
        busy={busy}
        ariaLabel="Text shadows"
        onOpen={(i, element) => {
          setOpenIndex((current) => (current === i ? undefined : i));
          setAnchorElement(element);
        }}
        onReorder={edit.reorder}
        onRemove={edit.remove}
        isHidden={(i) => rows[i]?.hidden ?? false}
        onToggleHidden={edit.toggle}
        renderRow={(i) => shadowLayerRow(shadows[i], i)}
      />
      {openIndex !== undefined && anchorElement && openShadow ? (
        <LayerPopover anchorEl={anchorElement} ariaLabel="Text shadow" onClose={() => setOpenIndex(undefined)}>
          <ShadowEditor shadow={openShadow} busy={busy} onChange={(shadowPatch, live) => edit.patch(openIndex, shadowPatch, live ? 'live' : 'commit')} />
        </LayerPopover>
      ) : undefined}
    </div>
  );
}

// A shadow's row in the layer list: its colour over a checkerboard, and its label.
export function shadowLayerRow(shadow: Shadow | undefined, index: number) {
  if (shadow === undefined) {
    throw new Error(`Text shadow ${index} is missing`);
  }
  const colorLayer = `linear-gradient(${shadow.color}, ${shadow.color})`;
  return {
    preview: (
      <span
        className="embed-editor_bg-layer-preview"
        style={{
          background: `${colorLayer}, ${SHADOW_PREVIEW_CHECKERBOARD}`,
        }}
        aria-hidden="true"
      />
    ),
    label: shadowLabel(shadow),
  };
}

// The edits the shadow list makes, each written back as the whole `text-shadow`
// value; the open editor's index follows the row it belongs to.
export function shadowRowEdits({
  rows,
  props,
  setOpenIndex,
}: {
  rows: Array<Hideable<Shadow>>;
  props: Props;
  setOpenIndex: React.Dispatch<React.SetStateAction<number | undefined>>;
}) {
  const write = (next: Array<Hideable<Shadow>>, mode: 'live' | 'commit') => {
    const value = serializeHideable(next, ',', serializeShadows);
    if (mode === 'live') {
      if (value) {
        props.liveSetProp('text-shadow', value, false);
      }
      return;
    }
    if (value) {
      props.setProp('text-shadow', value, false);
    } else {
      props.clearProp('text-shadow');
    }
  };
  return {
    add: () => {
      const next = [...rows, { item: blankShadow(), hidden: false }];
      write(next, 'commit');
      setOpenIndex(next.length - 1);
    },
    remove: (i: number) => {
      write(
        rows.filter((_, j) => j !== i),
        'commit',
      );
      setOpenIndex((current) => {
        if (current === i) {
          return undefined;
        }
        return current !== undefined && current > i ? current - 1 : current;
      });
    },
    reorder: (from: number, to: number) => {
      if (from === to) {
        return;
      }
      const next = [...rows];
      const [moved] = next.splice(from, 1);
      if (moved === undefined) {
        return;
      }
      next.splice(to, 0, moved);
      write(next, 'commit');
      setOpenIndex((current) => (current === from ? to : current));
    },
    patch: (i: number, shadowPatch: ShadowPatch, mode: 'live' | 'commit') =>
      write(
        rows.map((row, j) => (j === i ? { ...row, item: { ...row.item, ...shadowPatch } } : row)),
        mode,
      ),
    toggle: (i: number) =>
      write(
        rows.map((row, j) => (j === i ? { ...row, hidden: !row.hidden } : row)),
        'commit',
      ),
  };
}
