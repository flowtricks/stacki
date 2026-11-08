import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl';
import DragSlider from './components/DragSlider';
import { PositionGrid, NumberField } from './components/PositionGrid';
import FieldLabel from './components/FieldLabel';
import VariableConnect from './VariableConnect';
import { PropTip, useHoverTip } from './components/CssPropertyTip';
import { useHighlight } from './model/computedStyle';
import { handleArrowStep } from './model/numberStep';
import { commitInPlace } from './model/commitInPlace';
import { parseOrigin, serializeOrigin, type Origin } from './model/transformSettings';
import type { ResolvedProp } from './model/resolved';
import { displayOf } from './model/styleDisplay';
import ImportantMark from './components/ImportantMark';
import { useLengthUnit } from './model/lengthUnit';
import { formatPxLength, lengthUnitName, pxPerLengthUnit, type LengthUnit, type LengthUnitName } from '../../../shared/properties/lengthUnit';

// The settings behind the transform list, opened from the ⋯ beside its +: where a
// transform pivots, whether a turned element shows its back, and the two
// perspectives. Everything here applies to the whole element rather than to one
// layer, which is why it is not in the per-layer editor.
//
// See lib/transform-settings.ts for what "self" and "children" perspective
// actually mean in CSS — they are different properties, and the self one has to
// lead the transform list to mean what it says.

type Read = (prop: string) => ResolvedProp | undefined;
type SetProp = (prop: string, value: string, important: boolean) => void;
type ClearProp = (prop: string | string[]) => void;

const BACKFACE: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'visible', label: 'Visible' },
  { value: 'hidden', label: 'Hidden' },
];

// Far enough for the flat-looking end of the range to be reachable; a perspective
// past this is indistinguishable from none.
const DISTANCE_PX_MAX = 2000;

const effectiveValue = (read: Read, prop: string): string => {
  const resolved = read(prop);
  if (!resolved) {
    return '';
  }
  return (resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue.value : resolved.winner.value).trim();
};

// A px or rem distance in px (rem at the project's root font size), so the
// slider sits right whichever unit the project writes.
const pxNumber = (value: string, lengthUnit: LengthUnit): number | undefined => {
  const match = value.trim().match(/^(-?\d*\.?\d+)\s*(px|rem)$/i);
  if (!match) {
    return undefined;
  }
  const perUnit = pxPerLengthUnit(match[2] ?? '', lengthUnit);
  return perUnit === undefined ? undefined : parseFloat(match[1] ?? '') * perUnit;
};

/** A section heading, with the properties it writes on hover. */
function Heading({
  title,
  props,
  note,
  busy,
  onClear,
  cleared,
}: {
  title: string;
  props: readonly string[];
  note?: string;
  busy: boolean;
  onClear: () => void;
  cleared: boolean;
}) {
  const help = useHoverTip<HTMLSpanElement>(note ? <PropTip props={props} note={note} /> : undefined);
  return (
    <div className="embed-editor_tsettings-head">
      <FieldLabel
        className="embed-editor_tsettings-title"
        active={cleared}
        disabled={busy}
        onReset={onClear}
        resetLabel="Clear"
        tooltip={<PropTip props={props} />}
      >
        {title}
      </FieldLabel>
      {note ? (
        <>
          <span className="embed-editor_tsettings-help" ref={help.ref} {...help.hoverProps} aria-label={note} role="img">
            <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="14" height="14">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.2" />
              <path d="M6.4 6.2a1.7 1.7 0 1 1 1.9 1.7v1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              <circle cx="8.3" cy="11.2" r=".7" fill="currentColor" />
            </svg>
          </span>
          {help.tip}
        </>
      ) : undefined}
    </div>
  );
}

