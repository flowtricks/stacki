// The style selectors panel: every class and id selector in the project's
// stylesheets, which ones nothing can match any more, and a clean-up that
// removes exactly those. A selector the check cannot prove unused is shown as
// "Can't tell" with the reason and is never removed; the lock adds its names to
// `.stacki/styles.json` so no later clean-up touches them.
import React, { useCallback, useEffect, useState } from 'react';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { usePanelData } from '../../lib/usePanelData';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import { RefreshIcon, SearchIcon } from '../../ui/Icons';
import { verdictNames, type SelectorEntry, type SelectorReport } from '../../../shared/properties/selectorUsage';
import { keepMatcher } from '../../../shared/properties/styleKeepList';
import { LockIcon, SweepIcon, UnlockIcon } from './SelectorIcons';
import { exactPatterns, selectorCounts, selectorGroups, SELECTOR_FILTERS, unusedEntries, type SelectorFilter } from './selectorList';
import {
  readKeepList,
  readSelectorReport,
  selectorReportCache,
  removeSelectors,
  restoreSelectors,
  updateKeepList,
  type StoredKeepList,
} from './selectorsBridge';
import './selectors.css';

export interface SelectorsPanelProps {
  readonly project: { readonly path: string };
  readonly showToast: (message: string, kind?: 'info' | 'success' | 'error') => void;
  readonly onRecordUndo: (command: { readonly label: string; readonly undo: () => Promise<void>; redo: () => Promise<void> }) => void;
}

export default function SelectorsPanel(props: SelectorsPanelProps) {
  // A different project starts with a fresh filter, search and confirmation.
  return <ProjectSelectors key={props.project.path} {...props} />;
}

function ProjectSelectors({ project, showToast, onRecordUndo }: SelectorsPanelProps) {
  const read = useCallback(() => readSelectorReport(project.path), [project.path]);
  const { state, refresh } = usePanelData(selectorReportCache, project.path, read, onVariablesChanged);
  const early = useEarlyReport(project.path, { loading: state.kind === 'loading' });
  const keep = useKeepList(project.path, showToast);
  const [filter, setFilter] = useState<SelectorFilter>('all');
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The full check searches installed packages, which takes seconds the first
  // time; until it answers, the list comes from the project files alone.
  const report = state.kind === 'ready' ? state.value : early;
  const unused = report === undefined ? [] : unusedEntries(report);

  const cleanUp = async (): Promise<void> => {
    if (report === undefined) {
      return;
    }
    setBusy(true);
    const result = await removeSelectors(
      project.path,
      unused.map((entry) => entry.id),
      report.files,
    );
    setBusy(false);
    setConfirming(false);
    if (!result.ok) {
      showToast(result.error, 'error');
      await refresh();
      return;
    }
    const { changes, removed } = result.value;
    onRecordUndo({
      label: 'Clean up unused styles',
      undo: () => restoreSelectors(project.path, changes, 'before').finally(() => void refresh()),
      redo: () => restoreSelectors(project.path, changes, 'after').finally(() => void refresh()),
    });
    showToast(removed === 1 ? 'Removed 1 unused selector' : `Removed ${removed} unused selectors`, 'success');
    await refresh();
  };

  const toggleKeep = async (entry: SelectorEntry): Promise<void> => {
    await keep.toggle(entry);
    await refresh();
  };

  return (
    <div className="panel-section grow selectors-panel">
      <div className="panel-header">
        <h2>Style selectors</h2>
        <div className="selectors-actions">
          <button className="ghost" title="Check again" aria-label="Check again" onClick={() => void refresh()}>
            <RefreshIcon size={14} />
          </button>
          <span className="tip-anchor" title={unused.length === 0 ? 'No unused styles to clean up' : 'Clean up unused styles'}>
            <button className="ghost" aria-label="Clean up unused styles" disabled={unused.length === 0 || busy} onClick={() => setConfirming(true)}>
              <SweepIcon size={16} />
            </button>
          </span>
        </div>
      </div>
      {confirming && report !== undefined ? (
        <CleanupConfirm entries={unused} busy={busy} onCancel={() => setConfirming(false)} onDelete={() => void cleanUp()} />
      ) : (
        <div className="panel-body selectors-body">
          <label className="selectors-search">
            <SearchIcon size={14} />
            <input
              value={search}
              placeholder="Search styles"
              spellCheck={false}
              aria-label="Search styles"
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          {report !== undefined && <FilterBar report={report} filter={filter} onFilter={setFilter} />}
          {report === undefined && <PanelReadStatus state={state} label="style selectors" retry={refresh} />}
          {state.kind === 'loading' && report !== undefined && <p className="selectors-progress">Checking installed packages…</p>}
          {report !== undefined && (
            <SelectorGroups report={report} filter={filter} search={search} keepList={keep.stored} onToggleKeep={(entry) => void toggleKeep(entry)} />
          )}
          {report !== undefined && <ReportNotes report={report} />}
        </div>
      )}
    </div>
  );
}

