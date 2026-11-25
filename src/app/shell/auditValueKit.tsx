// The Style panel's value input, lent to the Audits review window. The window lives
// in a feature that may not import the style feature, so the app shell (which may)
// supplies the input here: the same VariableConnect over a plain input the Style
// panel's length fields use, so typing, arrow-key stepping and the variable picker
// behave identically.
import type { RawValueKit } from '../../features/audits/RawValueField';
import { isSupportedCssValue } from '../../features/style/embed/ResolvedRows';
import { isNonNegative } from '../../features/style/model/cssProperties';
import VariableConnect from '../../features/style/VariableConnect';

export const AUDIT_VALUE_KIT: RawValueKit = {
  supports: isSupportedCssValue,
  Input: (props) => (
    <VariableConnect
      code
      // A size, spacing or radius has no negative side to step onto.
      {...(isNonNegative(props.property) ? { stepMin: 0 } : {})}
      className="is-fill"
      ariaLabel={props.connectLabel}
      disabled={props.disabled}
      prop={props.property}
      onDraft={props.onChange}
      onPick={props.onPick}
    >
      <input
        className="u-input embed-editor_size-input"
        value={props.value}
        spellCheck={false}
        aria-label={props.ariaLabel}
        disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onBlur}
      />
    </VariableConnect>
  ),
};
