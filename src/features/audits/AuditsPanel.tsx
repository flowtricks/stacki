// The Audits panel, kept quiet: a title with a count, refresh and ⋯ (search,
// ignored findings, send all to AI); a category dropdown beside a "Site · This
// page" switch (the whole site unless the person chose this page, per project); and
// one flat list of rules, High first, each a single line — an icon tinted by
// severity, the title, a muted count. A rule opens to one sentence of why and
// its occurrences: the page or component and the element's tag. Clicking an
// occurrence goes to the element (opens its file, selects it as the Navigator
// does, scrolls to it and flashes it); Fix, AI and ⋯ appear on hover. Line
// numbers and raw attribute text stay in the row's tooltip. When safe fixes
// exist, a slim row at the top applies them. Fixes preview their code first.
// Ignore is one click: it writes the tracked `.stacki/audits.json` with no reason
// asked, and a toast offers Undo, which puts the file's entries back as they were.
// The project's own audits (shared/properties/customAudits.ts) list as rules like any other, with their own name, icon and
// category; ⋯ adds one or opens the list, and a custom rule's ⋯ edits, duplicates, turns off or deletes it.
import { assert } from '../../../shared/core/assert';
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PageNode } from '../../../shared/page/pageNode';
import { nodeAt } from '../../../shared/page/auditTrace';
import { describeNode } from '../../ui/navigatorLabel';
import { type AuditFinding, type AuditPriority, type AuditRuleGroup } from '../../../shared/page/auditFindings';
import { auditPrompt, promptBatches, AUDIT_PROMPT_FINDINGS_MAX } from '../../../shared/page/auditPrompt';
import { linkFix, relinkTarget } from '../../../shared/page/auditRepairs';
import { agentTask } from '../../../shared/properties/agentTask';
import { ignoreReasons, ignoredEntryCount, type IgnoredFinding } from '../../../shared/properties/auditIgnoreList';
import {
  withIgnore,
  withIgnoredPage,
  withoutAnyIgnores,
  withoutIgnore,
  withoutIgnoredPage,
  withUnitGroup,
  type AuditIgnore,
  type AuditIgnoredPage,
  type AuditIgnores,
  type AuditTokenSettings,
  type AuditUnitGroup,
} from '../../../shared/properties/auditIgnores';
import { dismissErrorToast, reportActionToast } from '../../ui/errorNotices';
import { agentTaskMessage, requestAgentTask } from '../../lib/agentTasks';
import { CodeBlock } from '../../ui/CodeBlock';
import { ErrorToast } from '../../ui/ErrorToast';
import Dropdown from '../../ui/Dropdown';
import MoreMenu from '../../ui/MoreMenu';
import { SearchField } from '../../ui/SearchField';
import { CheckIcon, ChevronRightIcon, ElementComponentIcon, FileIcon, PagePanelIcon, RefreshIcon, SparkleIcon } from '../../ui/Icons';
import { elementIcon } from '../../ui/ElementIcons';
import { AUDIT_ICONS, ruleIcon } from './AuditIcons';
import { CustomAuditDialog, deleteAudit, duplicateAudit, type CustomAuditView } from './CustomAuditDialog';
import { readLiveFiles, type LiveFiles } from './customAuditLive';
import type { CustomAudit } from '../../../shared/properties/customAudits';
import { applyFixes, type FixDeps } from './auditFixes';
import type { AuditScope } from './auditScope';
import { SegmentedTabs } from '../../ui/SegmentedTabs';
import { saveAuditIgnores } from './auditsBridge';
import { allFindings, auditState, updateAuditState, useAuditState } from './auditStore';
import { useFormat, useTranslate, useTranslateDescribed } from '../../lib/i18n/useTranslate';
import { useAuditText, type AuditText } from './useAuditText';
import { ENGLISH_TRANSLATE } from '../../../shared/properties/i18n/englishTranslator';
import type { MessageKey, Translator } from '../../../shared/properties/i18n/messageRef';
import { IgnoredList } from './IgnoredList';
import { FindReplace } from './FindReplace';
import { FixesInfo } from './FixesInfo';
import { PerformanceBar } from './PerformanceBar';
import { AUDIT_FILTERS, auditView, parseAuditFilter, type AuditFilter, type BuiltinAuditFilter } from './auditView';
import type { RawValueKit } from './RawValueField';
import { StyleReview } from './StyleReview';
import {
  codeTarget,
  declarationNote,
  declarationUnderElement,
  findingRowKey,
  flaggedUnitGroups,
  holdsSizeFindings,
  unitGroupText,
  type AuditCodeTarget,
} from './tokenActions';
import './audits.css';
import { PanelHeader } from '../../ui/PanelHeader';

type Toast = (message: string, kind?: 'info' | 'success' | 'error') => void;

export interface AuditsPanelProps {
  readonly project: { readonly path: string; readonly name: string };
  /** What a fix writes through, read when a fix is applied so it sees the page as it is then. */
  readonly fixDeps: () => FixDeps;
  /**
   * Opens the file; with a path, selects that element, scrolls to it and flashes it; with a prop, shows its field in Settings;
   * with code, also opens the code window at that declaration's line.
   */
  readonly onReveal: (file: string, path: readonly number[] | undefined, prop: string | undefined, code?: AuditCodeTarget) => void;
  /** Outlines the element on the canvas while the pointer is on its occurrence; undefined clears it. */
  readonly onHover: (file: string, path: readonly number[] | undefined) => void;
  /** Starts a new page at `route`, for a link that points nowhere yet. */
  readonly onCreatePage: (route: string) => void;
  /** The project's static routes, for "Change link…". */
  readonly routes: readonly string[];
  readonly showToast: Toast;
  /** What Performance measures: the dev server, the open page's route and every static page. */
  readonly measure: () => {
    readonly projectPath: string;
    readonly devUrl: string | undefined;
    readonly current: MeasureTarget | undefined;
    readonly pages: readonly MeasureTarget[];
  };
  /** The files Find & replace searches: the open one, and every page and component. */
  readonly sources: () => { readonly current: SearchSource | undefined; readonly all: readonly SearchSource[] };
  /** Opens Settings on the Audits tab. */
  readonly onConfigure: () => void;
  /** The Style panel's value input, for editing a raw value in the review window; absent, values are read-only. */
  readonly valueKit?: RawValueKit;
  /** The files the custom audit editor's live count reads; absent, the pages and components of `sources` and the stylesheets. */
  readonly customAuditFiles?: () => Promise<LiveFiles>;
}

