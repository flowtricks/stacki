import { useRef, useState } from 'react';
import ColorPicker from './ColorPicker';
import { useResolvedColor } from '../model/computedColor';
import { useLiveColor } from '../model/liveColor';
import { parseImportant } from '../model/styleDisplay';
import { assert } from '../../../../shared/core/assert';

// A clickable color swatch (checkerboard behind a transparent fill) that opens the
// color picker anchored under it. Drop-in for any color field: pass the current
// value and an onChange that routes live drags vs. committed changes.
export default function ColorSwatch({
  value,
  busy,
  onChange,
  ariaLabel = 'Choose color',
}: {
  value: string;
  busy?: boolean;
  onChange: (color: string, live: boolean) => void;
  ariaLabel?: string;
}) {
  // The swatch paints and picks a colour; `!important` is the field's to show.
  // A row hands over its field's text, and `#ceff08 !important` is not a
  // colour: as a background it is invalid, so the swatch drew nothing. The
  // row's onChange puts the flag back on what the picker emits.
  const color = parseImportant(value).value;
  assert(!/!\s*important\s*$/i.test(color), 'ColorSwatch: the painted colour carries no flag');
  const ref = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | undefined>(undefined);
  // The colour being dragged, not the one the model still holds: a drag writes
  // to the canvas and deliberately doesn't rebuild the panel's model, so `value`
  // only catches up on release — and the swatch is the thing that has to keep up
  // with the picker above it. Kept here so every colour field in the panel gets
  // it rather than each row remembering to (see liveColor.ts).
  const [shown, noteLive] = useLiveColor(color);
  // What that value looks like where it is used. A variable means nothing in
  // this panel's document — painted here it came out transparent — so a value
  // that leans on one is resolved by the page, against the selected element.
  // The picker still gets the raw value: editing works on the text.
  const fill = useResolvedColor(shown);
  return (
    <>
      <button
        ref={ref}
        type="button"
        className="u-color-swatch"
        disabled={busy}
        aria-label={ariaLabel}
        onClick={() => setAnchor((previous) => (previous ? undefined : (ref.current?.getBoundingClientRect() ?? undefined)))}
      >
        <span className="u-color-swatch-fill" style={{ background: fill.trim() || 'transparent' }} />
      </button>
      {anchor ? (
        <ColorPicker
          value={color}
          anchor={anchor}
          trigger={ref.current ?? undefined}
          onChange={(color, live) => {
            noteLive(live ? color : undefined);
            onChange(color, live);
          }}
          onClose={() => setAnchor(undefined)}
        />
      ) : undefined}
    </>
  );
}
