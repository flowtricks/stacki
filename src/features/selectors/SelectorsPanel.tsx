// The style selectors panel: every class and id selector in the project's
// stylesheets, which ones nothing can match any more, and a clean-up that
// removes exactly those. A selector the check cannot prove unused is listed
// under "Can't tell" with its reason and is never removed; the lock adds its
// names to `.stacki/styles.json` so no later clean-up touches them. A lock on
// a stylesheet's heading, or a folder's, keeps that whole library the same way
// (`lockedStylesheets` in the same file).
//
// The list stays quiet on purpose: one line per selector, with only the class
// names that make a rule removable tinted.
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { ok, type Result } from '../../../shared/core/result';
import Popup from '../../ui/Popup';
import { PanelReadStatus } from '../../ui/PanelReadStatus';
import { usePanelData } from '../../lib/usePanelData';
import { onPropertyFilesChanged, onVariablesChanged } from '../../ipc/editorEnvironment';
import { SearchIcon, TrashIcon } from '../../ui/Icons';
import { verdictNames, type SelectorEntry, type SelectorReport } from '../../../shared/properties/selectorUsage';
import { EMPTY_KEEP_LIST, folderLock, keepMatcher, serializeStyleKeepList, stylesheetLock, type StyleKeepList } from '../../../shared/properties/styleKeepList';
import { lockSheetChange, unlockOneChange, unlockSheetChange, type KeepListChange } from './lockChanges';
import { LockIcon, SweepIcon } from './SelectorIcons';
import {
  exactPatterns,
  firstRows,
  folderGroups,
  initialFilter,
  LIST_PAGE_ROWS,
  listedEntries,
  matchesFilter,
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
  keepListCache,
  readKeepList,
  readSelectorReport,
  selectorReportCache,
  removeSelectors,
  replaceKeepList,
  restoreSelectors,
  updateKeepList,
  type StoredKeepList,
} from './selectorsBridge';
import { lockShownClosed, type RowTransition } from './rowTransitions';
import { useRowTransitions, type RowTransitionActions } from './useRowTransitions';
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
  const keep = useKeepList(project.path, showToast, onRecordUndo, refresh);
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
  // `chosen` is a row's own trash: a stylesheet lock does not stop it.
  const removeEntries = async (targets: readonly SelectorEntry[], reach: 'cleanup' | 'chosen' = 'cleanup'): Promise<void> => {
    if (report === undefined || targets.length === 0) {
      return;
    }
    const rels = new Set(targets.map((entry) => entry.rel));
    setBusy(true);
    const result = await removeSelectors(
      project.path,
      targets.map((entry) => entry.id),
      report.files.filter((file) => rels.has(file.rel)),
      reach,
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
    if (entry.verdict.kind === 'unused') {
      void removeEntries(unused.filter((other) => other.rel === entry.rel && other.selector === entry.selector));
    } else {
      // A row in a locked stylesheet: deleting it by hand is not a cleanup.
      assert(entry.verdict.kind === 'kept', 'removeOne: only unused or sheet-locked rows have a trash button');
      const same = (report?.entries ?? []).filter((other) => other.rel === entry.rel && other.selector === entry.selector && other.verdict.kind === 'kept');
      void removeEntries(same, 'chosen');
    }
  };

  // A row a lock moves stays through the change, then collapses if its new
  // verdict has left the open tab; a row it brings in opens (useRowTransitions.ts).
  const inTab = useMemo(
    () =>
      new Map(
        (report === undefined ? [] : listedEntries(report)).filter((entry) => matchesFilter(entry.verdict.kind, filter)).map((entry) => [entry.id, entry]),
      ),
    [report, filter],
  );
  const transitions = useRowTransitions(filter, inTab);
  const toggleKeep = (entry: SelectorEntry): void => {
    // The tooltip names the row's state, which is about to change.
    hover.leave();
    // Unlocking a row its stylesheet's lock holds splits that lock (lockChanges.ts).
    const inLockedSheet = keep.stored !== undefined && stylesheetLock(keep.stored.keepList, entry.rel) !== undefined;
    // A thunk: a click the row's animation ignores must not write anything.
    const change = (): Promise<void> =>
      report !== undefined && entry.verdict.kind === 'kept' && inLockedSheet ? keep.unlockOne(report, entry) : keep.toggle(entry);
    transitions.runRow(entry, () => change().then(refresh));
  };
  // A stylesheet or folder lock changes verdicts in the main process, so the
  // report is read again once the file is written.
  const storedKeepList = keep.stored?.keepList;
  const nameKept = useMemo(() => (storedKeepList === undefined ? () => false : keepMatcher(storedKeepList)), [storedKeepList]);
  const sheetLocks: SheetLocks | undefined =
    storedKeepList === undefined || busy || report === undefined
      ? undefined
      : { keepList: storedKeepList, nameKept, onToggle: (target) => transitions.runHeading(() => keep.toggleSheet(report, target).then(refresh)) };

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
                transitions={transitions}
                onToggleKeep={toggleKeep}
                hover={hover}
                onRemove={busy ? undefined : removeOne}
              />
            ) : (
              <SelectorGroups
                report={report}
                sheets={selectorGroups(report, filter, search, transitions.listed)}
                locks={sheetLocks}
                limit={limit}
                onMore={more}
                empty={emptyText(report, filter)}
                keepList={keep.stored}
                transitions={transitions}
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
      // The row's state too, so the names it tints match the row's colour (a locked one is blue).
      className={`popup-tooltip selectors-tip is-${entry.verdict.kind}`}
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

function useKeepList(
  projectPath: string,
  showToast: SelectorsPanelProps['showToast'],
  onRecordUndo: SelectorsPanelProps['onRecordUndo'],
  refresh: () => Promise<unknown>,
) {
  // The kept list draws the lock controls in the first frame; the read below refreshes it.
  const [stored, setStored] = useState<StoredKeepList | undefined>(() => {
    const kept = keepListCache.get(projectPath);
    return kept?.kind === 'ready' ? kept.value : undefined;
  });
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
      const change =
        entry.verdict.kind === 'kept'
          ? { add: [], remove: exactPatterns(current.keepList, names), lock: [], unlock: [] }
          : { add: names, remove: [], lock: [], unlock: [] };
      setStored(await updateKeepList(projectPath, current, change));
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  // One write and one undo step per stylesheet lock change, however many
  // entries it touches; undo writes the earlier file back if no one else has
  // changed it since.
  const apply = async (label: string, plan: (current: StoredKeepList) => Result<KeepListChange, string>): Promise<void> => {
    try {
      const current = await readKeepList(projectPath);
      const change = plan(current);
      if (!change.ok) {
        showToast(change.error, 'error');
        return;
      }
      const saved = await updateKeepList(projectPath, current, change.value);
      setStored(saved);
      const before = current.source ?? serializeStyleKeepList(EMPTY_KEEP_LIST);
      const after = saved.source;
      assert(after !== undefined, 'useKeepList: a written keep list has bytes');
      onRecordUndo({
        label,
        undo: async () => {
          setStored(await replaceKeepList(projectPath, after, before));
          await refresh();
        },
        redo: async () => {
          setStored(await replaceKeepList(projectPath, before, after));
          await refresh();
        },
      });
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  };
  // `target` is a stylesheet or a folder ending in `/`; only its own entry is
  // toggled, so a sheet locked through its folder is unlocked at the folder.
  const toggleSheet = (report: SelectorReport, target: string): Promise<void> =>
    apply('Change stylesheet lock', (current) =>
      ok(current.keepList.lockedStylesheets.includes(target) ? unlockSheetChange(current.keepList, target) : lockSheetChange(report, current.keepList, target)),
    );
  const unlockOne = (report: SelectorReport, entry: SelectorEntry): Promise<void> =>
    apply('Unlock style', (current) => unlockOneChange(report, current.keepList, entry));
  return { stored, toggle, toggleSheet, unlockOne };
}

function emptyText(report: SelectorReport, filter: SelectorFilter): string {
  if (report.entries.length === 0) {
    return 'No class or id selectors in this project’s stylesheets.';
  }
  switch (filter) {
    case 'unused':
      return 'No unused styles. Every style is used, locked, or might be in use.';
    case 'kept':
      return 'No locked styles. Lock a style from its row, or a stylesheet from its heading, to keep it through every clean-up.';
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
  /** The rows animating after a lock click; undefined where rows have no lock. */
  readonly transitions: RowTransitionActions | undefined;
  readonly onToggleKeep: (entry: SelectorEntry) => void;
  readonly hover: HoverActions | undefined;
  /** Removes an unused row's selector; undefined where rows cannot be removed. */
  readonly onRemove: ((entry: SelectorEntry) => void) | undefined;
}

interface Paging {
  readonly limit: number;
  readonly onMore: () => void;
}

/** Locking whole stylesheets and folders from a group's heading; undefined where headings have no lock. */
interface SheetLocks {
  readonly keepList: StyleKeepList;
  /** Whether the keep list names `name`: such a row is held by its own lock too, so it has no trash. */
  readonly nameKept: (name: string) => boolean;
  /** Locks or unlocks a stylesheet, or a folder ending in `/`. */
  readonly onToggle: (target: string) => void;
}

function SelectorGroups({
  report,
  sheets: all,
  locks,
  limit,
  onMore,
  empty,
  keepList,
  transitions,
  onToggleKeep,
  hover,
  onRemove,
}: {
  /** Undefined where the list is not the project's (the cleanup confirmation): no folder headings. */
  readonly report: SelectorReport | undefined;
  readonly sheets: readonly SelectorGroup[];
  readonly locks: SheetLocks | undefined;
  readonly empty: string;
} & RowActions &
  Paging) {
  if (all.length === 0) {
    return <p className="selectors-empty">{empty}</p>;
  }
  const { groups: sheets, total } = firstRows(all, limit);
  const folders = report === undefined ? [{ folder: undefined, sheets }] : folderGroups(report, sheets);
  return (
    <>
      {folders.map((group) => (
        <React.Fragment key={group.folder ?? ''}>
          {group.folder !== undefined && (
            <FolderHeading
              folder={group.folder}
              locks={locks}
              motion={slotMotion(
                group.sheets.flatMap((sheet) => sheet.entries),
                transitions,
              )}
            />
          )}
          {group.sheets.map((sheet) => (
            <SheetSection
              key={sheet.rel}
              sheet={sheet}
              locks={locks}
              keepList={keepList}
              transitions={transitions}
              onToggleKeep={onToggleKeep}
              hover={hover}
              onRemove={onRemove}
            />
          ))}
        </React.Fragment>
      ))}
      {limit < total && <MoreRows onMore={onMore} />}
    </>
  );
}

// A folder's heading sits in its own slot so it closes and opens with the stylesheets under it.
function FolderHeading({ folder, locks, motion }: { readonly folder: string; readonly locks: SheetLocks | undefined; readonly motion: SlotMotion }) {
  const name = folder === '' ? 'Project root' : folder;
  return (
    <div className={`selectors-folder-slot ${slotClass(motion)}`} aria-hidden={motion === 'collapsing' ? true : undefined}>
      <div className="selectors-heading selectors-folder">
        <h3 className="selectors-heading-name" title={name}>
          {name}
        </h3>
        {locks !== undefined && folder !== '' && (
          <SheetLock target={folder} name={folder} covering={folderLock(locks.keepList, folder)} onToggle={locks.onToggle} />
        )}
      </div>
    </div>
  );
}

function SheetSection({ sheet, locks, ...actions }: { readonly sheet: SelectorGroup; readonly locks: SheetLocks | undefined } & RowActions) {
  const name = sheet.rel.slice(sheet.rel.lastIndexOf('/') + 1);
  const covering = locks === undefined ? undefined : stylesheetLock(locks.keepList, sheet.rel);
  const motion = slotMotion(sheet.entries, actions.transitions);
  return (
    <section
      className={`selectors-group ${covering === undefined ? '' : 'is-locked'} ${slotClass(motion)}`}
      aria-hidden={motion === 'collapsing' ? true : undefined}
    >
      <div className="selectors-group-body">
        <div className="selectors-heading">
          <h3 className="selectors-heading-name selectors-file" title={sheet.rel}>
            {name}
          </h3>
          {locks !== undefined && <SheetLock target={sheet.rel} name={name} covering={covering} onToggle={locks.onToggle} />}
        </div>
        {sheet.entries.map((entry) => (
          <SelectorRow
            key={entry.id}
            entry={entry}
            sheetLocked={covering !== undefined}
            nameKept={locks !== undefined && verdictNames(entry.verdict).some(locks.nameKept)}
            {...actions}
          />
        ))}
      </div>
    </section>
  );
}

// The heading's lock: shown on hover, always shown when locked. A sheet
// locked through its folder shows the lock closed but leaves the toggle to the
// folder, which is the entry that holds it.
function SheetLock({
  target,
  name,
  covering,
  onToggle,
}: {
  readonly target: string;
  readonly name: string;
  readonly covering: string | undefined;
  readonly onToggle: (target: string) => void;
}) {
  const own = covering === target;
  const inherited = covering !== undefined && !own;
  const label = own ? `Unlock ${name}` : inherited ? `Locked with ${covering}` : `Lock ${name} from cleanup`;
  const tip = own ? 'Unlock' : label;
  return (
    <span className="tip-anchor selectors-sheet-lock-anchor" title={tip}>
      <button
        className={`ghost selectors-sheet-lock ${covering === undefined ? '' : 'on'}`}
        aria-label={label}
        aria-pressed={covering !== undefined}
        disabled={inherited}
        onClick={() => onToggle(target)}
      >
        <LockIcon size={12} open={covering === undefined} />
      </button>
    </span>
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
  transitions,
  onToggleKeep,
  hover,
  onRemove,
}: { readonly report: SelectorReport; readonly search: string } & RowActions & Paging) {
  const all = unknownReasons(report, search, transitions?.reasons ?? NO_REASONS);
  if (all.length === 0) {
    return <p className="selectors-empty">Nothing is uncertain: every style was checked.</p>;
  }
  const { groups: reasons, total } = firstRows(all, limit);
  return (
    <>
      {reasons.map((group) => {
        const motion = slotMotion(group.entries, transitions);
        return (
          <section key={group.reason} className={`selectors-group ${slotClass(motion)}`} aria-hidden={motion === 'collapsing' ? true : undefined}>
            <div className="selectors-group-body">
              <p className="selectors-reason">{sentence(group.reason)}</p>
              {group.entries.map((entry) => (
                <SelectorRow
                  key={entry.id}
                  entry={entry}
                  keepList={keepList}
                  transitions={transitions}
                  onToggleKeep={onToggleKeep}
                  hover={hover}
                  onRemove={onRemove}
                />
              ))}
            </div>
          </section>
        );
      })}
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

const NO_REASONS: ReadonlyMap<string, string> = new Map();

/**
 * How a group's slot (a stylesheet, a folder, a reason) moves with its rows:
 * it closes when every row in it is closing, and opens when every row in it
 * has just arrived, so a heading never outlives or precedes its rows.
 */
type SlotMotion = 'steady' | 'collapsing' | 'entering';

function slotMotion(entries: readonly SelectorEntry[], transitions: RowTransitionActions | undefined): SlotMotion {
  if (transitions === undefined || entries.length === 0) {
    return 'steady';
  }
  if (entries.every((entry) => transitions.rows.get(entry.id)?.phase === 'collapsing')) {
    return 'collapsing';
  }
  if (entries.every((entry) => transitions.entering(entry.id))) {
    return 'entering';
  }
  return 'steady';
}

/** The slot class for a motion: a grid track that closes to nothing or opens from it (selectors.css). */
function slotClass(motion: SlotMotion): string {
  switch (motion) {
    case 'steady':
      return '';
    case 'collapsing':
      return 'is-collapsing';
    case 'entering':
      return 'is-entering';
    default: {
      const exhaustive: never = motion;
      return exhaustive;
    }
  }
}

function SelectorRow({
  entry,
  sheetLocked,
  nameKept,
  keepList,
  transitions,
  onToggleKeep,
  hover,
  onRemove,
}: { readonly entry: SelectorEntry; readonly sheetLocked?: boolean; readonly nameKept?: boolean } & RowActions) {
  const { verdict } = entry;
  const names = verdictNames(verdict);
  const locked = verdict.kind === 'kept';
  const lockable = names.length > 0 && keepList !== undefined && verdict.kind !== 'checking';
  // A row its stylesheet's lock holds is locked like any other: its lock
  // unlocks it alone (splitting the sheet lock), and its trash deletes it by
  // hand. A row whose own names are also kept has no trash: unlock it first.
  const heldBySheet = sheetLocked === true && locked;
  const removable = onRemove !== undefined && (verdict.kind === 'unused' || (heldBySheet && nameKept !== true));
  const unlockable = heldBySheet || (keepList !== undefined && exactPatterns(keepList.keepList, names).length > 0);
  const transition: RowTransition | undefined = transitions?.rows.get(entry.id);
  // While the keep list is written the lock already shows where the click is going.
  const closed = lockShownClosed(transition, verdict.kind);
  const collapsing = transition?.phase === 'collapsing';
  const motion: SlotMotion = collapsing ? 'collapsing' : transitions?.entering(entry.id) === true ? 'entering' : 'steady';
  return (
    // The slot closes the row's height (a grid track from 1fr to 0fr) so the rows below slide up,
    // and opens a row that has just arrived the same way in reverse.
    <div
      className={`selectors-row-slot ${slotClass(motion)}`}
      aria-hidden={collapsing ? true : undefined}
      onTransitionEnd={(event) => {
        if (collapsing && event.target === event.currentTarget && event.propertyName === 'grid-template-rows') {
          transitions?.collapsed(entry.id);
        }
      }}
    >
      <div
        className={`selectors-row is-${verdict.kind}`}
        onMouseEnter={(event) => hover?.enter(entry, event.currentTarget)}
        onMouseLeave={() => hover?.leave()}
      >
        <SelectorText entry={entry} className="selectors-selector" />
        {(lockable || removable) && (
          // Floats over the end of the row, so a hidden button takes no width from the selector.
          // The trash comes first: the lock ends the row, in the same column as every other lock.
          <span className="selectors-actions">
            {removable && (
              <button className="ghost selectors-remove-one" aria-label={`Remove ${entry.selector}`} onClick={() => onRemove(entry)}>
                <TrashIcon size={12} />
              </button>
            )}
            {lockable && (
              <button
                className={`ghost selectors-lock ${closed ? 'on' : ''}`}
                aria-label={locked ? `Unlock ${names.join(', ')}` : `Lock ${names.join(', ')} so clean-ups keep it`}
                disabled={locked && !unlockable}
                onClick={() => onToggleKeep(entry)}
              >
                <LockIcon size={12} open={!closed} />
              </button>
            )}
          </span>
        )}
      </div>
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
          report={undefined}
          sheets={[...files].map(([rel, list]) => ({ rel, entries: list }))}
          locks={undefined}
          limit={shown}
          onMore={() => undefined}
          empty=""
          keepList={undefined}
          transitions={undefined}
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
