// A search field with its glass (searchField.css). The Apps panel's searches use
// it, and so does the app UI kit's `<stacki-search>`
// (src/features/apps/uiKit/kitElements.tsx), so an app's search is this one.
// A caller that passes `clearLabel` also gets the panel search's clear button inside the field while it holds
// text, and Escape empties it (PanelSearch.tsx behaves the same), for the person working with the pointer.
import { CloseIcon, SearchIcon } from './Icons';
import './searchField.css';

export function SearchField({
  label,
  value,
  placeholder,
  className,
  clearLabel,
  onChange,
}: {
  /** The accessible name, and the placeholder unless one is given. */
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  /** A caller's own class beside `ui-search` (its margin in the panel). */
  readonly className?: string;
  /** Names the clear button; without it the field has none, as before. */
  readonly clearLabel?: string;
  readonly onChange: (value: string) => void;
}) {
  const clearable = clearLabel !== undefined;
  const classes = ['ui-search', clearable ? 'clearable' : '', className ?? ''].filter((name) => name !== '').join(' ');
  return (
    <label className={classes}>
      <SearchIcon size={14} className="ui-search-icon" />
      <input
        type="search"
        aria-label={label}
        placeholder={placeholder ?? label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // Only a field with text takes the key, so Escape on an empty one still reaches the panel.
          if (clearable && event.key === 'Escape' && value.length > 0) {
            event.stopPropagation();
            onChange('');
          }
        }}
      />
      {clearable && value.length > 0 && (
        <button
          type="button"
          className="ghost ui-search-clear"
          aria-label={clearLabel}
          onClick={(event) => {
            // The field keeps the focus, so the person types the next search straight away.
            event.preventDefault();
            event.currentTarget.parentElement?.querySelector('input')?.focus();
            onChange('');
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </label>
  );
}