/** The pad plus its Left/Top fields — the same control as the gradient centre. */
function OriginRow({
  label,
  origin,
  busy,
  ariaLabel,
  onChange,
}: {
  label: string;
  origin: Origin;
  busy: boolean;
  ariaLabel: string;
  onChange: (next: Origin, live: boolean) => void;
}) {
  return (
    <div className="embed-editor_size-row embed-editor_grad-pos-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">{label}</span>
      <div className="embed-editor_grad-pos">
        <PositionGrid x={origin.x} y={origin.y} busy={busy} ariaLabel={ariaLabel} onPick={(px, py) => onChange({ ...origin, x: px, y: py }, false)} />
        <div className="embed-editor_grad-pos-fields">
          {/* A <div>, not a <label>: the field here is VariableConnect's contenteditable
              editor, and the plain input behind it is opacity:0 / pointer-events:none.
              A <label> forwards a press to its labelable control — which is that
              invisible input — so clicking the field you can see moved the caret
              into one you cannot. The caption is decorative; the input carries its
              own aria-label. */}
          <div className="embed-editor_grad-pos-field">
            <span>Left</span>
            <NumberField
              value={origin.x}
              unit="%"
              label={`${ariaLabel} left`}
              busy={busy}
              prop="left"
              onLive={(x) => onChange({ ...origin, x }, true)}
              onCommit={(x) => onChange({ ...origin, x }, false)}
            />
          </div>
          <div className="embed-editor_grad-pos-field">
            <span>Top</span>
            <NumberField
              value={origin.y}
              unit="%"
              label={`${ariaLabel} top`}
              busy={busy}
              prop="top"
              onLive={(y) => onChange({ ...origin, y }, true)}
              onCommit={(y) => onChange({ ...origin, y }, false)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A perspective distance: a coarse slider beside the number, in px. */
function DistanceRow({
  value,
  busy,
  ariaLabel,
  onLive,
  onCommit,
}: {
  value: string;
  busy: boolean;
  ariaLabel: string;
  onLive: (value: string) => void;
  onCommit: (value: string) => void;
}) {
  // Undefined for a var()/calc(): the slider has no number to sit at, so it
  // disables while the field stays editable.
  const lengthUnit = useLengthUnit();
  const distancePx = pxNumber(value, lengthUnit);
  const written = (amountPx: number): string => formatPxLength(amountPx, lengthUnit);
  const [draft, setDraft] = useState(value || '0');
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) {
      setDraft(value || '0');
    }
  }, [value]);
  return (
    <div className="embed-editor_size-row">
      <span className="embed-editor_size-label embed-editor_bg-caption">Distance</span>
      <div className="embed-editor_shadow-field">
        <DragSlider
          value={distancePx ?? 0}
          min={0}
          max={DISTANCE_PX_MAX}
          disabled={busy || (value.trim() !== '' && distancePx === undefined)}
          ariaLabel={ariaLabel}
          onPreview={(amount) => {
            if (!focused.current) {
              setDraft(written(amount));
            }
          }}
          onInput={(amount) => onLive(written(amount))}
          onCommit={(amount) => onCommit(amount === 0 ? '' : written(amount))}
        />
        {/* Connected like every other single-value field, so a var() distance
            reads as a chip and the dot can pick or swap one. */}
        <VariableConnect
          code
          ariaLabel={`Connect ${ariaLabel} to a variable`}
          disabled={busy}
          className="is-fill"
          prop="perspective"
          onPick={(binding) => onCommit(binding)}
        >
          <input
            className="u-input embed-editor_size-input embed-editor_shadow-num"
            value={draft}
            spellCheck={false}
            disabled={busy}
            aria-label={ariaLabel}
            placeholder="0"
            onChange={(event) => setDraft(event.target.value)}
            onFocus={() => {
              focused.current = true;
            }}
            onBlur={() => {
              focused.current = false;
              onCommit(distanceText(draft, lengthUnitName(lengthUnit)));
            }}
            onKeyDown={(event) => {
              const stepped = stepDistanceKey(event);
              if (stepped !== undefined) {
                setDraft(stepped);
              }
            }}
          />
        </VariableConnect>
        <span className="embed-editor_tsettings-unit">{lengthUnitName(lengthUnit).toUpperCase()}</span>
      </div>
    </div>
  );
}

// The typed distance as written: blank or zero clears, a value with its own unit
// (or a var()/calc()) passes through, and a bare number is read in the unit the
// field shows (px, or rem in a rem project).
function distanceText(draft: string, unit: LengthUnitName): string {
  const trimmed = draft.trim();
  if (!trimmed || /^0(?:px|rem)?$/i.test(trimmed)) {
    return '';
  }
  return /[a-z%)]$/i.test(trimmed) ? trimmed : `${trimmed}${unit}`;
}

// Enter commits in place; an arrow key steps the number under the caret and
// writes it straight into the input. Returns the stepped text, if any.
function stepDistanceKey(event: KeyboardEvent<HTMLInputElement>): string | undefined {
  if (event.key === 'Enter') {
    commitInPlace(event.currentTarget);
    return undefined;
  }
  const stepped = handleArrowStep(event);
  if (!stepped) {
    return undefined;
  }
  event.preventDefault();
  const input = event.currentTarget;
  input.value = stepped.text;
  input.setSelectionRange(stepped.caret, stepped.caret);
  return stepped.text;
}

// The explanatory notes under the two perspective headings.
const SELF_PERSPECTIVE_NOTE = "Depth for this element's own transform — written as perspective() at the front of " + 'the transform list.';
const CHILDREN_PERSPECTIVE_NOTE = "Depth for this element's CHILDREN, so they share one viewpoint. It does nothing to " + 'the element itself.';

