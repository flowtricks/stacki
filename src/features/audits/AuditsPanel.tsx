// The Audits panel, kept quiet: a title with a count, refresh and ⋯ (search,
// ignored findings, send all to AI); a category dropdown beside a "Site · This
// page" switch (the whole site unless the person chose this page, per project); and
// one flat list of rules, High first, each a single line — an icon tinted by
// severity, the title, a muted count. A rule opens to one sentence of why and
// its occurrences: the page or component and the element's tag. Clicking an
// occurrence goes to the element (opens its file, selects it as the Navigator
// does, scrolls to it and flashes it); Fix, AI and ⋯ appear on hover. Line
// numbers and raw attribute text stay in the row's tooltip. When safe fixes
// exist, a slim row at the top applies them. Fixes preview their code first;
// Ignore asks for a reason and writes the tracked `.stacki/audits.json`.
import { assert } from '../../../shared/core/assert';
import { useState, type KeyboardEvent, type ReactNode } from 'react';
import type { PageNode } from '../../../shared/page/pageNode';
import { nodeAt } from '../../../shared/page/auditTrace';
import { describeNode } from '../../ui/navigatorLabel';
import { type AuditFinding, type AuditPriority, type AuditRuleGroup } from '../../../shared/page/auditFindings';
import { auditPrompt, promptBatches, AUDIT_PROMPT_FINDINGS_MAX } from '../../../shared/page/auditPrompt';
import { linkFix } from '../../../shared/page/auditRepairs';
import { agentTask } from '../../../shared/properties/agentTask';
import { ignoreReasons, ignoredEntryCount } from '../../../shared/properties/auditIgnoreList';
import { withIgnore, withIgnoredPage, withoutAnyIgnores, withoutIgnore, withoutIgnoredPage, type AuditIgnores } from '../../../shared/properties/auditIgnores';
import { agentTaskMessage, requestAgentTask } from '../../lib/agentTasks';
import { CodeBlock } from '../../ui/CodeBlock';
import Dropdown from '../../ui/Dropdown';
import MoreMenu from '../../ui/MoreMenu';
import { SearchField } from '../../ui/SearchField';
import { CheckIcon, ChevronRightIcon, ElementComponentIcon, FileIcon, PagePanelIcon, RefreshIcon, SparkleIcon } from '../../ui/Icons';
import { elementIcon } from '../../ui/ElementIcons';
import { AUDIT_ICONS } from './AuditIcons';
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
import { PerformanceBar } from './PerformanceBar';
import { AUDIT_FILTERS, auditView, type AuditFilter } from './auditView';
import type { RawValueKit } from './RawValueField';
import { StyleReview } from './StyleReview';
import './audits.css';

type Toast = (message: string, kind?: 'info' | 'success' | 'error') => void;

