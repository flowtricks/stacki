// The action bar under the Pages list while Select mode is on, as the Assets panel's bar: a select-all checkbox, how
// many are ticked, Cancel, and Delete, which is red because it is the one thing here that cannot be taken lightly.
import { useEffect, useRef } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';
import './pageSelect.css';

export function PageSelectionBar({
  count,
  allShown,
  someShown,
  busy,
  toggleAll,
  remove,
  cancel,
}: {
  readonly count: number;
  readonly allShown: boolean;
  readonly someShown: boolean;
  readonly busy: boolean;
  readonly toggleAll: () => void;
  readonly remove: () => void;
  readonly cancel: () => void;
}) {
  const translate = useTranslate();
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) {
      box.current.indeterminate = someShown && !allShown;
    }
  }, [allShown, someShown]);
  return (
    <div className="page-select-bar" role="toolbar" aria-label={translate('pages.select.startTitle')}>
      <input
        ref={box}
        type="checkbox"
        className="page-select-box"
        aria-label={translate('pages.select.all')}
        title={translate('pages.select.all')}
        checked={allShown}
        disabled={busy}
        onChange={toggleAll}
      />
      <span className="page-select-count" aria-live="polite">
        {translate('pages.select.count', { count })}
      </span>
      <button disabled={busy} onClick={cancel}>
        {translate('ui.cancel')}
      </button>
      <button className="danger" disabled={busy || count === 0} onClick={remove}>
        {translate('pages.select.delete')}
      </button>
    </div>
  );
}

/** The checkbox that starts a row in Select mode; the row's own click ticks it, so it takes no clicks itself. */
export function PageSelectBox({
  checked,
  partial,
  refusal,
  label,
}: {
  readonly checked: boolean;
  readonly partial: boolean;
  readonly refusal: string | undefined;
  readonly label: string;
}) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (box.current) {
      box.current.indeterminate = partial && !checked;
    }
  }, [checked, partial]);
  return (
    <input ref={box} type="checkbox" className="page-select-box" tabIndex={-1} readOnly checked={checked} disabled={refusal !== undefined} aria-label={label} />
  );
}
