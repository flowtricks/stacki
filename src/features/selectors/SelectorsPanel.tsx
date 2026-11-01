// The style selectors panel: every class and id selector in the project's
// stylesheets, which ones nothing can match any more, and a clean-up that
// removes exactly those. A selector the check cannot prove unused is listed
// under "Can't tell" with its reason and is never removed; the lock adds its
// names to `.stacki/styles.json` so no later clean-up touches them.
//
// The list stays quiet on purpose: one line per selector, with only the class
// names that make a rule removable tinted.
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import Popup from '../../ui/Popup';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { usePanelData } from '../../lib/usePanelData';
import { onPropertyFilesChanged, onVariablesChanged } from '../../ipc/editorEnvironment';
import { SearchIcon, TrashIcon } from '../../ui/Icons';
import { verdictNames, type SelectorEntry, type SelectorReport } from '../../../shared/properties/selectorUsage';
import { LockIcon, SweepIcon, UnlockIcon } from './SelectorIcons';
import {
  exactPatterns,
  firstRows,
  initialFilter,
  LIST_PAGE_ROWS,
  selectorCounts,
  selectorGroups,
  selectorSegments,
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

// The panel keeps itself current: any project file change (markup, scripts,
// data) or a stylesheet change re-runs the check, coalesced by usePanelData.
function onProjectChanged(changed: () => void): () => void {
  const offFiles = onPropertyFilesChanged(() => changed());
  const offStyles = onVariablesChanged(changed);
  return () => {
    offFiles();
    offStyles();
  };
}

export default function SelectorsPanel(props: SelectorsPanelProps) {
  // A different project starts with a fresh filter, search and confirmation.
  return <ProjectSelectors key={props.project.path} {...props} />;
}

function ProjectSelectors({ project, showToast, onRecordUndo }: SelectorsPanelProps) {
  const read = useCallback(() => readSelectorReport(project.path), [project.path]);
  const { state, refresh } = usePanelData(selectorReportCache, project.path, read, onProjectChanged);
  const early = useEarlyReport(project.path, { loading: state.kind === 'loading' });
  const keep = useKeepList(project.path, showToast);
  const [chosen, setFilter] = useState<SelectorFilter | undefined>(undefined);
  const [search, setSearch] = useState('');
  // Long lists draw a page at a time; a new tab or search starts from the top.
  const [limit, setLimit] = useState(LIST_PAGE_ROWS);
  useEffect(() => setLimit(LIST_PAGE_ROWS), [chosen, search]);
  const more = useCallback(() => setLimit((current) => current + LIST_PAGE_ROWS), []);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // The full check searches installed packages, which takes seconds the first
  // time; until it answers, the list comes from the project files alone.
  const report = state.kind === 'ready' ? state.value : early;
  const checking = state.kind === 'loading';
  const unused = report === undefined ? [] : unusedEntries(report);
  // Until the user picks a tab, open on the clean-up when there is one.
  const filter = chosen ?? (report === undefined ? 'all' : initialFilter(report));

  const hover = useHoverTip();
  // One path for removing styles, whether all of them or one row: the check
  // re-runs in the main process, and the files sent are only those touched.
  const removeEntries = async (targets: readonly SelectorEntry[]): Promise<void> => {
    if (report === undefined || targets.length === 0) {
      return;
    }
    const rels = new Set(targets.map((entry) => entry.rel));
    setBusy(true);
    const result = await removeSelectors(
      project.path,
      targets.map((entry) => entry.id),
      report.files.filter((file) => rels.has(file.rel)),
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
      label: 'Remove unused styles',
      undo: () => restoreSelectors(project.path, changes, 'before').finally(() => void refresh()),
      redo: () => restoreSelectors(project.path, changes, 'after').finally(() => void refresh()),
    });
    showToast(removed === 1 ? 'Removed 1 unused style' : `Removed ${removed} unused styles`, 'success');
    await refresh();
  };
  const cleanUp = (): Promise<void> => removeEntries(unused);
  // A row stands for every rule its selector is written in within that file.
  const removeOne = (entry: SelectorEntry): void => {
    hover.leave();
    void removeEntries(unused.filter((other) => other.rel === entry.rel && other.selector === entry.selector));
  };

  const toggleKeep = (entry: SelectorEntry): void => {
    void keep.toggle(entry).then(refresh);
  };

  if (confirming && report !== undefined) {
    return (
      <div className="panel-section grow selectors-panel">
        <div className="panel-header">
          <h2>Remove unused styles</h2>
        </div>
        <CleanupConfirm entries={unused} busy={busy} onCancel={() => setConfirming(false)} onDelete={() => void cleanUp()} />
      </div>
    );
  }
  return (
    <div className="panel-section grow selectors-panel">
      <div className="panel-header">
        <h2>Style selectors</h2>
        <span className="tip-anchor" title={unused.length === 0 ? 'No unused styles to clean up' : 'Clean up unused styles'}>
          <button
            className="ghost selectors-clean"
            aria-label="Clean up unused styles"
            disabled={unused.length === 0 || checking || busy}
            onClick={() => setConfirming(true)}
          >
            <SweepIcon size={16} />
          </button>
        </span>
      </div>
      {report === undefined ? (
        <div className="panel-body">
          <PanelReadStatus state={state} label="style selectors" retry={refresh} />
        </div>
      ) : (
        <>
          <div className="selectors-controls">
            <FilterTabs report={report} filter={filter} onFilter={setFilter} />
            <label className="selectors-search">
              <SearchIcon size={13} />
              <input value={search} placeholder="Search" spellCheck={false} aria-label="Search styles" onChange={(event) => setSearch(event.target.value)} />
            </label>
          </div>
          <div className="panel-body selectors-body">
            <Banner filter={filter} report={report} checking={checking} />
            {filter === 'unknown' ? (
              <ReasonList
                report={report}
                search={search}
                limit={limit}
                onMore={more}
                keepList={keep.stored}
                onToggleKeep={toggleKeep}
                hover={hover}
                onRemove={busy ? undefined : removeOne}
              />
            ) : (
              <SelectorGroups
                groups={selectorGroups(report, filter, search)}
                limit={limit}
                onMore={more}
                empty={emptyText(report, filter)}
                keepList={keep.stored}
                onToggleKeep={toggleKeep}
                hover={hover}
                onRemove={busy ? undefined : removeOne}
              />
            )}
            <ReportNotes report={report} />
          </div>
          <SelectorTip tip={hover.tip} onClose={hover.leave} />
        </>
      )}
    </div>
  );
}