export interface SearchSource {
  /** Absolute, as readPage takes it. */
  readonly path: string;
  /** Project-relative. */
  readonly file: string;
}

export interface MeasureTarget {
  readonly route: string;
  readonly file: string;
}

interface ShownRule extends AuditRuleGroup {
  readonly priority: AuditPriority;
}

/**
 * The row the person last went to (findingRowKey), kept by the panel so it stays marked while the list redraws or the
 * filter changes. Keyed by place, not text: two declarations can read the same.
 */
const ActiveRowContext = createContext<{ readonly key: string | undefined; readonly pick: (key: string) => void }>({ key: undefined, pick: () => undefined });

export default function AuditsPanel(props: AuditsPanelProps) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  const state = useAuditState();
  const [filter, setFilter] = useState<AuditFilter>(() => storedFilter(props.project.path));
  const [reviewing, setReviewing] = useState<readonly AuditFinding[] | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [activeRow, setActiveRow] = useState<string | undefined>(undefined);
  const reasons = ignoreReasons(allFindings(state), state.ignores.value);
  const ignoredIds: ReadonlySet<string> = new Set(reasons.keys());
  const [ignoredView, setIgnoredView] = useState(false);
  const customAudits = state.ignores.value.customAudits;
  const view = auditView({
    findings: allFindings(state),
    ignored: ignoredIds,
    filter,
    search,
    showIgnored,
    customCategories: customAudits.filter((audit) => audit.enabled).map((audit) => audit.category),
  });
  const [customView, setCustomView] = useState<CustomAuditView | undefined>(undefined);
  useCustomAuditNotices(props);
  const [findOpen, setFindOpen] = useState(false);
  const rules: readonly ShownRule[] = view.groups.flatMap((group) => group.rules.map((rule) => ({ ...rule, priority: group.priority })));
  const toggle = (check: string): void =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(check)) {
        next.add(check);
      }
      return next;
    });
  const actions: Actions = {
    busy,
    fix: async (targets, label) => {
      setBusy(true);
      try {
        const outcome = await applyFixes(targets, props.fixDeps(), label);
        const [failure] = outcome.failures;
        if (failure === undefined) {
          props.showToast(
            outcome.fixed === 1 ? translate('auditsUi.fixed.one') : translate('auditsUi.fixed.many', { fixed: outcome.fixed, count: outcome.files }),
            'success',
          );
        } else {
          props.showToast(`${failure.file.split('/').pop() ?? failure.file}: ${translateDescribed(failure)}`, 'error');
        }
      } catch (error: unknown) {
        props.showToast(error instanceof Error ? error.message : String(error), 'error');
      } finally {
        setBusy(false);
        updateAuditState((current) => ({ ...current, request: current.request + 1 }));
      }
    },
    handOff: async (targets) => {
      const [batch] = promptBatches(targets);
      if (batch === undefined) {
        return;
      }
      const { message, kind } = agentTaskMessage(
        await requestAgentTask(agentTask({ ...auditPrompt(batch, props.project.name), surface: 'auditFix' })),
        translate,
      );
      const rest = targets.length - batch.length;
      props.showToast(rest > 0 ? translate('auditsUi.handOff.partial', { message, count: AUDIT_PROMPT_FINDINGS_MAX }) : message, kind);
    },
    ignore: (finding) => ignoreFindings(props, translate, [finding], undefined),
    ignoreAll: (findings, reason) => ignoreFindings(props, translate, findings, reason),
    ignorePage: async (file) => {
      const before = auditState().ignores.value.ignoredPages.find((entry) => entry.file === file);
      if (await writeIgnores(props, translate, (value) => withIgnoredPage(value, { file, reason: undefined }))) {
        undoToast(translate('audits.ignorePage.toast'), translate, () => writeIgnores(props, translate, (value) => pageRestored(value, file, before)));
      }
    },
    unignorePage: async (file) => void (await writeIgnores(props, translate, (value) => withoutIgnoredPage(value, file))),
    unignoreIds: async (ids) => void (await writeIgnores(props, translate, (value) => ids.reduce(withoutIgnore, value))),
    unignoreAll: async () => void (await writeIgnores(props, translate, withoutAnyIgnores)),
    restore: async (finding) => void (await writeIgnores(props, translate, (value) => withoutIgnore(value, finding.id))),
    ignoredOf: (finding) => reasons.get(finding.id),
    changeTokens: (message, change) => changeTokenSettings(props, translate, message, change),
    customAudit: (id) => customAudits.find((audit) => audit.id === id),
    editCustom: (id) => setCustomView({ kind: 'edit', id }),
    saveCustom: (change) => saveCustomAudits(props, translate, change),
  };
  const open = view.shown.filter((finding) => !ignoredIds.has(finding.id));
  const fixes = view.fixable.length;
  return (
    <div className="panel-section grow audits-panel">
      <PanelHeader
        titleClassName="audits-heading"
        title={
          <>
            {translate('auditsUi.title')}
            {view.counts.all > 0 && (
              <span className="audits-pill" title={state.scope === 'page' ? translate('auditsUi.pill.pageTitle') : translate('auditsUi.pill.siteTitle')}>
                {state.scope === 'page' ? translate('auditsUi.pill.page', { count: view.counts.all }) : view.counts.all}
              </span>
            )}
          </>
        }
        actions={
          <>
            <button
              className="ghost"
              aria-label={translate('auditsUi.again')}
              title={translate('auditsUi.again')}
              disabled={state.running}
              onClick={() => updateAuditState((current) => ({ ...current, request: current.request + 1 }))}
            >
              <RefreshIcon size={14} className={state.running ? 'audits-spin' : undefined} />
            </button>
            <MoreMenu
              title={translate('auditsUi.options')}
              width={200}
              items={[
                {
                  label: searching ? translate('auditsUi.menu.hideSearch') : translate('auditsUi.searchFindings'),
                  onSelect: () => setSearching((value) => !value),
                },
                { label: findOpen ? translate('auditsUi.menu.closeFind') : translate('auditsUi.menu.find'), onSelect: () => setFindOpen((value) => !value) },
                { label: translate('auditsUi.menu.configure'), onSelect: props.onConfigure },
                { label: translate('customAudits.menu.add'), onSelect: () => setCustomView({ kind: 'new', preset: undefined }) },
                { label: translate('customAudits.menu.manage'), onSelect: () => setCustomView({ kind: 'list' }) },
                {
                  label: showIgnored ? translate('auditsUi.menu.hideIgnored') : translate('auditsUi.menu.showIgnored', { count: view.ignoredCount }),
                  disabled: view.ignoredCount === 0 && !showIgnored,
                  onSelect: () => setShowIgnored((value) => !value),
                },
                open.length > 0 && { label: translate('auditsUi.menu.sendAll'), icon: <SparkleIcon size={12} />, onSelect: () => void actions.handOff(open) },
              ]}
            />
          </>
        }
      />
      <div className="audits-toolbar">
        <Dropdown<AuditFilter>
          ariaLabel={translate('auditsUi.category')}
          className="audits-category"
          menuWidthMin={200}
          value={filter}
          options={[
            ...AUDIT_FILTERS.map((value) => ({
              value,
              label: `${translate(FILTER_LABELS[value])}${view.counts[value] > 0 ? `  ${view.counts[value]}` : ''}`,
              icon: <FilterIcon filter={value} />,
            })),
            // The project's own categories, named as its custom audits name them, after the built-in ones.
            ...view.customCategories.map((entry) => ({
              value: entry.filter,
              label: `${entry.name}${entry.count > 0 ? `  ${entry.count}` : ''}`,
              icon: <FilterIcon filter={entry.filter} />,
            })),
          ]}
          onChange={(value) => {
            setFilter(value);
            storeFilter(props.project.path, value);
          }}
        />
        {/* Site · This page and Ignored travel together: when the row is too narrow for all three controls the group drops under the menu. */}
        <div className="audits-filters">
          <SegmentedTabs<PanelScope>
            label={translate('auditsUi.scope.label')}
            className={{ track: 'audits-scope' }}
            value={state.scope === 'page' ? 'page' : 'site'}
            tabs={[
              { value: 'site', label: translate('auditsUi.scope.site') },
              { value: 'page', label: translate('auditsUi.scope.page') },
            ]}
            onPick={(scope) => updateAuditState((current) => ({ ...current, scope }))}
          />
          <button
            className={`audits-pill-toggle ${ignoredView ? 'on' : ''}`}
            role="switch"
            aria-checked={ignoredView}
            onClick={() => setIgnoredView((value) => !value)}
          >
            {ignoredView && <CheckIcon size={11} />}
            {translate('audits.ignored.chip')}
            {ignoredEntryCount(state.ignores.value) > 0 && <span className="audits-count">{ignoredEntryCount(state.ignores.value)}</span>}
          </button>
        </div>
        {searching && <SearchField label={translate('auditsUi.searchFindings')} value={search} onChange={setSearch} />}
      </div>
      {state.running && state.report === undefined && state.progress !== undefined && (
        <p className="audits-progress" role="status">
          {translate(state.progress.stage === 'files' ? 'auditsUi.progress.files' : 'auditsUi.progress.pages', {
            done: state.progress.done,
            total: state.progress.total,
          })}
        </p>
      )}
      {reviewing !== undefined && (
        <StyleReview findings={reviewing.filter((item) => !ignoredIds.has(item.id))} actions={actions} panel={props} onClose={() => setReviewing(undefined)} />
      )}
      <ActiveRowContext.Provider value={{ key: activeRow, pick: setActiveRow }}>
        <div className="audits-list">
          {ignoredView && <IgnoredList findings={allFindings(state)} ignores={state.ignores.value} actions={actions} />}
          {!ignoredView && findOpen && (
            <FindReplace
              project={props.project}
              fixDeps={props.fixDeps}
              onReveal={props.onReveal}
              showToast={props.showToast}
              sources={props.sources}
              onClose={() => setFindOpen(false)}
            />
          )}
          {!ignoredView && filter === 'performance' && <PerformanceBar measure={props.measure} />}
          {!ignoredView && fixes > 0 && (
            <div className="audits-ready">
              <span className="audits-ready-lead">
                <span className="audits-ready-text" title={translate('auditsUi.fixesReady', { count: fixes })}>
                  {translate('auditsUi.fixesReady', { count: fixes })}
                </span>
                <FixesInfo plan={view.fixPlan} onGo={(finding) => props.onReveal(finding.file, finding.element?.path ?? fixTarget(finding), finding.prop)} />
              </span>
              <button className="audits-apply" disabled={busy} onClick={() => void actions.fix(view.fixable, translate('auditsUi.fixAllLabel'))}>
                {translate('ui.apply')}
              </button>
            </div>
          )}
          {(ignoredView ? [] : rules).map((rule) => (
            <RuleRow
              onReview={(findings) => setReviewing(findings)}
              key={rule.key}
              rule={rule}
              open={expanded.has(rule.key)}
              onToggle={() => toggle(rule.key)}
              actions={actions}
              panel={props}
            />
          ))}
          {!ignoredView && rules.length === 0 && filter !== 'performance' && <EmptyState filtered={view.counts.all > 0} />}
          {!ignoredView && rules.length === 0 && filter === 'performance' && <SpeedClear />}
        </div>
      </ActiveRowContext.Provider>
      {customView !== undefined && (
        <CustomAuditDialog
          view={customView}
          audits={customAudits}
          loadFiles={
            props.customAuditFiles ??
            (() =>
              readLiveFiles(
                props.project.path,
                props.sources().all.map((source) => source.file),
              ))
          }
          onSave={actions.saveCustom}
          showToast={props.showToast}
          onClose={() => setCustomView(undefined)}
        />
      )}
    </div>
  );
}

