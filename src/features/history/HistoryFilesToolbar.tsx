import Dropdown from '../../ui/Dropdown';
import type { HistoryFileFilter, HistoryFileSort } from './historyFileList';
import type { HistoryFileSummary } from './historyFileSummary';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'updated', label: 'Changed' },
  { value: 'added', label: 'New' },
  { value: 'deleted', label: 'Deleted' },
] as const;
const SORTS = [
  { value: 'path', label: 'File path' },
  { value: 'status', label: 'Status' },
] as const;

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
  const total = counts.added + counts.deleted + counts.updated;
  return (
    <div className="history-files-toolbar">
      <div className="history-file-filters" role="group" aria-label="Filter changed files">
        {FILTERS.map(({ value, label }) => (
          <button key={value} aria-pressed={filter === value} onClick={() => onFilter(value)}>
            {label} ({value === 'all' ? total : counts[value]})
          </button>
        ))}
      </div>
      <div className="history-file-sort">
        <span>Sort</span>
        <Dropdown<HistoryFileSort> ariaLabel="Sort changed files" value={sort} options={SORTS} onChange={onSort} />
      </div>
    </div>
  );
}