function useEarlyReport(projectPath: string, options: { readonly loading: boolean }): SelectorReport | undefined {
  const wanted = options.loading;
  const [early, setEarly] = useState<SelectorReport | undefined>(undefined);
  useEffect(() => {
    if (!wanted) {
      return undefined;
    }
    let active = true;
    void readSelectorReport(projectPath, 'cached').then((result) => {
      if (active && result.ok) {
        setEarly(result.value);
      }
    });
    return () => {
      active = false;
    };
  }, [projectPath, wanted]);
  return early;
}

function useKeepList(projectPath: string, showToast: SelectorsPanelProps['showToast']) {
  const [stored, setStored] = useState<StoredKeepList | undefined>(undefined);
  useEffect(() => {
    let active = true;
    readKeepList(projectPath).then(
      (value) => {
        if (active) {
          setStored(value);
        }
      },
      (error: unknown) => showToast(`Could not read .stacki/styles.json: ${String(error)}`, 'error'),
    );
    return () => {
      active = false;
    };
  }, [projectPath, showToast]);
  const toggle = async (entry: SelectorEntry): Promise<void> => {
    const names = verdictNames(entry.verdict);
    if (names.length === 0) {
      return;
    }
    try {
      // Re-read first: another window or an editor may have changed the file.
      const current = await readKeepList(projectPath);
      const change = entry.verdict.kind === 'kept' ? { add: [], remove: exactPatterns(current.keepList, names) } : { add: names, remove: [] };
      setStored(await updateKeepList(projectPath, current, change));
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  return { stored, toggle };
}

const FILTER_LABELS: Readonly<Record<SelectorFilter, string>> = { all: 'All', unused: 'Unused', unknown: 'Can’t tell', kept: 'Locked' };

function FilterBar({
  report,
  filter,
  onFilter,
}: {
  readonly report: SelectorReport;
  readonly filter: SelectorFilter;
  readonly onFilter: (filter: SelectorFilter) => void;
}) {
  const counts = selectorCounts(report);
  return (
    <div className="selectors-filters" role="tablist" aria-label="Show selectors">
      {SELECTOR_FILTERS.map((option) => (
        <button
          key={option}
          role="tab"
          aria-selected={filter === option}
          className={`selectors-filter ${filter === option ? 'on' : ''}`}
          onClick={() => onFilter(option)}
        >
          {FILTER_LABELS[option]} <span className="selectors-filter-count">{counts[option]}</span>
        </button>
      ))}
    </div>
  );
}

interface GroupsProps {
  readonly report: SelectorReport;
  readonly filter: SelectorFilter;
  readonly search: string;
  readonly keepList: StoredKeepList | undefined;
  readonly onToggleKeep: (entry: SelectorEntry) => void;
}

function SelectorGroups({ report, filter, search, keepList, onToggleKeep }: GroupsProps) {
  const groups = selectorGroups(report, filter, search);
  if (groups.length === 0) {
    return <div className="props-empty">{report.entries.length === 0 ? 'No class or id selectors in this project’s stylesheets.' : 'No selectors match.'}</div>;
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.rel} className="selectors-group">
          <h3 className="selectors-file" title={group.rel}>
            {group.rel}
          </h3>
          {group.entries.map((entry) => (
            <SelectorRow key={entry.id} entry={entry} keepList={keepList} onToggleKeep={onToggleKeep} />
          ))}
        </section>
      ))}
    </>
  );
}

