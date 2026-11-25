import Dropdown from '../../ui/Dropdown';
import type { MessageKey } from '../../lib/i18n/localeContext';
import { useTranslate } from '../../lib/i18n/useTranslate';
import type { HistoryFileFilter, HistoryFileSort } from './historyFileList';
import type { HistoryFileSummary } from './historyFileSummary';

const FILTERS = [
  { value: 'all', label: 'history.filter.all' },
  { value: 'updated', label: 'history.filter.updated' },
  { value: 'added', label: 'history.filter.added' },
  { value: 'deleted', label: 'history.filter.deleted' },
] as const satisfies ReadonlyArray<{ readonly value: string; readonly label: MessageKey }>;
const SORTS = [
  { value: 'path', label: 'history.sort.path' },
  { value: 'status', label: 'history.sort.status' },
] as const satisfies ReadonlyArray<{ readonly value: HistoryFileSort; readonly label: MessageKey }>;

export default function HistoryFilesToolbar({
  counts,
  filter,
  sort,
  onFilter,
  onSort,
}: {
  readonly counts: HistoryFileSummary;
  readonly filter: HistoryFileFilter;
  readonly sort: HistoryFileSort;
  readonly onFilter: (value: HistoryFileFilter) => void;
  readonly onSort: (value: HistoryFileSort) => void;
}) {
  const translate = useTranslate();
  const sortOptions = SORTS.map(({ value, label }) => ({ value, label: translate(label) }));
  const total = counts.added + counts.deleted + counts.updated;
  return (
    <div className="history-files-toolbar">
      <div className="history-file-filters" role="group" aria-label={translate('history.filter.label')}>
        {FILTERS.map(({ value, label }) => (
          <button key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>
            {translate(label)} ({value === 'all' ? total : counts[value]})
          </button>
        ))}
      </div>
      <div className="history-file-sort">
        <span>{translate('history.sort.label')}</span>
        <Dropdown<HistoryFileSort> ariaLabel={translate('history.sort.ariaLabel')} value={sort} options={sortOptions} onChange={onSort} />
      </div>
    </div>
  );
}