interface HoverTip {
  readonly entry: SelectorEntry;
  readonly left: number;
  readonly top: number;
}

interface HoverActions {
  readonly tip: HoverTip | undefined;
  readonly enter: (entry: SelectorEntry, row: HTMLElement) => void;
  readonly leave: () => void;
}

// A short delay keeps the tooltip from flickering while the pointer crosses
// the list; once one is open, moving to the next row shows its tip at once.
const TIP_DELAY_MS = 250;

function useHoverTip(): HoverActions {
  const [tip, setTip] = useState<HoverTip | undefined>(undefined);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const enter = (entry: SelectorEntry, row: HTMLElement): void => {
    const bounds = row.getBoundingClientRect();
    const next = {
      entry,
      left: Math.max(8, Math.min(bounds.left + 18, window.innerWidth - 368)),
      top: Math.min(bounds.bottom + 4, window.innerHeight - 140),
    };
    clearTimeout(timer.current);
    if (tip === undefined) {
      timer.current = setTimeout(() => setTip(next), TIP_DELAY_MS);
    } else {
      setTip(next);
    }
  };
  const leave = (): void => {
    clearTimeout(timer.current);
    setTip(undefined);
  };
  return { tip, enter, leave };
}

// The full selector; the row itself stays one line.
function SelectorTip({ tip, onClose }: { readonly tip: HoverTip | undefined; readonly onClose: () => void }) {
  if (tip === undefined) {
    return undefined;
  }
  const { entry } = tip;
  return (
    <Popup
      mode="popover"
      role="tooltip"
      open
      dismissible={false}
      onClose={onClose}
      className="popup-tooltip selectors-tip"
      style={{ position: 'fixed', left: tip.left, top: tip.top }}
    >
      <SelectorText entry={entry} className="selectors-tip-selector" />
    </Popup>
  );
}

const FILTER_LABELS: Readonly<Record<SelectorFilter, string>> = { unused: 'Unused', unknown: 'Can’t tell', kept: 'Locked', all: 'All' };

