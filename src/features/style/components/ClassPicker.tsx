import { useTranslate } from '../../../lib/i18n/useTranslate';
import './ClassPicker.css';

export type ClassTokenKind = 'tag' | 'class' | 'attribute';

export type ClassToken = {
  /** Identifier used for selection (e.g. a class name, tag name, or attribute key). */
  name: string;
  /** Display text; defaults to `name`. */
  label?: string;
  /** Drives the tag's color. Defaults to `class`. */
  kind?: ClassTokenKind;
};

export type ClassPickerProps = {
  /** Tokens in display order (e.g. tag first, then classes, then attributes). */
  tokens: ClassToken[];
  /** The currently selected token names. One = a standalone selector; many = a combo. */
  selected: string[];
  /** Called with the next selection whenever it changes. */
  onChange: (selected: string[]) => void;
  ariaLabel?: string;
  className?: string;
  disabled?: boolean;
  /** Custom tooltip per token. Defaults to a "Shift-click to combine" hint. */
  tagTitle?: (token: ClassToken, isActive: boolean) => string;
};

/**
 * The token-choosing control shared across tools (first used in Clip Path): shows
 * each token on the selected element (its tag, classes, and attributes) as a tag.
 * A plain click selects just that token; Shift- or Option-click toggles it into a
 * combined selection. The chosen tokens are always ordered to match the token
 * order given, so a combo reads `.base.combo`, never `.combo.base`.
 */
export function ClassPicker({ tokens, selected, onChange, ariaLabel, className, disabled = false, tagTitle }: ClassPickerProps) {
  const translate = useTranslate();
  const order = tokens.map((token) => token.name);

  // Additive (Shift/Alt) toggles a token in or out of the combo; plain replaces it.
  const selectToken = (name: string, options: { readonly additive: boolean }) => {
    const next = options.additive
      ? selected.includes(name)
        ? // Toggling off — but never empty the selection; at least one stays selected.
          selected.length > 1
          ? selected.filter((entry) => entry !== name)
          : selected
        : [...selected, name]
      : [name];
    // Keep the combo order matching the token order.
    const ordered = [...next].sort((left, right) => order.indexOf(left) - order.indexOf(right));
    // No-op guard so a click on the sole selected token doesn't churn.
    if (ordered.length === selected.length && ordered.every((entry, index) => entry === selected[index])) {
      return;
    }
    onChange(ordered);
  };

  if (!tokens.length) {
    return undefined;
  }

  return (
    <div
      className={`class-picker${className ? ` ${className}` : ''}`}
      role="group"
      aria-label={ariaLabel ?? translate('styleModel.components.classPicker.tokens')}
    >
      {tokens.map((token) => {
        const isActive = selected.includes(token.name);
        const kind = token.kind ?? 'class';
        return (
          <button
            key={`${kind}:${token.name}`}
            type="button"
            className={`class-picker_tag is-${kind}${isActive ? ' is-active' : ''}`}
            aria-pressed={isActive}
            disabled={disabled}
            title={tagTitle ? tagTitle(token, isActive) : translate('styleModel.components.classPicker.combine', { name: token.label ?? token.name })}
            onClick={(event) => selectToken(token.name, { additive: event.shiftKey || event.altKey })}
          >
            {token.label ?? token.name}
          </button>
        );
      })}
    </div>
  );
}

export default ClassPicker;
