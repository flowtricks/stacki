// The style selectors panel: every class and id selector in the project's
// stylesheets, which ones nothing can match any more, and a clean-up that
// removes exactly those. A selector the check cannot prove unused is shown as
// "Can't tell" under its reason, with the action that would settle it, and is
// never removed; the lock adds its names to `.stacki/styles.json` so no later
// clean-up touches them.
import React, { useCallback, useEffect, useState } from 'react';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { usePanelData } from '../../lib/usePanelData';
import { onVariablesChanged } from '../../ipc/editorEnvironment';
import { RefreshIcon, SearchIcon } from '../../ui/Icons';
import { verdictNames, type SelectorEntry, type SelectorReport } from '../../../shared/properties/selectorUsage';
import { keepMatcher } from '../../../shared/properties/styleKeepList';
import { LockIcon, SweepIcon, UnlockIcon } from './SelectorIcons';
import {
  exactPatterns,
  initialFilter,
  selectorCounts,
  selectorGroups,
  SELECTOR_FILTERS,
  unknownReasons,
  unusedEntries,
  type SelectorFilter,
  type SelectorGroup,
} from './selectorList';
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
  const [chosen, setFilter] = useState<SelectorFilter | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The full check searches installed packages, which takes seconds the first
  // time; until it answers, the list comes from the project files alone.
  const report = state.kind === 'ready' ? state.value : early;
  const checking = state.kind === 'loading';
  const unused = report === undefined ? [] : unusedEntries(report);
  // Until the user picks a tab, open on the clean-up when there is one.
  const filter = chosen ?? (report === undefined ? 'all' : initialFilter(report));

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
    showToast(removed === 1 ? 'Removed 1 unused style' : `Removed ${removed} unused styles`, 'success');
    await refresh();
  };

  const changeKeepList = async (run: () => Promise<void>): Promise<void> => {
    await run();
    await refresh();
  };

  if (confirming && report !== undefined) {
    return (
      <div className="panel-section grow selectors-panel">
        <div className="panel-header">
          <h2>Style selectors</h2>
        </div>
        <CleanupConfirm entries={unused} busy={busy} onCancel={() => setConfirming(false)} onDelete={() => void cleanUp()} />
      </div>
    );
  }
  return (
    <div className="panel-section grow selectors-panel">
      <div className="panel-header">
        <h2>Style selectors</h2>
        <button className="ghost" title="Check again" aria-label="Check again" disabled={checking} onClick={() => void refresh()}>
          <RefreshIcon size={14} />
        </button>
      </div>
      <div className="panel-body selectors-body">
        {report === undefined && <PanelReadStatus state={state} label="style selectors" retry={refresh} />}
        {report !== undefined && <Summary report={report} checking={checking} busy={busy} onReview={() => setConfirming(true)} />}
        {report !== undefined && <FilterBar report={report} filter={filter} onFilter={setFilter} />}
        {report !== undefined && (
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
        )}
        {report !== undefined && filter === 'unknown' && (
          <ReasonList report={report} search={search} keepList={keep.stored} onToggleKeep={(entry) => void changeKeepList(() => keep.toggle(entry))} />
        )}
        {report !== undefined && filter !== 'unknown' && (
          <SelectorGroups
            groups={selectorGroups(report, filter, search)}
            empty={emptyText(report, filter)}
            keepList={keep.stored}
            onToggleKeep={(entry) => void changeKeepList(() => keep.toggle(entry))}
          />
        )}
        {report !== undefined && <ReportNotes report={report} />}
      </div>
    </div>
  );
}