export interface Actions {
  readonly busy: boolean;
  readonly fix: (targets: readonly AuditFinding[], label: string) => Promise<void>;
  readonly handOff: (targets: readonly AuditFinding[]) => Promise<void>;
  /** One click: no reason asked; a toast offers Undo. */
  readonly ignore: (finding: AuditFinding) => Promise<void>;
  /** Several findings ignored in one write, with the reason the caller states (or none); a toast offers Undo. */
  readonly ignoreAll: (findings: readonly AuditFinding[], reason: string | undefined) => Promise<void>;
  /** Every finding in `file`, of every check, ignored with one entry; a toast offers Undo. */
  readonly ignorePage: (file: string) => Promise<void>;
  /** Removes the whole-page entry; findings ignored one by one stay ignored. */
  readonly unignorePage: (file: string) => Promise<void>;
  readonly unignoreIds: (ids: readonly string[]) => Promise<void>;
  readonly unignoreAll: () => Promise<void>;
  readonly restore: (finding: AuditFinding) => Promise<void>;
  /** Whether the finding is ignored, and the note behind it when someone left one. */
  readonly ignoredOf: (finding: AuditFinding) => IgnoredFinding | undefined;
  /** Changes the design-token rules in one write, audits again, and offers Undo in a toast that says `message`. */
  readonly changeTokens: (message: string, change: (tokens: AuditTokenSettings) => AuditTokenSettings) => Promise<void>;
  /** The project's custom audit `id`, as the file holds it now. */
  readonly customAudit: (id: string) => CustomAudit | undefined;
  /** Opens the editor on custom audit `id`. */
  readonly editCustom: (id: string) => void;
  /** Changes the custom audit list in one write and audits again; true once saved. */
  readonly saveCustom: (change: (audits: readonly CustomAudit[]) => readonly CustomAudit[]) => Promise<boolean>;
}