function SelectorRow({
  entry,
  keepList,
  onToggleKeep,
}: {
  readonly entry: SelectorEntry;
  readonly keepList: StoredKeepList | undefined;
  readonly onToggleKeep: (entry: SelectorEntry) => void;
}) {
  const { verdict } = entry;
  const names = verdictNames(verdict);
  const lockable = names.length > 0;
  const title = rowTitle(entry, keepList);
  return (
    <div className={`selectors-row selectors-${verdict.kind}`} title={title}>
      <span className="selectors-chip">{entry.selector}</span>
      <span className="selectors-line">{entry.line}</span>
      {lockable && keepList !== undefined && (
        <button
          className="ghost selectors-lock"
          aria-label={verdict.kind === 'kept' ? `Unlock ${names.join(', ')}` : `Lock ${names.join(', ')} so clean-ups keep it`}
          disabled={verdict.kind === 'kept' && exactPatterns(keepList.keepList, names).length === 0}
          onClick={() => onToggleKeep(entry)}
        >
          {verdict.kind === 'kept' ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
        </button>
      )}
    </div>
  );
}

function rowTitle(entry: SelectorEntry, keepList: StoredKeepList | undefined): string {
  const where = `${entry.rel}:${entry.line}${entry.scope === 'scoped' ? ' (scoped)' : ''}`;
  const { verdict } = entry;
  switch (verdict.kind) {
    case 'used':
      return `${where}\nIn use.`;
    case 'untracked':
      return `${where}\nStyles elements by tag or attribute; clean-ups never remove it.`;
    case 'unused':
      return `${where}\nNothing in the project produces ${verdict.names.map((name) => `“${name}”`).join(', ')}.`;
    case 'kept': {
      const match =
        keepList === undefined
          ? undefined
          : keepList.keepList.keep.find((pattern) => verdict.names.some((name) => keepMatcher({ ...keepList.keepList, keep: [pattern] })(name)));
      return `${where}\nLocked${match === undefined ? '' : ` by “${match}”`} in .stacki/styles.json.`;
    }
    case 'unknown':
      return `${where}\nCan’t tell whether it is used: ${verdict.reason}.`;
    case 'checking':
      return `${where}\nNot used in the project files; checking installed packages for ${verdict.names.map((name) => `“${name}”`).join(', ')}.`;
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

function CleanupConfirm({
  entries,
  busy,
  onCancel,
  onDelete,
}: {
  readonly entries: readonly SelectorEntry[];
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onDelete: () => void;
}) {
  return (
    <div className="panel-body selectors-confirm">
      <p>These styles are not used by anything in the project:</p>
      <div className="selectors-confirm-list">
        {entries.map((entry) => (
          <span key={entry.id} className="selectors-chip" title={`${entry.rel}:${entry.line}`}>
            {entry.selector}
          </span>
        ))}
      </div>
      <p>Delete them? Undo restores them.</p>
      <div className="selectors-confirm-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="danger" onClick={onDelete} disabled={busy}>
          {busy ? 'Deleting…' : 'Delete'}
        </button>
      </div>
    </div>
  );
}

function ReportNotes({ report }: { readonly report: SelectorReport }) {
  if (report.notes.length === 0) {
    return undefined;
  }
  return (
    <details className="selectors-notes">
      <summary>Not checked ({report.notes.length})</summary>
      {report.notes.map((note, index) => (
        <p key={`${note.rel}-${index}`}>
          <span className="selectors-file">{note.rel}</span> {note.message}
        </p>
      ))}
    </details>
  );
}
