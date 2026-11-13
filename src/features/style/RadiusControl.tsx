// Border radius: one value or a value per corner, each corner its own field
// with its own icon (BordersSection.tsx).

import { splitTopLevelSpaces } from './model/background';
import { displayOf, parseImportant, withImportant } from './model/styleDisplay';
import { type Props, stripImportant, PropLabel, LiveInput } from './BordersKit';
import { useTranslate } from '../../lib/i18n/useTranslate';

// The Borders section: a corner-radius control (linked / per-corner) and a border
// control scoped to a side (all / top / right / bottom / left) with style, width,
// and color. Driven by the resolved model like the Size/Spacing sections — blue
// when the picked selector sets it, orange when another does, dim when unset.

// ─────────────────────────── Icons ───────────────────────────

// Webflow's corner glyphs: the box drawn dim, with the one rounded corner this
// field controls picked out in full strength.
export function CornerIcon({ corner }: { corner: 'tl' | 'tr' | 'bl' | 'br' }) {
  const box = {
    tl: ['M14 14V9H13V13H9V14H14Z', 'M7 14V13H3V9H2V14H7Z', 'M2 7H3V6.5C3 4.567 4.567 3 6.5 3H7V2H6.5C4.01472 2 2 4.01472 2 6.5V7Z', 'M9 2V3H13V7H14V2H9Z'],
    tr: ['M2 14V9H3V13H7V14H2Z', 'M9 14V13H13V9H14V14H9Z', 'M14 7H13V6.5C13 4.567 11.433 3 9.5 3H9V2H9.5C11.9853 2 14 4.01472 14 6.5V7Z', 'M7 2V3H3V7H2V2H7Z'],
    bl: ['M2 2V7H3V3H7V2H2Z', 'M9 2V3H13V7H14V2H9Z', 'M14 9H13V13H9V14H14V9Z', 'M7 14V13H6.5C4.567 13 3 11.433 3 9.5V9H2V9.5C2 11.9853 4.01472 14 6.5 14H7Z'],
    br: [
      'M2 2V7H3V3H7V2H2Z',
      'M9 2V3H13V7H14V2H9Z',
      'M14 9H13V11.5C13 12.3284 12.3284 13 11.5 13H9V14H11.5C12.8807 14 14 12.8807 14 11.5V9Z',
      'M7 14V13H3V9H2V14H7Z',
    ],
  }[corner];
  const arc = {
    tl: 'M2.5 7V6.5C2.5 4.29086 4.29086 2.5 6.5 2.5H7',
    tr: 'M13.5 7V6.5C13.5 4.29086 11.7091 2.5 9.5 2.5H9',
    bl: 'M2.5 9V9.5C2.5 11.7091 4.29086 13.5 6.5 13.5H7',
    br: 'M13.5 9V9.5C13.5 11.7091 11.7091 13.5 9.5 13.5H9',
  }[corner];
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <g opacity="0.4">
        {box.map((path, i) => (
          <path key={i} d={path} fill="currentColor" />
        ))}
      </g>
      <path d={arc} stroke="currentColor" />
    </svg>
  );
}

// ─────────────────────────── Radius ───────────────────────────

export const RADIUS = 'border-radius';
export const CORNERS = [
  { prop: 'border-top-left-radius', corner: 'tl' as const, nameKey: 'style.radiusControl.topLeft' as const },
  { prop: 'border-top-right-radius', corner: 'tr' as const, nameKey: 'style.radiusControl.topRight' as const },
  { prop: 'border-bottom-left-radius', corner: 'bl' as const, nameKey: 'style.radiusControl.bottomLeft' as const },
  { prop: 'border-bottom-right-radius', corner: 'br' as const, nameKey: 'style.radiusControl.bottomRight' as const },
];

export type Corners = { tl: string; tr: string; bl: string; br: string };