export default function TransformSettings({
  read,
  busy,
  setProp,
  clearProp,
  selfPerspective,
  onSelfPerspective,
}: {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  /** The `perspective()` inside the element's own transform, which its row owns. */
  selfPerspective: string;
  onSelfPerspective: (distance: string, live: boolean) => void;
}) {
  const writeOrigin = (prop: string, next: Origin) => {
    const value = serializeOrigin(next);
    // The centre IS the default, so writing `50% 50%` would leave a declaration
    // that says nothing — clear it instead and let the property go back to unset.
    if (value) {
      setProp(prop, value, false);
    } else {
      clearProp(prop);
    }
  };

  return (
    <div className="embed-editor_tsettings">
      <TransformSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} writeOrigin={writeOrigin} />

      <section className="embed-editor_tsettings-section">
        <Heading
          title="Self perspective"
          props={['transform']}
          note={SELF_PERSPECTIVE_NOTE}
          busy={busy}
          cleared={!!selfPerspective}
          onClear={() => onSelfPerspective('', false)}
        />
        <DistanceRow
          value={selfPerspective}
          busy={busy}
          ariaLabel="Self perspective distance"
          onLive={(distance) => onSelfPerspective(distance, true)}
          onCommit={(distance) => onSelfPerspective(distance, false)}
        />
      </section>

      <ChildrenPerspectiveSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} writeOrigin={writeOrigin} />
    </div>
  );
}

type SectionProps = {
  read: Read;
  busy: boolean;
  setProp: SetProp;
  clearProp: ClearProp;
  writeOrigin: (prop: string, next: Origin) => void;
};

// Where the element's own transform pivots, and whether a turned element shows
// its back.
function TransformSection({ read, busy, setProp, clearProp, writeOrigin }: SectionProps) {
  const transformOrigin = parseOrigin(effectiveValue(read, 'transform-origin'));
  const backface = effectiveValue(read, 'backface-visibility').toLowerCase();
  // Nothing authored → highlight what the page actually computes for this element,
  // falling back to the CSS initial value when there is no canvas to ask. Without
  // this the control showed NEITHER segment lit, which reads as "no answer" when
  // the real answer is always one or the other — backface-visibility has no unset
  // state at render time, it is `visible` until something says otherwise.
  const shownBackface = useHighlight(backface, 'backface-visibility', ['visible', 'hidden'], 'visible');
  // Two segments and no custom field: a flagged value is marked, and a pick keeps the flag.
  const backfaceImportant = displayOf(read('backface-visibility')).important;
  return (
    <section className="embed-editor_tsettings-section">
      <Heading
        title="Transform settings"
        props={['transform-origin', 'backface-visibility']}
        busy={busy}
        cleared={!!effectiveValue(read, 'transform-origin') || !!backface}
        onClear={() => clearProp(['transform-origin', 'backface-visibility'])}
      />
      <OriginRow label="Origin" origin={transformOrigin} busy={busy} ariaLabel="Transform origin" onChange={(next) => writeOrigin('transform-origin', next)} />
      <div className="embed-editor_size-row">
        <span className="embed-editor_size-label embed-editor_bg-caption">Backface</span>
        <ImportantMark important={backfaceImportant}>
          <SegmentedControl
            value={shownBackface}
            options={BACKFACE}
            onChange={(value) => setProp('backface-visibility', value, backfaceImportant)}
            ariaLabel="Backface visibility"
            disabled={busy}
          />
        </ImportantMark>
      </div>
    </section>
  );
}

// The perspective this element gives its children, and where it looks from.
function ChildrenPerspectiveSection({ read, busy, setProp, clearProp, writeOrigin }: SectionProps) {
  const perspectiveOrigin = parseOrigin(effectiveValue(read, 'perspective-origin'));
  const childDistance = effectiveValue(read, 'perspective');
  return (
    <section className="embed-editor_tsettings-section">
      <Heading
        title="Children perspective"
        props={['perspective', 'perspective-origin']}
        note={CHILDREN_PERSPECTIVE_NOTE}
        busy={busy}
        cleared={!!childDistance || !!effectiveValue(read, 'perspective-origin')}
        onClear={() => clearProp(['perspective', 'perspective-origin'])}
      />
      <DistanceRow
        value={childDistance}
        busy={busy}
        ariaLabel="Children perspective distance"
        onLive={(distance) => {
          if (distance) {
            setProp('perspective', distance, false);
          }
        }}
        onCommit={(distance) => {
          if (distance) {
            setProp('perspective', distance, false);
          } else {
            clearProp('perspective');
          }
        }}
      />
      <OriginRow
        label="Origin"
        origin={perspectiveOrigin}
        busy={busy}
        ariaLabel="Perspective origin"
        onChange={(next) => writeOrigin('perspective-origin', next)}
      />
    </section>
  );
}
