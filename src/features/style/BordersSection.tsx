import Popup from '../../ui/Popup';
import { useEffect, useRef, useState } from 'react';
import type { SegmentedOption } from './components/SegmentedControl';
import ColorSwatch from './components/ColorSwatch';
import { useLiveColor } from './model/liveColor';
import VariableConnect from './VariableConnect';
import { useHighlight } from './model/computedStyle';
import SegmentPill from './components/SegmentPill';
import { commitInPlace } from './model/commitInPlace';
import { ChevronIcon, MenuItem } from './components/MenuParts';
import { displayOf, displayText, parseImportant, withImportant, type Display } from './model/styleDisplay';
import { type Read, type Props, stripImportant, PropLabel, LiveInput } from './BordersKit';
import { RadiusControl } from './RadiusControl';

export { LiveInput } from './BordersKit';

// ─────────────────────────── Border side + style/width/color ───────────────────────────

type Side = 'all' | 'top' | 'right' | 'bottom' | 'left';
type Facet = 'style' | 'width' | 'color';
const EDGES = ['top', 'right', 'bottom', 'left'] as const;

// Props the label clears — for 'all', all four edges plus any leftover shorthand.
const facetClear = (facet: Facet, side: Side): string[] =>
  side === 'all' ? [`border-${facet}`, ...EDGES.map((edge) => `border-${edge}-${facet}`)] : [`border-${side}-${facet}`];
// Representative property to read / label. A single side owns its edge longhand;
// "all" owns only the border facet shorthand. It must not borrow a side value — doing
// so makes the center selector show (and edit) Bottom when only Bottom is configured.
function facetRead(facet: Facet, side: Side, read: Read): { d: Display; prop: string } {
  const prop = side === 'all' ? `border-${facet}` : `border-${side}-${facet}`;
  return { d: displayOf(read(prop)), prop };
}
// How a facet write lands: live while typing or dragging, or committed.
interface WriteOptions {
  readonly live: boolean;
}
type FacetWrite = (next: string, options: WriteOptions) => void;

function facetWrite(facet: Facet, side: Side, props: Props): FacetWrite {
  return (next, { live }) => {
    const trimmed = next.trim();
    if (!trimmed) {
      if (!live) {
        props.clearProp(facetClear(facet, side));
      }
      return;
    }
    const { value, important } = parseImportant(trimmed);
    const set = live ? props.liveSetProp : props.setProp;
    if (side === 'all') {
      // Write the SINGLE `border-<facet>` shorthand — not the four edge longhands.
      // Webflow groups the sides, so setting them one at a time makes it drop/flash
      // the others (the read/write thrash the radius control avoids by writing one
      // `border-radius`). One property → one native write → no flicker.
      set(`border-${facet}`, value, important);
      // On commit, drop any stray per-side longhands so the shorthand stays the source
      // — but only when some exist, so a plain "all" edit stays a single write.
      if (!live) {
        const strays = EDGES.map((edge) => `border-${edge}-${facet}`).filter((prop) => displayOf(props.read(prop)).present);
        if (strays.length) {
          props.clearProp(strays);
        }
      }
    } else {
      set(`border-${side}-${facet}`, value, important);
    }
  };
}

// A blue edge means the picked selector actually sets that side. Keep this separate
// from `side` (the neutral raised button), which only says which side's fields are
// currently open. This lets Bottom remain visibly applied while All is being viewed.
function appliedBorderSides(read: Read): Set<Side> {
  const applied = new Set<Side>();
  const owns = (prop: string) => displayOf(read(prop)).isSelected;
  if (['border', 'border-style', 'border-width', 'border-color'].some(owns)) {
    applied.add('all');
  }
  for (const side of EDGES) {
    if ([`border-${side}`, `border-${side}-style`, `border-${side}-width`, `border-${side}-color`].some(owns)) {
      applied.add(side);
    }
  }
  return applied;
}

function SideSelector({ side, applied, onPick }: { side: Side; applied: ReadonlySet<Side>; onPick: (s: Side) => void }) {
  const sideButton = (option: Side, label: string) => (
    <button
      type="button"
      className={`embed-editor_border-side is-${option} ${side === option ? 'is-active' : ''} ` + (applied.has(option) ? 'is-applied' : '')}
      aria-pressed={side === option}
      aria-label={option === 'all' ? 'All borders' : `${label} border`}
      onClick={() => onPick(option)}
    >
      <span className="embed-editor_border-side-mark" />
    </button>
  );
  return (
    <div className="embed-editor_border-sides" role="group" aria-label="Border side">
      {sideButton('top', 'Top')}
      <div className="embed-editor_border-sides-mid">
        {sideButton('left', 'Left')}
        {sideButton('all', 'All')}
        {sideButton('right', 'Right')}
      </div>
      {sideButton('bottom', 'Bottom')}
    </div>
  );
}