export interface AuditsPanelProps {
  readonly project: { readonly path: string; readonly name: string };
  /** What a fix writes through, read when a fix is applied so it sees the page as it is then. */
  readonly fixDeps: () => FixDeps;
  /** Opens the file; with a path, selects that element, scrolls to it and flashes it; with a prop, shows its field in Settings. */
  readonly onReveal: (file: string, path: readonly number[] | undefined, prop: string | undefined) => void;
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
  const reasons = ignoreReasons(allFindings(state), state.ignores.value);
  const ignoredIds: ReadonlySet<string> = new Set(reasons.keys());
  const [ignoredView, setIgnoredView] = useState(false);
  const view = auditView({ findings: allFindings(state), ignored: ignoredIds, filter, search, showIgnored });
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
      const { message, kind } = agentTaskMessage(await requestAgentTask(agentTask(auditPrompt(batch, props.project.name))), translate);
      const rest = targets.length - batch.length;
      props.showToast(rest > 0 ? translate('auditsUi.handOff.partial', { message, count: AUDIT_PROMPT_FINDINGS_MAX }) : message, kind);
    },
    ignore: (finding, reason) => writeIgnores(props, translate, (value) => withIgnore(value, { id: finding.id, reason })),
    ignoreAll: (findings, reason) =>
      writeIgnores(props, translate, (value) => findings.reduce((file, finding) => withIgnore(file, { id: finding.id, reason }), value)),
    ignorePage: (file, reason) => writeIgnores(props, translate, (value) => withIgnoredPage(value, { file, reason })),
    unignorePage: (file) => writeIgnores(props, translate, (value) => withoutIgnoredPage(value, file)),
    unignoreIds: (ids) => writeIgnores(props, translate, (value) => ids.reduce(withoutIgnore, value)),
    unignoreAll: () => writeIgnores(props, translate, withoutAnyIgnores),
    restore: (finding) => writeIgnores(props, translate, (value) => withoutIgnore(value, finding.id)),
    reasonOf: (finding) => reasons.get(finding.id),
  };
  const open = view.shown.filter((finding) => !ignoredIds.has(finding.id));
  const fixes = view.fixable.length;
  return (
    <div className="panel-section grow audits-panel">
      <div className="panel-header">
        <h2 className="audits-heading">
          {translate('auditsUi.title')}
          {view.counts.all > 0 && (
            <span className="audits-pill" title={state.scope === 'page' ? translate('auditsUi.pill.pageTitle') : translate('auditsUi.pill.siteTitle')}>
              {state.scope === 'page' ? translate('auditsUi.pill.page', { count: view.counts.all }) : view.counts.all}
            </span>
          )}
        </h2>
        <div className="audits-header-tools">
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
              {
                label: showIgnored ? translate('auditsUi.menu.hideIgnored') : translate('auditsUi.menu.showIgnored', { count: view.ignoredCount }),
                disabled: view.ignoredCount === 0 && !showIgnored,
                onSelect: () => setShowIgnored((value) => !value),
              },
              open.length > 0 && { label: translate('auditsUi.menu.sendAll'), icon: <SparkleIcon size={12} />, onSelect: () => void actions.handOff(open) },
            ]}
          />
        </div>
      </div>
      <div className="audits-toolbar">
        <Dropdown<AuditFilter>
          ariaLabel={translate('auditsUi.category')}
          className="audits-category"
          menuWidthMin={200}
          value={filter}
          options={AUDIT_FILTERS.map((value) => ({
            value,
            label: `${translate(FILTER_LABELS[value])}${view.counts[value] > 0 ? `  ${view.counts[value]}` : ''}`,
            icon: <FilterIcon filter={value} />,
          }))}
          onChange={(value) => {
            setFilter(value);
            storeFilter(props.project.path, value);
          }}
        />
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
            <span>{translate('auditsUi.fixesReady', { count: fixes })}</span>
            <button className="audits-apply" disabled={busy} onClick={() => void actions.fix(view.fixable, translate('auditsUi.fixAllLabel'))}>
              {translate('ui.apply')}
            </button>
          </div>
        )}
        {(ignoredView ? [] : rules).map((rule) => (
          <RuleRow
            onReview={(findings) => setReviewing(findings)}
            key={rule.check}
            rule={rule}
            open={expanded.has(rule.check)}
            onToggle={() => toggle(rule.check)}
            actions={actions}
            panel={props}
          />
        ))}
        {!ignoredView && rules.length === 0 && filter !== 'performance' && <EmptyState filtered={view.counts.all > 0} />}
        {!ignoredView && rules.length === 0 && filter === 'performance' && <SpeedClear />}
      </div>
    </div>
  );
}

