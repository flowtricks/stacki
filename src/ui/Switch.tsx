// The app's on/off switch: a button with the switch role, its state in
// aria-checked. One component so every switch hovers, focuses and disables the
// same way (switch.css). SwitchRow puts its visible label beside it, the way
// Settings' role toggles lay a switch out: the label first, the switch at the end.
import './switch.css';

export interface SwitchProps {
  /** The accessible name; a visible label beside the switch says the same. */
  readonly label: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
  /** The id of the text that describes the setting, read after the name. */
  readonly describedBy?: string;
  readonly onToggle: () => void;
}

export function Switch(props: SwitchProps) {
  return (
    <button
      type="button"
      className="ui-switch"
      role="switch"
      aria-label={props.label}
      aria-checked={props.checked}
      aria-describedby={props.describedBy}
      disabled={props.disabled ?? false}
      onClick={props.onToggle}
    >
      <span className="ui-switch-thumb" aria-hidden="true" />
    </button>
  );
}

/**
 * A switch with its label shown: the label first, the switch at the end of the
 * row. The whole row is a `<label>`, so a click on the text toggles the switch,
 * and the switch keeps its own accessible name. The app UI kit's
 * `<stacki-switch label>` draws this.
 */
export function SwitchRow(props: SwitchProps) {
  return (
    <label className="ui-switch-row">
      <span className="ui-switch-row-label">{props.label}</span>
      <Switch {...props} />
    </label>
  );
}