const STYLE_OPTIONS: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'none', label: '✕', ariaLabel: 'None' },
  {
    value: 'solid',
    label: <span className="embed-editor_border-style-line is-solid" />,
    ariaLabel: 'Solid',
  },
  {
    value: 'dashed',
    label: <span className="embed-editor_border-style-line is-dashed" />,
    ariaLabel: 'Dashed',
  },
  {
    value: 'dotted',
    label: <span className="embed-editor_border-style-line is-dotted" />,
    ariaLabel: 'Dotted',
  },
];
const STYLE_VALUES = new Set(STYLE_OPTIONS.map((option) => option.value));

// The border-style segmented bar (None / Solid / Dashed / Dotted) + a chevron menu
// whose Custom item enters a free-value mode (double / groove / var()…) and offers
// the presets to switch back — mirroring the Display / Float / Clear controls. Writes
// go through the side-aware `write` (which handles the `border-style` shorthand for
// "all" vs a per-side longhand).
function StyleControl({
  value,
  important,
  prop,
  busy,
  write,
  clear,
}: {
  value: string;
  /** Whether the style is written `!important`: the custom field shows it. */
  important: boolean;
  /** The property this bar edits (side-aware) — its computed value highlights an
   *  unset control, so an inherited or UA style shows instead of an empty bar. */
  prop: string;
  busy: boolean;
  write: FacetWrite;
  clear: () => void;
}) {
  const lower = value.trim().toLowerCase();
  // Unset → what the page draws: its computed border style, or `none` (the initial
  // value) when there's no canvas to ask.
  const shown = useHighlight(
    lower,
    prop,
    STYLE_OPTIONS.map((option) => option.value),
    'none',
  );
  // The bar shows a listed style without `!important`, the convention every
  // segmented bar in the panel follows (DisplayControl, SegmentedField): a
  // flagged style opens the custom field, whose text shows the flag and lets it
  // be deleted. Before, the bar drew `solid !important` as plain Solid.
  const customMode = important || (!!lower && !STYLE_VALUES.has(lower));
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestFocus = useFocusOnceReady({ customMode, busy, inputRef });

  // A pick returns to the bar, which shows no flag, so it writes the preset
  // plain — the same as DisplayControl's pick.
  const pick = (next: string) => {
    setOpen(false);
    if (next !== lower || important) {
      write(next, { live: false });
    }
  };
  const enterCustom = () => {
    setOpen(false);
    requestFocus();
    write('unset', { live: false });
  };

  return (
    <div ref={rootRef} className={`embed-editor_display embed-editor_border-style ${customMode ? 'is-custom' : ''}`} role="group" aria-label="Border style">
      <SegmentPill />
      {customMode ? (
        <StyleCustomField value={withImportant({ value, important })} busy={busy} inputRef={inputRef} write={write} clear={clear} />
      ) : (
        <StyleSegments shown={shown} busy={busy} pick={pick} />
      )}
      <StyleMenu
        open={open}
        customMode={customMode}
        shown={shown}
        busy={busy}
        onToggle={() => setOpen((wasOpen) => !wasOpen)}
        pick={pick}
        enterCustom={enterCustom}
      />
    </div>
  );
}

// None / Solid / Dashed / Dotted.
function StyleSegments({ shown, busy, pick }: { shown: string; busy: boolean; pick: (next: string) => void }) {
  return STYLE_OPTIONS.map((seg) => (
    <button
      key={seg.value}
      type="button"
      role="radio"
      aria-checked={shown === seg.value}
      className={`embed-editor_display-seg ${shown === seg.value ? 'is-selected' : ''}`}
      disabled={busy}
      title={seg.ariaLabel}
      aria-label={seg.ariaLabel}
      onClick={() => pick(seg.value)}
    >
      {seg.label}
    </button>
  ));
}

// Focus the custom field once its `unset` write settles (the input is disabled
// mid-save). Returns the request to make when entering custom mode.
function useFocusOnceReady({ customMode, busy, inputRef }: { customMode: boolean; busy: boolean; inputRef: React.RefObject<HTMLInputElement> }) {
  const wantFocus = useRef(false);
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [customMode, busy, inputRef]);
  return () => {
    wantFocus.current = true;
  };
}

// The free-value field of custom mode: live-writes while typing, commits on blur
// (clearing the property when emptied). It mounts only in custom mode, starting from
// the current value, and mirrors external edits unless the user is typing.
function StyleCustomField({
  value,
  busy,
  inputRef,
  write,
  clear,
}: {
  value: string;
  busy: boolean;
  inputRef: React.RefObject<HTMLInputElement>;
  write: FacetWrite;
  clear: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value);
    }
  }, [value]);
  const commitCustom = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      clear();
      return;
    }
    write(withImportant(parseImportant(trimmed)), { live: false });
  };
  return (
    <VariableConnect ariaLabel="Connect border style to a variable" disabled={busy} prop="border-style" onPick={(binding) => write(binding, { live: false })}>
      <input
        ref={inputRef}
        className="embed-editor_value-input embed-editor_display-input"
        value={draft}
        placeholder="custom value"
        spellCheck={false}
        disabled={busy}
        onChange={(event) => {
          setDraft(event.target.value);
          const trimmed = event.target.value.trim();
          if (trimmed) {
            write(trimmed, { live: true });
          }
        }}
        onFocus={() => {
          focused.current = true;
        }}
        onBlur={() => {
          focused.current = false;
          commitCustom();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commitInPlace(event.currentTarget);
          }
        }}
        aria-label="Border style value"
      />
    </VariableConnect>
  );
}