// A change to the custom audit list: saved, then audited again so the rows follow at once.
async function saveCustomAudits(
  props: AuditsPanelProps,
  translate: Translator,
  change: (audits: readonly CustomAudit[]) => readonly CustomAudit[],
): Promise<boolean> {
  const saved = await writeIgnores(props, translate, (value) => ({ ...value, customAudits: change(value.customAudits) }));
  if (saved) {
    updateAuditState((current) => ({ ...current, request: current.request + 1 }));
  }
  return saved;
}

// A custom audit that did not run (its pattern was refused) or stopped early is said once per report, as a toast.
function useCustomAuditNotices(props: Pick<AuditsPanelProps, 'showToast'>): void {
  const translate = useTranslate();
  const report = useAuditState().report;
  const told = useRef<number | undefined>(undefined);
  useEffect(() => {
    const custom = report?.custom;
    if (report === undefined || custom === undefined || told.current === report.checkedAt) {
      return;
    }
    told.current = report.checkedAt;
    for (const skipped of custom.problems) {
      props.showToast(translate('customAudits.toast.skipped', { name: skipped.name, problem: skipped.problem.message }), 'error');
    }
    for (const stopped of custom.stopped) {
      props.showToast(translate('customAudits.toast.stopped', { name: stopped.name }), 'info');
    }
  }, [report, props, translate]);
}

// A quick token-rule change from a rule's ⋯ ("Allow em values"): saved, audited again, and undone by writing back the rules
// exactly as they were, so Undo never touches a rule the change did not.
async function changeTokenSettings(
  props: AuditsPanelProps,
  translate: Translator,
  message: string,
  change: (tokens: AuditTokenSettings) => AuditTokenSettings,
): Promise<void> {
  const before = auditState().ignores.value.tokens;
  const rerun = (): void => updateAuditState((current) => ({ ...current, request: current.request + 1 }));
  if (await writeIgnores(props, translate, (value) => ({ ...value, tokens: change(value.tokens) }))) {
    rerun();
    undoToast(message, translate, async () => {
      const restored = await writeIgnores(props, translate, (value) => ({ ...value, tokens: before }));
      if (restored) {
        rerun();
      }
      return restored;
    });
  }
}

/** How long the Undo toast stays up before it goes by itself. */
const UNDO_TOAST_MS = 8_000;

// Ignores `findings` in one write and, once it is saved, offers to put back exactly what the
// file held for them before: no entry, or the entry (and reason) one of them already had.
async function ignoreFindings(props: AuditsPanelProps, translate: Translator, findings: readonly AuditFinding[], reason: string | undefined): Promise<void> {
  assert(findings.length > 0, 'ignoreFindings: something to ignore');
  const ids = new Set(findings.map((finding) => finding.id));
  const before = auditState().ignores.value.ignored.filter((entry) => ids.has(entry.id));
  assert(before.length <= ids.size, 'ignoreFindings: at most one entry per id');
  const saved = await writeIgnores(props, translate, (value) => findings.reduce((file, finding) => withIgnore(file, { id: finding.id, reason }), value));
  if (saved) {
    const message = findings.length === 1 ? translate('auditsUi.ignoredToast') : translate('auditsUi.ignoredManyToast');
    undoToast(message, translate, () => writeIgnores(props, translate, (value) => findingsRestored(value, ids, before)));
  }
}

/** The file with the entries for `ids` back to `before`: removed, then the ones that were there re-added. */
export function findingsRestored(value: AuditIgnores, ids: ReadonlySet<string>, before: readonly AuditIgnore[]): AuditIgnores {
  const cleared = [...ids].reduce(withoutIgnore, value);
  const restored = before.reduce(withIgnore, cleared);
  assert(restored.ignored.length <= value.ignored.length, 'findingsRestored: undo never adds entries');
  return restored;
}

/** The file with the page entry for `file` back to `before`: none, or the entry it had. */
export function pageRestored(value: AuditIgnores, file: string, before: AuditIgnoredPage | undefined): AuditIgnores {
  const cleared = withoutIgnoredPage(value, file);
  return before === undefined ? cleared : withIgnoredPage(cleared, before);
}

// A success toast with Undo. A toast with an action stays until it is used or dismissed, so this
// one is dismissed after a while: an Undo offered long after the click would surprise.
function undoToast(message: string, translate: Translator, undo: () => Promise<boolean>): void {
  const id = reportActionToast(message, 'success', [{ label: translate('menu.edit.undo'), run: async () => void (await undo()) }]);
  if (id !== undefined) {
    setTimeout(() => dismissErrorToast(id), UNDO_TOAST_MS);
  }
}

// Speed with nothing to fix: said positively once a measurement has finished, and nothing while one runs.
function SpeedClear() {
  const translate = useTranslate();
  const performance = useAuditState().performance;
  if (performance.running || performance.results.length === 0) {
    return undefined;
  }
  return (
    <p className="audits-note audits-clean">
      <CheckIcon size={12} /> {translate('auditsUi.speedClear')}
    </p>
  );
}

// Nothing to list: why, in one muted line. A failed audit is a toast; the ordinary empty line stays, so nothing is appended.
function EmptyState({ filtered }: { readonly filtered: boolean }) {
  const problem = useAuditState().problem;
  return (
    <>
      <ErrorToast message={problem} />
      <EmptyLine filtered={filtered} />
    </>
  );
}