// Parse a `border-radius` shorthand into our four corners. Only the horizontal
// radii drive per-corner editing (the elliptical `/ y…` part, if present, is
// dropped). 1–4 values expand per spec: 1 → all; 2 → tl/br=a, tr/bl=b;
// 3 → tl=a, tr/bl=b, br=c; 4 → tl tr br bl.
export function parseRadius(shorthand: string): Corners {
  const parts = splitTopLevelSpaces(stripImportant(shorthand).split('/')[0] ?? '').filter(Boolean);
  return {
    tl: parts[0] ?? '',
    tr: parts[1] ?? parts[0] ?? '',
    br: parts[2] ?? parts[0] ?? '',
    bl: parts[3] ?? parts[1] ?? parts[0] ?? '',
  };
}

export interface RadiusWrite {
  readonly onLive: (next: string) => void;
  readonly onCommit: (next: string) => void;
}

// The Radius control: one field per property — the `border-radius` shorthand first,
// then the four corner longhands. A corner left empty inherits the shorthand, which
// its placeholder shows; typing in it writes that corner's longhand (which wins over
// the shorthand in the cascade), and clearing it hands the corner back.
export function RadiusControl(props: Props) {
  const { read, busy } = props;
  const translate = useTranslate();
  const radiusDisplay = displayOf(read(RADIUS));
  const fromShorthand = parseRadius(radiusDisplay.value);
  const write = (prop: string): RadiusWrite => ({
    onLive: (next: string) => {
      const trimmed = next.trim();
      if (trimmed) {
        const { value, important } = parseImportant(trimmed);
        props.liveSetProp(prop, value, important);
      }
    },
    onCommit: (next: string) => {
      const trimmed = next.trim();
      if (!trimmed) {
        props.clearProp(prop);
        return;
      }
      const { value, important } = parseImportant(trimmed);
      props.setProp(prop, value, important);
    },
  });
  return (
    <>
      <div className="embed-editor_size-row">
        {/* This label belongs to the field beside it — the `border-radius` shorthand
            and nothing else; each corner glyph below owns its own longhand. */}
        <PropLabel
          label={translate('style.radiusControl.radius')}
          prop={RADIUS}
          read={read}
          busy={busy}
          clearProp={props.clearProp}
          onProvenance={props.onProvenance}
          onSelectSelector={props.onSelectSelector}
        />
        <div className="embed-editor_radius-head">
          <LiveInput
            value={radiusDisplay.present ? withImportant(radiusDisplay) : ''}
            busy={busy}
            ariaLabel={translate('style.radiusControl.borderRadius')}
            prop={RADIUS}
            {...write(RADIUS)}
          />
        </div>
      </div>
      <div className="embed-editor_radius-grid">
        {CORNERS.map((field) => (
          <CornerField key={field.prop} field={field} placeholder={fromShorthand[field.corner] || '0'} props={props} write={write(field.prop)} />
        ))}
      </div>
    </>
  );
}

// One corner's longhand field, with its corner glyph as the label.
export function CornerField({ field, placeholder, props, write }: { field: (typeof CORNERS)[number]; placeholder: string; props: Props; write: RadiusWrite }) {
  const { read, busy } = props;
  const translate = useTranslate();
  const radiusName = translate('style.radiusControl.cornerRadius', { corner: translate(field.nameKey) });
  const display = displayOf(read(field.prop));
  return (
    <div className="embed-editor_radius-corner">
      {/* The corner glyph IS the label: blue when the picked selector sets this
          corner, orange when another does, dim when it only inherits the
          shorthand. Its menu clears just this corner. */}
      <PropLabel
        label={
          <>
            <CornerIcon corner={field.corner} />
            <span className="u-sr-only">{radiusName}</span>
          </>
        }
        prop={field.prop}
        className="embed-editor_radius-corner-label"
        read={read}
        busy={busy}
        clearProp={props.clearProp}
        onProvenance={props.onProvenance}
        onSelectSelector={props.onSelectSelector}
      />
      <LiveInput
        value={display.present ? withImportant(display) : ''}
        busy={busy}
        ariaLabel={radiusName}
        placeholder={placeholder}
        prop={field.prop}
        {...write}
      />
    </div>
  );
}
