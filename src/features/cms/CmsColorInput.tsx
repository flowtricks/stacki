// A colour held as text (`#c63f2a`), chosen with Stacki's own colour picker:
// the swatch opens the style panel's picker, and the text beside it can be
// typed. A drag in the picker previews in the swatch and is saved on release.
import ColorSwatch from '../style/components/ColorSwatch';

/** A hex colour: #rgb, #rgba, #rrggbb or #rrggbbaa. */
export const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function CmsColorInput(props: {
  readonly value: string;
  readonly label: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <div className="cms-color-input">
      <ColorSwatch
        value={props.value}
        ariaLabel={`Choose the colour for ${props.label}`}
        onChange={(color, live) => {
          if (!live) {
            props.onChange(color);
          }
        }}
      />
      <input
        value={props.value}
        placeholder="#000000"
        spellCheck={false}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  );
}
