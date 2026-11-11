// A search field with its glass (searchField.css). The Apps panel's searches use
// it, and so does the app UI kit's `<stacki-search>`
// (src/features/apps/uiKit/kitElements.tsx), so an app's search is this one.
import { SearchIcon } from './Icons';
import './searchField.css';

export function SearchField({
  label,
  value,
  placeholder,
  className,
  onChange,
}: {
  /** The accessible name, and the placeholder unless one is given. */
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  /** A caller's own class beside `ui-search` (its margin in the panel). */
  readonly className?: string;
  readonly onChange: (value: string) => void;
}) {
  return (
    <label className={`ui-search${className === undefined ? '' : ` ${className}`}`}>
      <SearchIcon size={14} className="ui-search-icon" />
      <input type="search" aria-label={label} placeholder={placeholder ?? label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}