function EmptyLine({ filtered }: { readonly filtered: boolean }) {
  const translate = useTranslate();
  const { formatDate } = useFormat();
  const state = useAuditState();
  const report = state.report;
  if (report === undefined) {
    return <p className="audits-note">{state.running ? translate('auditsUi.empty.auditing') : translate('auditsUi.empty.open')}</p>;
  }
  if (filtered) {
    return <p className="audits-note">{translate('auditsUi.empty.nothing')}</p>;
  }
  const time = formatDate(report.checkedAt, { hour: 'numeric', minute: '2-digit' });
  return (
    <p className="audits-note audits-clean">
      <CheckIcon size={12} /> {translate(report.rendered.tag === 'offline' ? 'auditsUi.empty.cleanOffline' : 'auditsUi.empty.clean', { time })}
    </p>
  );
}

/** Writes the changed ignores; true once they are saved, false after a failure the person was told about. */
async function writeIgnores(props: AuditsPanelProps, translate: Translator, change: (value: AuditIgnores) => AuditIgnores): Promise<boolean> {
  const base = auditState().ignores;
  let next: AuditIgnores;
  try {
    next = change(base.value);
  } catch (error: unknown) {
    props.showToast(error instanceof Error ? error.message : String(error), 'error');
    return false;
  }
  const saved = await saveAuditIgnores(props.project.path, base, next);
  if (saved.ok) {
    updateAuditState((current) => ({ ...current, ignores: saved.value }));
    return true;
  }
  props.showToast(translate('auditsUi.ignoreWriteFailed', { error: saved.error }), 'error');
  return false;
}

function activateOnKey(activate: () => void): (event: KeyboardEvent) => void {
  return (event) => {
    if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      activate();
    }
  };
}

function RuleRow(props: {
  readonly rule: ShownRule;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onReview: (findings: readonly AuditFinding[]) => void;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
}) {
  const translate = useTranslate();
  const { rule } = props;
  const auditText = useAuditText();
  const Icon = ruleIcon(rule);
  // A custom audit's declarations are not raw values to swap for variables, so they have no review window.
  const reviewable = rule.custom === undefined && rule.findings.some((finding) => finding.css !== undefined);
  const title = auditText.ruleTitle(rule);
  const files = byFile(rule.findings);
  const trees = useAuditState().report?.trees;
  return (
    <div className={`audits-rule ${props.open ? 'open' : ''}`}>
      <div
        className="list-item audits-row"
        role="button"
        tabIndex={0}
        aria-expanded={props.open}
        onClick={props.onToggle}
        onKeyDown={activateOnKey(props.onToggle)}
      >
        <span className={`icon audits-icon audits-${rule.priority}`}>
          <Icon size={14} />
        </span>
        <span className="label audits-title" title={rule.custom?.message === undefined ? title : `${title}: ${rule.custom.message}`}>
          {title}
        </span>
        {reviewable && (
          <span className="audits-breakdown" title={breakdown(rule.findings, translate)}>
            {breakdown(rule.findings, translate)}
          </span>
        )}
        {reviewable && props.open && (
          <button
            className="audits-review-button"
            onClick={(event) => {
              event.stopPropagation();
              props.onReview(rule.findings);
            }}
          >
            {translate('auditsUi.review.button')}
          </button>
        )}
        <span className="audits-count">{rule.findings.length}</span>
        {rule.custom === undefined ? (
          <TokenRuleMenu findings={rule.findings} actions={props.actions} />
        ) : (
          <CustomRuleMenu id={rule.custom.id} actions={props.actions} panel={props.panel} />
        )}
      </div>
      {props.open && (
        <div className="audits-rule-body">
          {files.map(([file, findings]) => (
            <FileGroup key={file} file={file} findings={findings} nodes={trees?.get(file)} actions={props.actions} panel={props.panel} />
          ))}
        </div>
      )}
    </div>
  );
}

// A raw-value rule's ⋯: allow a unit it flags, or stop flagging widths and heights, each one click with Undo. Nothing to offer, no menu.
function TokenRuleMenu(props: { readonly findings: readonly AuditFinding[]; readonly actions: Actions }) {
  const translate = useTranslate();
  const tokens = useAuditState().ignores.value.tokens;
  const groups = flaggedUnitGroups(props.findings, tokens);
  const sizes = tokens.sizes && holdsSizeFindings(props.findings);
  if (groups.length === 0 && !sizes) {
    return undefined;
  }
  const allow = (group: AuditUnitGroup): void => {
    const units = unitGroupText(group, 'short');
    void props.actions.changeTokens(translate('auditsUi.allowUnitToast', { units }), (current) => withUnitGroup(current, group, 'allowed'));
  };
  return (
    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <MoreMenu
        className="audits-icon-button"
        title={translate('auditsUi.more')}
        width={220}
        items={[
          ...groups.map((group) => ({ label: translate('auditsUi.allowUnit', { units: unitGroupText(group, 'short') }), onSelect: () => allow(group) })),
          sizes && {
            label: translate('auditsUi.untrackSizes'),
            onSelect: () => void props.actions.changeTokens(translate('auditsUi.untrackSizesToast'), (current) => ({ ...current, sizes: false })),
          },
        ]}
      />
    </span>
  );
}

// A custom audit's ⋯: edit it, duplicate it, turn it off (one click with Undo in the toast), or delete it after a confirmation.
function CustomRuleMenu(props: { readonly id: string; readonly actions: Actions; readonly panel: AuditsPanelProps }) {
  const translate = useTranslate();
  const audit = props.actions.customAudit(props.id);
  if (audit === undefined) {
    return undefined; // The file no longer holds it; the next run drops the row.
  }
  const deps = { onSave: props.actions.saveCustom, showToast: props.panel.showToast };
  const switched = (state: 'on' | 'off') => (audits: readonly CustomAudit[]) =>
    audits.map((entry) => (entry.id === audit.id ? { ...entry, enabled: state === 'on' } : entry));
  const turnOff = async (): Promise<void> => {
    if (await props.actions.saveCustom(switched('off'))) {
      undoToast(translate('customAudits.toast.disabled'), translate, () => props.actions.saveCustom(switched('on')));
    }
  };
  return (
    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <MoreMenu
        className="audits-icon-button"
        title={translate('auditsUi.more')}
        width={180}
        items={[
          { label: translate('customAudits.row.edit'), onSelect: () => props.actions.editCustom(audit.id) },
          { label: translate('customAudits.row.duplicate'), onSelect: () => void duplicateAudit(audit, deps, translate) },
          { label: translate('customAudits.row.disable'), onSelect: () => void turnOff() },
          { label: translate('customAudits.row.delete'), danger: true, onSelect: () => void deleteAudit(audit, deps, translate) },
        ]}
      />
    </span>
  );
}