function Summary({
  report,
  checking,
  busy,
  onReview,
}: {
  readonly report: SelectorReport;
  readonly checking: boolean;
  readonly busy: boolean;
  readonly onReview: () => void;
}) {
  const counts = selectorCounts(report);
  if (counts.unused > 0) {
    return (
      <div className="selectors-summary has-unused">
        <div className="selectors-summary-text">
          <strong>{counts.unused === 1 ? '1 unused style' : `${counts.unused} unused styles`}</strong>
          <span>Nothing in the project uses {counts.unused === 1 ? 'it' : 'them'}.</span>
        </div>
        <button className="selectors-review" disabled={checking || busy} onClick={onReview}>
          <SweepIcon size={14} />
          Review
        </button>
      </div>
    );
  }
  return (
    <div className="selectors-summary">
      <div className="selectors-summary-text">
        <strong>{checking ? 'Checking installed packages…' : 'No unused styles'}</strong>
        <span>
          {checking
            ? 'The list below comes from the project files; the clean-up waits for this.'
            : counts.unknown > 0
              ? `${counts.unknown} can’t be proven either way — see Can’t tell.`
              : 'Every style is used or locked.'}
        </span>
      </div>
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
  // Every change re-reads the file first: another window or an editor may have changed it.
  const change = async (next: (current: StoredKeepList) => Parameters<typeof updateKeepList>[2]): Promise<void> => {
    try {
      const current = await readKeepList(projectPath);
      setStored(await updateKeepList(projectPath, current, next(current)));
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  const toggle = async (entry: SelectorEntry): Promise<void> => {
    const names = verdictNames(entry.verdict);
    if (names.length === 0) {
      return;
    }
    await change((current) => (entry.verdict.kind === 'kept' ? { add: [], remove: exactPatterns(current.keepList, names) } : { add: names, remove: [] }));
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
    <div className="selectors-tabs" role="tablist" aria-label="Show selectors">
      {SELECTOR_FILTERS.map((option) => (
        <button
          key={option}
          role="tab"
          aria-selected={filter === option}
          className={`selectors-tab ${filter === option ? 'on' : ''}`}
          onClick={() => onFilter(option)}
        >
          {FILTER_LABELS[option]}
          <span className="selectors-tab-count">{counts[option]}</span>
        </button>
      ))}
    </div>
  );
}

function emptyText(report: SelectorReport, filter: SelectorFilter): string {
  if (report.entries.length === 0) {
    return 'No class or id selectors in this project’s stylesheets.';
  }
  switch (filter) {
    case 'unused':
      return 'Nothing to clean up: every style is used, locked or can’t be proven unused.';
    case 'kept':
      return 'No locked styles. Lock a style to keep it through every clean-up.';
    case 'all':
    case 'unknown':
      return 'No selectors match.';
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
}

interface RowActions {
  readonly keepList: StoredKeepList | undefined;
  readonly onToggleKeep: (entry: SelectorEntry) => void;
}

function SelectorGroups({ groups, empty, keepList, onToggleKeep }: { readonly groups: readonly SelectorGroup[]; readonly empty: string } & RowActions) {
  if (groups.length === 0) {
    return <div className="selectors-empty">{empty}</div>;
  }
  return (
    <>
      {groups.map((group) => (
        <section key={group.rel} className="selectors-group">
          <FileHeading rel={group.rel} count={group.entries.length} />
          {group.entries.map((entry) => (
            <SelectorRow key={entry.id} entry={entry} keepList={keepList} onToggleKeep={onToggleKeep} />
          ))}
        </section>
      ))}
    </>
  );
}

function FileHeading({ rel, count }: { readonly rel: string; readonly count: number }) {
  const slash = rel.lastIndexOf('/');
  return (
    <h3 className="selectors-file" title={rel}>
      <span className="selectors-file-name">{rel.slice(slash + 1)}</span>
      <span className="selectors-file-folder">{slash === -1 ? '' : rel.slice(0, slash)}</span>
      <span className="selectors-file-count">{count}</span>
    </h3>
  );
}

// "Can't tell" grouped by reason: each reason is explained once, with the
// next step: lock the names, or change the code so the check can see them.
function ReasonList({ report, search, keepList, onToggleKeep }: { readonly report: SelectorReport; readonly search: string } & RowActions) {
  const reasons = unknownReasons(report, search);
  if (reasons.length === 0) {
    return <div className="selectors-empty">Every style was checked: nothing here is uncertain.</div>;
  }
  return (
    <>
      {reasons.map((group) => (
        <section key={group.reason} className="selectors-reason">
          <div className="selectors-reason-card">
            <p>{group.reason}.</p>
            <p className="selectors-reason-hint">Lock a style to keep it through clean-ups, or change the code above so the check can see its classes.</p>
          </div>
          {group.entries.map((entry) => (
            <SelectorRow key={entry.id} entry={entry} keepList={keepList} onToggleKeep={onToggleKeep} showFile />
          ))}
        </section>
      ))}
    </>
  );
}

function SelectorRow({ entry, keepList, onToggleKeep, showFile = false }: { readonly entry: SelectorEntry; readonly showFile?: boolean } & RowActions) {
  const { verdict } = entry;
  const names = verdictNames(verdict);
  const locked = verdict.kind === 'kept';
  const lockable = names.length > 0 && keepList !== undefined && verdict.kind !== 'checking';
  return (
    <div className={`selectors-row selectors-${verdict.kind}`} title={rowTitle(entry, keepList)}>
      <span className="selectors-chip">{entry.selector}</span>
      {showFile && <span className="selectors-where">{entry.rel.slice(entry.rel.lastIndexOf('/') + 1)}</span>}
      {lockable && (
        <button
          className="ghost selectors-lock"
          aria-label={locked ? `Unlock ${names.join(', ')}` : `Lock ${names.join(', ')} so clean-ups keep it`}
          disabled={locked && exactPatterns(keepList.keepList, names).length === 0}
          onClick={() => onToggleKeep(entry)}
        >
          {locked ? <LockIcon size={13} /> : <UnlockIcon size={13} />}
        </button>
      )}
    </div>
  );
}

function rowTitle(entry: SelectorEntry, keepList: StoredKeepList | undefined): string {
  const where = `${entry.rel}:${entry.line}${entry.scope === 'scoped' ? ' (scoped to its component)' : ''}`;
  const { verdict } = entry;
  const quoted = (names: readonly string[]): string => names.map((name) => `“${name}”`).join(', ');
  switch (verdict.kind) {
    case 'used':
      return `${where}\nIn use.`;
    case 'untracked':
      return `${where}\nStyles elements by tag or attribute; clean-ups never remove it.`;
    case 'unused':
      return `${where}\nNo element, component or script produces ${quoted(verdict.names)}.`;
    case 'kept': {
      const match =
        keepList === undefined
          ? undefined
          : keepList.keepList.keep.find((pattern) => verdict.names.some((name) => keepMatcher({ ...keepList.keepList, keep: [pattern] })(name)));
      return `${where}\nLocked${match === undefined ? '' : ` by “${match}”`} in .stacki/styles.json.`;
    }
    case 'unknown':
      return `${where}\nNothing in the project produces ${quoted(verdict.names)}, but ${verdict.reason}.`;
    case 'checking':
      return `${where}\nNot used in the project files; checking installed packages for ${quoted(verdict.names)}.`;
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
  // Each selector once per file, though every rule it is written in is removed.
  const files = new Map<string, SelectorEntry[]>();
  for (const entry of entries) {
    const list = files.get(entry.rel) ?? [];
    if (!list.some((other) => other.selector === entry.selector)) {
      files.set(entry.rel, [...list, entry]);
    }
  }
  const shown = [...files.values()].reduce((total, list) => total + list.length, 0);
  return (
    <div className="panel-body selectors-confirm">
      <p className="selectors-confirm-title">
        Remove {shown === 1 ? '1 unused style' : `${shown} unused styles`} from {files.size === 1 ? '1 file' : `${files.size} files`}?
      </p>
      <p className="selectors-confirm-text">No element, component, script or installed package uses these. Undo puts them back.</p>
      <div className="selectors-confirm-list">
        {[...files].map(([rel, list]) => (
          <section key={rel} className="selectors-group">
            <FileHeading rel={rel} count={list.length} />
            {list.map((entry) => (
              <div key={entry.id} className="selectors-row selectors-unused" title={`${entry.rel}:${entry.line}`}>
                <span className="selectors-chip">{entry.selector}</span>
              </div>
            ))}
          </section>
        ))}
      </div>
      <div className="selectors-confirm-actions">
        <button className="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="danger" onClick={onDelete} disabled={busy}>
          {busy ? 'Removing…' : shown === 1 ? 'Remove style' : `Remove ${shown} styles`}
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
      <summary>{report.notes.length === 1 ? '1 file' : `${report.notes.length} files`} not checked</summary>
      {report.notes.map((note, index) => (
        <p key={`${note.rel}-${index}`}>
          <span className="selectors-note-file">{note.rel}</span>
          {note.message.replace(/^Its styles were not checked: /, '')}
        </p>
      ))}
    </details>
  );
}
