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
import { AUDIT_CHECKS, type AuditFinding, type AuditPriority, type AuditRuleGroup } from '../../../shared/page/auditFindings';
import { auditPrompt, promptBatches, AUDIT_PROMPT_FINDINGS_MAX } from '../../../shared/page/auditPrompt';
import { linkFix } from '../../../shared/page/auditRepairs';
import { agentTask } from '../../../shared/properties/agentTask';
import { withIgnore, withoutIgnore, type AuditIgnores } from '../../../shared/properties/auditIgnores';
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
import { FindReplace } from './FindReplace';
import { PerformanceBar } from './PerformanceBar';
import { AUDIT_FILTERS, auditView, type AuditFilter } from './auditView';
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
  const state = useAuditState();
  const [filter, setFilter] = useState<AuditFilter>(() => storedFilter(props.project.path));
  const [reviewing, setReviewing] = useState<readonly AuditFinding[] | undefined>(undefined);
  const [search, setSearch] = useState('');
  const [showIgnored, setShowIgnored] = useState(false);
  const [searching, setSearching] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const ignoredIds = new Set(state.ignores.value.ignored.map((entry) => entry.id));
  const reasons = new Map(state.ignores.value.ignored.map((entry) => [entry.id, entry.reason]));
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
          props.showToast(outcome.fixed === 1 ? 'Fixed.' : `Fixed ${outcome.fixed} in ${outcome.files} ${outcome.files === 1 ? 'file' : 'files'}.`, 'success');
        } else {
          props.showToast(`${failure.file.split('/').pop() ?? failure.file}: ${failure.message}`, 'error');
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
      const { message, kind } = agentTaskMessage(await requestAgentTask(agentTask(auditPrompt(batch, props.project.name))));
      const rest = targets.length - batch.length;
      props.showToast(rest > 0 ? `${message} The first ${AUDIT_PROMPT_FINDINGS_MAX} went; send the rest after.` : message, kind);
    },
    ignore: (finding, reason) => writeIgnores(props, (value) => withIgnore(value, { id: finding.id, reason })),
    ignoreAll: (findings, reason) => writeIgnores(props, (value) => findings.reduce((file, finding) => withIgnore(file, { id: finding.id, reason }), value)),
    restore: (finding) => writeIgnores(props, (value) => withoutIgnore(value, finding.id)),
    reasonOf: (finding) => reasons.get(finding.id),
  };
  const open = view.shown.filter((finding) => !ignoredIds.has(finding.id));
  const fixes = view.fixable.length;
  return (
    <div className="panel-section grow audits-panel">
      <div className="panel-header">
        <h2 className="audits-heading">
          Audits
          {view.counts.all > 0 && (
            <span className="audits-pill" title={state.scope === 'page' ? 'Findings on the open page and the components it uses' : 'Findings across the site'}>
              {state.scope === 'page' ? `${view.counts.all} on this page` : view.counts.all}
            </span>
          )}
        </h2>
        <div className="audits-header-tools">
          <button
            className="ghost"
            aria-label="Audit again"
            title="Audit again"
            disabled={state.running}
            onClick={() => updateAuditState((current) => ({ ...current, request: current.request + 1 }))}
          >
            <RefreshIcon size={14} className={state.running ? 'audits-spin' : undefined} />
          </button>
          <MoreMenu
            title="Audit options"
            width={200}
            items={[
              { label: searching ? 'Hide search' : 'Search findings', onSelect: () => setSearching((value) => !value) },
              { label: findOpen ? 'Close find & replace' : 'Find & replace…', onSelect: () => setFindOpen((value) => !value) },
              { label: 'Configure checks…', onSelect: props.onConfigure },
              {
                label: showIgnored ? 'Hide ignored' : `Show ignored (${view.ignoredCount})`,
                disabled: view.ignoredCount === 0 && !showIgnored,
                onSelect: () => setShowIgnored((value) => !value),
              },
              open.length > 0 && { label: 'Send all to AI', icon: <SparkleIcon size={12} />, onSelect: () => void actions.handOff(open) },
            ]}
          />
        </div>
      </div>
      <div className="audits-toolbar">
        <Dropdown<AuditFilter>
          ariaLabel="Category"
          className="audits-category"
          menuWidthMin={200}
          value={filter}
          options={AUDIT_FILTERS.map((value) => ({
            value,
            label: `${FILTER_LABELS[value]}${view.counts[value] > 0 ? `  ${view.counts[value]}` : ''}`,
            icon: <FilterIcon filter={value} />,
          }))}
          onChange={(value) => {
            setFilter(value);
            storeFilter(props.project.path, value);
          }}
        />
        <SegmentedTabs<PanelScope>
          label="Audit scope"
          className={{ track: 'audits-scope' }}
          value={state.scope === 'page' ? 'page' : 'site'}
          tabs={SCOPE_TABS}
          onPick={(scope) => updateAuditState((current) => ({ ...current, scope }))}
        />
        {searching && <SearchField label="Search findings" value={search} onChange={setSearch} />}
      </div>
      {state.running && state.report === undefined && state.progress !== undefined && (
        <p className="audits-progress" role="status">
          {state.progress.stage === 'files' ? 'Reading files' : 'Checking pages'} · {state.progress.done} of {state.progress.total}
        </p>
      )}
      {reviewing !== undefined && (
        <StyleReview findings={reviewing.filter((item) => !ignoredIds.has(item.id))} actions={actions} panel={props} onClose={() => setReviewing(undefined)} />
      )}
      <div className="audits-list">
        {findOpen && (
          <FindReplace
            project={props.project}
            fixDeps={props.fixDeps}
            onReveal={props.onReveal}
            showToast={props.showToast}
            sources={props.sources}
            onClose={() => setFindOpen(false)}
          />
        )}
        {filter === 'performance' && <PerformanceBar measure={props.measure} />}
        {fixes > 0 && (
          <div className="audits-ready">
            <span>
              {fixes} {fixes === 1 ? 'fix' : 'fixes'} ready
            </span>
            <button className="audits-apply" disabled={busy} onClick={() => void actions.fix(view.fixable, 'Fix audit findings')}>
              Apply
            </button>
          </div>
        )}
        {rules.map((rule) => (
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
        {rules.length === 0 && filter !== 'performance' && <EmptyState filtered={view.counts.all > 0} />}
        {rules.length === 0 && filter === 'performance' && <SpeedClear />}
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
  readonly restore: (finding: AuditFinding) => Promise<void>;
  readonly reasonOf: (finding: AuditFinding) => string | undefined;
}

// Speed with nothing to fix: said positively once a measurement has finished, and nothing while one runs.
function SpeedClear() {
  const performance = useAuditState().performance;
  if (performance.running || performance.results.length === 0) {
    return undefined;
  }
  return (
    <p className="audits-note audits-clean">
      <CheckIcon size={12} /> No speed issues found
    </p>
  );
}

// Nothing to list: why, in one muted line.
function EmptyState({ filtered }: { readonly filtered: boolean }) {
  const state = useAuditState();
  const report = state.report;
  if (state.problem !== undefined) {
    return <p className="audits-note">{state.problem}</p>;
  }
  if (report === undefined) {
    return <p className="audits-note">{state.running ? 'Auditing…' : 'Open a page to audit it.'}</p>;
  }
  if (filtered) {
    return <p className="audits-note">Nothing here.</p>;
  }
  const time = new Date(report.checkedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const offline = report.rendered.tag === 'offline' ? ' Start the preview to check contrast too.' : '';
  return (
    <p className="audits-note audits-clean">
      <CheckIcon size={12} /> No issues · checked {time}.{offline}
    </p>
  );
}

async function writeIgnores(props: AuditsPanelProps, change: (value: AuditIgnores) => AuditIgnores): Promise<void> {
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
    props.showToast(`Couldn’t update .stacki/audits.json: ${saved.error}`, 'error');
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
  const { rule } = props;
  const check = AUDIT_CHECKS[rule.check];
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
        <span className="label audits-title">{check.title}</span>
        {reviewable && <span className="audits-breakdown">{breakdown(rule.findings)}</span>}
        {reviewable && props.open && (
          <button
            className="audits-review-button"
            onClick={(event) => {
              event.stopPropagation();
              props.onReview(rule.findings);
            }}
          >
            Review
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
export function breakdown(findings: readonly AuditFinding[]): string {
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
    .map(([group, count]) => `${count} ${group === 'colour' && count !== 1 ? 'colours' : group}`)
    .join(' · ');
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
        <span className="label audits-title">{first === undefined ? props.file : occurrenceName(first)}</span>
        <span className="audits-count">{props.findings.length}</span>
      </div>
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
  const toggle = (): void => setOpen((value) => !value);
  const [first] = props.findings;
  assert(first !== undefined, 'An element group has findings');
  const view = occurrenceView(first, props.nodes);
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
const SCOPE_TABS: readonly { readonly value: PanelScope; readonly label: string }[] = [
  { value: 'site', label: 'Site' },
  { value: 'page', label: 'This page' },
];

const FILTER_LABELS: Readonly<Record<AuditFilter, string>> = {
  all: 'All',
  accessibility: 'Accessibility',
  seo: 'SEO and launch',
  content: 'Placeholders',
  tokens: 'Design tokens',
  performance: 'Speed',
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
export function occurrenceView(finding: AuditFinding, nodes: readonly PageNode[] | undefined): { readonly icon: ReactNode; readonly label: string } {
  const element = finding.element;
  if (element === undefined) {
    return { icon: <FileKindIcon file={finding.file} kind={finding.fileKind} />, label: AUDIT_CHECKS[finding.check].title };
  }
  const node = nodes === undefined ? undefined : nodeAt(nodes, element.path);
  const described = node === undefined ? { icon: elementIcon(element.tag, 14), label: element.tag } : describeNode(node, undefined);
  return { icon: <span className="audits-occurrence-icon">{described.icon}</span>, label: described.label };
}

/** A finding under its element's row: a raw CSS value reads as `padding: 12px`; anything else keeps its detail. */
function nestedLabel(finding: AuditFinding, fallback: string): string {
  if (finding.css !== undefined) {
    return `${finding.css.property}: ${finding.css.value}`;
  }
  return finding.detail.length > 0 ? finding.detail : fallback;
}

/** The muted second line: the text in the finding's detail (`"Button Text"`, `href="/x"`), or why it is ignored. */
export function occurrenceNote(finding: Pick<AuditFinding, 'detail' | 'excerpt'>, reason: string | undefined): string | undefined {
  if (reason !== undefined) {
    return `Ignored: ${reason}`;
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
  const { finding, actions, panel } = props;
  const [mode, setMode] = useState<'idle' | 'preview' | 'ignore' | 'relink'>('idle');
  const [reason, setReason] = useState('');
  const element = finding.element;
  const ignoredBecause = actions.reasonOf(finding);
  const fix = ignoredBecause === undefined ? finding.fix : undefined;
  const go = (): void => panel.onReveal(finding.file, element?.path ?? fixTarget(finding), finding.prop);
  const href = /href="([^"]*)"/.exec(finding.detail)?.[1];
  const brokenRoute = finding.check === 'link-broken' && href !== undefined ? href.split(/[?#]/)[0] : undefined;
  const whole = occurrenceView(finding, props.nodes);
  const view = props.nested === true ? { icon: <span className="audits-occurrence-icon" />, label: nestedLabel(finding, whole.label) } : whole;
  const note =
    props.nested === true && finding.css !== undefined && ignoredBecause === undefined ? finding.css.selector : occurrenceNote(finding, ignoredBecause);
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
        {finding.measure !== undefined && <span className="audits-tag">{finding.measure}</span>}
        <span className="audits-hover-actions" onClick={(event) => event.stopPropagation()}>
          {fix !== undefined && (
            <button className="audits-link" title={fix.label} onClick={() => setMode(mode === 'preview' ? 'idle' : 'preview')}>
              Fix
            </button>
          )}
          <button className="ghost audits-icon-button" aria-label="Fix with AI" title="Fix with AI" onClick={() => void actions.handOff([finding])}>
            <SparkleIcon size={12} />
          </button>
          <MoreMenu
            className="audits-icon-button"
            title="More"
            width={180}
            items={[
              brokenRoute !== undefined && { label: `Create ${brokenRoute}`, onSelect: () => panel.onCreatePage(brokenRoute) },
              brokenRoute !== undefined && element !== undefined && { label: 'Change link…', onSelect: () => setMode('relink') },
              ignoredBecause === undefined
                ? { label: 'Ignore…', onSelect: () => setMode('ignore') }
                : { label: 'Stop ignoring', onSelect: () => void actions.restore(finding) },
            ]}
          />
        </span>
      </div>
      {mode === 'preview' && fix !== undefined && finding.choices !== undefined && (
        <div className="audits-inset">
          <Dropdown<string>
            ariaLabel="Variable to use"
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
          <CodeBlock text={fix.before} language="astro" className="audits-code audits-before" label="Before" />
          <CodeBlock text={fix.after} language="astro" className="audits-code" label="After" />
          <div className="audits-actions">
            <button className="audits-link" disabled={actions.busy} onClick={() => void actions.fix([finding], fix.label).then(() => setMode('idle'))}>
              {fix.label}
            </button>
            <button className="audits-link muted" onClick={() => setMode('idle')}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {mode === 'relink' && element !== undefined && (
        <div className="audits-inset">
          <Dropdown<string>
            ariaLabel="Link to"
            placeholder="Pick a page…"
            value=""
            options={panel.routes.map((route) => ({ value: route, label: route }))}
            onChange={(route) => {
              setMode('idle');
              void actions.fix([{ ...finding, fix: linkFix({ file: finding.file, path: element.path, href: href ?? '' }, route) }], `Link to ${route}`);
            }}
          />
        </div>
      )}
      {mode === 'ignore' && (
        <div className="audits-inset audits-actions">
          <input
            className="audits-reason"
            placeholder="Why ignore it?"
            aria-label="Reason for ignoring"
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
            Ignore
          </button>
          <button className="audits-link muted" onClick={() => setMode('idle')}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