/** Findings by file, in the order the files first appear. */
export function byFile(findings: readonly AuditFinding[]): readonly (readonly [string, readonly AuditFinding[]])[] {
  const groups = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    groups.set(finding.file, [...(groups.get(finding.file) ?? []), finding]);
  }
  return [...groups];
}

/** "12 colours · 9 spacing · 7 radius": what kinds of raw values a rule holds, most first. */
export function breakdown(findings: readonly AuditFinding[], translate: Translator = ENGLISH_TRANSLATE): string {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    const group = finding.css?.group;
    if (group !== undefined) {
      counts.set(group, (counts.get(group) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 3)
    .map(([group, count]) => translate(breakdownKey(group), { count }))
    .join(' · ');
}

/** The kind's count phrase, "12 colours": a plural message per known kind. */
function breakdownKey(group: string): MessageKey {
  switch (group) {
    case 'colour':
      return 'auditsUi.breakdown.colour';
    case 'spacing':
      return 'auditsUi.breakdown.spacing';
    case 'radius':
      return 'auditsUi.breakdown.radius';
    case 'type':
      return 'auditsUi.breakdown.type';
    case 'size':
      return 'auditsUi.breakdown.size';
    default:
      return 'auditsUi.breakdown.unit';
  }
}

/** Groups with at most this many occurrences start open; larger ones start closed. */
export const GROUP_OPEN_MAX = 5;

// A page, component or file under a rule: its icon, name and count behind a chevron, opening to
// its element rows, indented as the Navigator indents children. The row only opens and closes;
// going to an element is the element rows' job.
function FileGroup(props: {
  readonly file: string;
  readonly findings: readonly AuditFinding[];
  readonly nodes: readonly PageNode[] | undefined;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
}) {
  const translate = useTranslate();
  const [open, setOpen] = useState(props.findings.length <= GROUP_OPEN_MAX);
  const toggle = (): void => setOpen((value) => !value);
  const [first] = props.findings;
  return (
    <div className={`audits-file-group ${open ? 'open' : ''}`}>
      <div className="list-item audits-row audits-group-row" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={activateOnKey(toggle)}>
        <span className="audits-chevron" aria-hidden="true">
          <ChevronRightIcon size={10} />
        </span>
        <FileKindIcon file={props.file} kind={first?.fileKind} />
        <span className="label audits-title" title={props.file}>
          {first === undefined ? props.file : occurrenceName(first)}
        </span>
        <span className="audits-count">{props.findings.length}</span>
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <MoreMenu
            className="audits-icon-button"
            title={translate('auditsUi.more')}
            width={200}
            items={[{ label: translate('audits.ignorePage.submit'), onSelect: () => void props.actions.ignorePage(props.file) }]}
          />
        </span>
      </div>
      {open && (
        <div className="audits-file-body">
          {sameElementRuns(props.findings).map(([only, ...others]) =>
            only === undefined ? undefined : others.length === 0 && !declarationUnderElement(only) ? (
              <Occurrence key={only.id} finding={only} nodes={props.nodes} actions={props.actions} panel={props.panel} />
            ) : (
              <ElementGroup key={only.id} findings={[only, ...others]} nodes={props.nodes} actions={props.actions} panel={props.panel} />
            ),
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Consecutive findings that are about one element, in the order they came: seven raw values in one `<style>`
 * are one element with seven findings, not seven rows that each read "style". A finding with no element of its own
 * stands alone.
 */
export function sameElementRuns(findings: readonly AuditFinding[]): readonly (readonly AuditFinding[])[] {
  const runs: AuditFinding[][] = [];
  for (const finding of findings) {
    const last = runs.at(-1);
    const lastElement = last?.[0]?.element;
    const sameElement = finding.element !== undefined && lastElement !== undefined && finding.element.path.join('.') === lastElement.path.join('.');
    if (last !== undefined && sameElement) {
      last.push(finding);
    } else {
      runs.push([finding]);
    }
  }
  assert(runs.reduce((count, run) => count + run.length, 0) === findings.length, 'Grouping keeps every finding');
  return runs;
}

/** One element that several findings are about: its own row (icon, name, count), the findings under it. */
function ElementGroup(props: {
  readonly findings: readonly AuditFinding[];
  readonly nodes: readonly PageNode[] | undefined;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
}) {
  const [open, setOpen] = useState(props.findings.length <= GROUP_OPEN_MAX);
  const auditText = useAuditText();
  const [first] = props.findings;
  assert(first !== undefined, 'An element group has findings');
  const code = codeTarget(first);
  // A `<style>` block's row also goes to its code, at its first declaration, each time it is clicked.
  const toggle = (): void => {
    if (code !== undefined) {
      props.panel.onReveal(first.file, first.element?.path, undefined, code);
    }
    setOpen((value) => !value);
  };
  const view = occurrenceView(first, props.nodes, auditText);
  const element = first.element;
  return (
    <div className={`audits-file-group audits-element-group ${open ? 'open' : ''}`}>
      <div
        className="list-item audits-row audits-group-row"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={toggle}
        onKeyDown={activateOnKey(toggle)}
        onMouseEnter={element === undefined ? undefined : () => props.panel.onHover(first.file, element.path)}
        onMouseLeave={element === undefined ? undefined : () => props.panel.onHover(first.file, undefined)}
      >
        <span className="audits-chevron" aria-hidden="true">
          <ChevronRightIcon size={10} />
        </span>
        {view.icon}
        <span className="label audits-title" title={view.label}>
          {view.label}
        </span>
        <span className="audits-count">{props.findings.length}</span>
      </div>
      {open && (
        <div className="audits-file-body">
          {props.findings.map((finding) => (
            <Occurrence key={findingRowKey(finding)} finding={finding} nodes={props.nodes} actions={props.actions} panel={props.panel} nested={true} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The two scopes the panel offers: the whole site (the default) or the open page and what it uses. */
type PanelScope = Extract<AuditScope, 'site' | 'page'>;

const FILTER_LABELS: Readonly<Record<BuiltinAuditFilter, MessageKey>> = {
  all: 'auditsUi.filter.all',
  accessibility: 'auditsUi.filter.accessibility',
  seo: 'auditsUi.filter.seo',
  content: 'auditsUi.filter.content',
  tokens: 'auditsUi.filter.tokens',
  performance: 'auditsUi.filter.performance',
};

function FilterIcon({ filter }: { readonly filter: AuditFilter }) {
  const Icon = filter === 'all' ? AUDIT_ICONS['img-alt'] : filter.startsWith('category:') ? AUDIT_ICONS.custom : CATEGORY_ICONS[builtinFilter(filter)];
  return <Icon size={14} />;
}

// A built-in category filter, `all` excluded: the caller has already sent `all` and the project's own categories elsewhere.
function builtinFilter(filter: AuditFilter): Exclude<BuiltinAuditFilter, 'all'> {
  const found = AUDIT_FILTERS.find((candidate): candidate is Exclude<BuiltinAuditFilter, 'all'> => candidate === filter && candidate !== 'all');
  assert(found !== undefined, 'builtinFilter: a built-in category');
  return found;
}

const CATEGORY_ICONS = {
  accessibility: AUDIT_ICONS['aria-role'],
  seo: AUDIT_ICONS['title-missing'],
  content: AUDIT_ICONS['placeholder-text'],
  tokens: AUDIT_ICONS['token-color'],
  performance: AUDIT_ICONS['perf-lcp'],
} as const;

const FILTER_KEY = 'stacki.audits.category';

/** The category this project's panel last showed. */
export function storedFilter(projectPath: string): AuditFilter {
  try {
    const raw = localStorage.getItem(`${FILTER_KEY}:${projectPath}`);
    return parseAuditFilter(raw ?? undefined) ?? 'all';
  } catch {
    return 'all'; // Storage blocked: every category.
  }
}

function storeFilter(projectPath: string, filter: AuditFilter): void {
  try {
    localStorage.setItem(`${FILTER_KEY}:${projectPath}`, filter);
  } catch {
    // A choice that cannot be kept lasts this session only.
  }
}

/** A file's icon by what it is: a page, a component or layout, or any other file (a stylesheet, the config). */
export function FileKindIcon(props: { readonly file: string; readonly kind: AuditFinding['fileKind'] | undefined }) {
  const icon =
    props.kind === 'page' || props.file.startsWith('src/pages/') ? (
      <PagePanelIcon size={14} />
    ) : props.file.endsWith('.astro') ? (
      <ElementComponentIcon size={14} />
    ) : (
      <FileIcon size={14} />
    );
  return <span className="audits-occurrence-icon">{icon}</span>;
}

/** The page or component an occurrence is in, by name: `example-components`, `Card`. */
export function occurrenceName(finding: Pick<AuditFinding, 'file'>): string {
  const base = finding.file.split('/').pop() ?? finding.file;
  return base.replace(/\.(astro|mdx?|html)$/, '');
}

/** For a finding with no element of its own (a missing h1): the element its fix would change, so go-to shows it. */
export function fixTarget(finding: Pick<AuditFinding, 'file' | 'fix'>): readonly number[] | undefined {
  const fix = finding.fix;
  if (fix === undefined || fix.file !== finding.file) {
    return undefined;
  }
  const edit = fix.edits.find((candidate) => candidate.tag === 'attributes');
  return edit?.tag === 'attributes' ? edit.path : undefined;
}

/** What an occurrence row shows: the Navigator's icon and label for its element, or the file's for a finding about the whole file. */
export function occurrenceView(
  finding: AuditFinding,
  nodes: readonly PageNode[] | undefined,
  auditText: AuditText,
): { readonly icon: ReactNode; readonly label: string } {
  const element = finding.element;
  if (element === undefined) {
    return { icon: <FileKindIcon file={finding.file} kind={finding.fileKind} />, label: auditText.checkTitle(finding.check) };
  }
  const node = nodes === undefined ? undefined : nodeAt(nodes, element.path);
  const described = node === undefined ? { icon: elementIcon(element.tag, 14), label: element.tag } : describeNode(node, undefined);
  // An instance found by its prop names the prop too, `Button · href`: the field to edit in Settings.
  const label = finding.prop !== undefined && node?.kind === 'component' ? `${described.label} · ${finding.prop}` : described.label;
  return { icon: <span className="audits-occurrence-icon">{described.icon}</span>, label };
}

/**
 * The route "Create page" offers for a broken link: its path, when it is a site path no page has.
 * A fragment on a page that exists (`/about#team`), a relative link and an outside address offer none.
 */
export function missingRoute(finding: Pick<AuditFinding, 'check' | 'detail'>, routes: readonly string[]): string | undefined {
  const href = finding.check === 'link-broken' ? /href="([^"]*)"/.exec(finding.detail)?.[1] : undefined;
  const route = href?.split(/[?#]/)[0];
  if (route === undefined || !route.startsWith('/') || route.startsWith('//')) {
    return undefined;
  }
  const trim = (value: string): string => (value.length > 1 ? value.replace(/\/+$/, '') : value);
  return routes.some((known) => trim(known) === trim(route)) ? undefined : route;
}

/** A finding under its element's row: a raw CSS value reads as `padding: 12px`; anything else keeps its detail. */
function nestedLabel(finding: AuditFinding, fallback: string, auditText: AuditText): string {
  if (finding.css !== undefined) {
    // A custom audit's text match has no property: it reads as what matched.
    return finding.css.property.length === 0 ? finding.css.value : `${finding.css.property}: ${finding.css.value}`;
  }
  return finding.detail.length > 0 ? auditText.detail(finding) : fallback;
}

/** The muted second line: the text in the finding's detail (`"Button Text"`, `href="/x"`), or that it is ignored and why, when a note says. */
export function occurrenceNote(
  finding: Pick<AuditFinding, 'detail' | 'excerpt'>,
  ignored: IgnoredFinding | undefined,
  translate: Translator = ENGLISH_TRANSLATE,
): string | undefined {
  if (ignored !== undefined) {
    return ignored.reason === undefined ? translate('audits.ignored.chip') : translate('auditsUi.ignoredNote', { reason: ignored.reason });
  }
  if (finding.excerpt !== undefined) {
    return finding.excerpt;
  }
  const quoted = /"([^"]*)"/.exec(finding.detail)?.[1];
  return quoted === undefined || quoted.trim().length === 0 ? undefined : quoted;
}

function Occurrence(props: {
  readonly finding: AuditFinding;
  readonly nodes: readonly PageNode[] | undefined;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
  /** Under its element's own row (ElementGroup): the row says what is wrong, not which element, which the parent row says. */
  readonly nested?: boolean;
}) {
  const translate = useTranslate();
  const { finding, actions, panel } = props;
  const [mode, setMode] = useState<'idle' | 'preview' | 'relink'>('idle');
  const element = finding.element;
  const ignoredBecause = actions.ignoredOf(finding);
  const fix = ignoredBecause === undefined ? finding.fix : undefined;
  const active = useContext(ActiveRowContext);
  const rowKey = findingRowKey(finding);
  const selected = active.key === rowKey;
  const go = (): void => {
    active.pick(rowKey);
    panel.onReveal(finding.file, element?.path ?? fixTarget(finding), finding.prop, codeTarget(finding));
  };
  const href = /href="([^"]*)"/.exec(finding.detail)?.[1];
  const brokenRoute = missingRoute(finding, panel.routes);
  // Only a literal is rewritten: an href a component computes is fixed where its value is written.
  const relink =
    finding.check === 'link-broken' && element !== undefined && props.nodes !== undefined ? relinkTarget(props.nodes, element.path, finding.prop) : undefined;
  const auditText = useAuditText();
  const whole = occurrenceView(finding, props.nodes, auditText);
  // A raw value reads as its declaration wherever it is listed: under its block's row, or alone for a stylesheet's (no element).
  const declaration = finding.css !== undefined && (props.nested === true || element === undefined);
  const view = declaration ? { icon: <span className="audits-occurrence-icon" />, label: nestedLabel(finding, whole.label, auditText) } : whole;
  const note =
    declaration && finding.css !== undefined && ignoredBecause === undefined
      ? declarationNote(finding.css, translate)
      : occurrenceNote(finding, ignoredBecause, translate);
  return (
    <div className="audits-occurrence">
      <div
        className={`list-item audits-row audits-occurrence-row ${ignoredBecause === undefined ? '' : 'ignored'} ${selected ? 'selected' : ''}`}
        role="button"
        tabIndex={0}
        aria-current={selected ? 'true' : undefined}
        onClick={go}
        onKeyDown={activateOnKey(go)}
        onMouseEnter={element === undefined ? undefined : () => panel.onHover(finding.file, element.path)}
        onMouseLeave={element === undefined ? undefined : () => panel.onHover(finding.file, undefined)}
      >
        {view.icon}
        <span className="audits-occurrence-text">
          <span className="label audits-title" title={view.label}>
            {view.label}
          </span>
          {note !== undefined && (
            <span className="audits-note-line" title={note}>
              {note}
            </span>
          )}
        </span>
        {finding.measure !== undefined && <span className="audits-tag">{auditText.measure(finding)}</span>}
        <span className="audits-hover-actions" onClick={(event) => event.stopPropagation()}>
          {fix !== undefined && (
            <button className="audits-link" title={auditText.fixLabel(fix)} onClick={() => setMode(mode === 'preview' ? 'idle' : 'preview')}>
              {translate('auditsUi.fix')}
            </button>
          )}
          <button
            className="ghost audits-icon-button"
            aria-label={translate('auditsUi.fixWithAI')}
            title={translate('auditsUi.fixWithAI')}
            onClick={() => void actions.handOff([finding])}
          >
            <SparkleIcon size={12} />
          </button>
          <MoreMenu
            className="audits-icon-button"
            title={translate('auditsUi.more')}
            width={180}
            items={[
              brokenRoute !== undefined && { label: translate('auditsUi.createPage', { route: brokenRoute }), onSelect: () => panel.onCreatePage(brokenRoute) },
              relink !== undefined && { label: translate('auditsUi.changeLink'), onSelect: () => setMode('relink') },
              ignoredBecause === undefined
                ? { label: translate('auditsUi.ignoreButton'), onSelect: () => void actions.ignore(finding) }
                : { label: translate('auditsUi.stopIgnoring'), onSelect: () => void actions.restore(finding) },
            ]}
          />
        </span>
      </div>
      {mode === 'preview' && fix !== undefined && finding.choices !== undefined && (
        <div className="audits-inset">
          <Dropdown<string>
            ariaLabel={translate('auditsUi.variableToUse')}
            value={fix.label}
            options={finding.choices.map((choice) => ({ value: choice.label, label: choice.label.replace(/^Use /, '') }))}
            onChange={(label) => {
              const chosen = finding.choices?.find((choice) => choice.label === label);
              if (chosen !== undefined) {
                void actions.fix([{ ...finding, fix: chosen }], chosen.label).then(() => setMode('idle'));
              }
            }}
          />
        </div>
      )}
      {mode === 'preview' && fix !== undefined && (
        <div className="audits-inset">
          <CodeBlock text={fix.before} language="astro" className="audits-code audits-before" label={translate('auditsUi.before')} />
          <CodeBlock text={fix.after} language="astro" className="audits-code" label={translate('auditsUi.after')} />
          <div className="audits-actions">
            <button className="audits-link" disabled={actions.busy} onClick={() => void actions.fix([finding], fix.label).then(() => setMode('idle'))}>
              {auditText.fixLabel(fix)}
            </button>
            <button className="audits-link muted" onClick={() => setMode('idle')}>
              {translate('ui.cancel')}
            </button>
          </div>
        </div>
      )}
      {mode === 'relink' && element !== undefined && relink !== undefined && (
        <div className="audits-inset">
          <Dropdown<string>
            ariaLabel={translate('auditsUi.linkTo')}
            placeholder={translate('auditsUi.pickPage')}
            value=""
            options={panel.routes.map((route) => ({ value: route, label: route }))}
            onChange={(route) => {
              setMode('idle');
              void actions.fix(
                [{ ...finding, fix: linkFix({ file: finding.file, path: element.path, href: href ?? '', at: relink }, route) }],
                translate('auditsUi.linkToLabel', { route }),
              );
            }}
          />
        </div>
      )}
    </div>
  );
}