function FilterTabs({
  report,
  filter,
  onFilter,
}: {
  readonly report: SelectorReport;
  readonly filter: SelectorFilter;
  readonly onFilter: (filter: SelectorFilter) => void;
}) {
  const counts = selectorCounts(report);
  // Can't tell and Locked appear only when they hold something (or are open),
  // so the tabs that matter always fit.
  const shown = SELECTOR_FILTERS.filter((option) => option === 'unused' || option === 'all' || option === filter || counts[option] > 0);
  const indicator = useTabIndicator(filter, shown.join(' '));
  return (
    <div className="selectors-tabs" role="tablist" aria-label="Show selectors" ref={indicator.list}>
      <span className="selectors-tab-indicator" aria-hidden="true" style={indicator.style} />
      {shown.map((option) => (
        <button
          key={option}
          role="tab"
          aria-selected={filter === option}
          data-tab={option}
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

// The active tab's background is one element that slides to whichever tab is
// selected. It is measured after layout, and again when the list resizes (the
// panel is resizable, and tabs come and go with their counts).
function useTabIndicator(filter: SelectorFilter, layoutKey: string) {
  const list = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ readonly left: number; readonly width: number } | undefined>(undefined);
  useLayoutEffect(() => {
    const element = list.current;
    if (element === null) {
      return undefined;
    }
    const measure = (): void => {
      const tab = element.querySelector<HTMLElement>(`[data-tab="${filter}"]`);
      setBox(tab === null ? undefined : { left: tab.offsetLeft, width: tab.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [filter, layoutKey]);
  const style = box === undefined ? { opacity: 0 } : { transform: `translateX(${box.left}px)`, width: box.width };
  return { list, style };
}

// A line above the list only where the list needs explaining: while packages
// are being searched, and why "Can't tell" styles are never removed.
function Banner({ filter, report, checking }: { readonly filter: SelectorFilter; readonly report: SelectorReport; readonly checking: boolean }) {
  const counts = selectorCounts(report);
  if (checking) {
    return <p className="selectors-banner">Checking installed packages…</p>;
  }
  switch (filter) {
    case 'unknown':
      return counts.unknown === 0 ? undefined : <p className="selectors-banner">These may be in use, so they are never removed.</p>;
    case 'unused':
    case 'kept':
    case 'all':
      return undefined;
    default: {
      const exhaustive: never = filter;
      return exhaustive;
    }
  }
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

function emptyText(report: SelectorReport, filter: SelectorFilter): string {
  if (report.entries.length === 0) {
    return 'No class or id selectors in this project’s stylesheets.';
  }
  switch (filter) {
    case 'unused':
      return 'No unused styles. Every style is used, locked, or might be in use.';
    case 'kept':
      return 'No locked styles. Lock a style from its row to keep it through every clean-up.';
    case 'unknown':
    case 'all':
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
  readonly hover: HoverActions | undefined;
  /** Removes an unused row's selector; undefined where rows cannot be removed. */
  readonly onRemove: ((entry: SelectorEntry) => void) | undefined;
}

interface Paging {
  readonly limit: number;
  readonly onMore: () => void;
}

function SelectorGroups({
  groups: all,
  limit,
  onMore,
  empty,
  keepList,
  onToggleKeep,
  hover,
  onRemove,
}: { readonly groups: readonly SelectorGroup[]; readonly empty: string } & RowActions & Paging) {
  if (all.length === 0) {
    return <p className="selectors-empty">{empty}</p>;
  }
  const { groups, total } = firstRows(all, limit);
  return (
    <>
      {groups.map((group) => (
        <section key={group.rel} className="selectors-group">
          <h3 className="selectors-file" title={group.rel}>
            {group.rel.slice(group.rel.lastIndexOf('/') + 1)}
          </h3>
          {group.entries.map((entry) => (
            <SelectorRow key={entry.id} entry={entry} keepList={keepList} onToggleKeep={onToggleKeep} hover={hover} onRemove={onRemove} />
          ))}
        </section>
      ))}
      {limit < total && <MoreRows onMore={onMore} />}
    </>
  );
}

// "Can't tell" grouped by reason: each reason is said once, above the
// selectors it covers.
function ReasonList({
  report,
  search,
  limit,
  onMore,
  keepList,
  onToggleKeep,
  hover,
  onRemove,
}: { readonly report: SelectorReport; readonly search: string } & RowActions & Paging) {
  const all = unknownReasons(report, search);
  if (all.length === 0) {
    return <p className="selectors-empty">Nothing is uncertain: every style was checked.</p>;
  }
  const { groups: reasons, total } = firstRows(all, limit);
  return (
    <>
      {reasons.map((group) => (
        <section key={group.reason} className="selectors-group">
          <p className="selectors-reason">{sentence(group.reason)}</p>
          {group.entries.map((entry) => (
            <SelectorRow key={entry.id} entry={entry} keepList={keepList} onToggleKeep={onToggleKeep} hover={hover} onRemove={onRemove} />
          ))}
        </section>
      ))}
      {limit < total && <MoreRows onMore={onMore} />}
    </>
  );
}

// The end of a page: the next one is drawn as this scrolls near view, a
// little before the bottom so the list never visibly runs out. Without an
// IntersectionObserver it is a button.
function MoreRows({ onMore }: { readonly onMore: () => void }) {
  const marker = useRef<HTMLDivElement>(null);
  const watching = typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    const element = marker.current;
    if (element === null || !watching) {
      return undefined;
    }
    const observer = new IntersectionObserver(
      (records) => {
        if (records.some((record) => record.isIntersecting)) {
          onMore();
        }
      },
      { rootMargin: '0px 0px 300px 0px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [onMore, watching]);
  return (
    <div ref={marker} className="selectors-more">
      {!watching && (
        <button className="ghost" onClick={onMore}>
          Show more
        </button>
      )}
    </div>
  );
}

function sentence(text: string): string {
  const capital = text.charAt(0).toUpperCase() + text.slice(1);
  return capital.endsWith('.') ? capital : `${capital}.`;
}

function SelectorRow({ entry, keepList, onToggleKeep, hover, onRemove }: { readonly entry: SelectorEntry } & RowActions) {
  const { verdict } = entry;
  const names = verdictNames(verdict);
  const locked = verdict.kind === 'kept';
  const lockable = names.length > 0 && keepList !== undefined && verdict.kind !== 'checking';
  return (
    <div className={`selectors-row is-${verdict.kind}`} onMouseEnter={(event) => hover?.enter(entry, event.currentTarget)} onMouseLeave={() => hover?.leave()}>
      <SelectorText entry={entry} className="selectors-selector" />
      {(lockable || (verdict.kind === 'unused' && onRemove !== undefined)) && (
        // Floats over the end of the row, so a hidden button takes no width from the selector.
        <span className="selectors-actions">
          {lockable && (
            <button
              className={`ghost selectors-lock ${locked ? 'on' : ''}`}
              aria-label={locked ? `Unlock ${names.join(', ')}` : `Lock ${names.join(', ')} so clean-ups keep it`}
              disabled={locked && exactPatterns(keepList.keepList, names).length === 0}
              onClick={() => onToggleKeep(entry)}
            >
              {locked ? <LockIcon size={12} /> : <UnlockIcon size={12} />}
            </button>
          )}
          {verdict.kind === 'unused' && onRemove !== undefined && (
            <button className="ghost selectors-remove-one" aria-label={`Remove ${entry.selector}`} onClick={() => onRemove(entry)}>
              <TrashIcon size={12} />
            </button>
          )}
        </span>
      )}
    </div>
  );
}

/** A selector with the names its verdict is about tinted. */
function SelectorText({ entry, className }: { readonly entry: SelectorEntry; readonly className: string }) {
  const names = entry.verdict.kind === 'used' ? [] : verdictNames(entry.verdict);
  return (
    <code className={className}>
      {selectorSegments(entry.selector, names).map((segment, index) =>
        segment.flagged ? (
          <mark key={index} className="selectors-flag">
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </code>
  );
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
    <>
      <div className="panel-body selectors-body">
        <p className="selectors-banner">
          {shown === 1 ? 'This style' : `These ${shown} styles`} will be removed from {files.size === 1 ? '1 file' : `${files.size} files`}. Undo puts{' '}
          {shown === 1 ? 'it' : 'them'} back.
        </p>
        <SelectorGroups
          groups={[...files].map(([rel, list]) => ({ rel, entries: list }))}
          limit={shown}
          onMore={() => undefined}
          empty=""
          keepList={undefined}
          onToggleKeep={() => undefined}
          hover={undefined}
          onRemove={undefined}
        />
      </div>
      <div className="selectors-confirm-actions">
        <button className="selectors-cancel" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button className="selectors-delete" onClick={onDelete} disabled={busy}>
          {busy ? 'Removing…' : shown === 1 ? 'Remove style' : `Remove ${shown} styles`}
        </button>
      </div>
    </>
  );
}

function ReportNotes({ report }: { readonly report: SelectorReport }) {
  if (report.notes.length === 0) {
    return undefined;
  }
  return (
    <details className="selectors-notes">
      <summary>{report.notes.length === 1 ? '1 file not checked' : `${report.notes.length} files not checked`}</summary>
      {report.notes.map((note, index) => (
        <p key={`${note.rel}-${index}`}>
          <span className="selectors-note-file">{note.rel}</span>
          {note.message.replace(/^Its styles were not checked: /, '')}
        </p>
      ))}
    </details>
  );
}