// The chevron and its menu: the presets from custom mode, or Custom from the bar.
function StyleMenu({
  open,
  customMode,
  shown,
  busy,
  onToggle,
  pick,
  enterCustom,
}: {
  open: boolean;
  customMode: boolean;
  shown: string;
  busy: boolean;
  onToggle: () => void;
  pick: (next: string) => void;
  enterCustom: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className="embed-editor_display-arrow"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="More border style options"
        disabled={busy}
        onClick={onToggle}
      >
        <ChevronIcon />
      </button>
      {open ? (
        <Popup mode="popover" portal={false} onClose={onToggle} className="embed-editor_display-menu" role="menu">
          {customMode ? (
            STYLE_OPTIONS.map((seg) => (
              <MenuItem key={seg.value} label={seg.ariaLabel ?? seg.value} selected={shown === seg.value} onClick={() => pick(seg.value)} />
            ))
          ) : (
            <MenuItem label="Custom" selected={false} onClick={enterCustom} />
          )}
        </Popup>
      ) : undefined}
    </>
  );
}

export function ColorVariableInput({
  value,
  swatchValue = value,
  busy,
  ariaLabel,
  prop = 'color',
  onLive,
  onCommit,
  onVariablePick,
}: {
  value: string;
  swatchValue?: string;
  busy: boolean;
  ariaLabel: string;
  prop?: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
  onVariablePick?: (binding: string) => void;
}) {
  // A live drag writes to the canvas, not to the model this field reads — so the
  // value it emitted is what both show until the model catches up.
  const [shown, noteLive] = useLiveColor(value);
  // The swatch picks a colour, not the flag: a colour written `!important`
  // stays so, and the field beside it keeps showing it through the drag.
  const { important } = parseImportant(value);
  return (
    <div className="embed-editor_border-color">
      <ColorSwatch
        value={stripImportant(shown === value ? swatchValue : shown)}
        busy={busy}
        ariaLabel={ariaLabel}
        onChange={(color, live) => {
          const emitted = withImportant({ value: color, important });
          noteLive(live ? emitted : undefined);
          if (live) {
            onLive(emitted);
          } else {
            onCommit(emitted);
          }
        }}
      />
      <LiveInput
        value={shown}
        busy={busy}
        ariaLabel={ariaLabel}
        placeholder="black"
        prop={prop}
        onLive={onLive}
        onCommit={onCommit}
        {...(onVariablePick === undefined ? {} : { onVariablePick })}
      />
    </div>
  );
}

function ColorField({ side, props }: { side: Side; props: Props }) {
  const value = displayText(facetRead('color', side, props.read).d);
  const write = facetWrite('color', side, props);
  return (
    <ColorVariableInput
      value={value}
      busy={props.busy}
      ariaLabel={`${side} border color`}
      prop="border-color"
      onLive={(next) => write(next, { live: true })}
      onCommit={(next) => write(next, { live: false })}
    />
  );
}

function BorderControl(props: Props) {
  const { busy } = props;
  const [side, setSide] = useState<Side>('all');
  const applied = appliedBorderSides(props.read);
  const styleFacet = facetRead('style', side, props.read);
  const widthFacet = facetRead('width', side, props.read);
  const colorFacet = facetRead('color', side, props.read);
  const writeStyle = facetWrite('style', side, props);
  const writeWidth = facetWrite('width', side, props);

  return (
    <div className="embed-editor_border-body">
      <SideSelector side={side} applied={applied} onPick={setSide} />
      <div className="embed-editor_border-fields">
        <div className="embed-editor_size-row">
          <PropLabel label="Style" prop={styleFacet.prop} clearProps={facetClear('style', side)} {...props} />
          <StyleControl
            value={styleFacet.d.present ? styleFacet.d.value.trim() : ''}
            important={styleFacet.d.important}
            prop={styleFacet.prop}
            busy={busy}
            write={writeStyle}
            clear={() => props.clearProp(facetClear('style', side))}
          />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel label="Width" prop={widthFacet.prop} clearProps={facetClear('width', side)} {...props} />
          <LiveInput
            value={displayText(widthFacet.d)}
            busy={busy}
            ariaLabel={`${side} border width`}
            prop="border-width"
            onLive={(next) => writeWidth(next, { live: true })}
            onCommit={(next) => writeWidth(next, { live: false })}
          />
        </div>
        <div className="embed-editor_size-row">
          <PropLabel label="Color" prop={colorFacet.prop} clearProps={facetClear('color', side)} {...props} />
          <ColorField side={side} props={props} />
        </div>
      </div>
    </div>
  );
}

export default function BordersSection(props: Props) {
  return (
    <div className="embed-editor_borders">
      <RadiusControl {...props} />
      <div className="embed-editor_border-heading">Borders</div>
      <BorderControl {...props} />
    </div>
  );
}