export interface Actions {
  readonly busy: boolean;
  readonly fix: (targets: readonly AuditFinding[], label: string) => Promise<void>;
  readonly handOff: (targets: readonly AuditFinding[]) => Promise<void>;
  readonly ignore: (finding: AuditFinding, reason: string) => Promise<void>;
  /** Several findings ignored with one reason, in one write. */
  readonly ignoreAll: (findings: readonly AuditFinding[], reason: string) => Promise<void>;
  /** Every finding in `file`, of every check, ignored with one entry. */
  readonly ignorePage: (file: string, reason: string) => Promise<void>;
  /** Removes the whole-page entry; findings ignored one by one stay ignored. */
  readonly unignorePage: (file: string) => Promise<void>;
  readonly unignoreIds: (ids: readonly string[]) => Promise<void>;
  readonly unignoreAll: () => Promise<void>;
  readonly restore: (finding: AuditFinding) => Promise<void>;
  readonly reasonOf: (finding: AuditFinding) => string | undefined;
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

// Nothing to list: why, in one muted line.
function EmptyState({ filtered }: { readonly filtered: boolean }) {
  const translate = useTranslate();
  const { formatDate } = useFormat();
  const state = useAuditState();
  const report = state.report;
  if (state.problem !== undefined) {
    return <p className="audits-note">{state.problem}</p>;
  }
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

async function writeIgnores(props: AuditsPanelProps, translate: Translator, change: (value: AuditIgnores) => AuditIgnores): Promise<void> {
  const base = auditState().ignores;
  let next: AuditIgnores;
  try {
    next = change(base.value);
  } catch (error: unknown) {
    props.showToast(error instanceof Error ? error.message : String(error), 'error');
    return;
  }
  const saved = await saveAuditIgnores(props.project.path, base, next);
  if (saved.ok) {
    updateAuditState((current) => ({ ...current, ignores: saved.value }));
  } else {
    props.showToast(translate('auditsUi.ignoreWriteFailed', { error: saved.error }), 'error');
  }
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
  const Icon = AUDIT_ICONS[rule.check];
  const reviewable = rule.findings.some((finding) => finding.css !== undefined);
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
        <span className="label audits-title">{auditText.checkTitle(rule.check)}</span>
        {reviewable && <span className="audits-breakdown">{breakdown(rule.findings, translate)}</span>}
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
  const [ignoring, setIgnoring] = useState(false);
  const [reason, setReason] = useState('');
  const toggle = (): void => setOpen((value) => !value);
  const [first] = props.findings;
  return (
    <div className={`audits-file-group ${open ? 'open' : ''}`}>
      <div className="list-item audits-row audits-group-row" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={activateOnKey(toggle)}>
        <span className="audits-chevron" aria-hidden="true">
          <ChevronRightIcon size={10} />
        </span>
        <FileKindIcon file={props.file} kind={first?.fileKind} />
        <span className="label audits-title">{first === undefined ? props.file : occurrenceName(first)}</span>
        <span className="audits-count">{props.findings.length}</span>
        <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <MoreMenu
            className="audits-icon-button"
            title={translate('audits.ignorePage.menu')}
            width={200}
            items={[{ label: translate('audits.ignorePage.menu'), onSelect: () => setIgnoring(true) }]}
          />
        </span>
      </div>
      {ignoring && (
        <div className="audits-inset audits-actions">
          <input
            className="audits-reason"
            placeholder={translate('audits.ignorePage.placeholder')}
            aria-label={translate('audits.ignorePage.aria')}
            value={reason}
            maxLength={500}
            autoFocus
            onChange={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && reason.trim().length > 0) {
                void props.actions.ignorePage(props.file, reason);
              } else if (event.key === 'Escape') {
                setIgnoring(false);
              }
            }}
          />
          <button className="audits-link" disabled={reason.trim().length === 0} onClick={() => void props.actions.ignorePage(props.file, reason)}>
            {translate('audits.ignorePage.submit')}
          </button>
          <button className="audits-link muted" onClick={() => setIgnoring(false)}>
            {translate('audits.ignored.cancel')}
          </button>
        </div>
      )}
      {open && (
        <div className="audits-file-body">
          {sameElementRuns(props.findings).map(([only, ...others]) =>
            only === undefined ? undefined : others.length === 0 ? (
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
  const toggle = (): void => setOpen((value) => !value);
  const [first] = props.findings;
  assert(first !== undefined, 'An element group has findings');
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
        <span className="label audits-title">{view.label}</span>
        <span className="audits-count">{props.findings.length}</span>
      </div>
      {open && (
        <div className="audits-file-body">
          {props.findings.map((finding) => (
            <Occurrence key={finding.id} finding={finding} nodes={props.nodes} actions={props.actions} panel={props.panel} nested={true} />
          ))}
        </div>
      )}
    </div>
  );
}

/** The two scopes the panel offers: the whole site (the default) or the open page and what it uses. */
type PanelScope = Extract<AuditScope, 'site' | 'page'>;

const FILTER_LABELS: Readonly<Record<AuditFilter, MessageKey>> = {
  all: 'auditsUi.filter.all',
  accessibility: 'auditsUi.filter.accessibility',
  seo: 'auditsUi.filter.seo',
  content: 'auditsUi.filter.content',
  tokens: 'auditsUi.filter.tokens',
  performance: 'auditsUi.filter.performance',
};

function FilterIcon({ filter }: { readonly filter: AuditFilter }) {
  const Icon = filter === 'all' ? AUDIT_ICONS['img-alt'] : CATEGORY_ICONS[filter];
  return <Icon size={14} />;
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
    return AUDIT_FILTERS.find((filter) => filter === raw) ?? 'all';
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
  return { icon: <span className="audits-occurrence-icon">{described.icon}</span>, label: described.label };
}

/** A finding under its element's row: a raw CSS value reads as `padding: 12px`; anything else keeps its detail. */
function nestedLabel(finding: AuditFinding, fallback: string, auditText: AuditText): string {
  if (finding.css !== undefined) {
    return `${finding.css.property}: ${finding.css.value}`;
  }
  return finding.detail.length > 0 ? auditText.detail(finding) : fallback;
}

/** The muted second line: the text in the finding's detail (`"Button Text"`, `href="/x"`), or why it is ignored. */
export function occurrenceNote(
  finding: Pick<AuditFinding, 'detail' | 'excerpt'>,
  reason: string | undefined,
  translate: Translator = ENGLISH_TRANSLATE,
): string | undefined {
  if (reason !== undefined) {
    return translate('auditsUi.ignoredNote', { reason });
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
  const [mode, setMode] = useState<'idle' | 'preview' | 'ignore' | 'relink'>('idle');
  const [reason, setReason] = useState('');
  const element = finding.element;
  const ignoredBecause = actions.reasonOf(finding);
  const fix = ignoredBecause === undefined ? finding.fix : undefined;
  const go = (): void => panel.onReveal(finding.file, element?.path ?? fixTarget(finding), finding.prop);
  const href = /href="([^"]*)"/.exec(finding.detail)?.[1];
  const brokenRoute = finding.check === 'link-broken' && href !== undefined ? href.split(/[?#]/)[0] : undefined;
  const auditText = useAuditText();
  const whole = occurrenceView(finding, props.nodes, auditText);
  const view = props.nested === true ? { icon: <span className="audits-occurrence-icon" />, label: nestedLabel(finding, whole.label, auditText) } : whole;
  const note =
    props.nested === true && finding.css !== undefined && ignoredBecause === undefined
      ? finding.css.selector
      : occurrenceNote(finding, ignoredBecause, translate);
  return (
    <div className="audits-occurrence">
      <div
        className={`list-item audits-row audits-occurrence-row ${ignoredBecause === undefined ? '' : 'ignored'}`}
        role="button"
        tabIndex={0}
        onClick={go}
        onKeyDown={activateOnKey(go)}
        onMouseEnter={element === undefined ? undefined : () => panel.onHover(finding.file, element.path)}
        onMouseLeave={element === undefined ? undefined : () => panel.onHover(finding.file, undefined)}
      >
        {view.icon}
        <span className="audits-occurrence-text">
          <span className="label audits-title">{view.label}</span>
          {note !== undefined && <span className="audits-note-line">{note}</span>}
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
              brokenRoute !== undefined && element !== undefined && { label: translate('auditsUi.changeLink'), onSelect: () => setMode('relink') },
              ignoredBecause === undefined
                ? { label: translate('auditsUi.ignoreMenu'), onSelect: () => setMode('ignore') }
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
      {mode === 'relink' && element !== undefined && (
        <div className="audits-inset">
          <Dropdown<string>
            ariaLabel={translate('auditsUi.linkTo')}
            placeholder={translate('auditsUi.pickPage')}
            value=""
            options={panel.routes.map((route) => ({ value: route, label: route }))}
            onChange={(route) => {
              setMode('idle');
              void actions.fix(
                [{ ...finding, fix: linkFix({ file: finding.file, path: element.path, href: href ?? '' }, route) }],
                translate('auditsUi.linkToLabel', { route }),
              );
            }}
          />
        </div>
      )}
      {mode === 'ignore' && (
        <div className="audits-inset audits-actions">
          <input
            className="audits-reason"
            placeholder={translate('auditsUi.ignoreWhy')}
            aria-label={translate('auditsUi.ignoreReason')}
            value={reason}
            maxLength={500}
            autoFocus
            onChange={(event) => setReason(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && reason.trim().length > 0) {
                void actions.ignore(finding, reason);
              } else if (event.key === 'Escape') {
                setMode('idle');
              }
            }}
          />
          <button className="audits-link" disabled={reason.trim().length === 0} onClick={() => void actions.ignore(finding, reason)}>
            {translate('auditsUi.ignoreButton')}
          </button>
          <button className="audits-link muted" onClick={() => setMode('idle')}>
            {translate('ui.cancel')}
          </button>
        </div>
      )}
    </div>
  );
}
