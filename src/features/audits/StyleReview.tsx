// The review window for raw CSS values: too many to read in the panel, each
// needing its context. A floating, resizable window over the canvas lists them
// grouped by file (a component's style block or a stylesheet), each with its
// rule's selector and declaration highlighted, a swatch for a colour, the
// variable that holds exactly that value with "Use variable" (a choice when
// several do), its line, go-to and Ignore. Filters narrow by kind, file and
// "has a fix"; identical values collapse ("6px used 9×"). "Apply all exact
// fixes" previews every swap first and writes them as one undo step. Only values
// are ever swapped: selectors and scoping stay exactly as written.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AuditFinding, AuditFix } from '../../../shared/page/auditFindings';
import { TOKEN_GROUPS } from '../../../shared/page/auditTokens';
import { CodeBlock, CodeInline } from '../../ui/CodeBlock';
import DockableWindow, { type WindowMode } from '../../ui/DockableWindow';
import Dropdown from '../../ui/Dropdown';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CloseIcon } from '../../ui/Icons';
import MoreMenu from '../../ui/MoreMenu';
import { CrosshairIcon } from './AuditIcons';
import { RawValueField } from './RawValueField';
import { FileKindIcon, type Actions, type AuditsPanelProps } from './AuditsPanel';

/** Rows the window draws before it asks to narrow the filters. */
const ROWS_MAX = 600;
type KindFilter = 'all' | (typeof TOKEN_GROUPS)[number] | 'style-block';

export interface ReviewRow {
  readonly key: string;
  readonly findings: readonly AuditFinding[];
}

/** Rows of one file: identical declarations (same selector-free property and token) collapsed into one, in line order. */
export function reviewRows(findings: readonly AuditFinding[], options: { readonly collapse: boolean }): readonly ReviewRow[] {
  const rows = new Map<string, AuditFinding[]>();
  for (const finding of findings) {
    const css = finding.css;
    const key = options.collapse && css !== undefined ? `${css.property}|${css.token.toLowerCase()}` : finding.id;
    rows.set(key, [...(rows.get(key) ?? []), finding]);
  }
  const ordered = [...rows]
    .map(([key, list]) => ({ key, findings: list }))
    .sort((left, right) => (left.findings[0]?.css?.line ?? 0) - (right.findings[0]?.css?.line ?? 0));
  assert(ordered.reduce((total, row) => total + row.findings.length, 0) === findings.length, 'reviewRows: every finding in one row');
  return ordered;
}

/** Whether a finding matches the window's filters. */
export function reviewMatches(finding: AuditFinding, filters: { readonly kind: KindFilter; readonly file: string; readonly fixable: boolean }): boolean {
  const kind = finding.css?.group ?? 'style-block';
  if (filters.kind !== 'all' && kind !== filters.kind) {
    return false;
  }
  if (filters.file !== 'all' && finding.file !== filters.file) {
    return false;
  }
  return !filters.fixable || finding.fix !== undefined;
}

export function StyleReview(props: {
  readonly findings: readonly AuditFinding[];
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
  readonly onClose: () => void;
}) {
  const [mode, setMode] = useState<WindowMode>('floating');
  const [kind, setKind] = useState<KindFilter>('all');
  const [file, setFile] = useState('all');
  const [fixable, setFixable] = useState(false);
  const [collapse, setCollapse] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const shown = props.findings.filter((finding) => reviewMatches(finding, { kind, file, fixable }));
  const exact = shown.filter((finding) => finding.fix !== undefined && finding.choices === undefined);
  const files = [...new Set(props.findings.map((finding) => finding.file))].sort();
  const grouped = files.map((name) => [name, shown.filter((finding) => finding.file === name)] as const).filter(([, list]) => list.length > 0);
  const fold = (name: string): void =>
    setFolded((current) => {
      const next = new Set(current);
      if (!next.delete(name)) {
        next.add(name);
      }
      return next;
    });
  let drawn = 0;
  return (
    <DockableWindow
      mode={mode}
      onModeChange={(next) => setMode(next === 'docked' ? 'floating' : next)}
      label="Review raw values"
      className="audits-review"
      minimumSize={{ width: 480, height: 320 }}
      initialSize={{ width: 760, height: 560 }}
      storageKey="stacki.window.auditsReview"
      header={
        <span className="audits-review-title">
          Raw values <span className="audits-count">{shown.length}</span>
        </span>
      }
      trailing={
        <button className="ghost" aria-label="Close" title="Close" onClick={props.onClose}>
          <CloseIcon size={14} />
        </button>
      }
    >
      <div className="audits-review-filters">
        <Dropdown<KindFilter>
          className="audits-review-filter"
          ariaLabel="Kind of value"
          menuWidthMin={160}
          value={kind}
          options={[
            { value: 'all', label: 'Kind' },
            ...TOKEN_GROUPS.map((group) => ({ value: group, label: group[0]?.toUpperCase() + group.slice(1) })),
            { value: 'style-block', label: 'Style blocks' },
          ]}
          onChange={setKind}
        />
        <Dropdown<string>
          className="audits-review-filter"
          ariaLabel="File"
          menuWidthMin={240}
          value={file}
          options={[{ value: 'all', label: 'File' }, ...files.map((name) => ({ value: name, label: name.split('/').pop() ?? name, description: name }))]}
          onChange={setFile}
        />
        <Pill label="Has a fix" on={fixable} onToggle={() => setFixable((value) => !value)} />
        <Pill label="Group identical" on={collapse} onToggle={() => setCollapse((value) => !value)} />
        <span className="audits-spacer" />
        {exact.length > 0 && (
          <button className="audits-apply" onClick={() => setConfirming(true)}>
            Apply {exact.length} exact {exact.length === 1 ? 'fix' : 'fixes'}
          </button>
        )}
      </div>
      {confirming && (
        <div className="audits-inset audits-review-confirm">
          <CodeBlock
            text={exact
              .slice(0, 40)
              .map((finding) => `/* ${finding.file}:${finding.css?.line ?? ''} */\n${finding.fix?.before ?? ''}\n${finding.fix?.after ?? ''}`)
              .join('\n')}
            language="css"
            className="audits-code"
            label="Changes"
          />
          <div className="audits-actions">
            <button
              className="audits-link"
              disabled={props.actions.busy}
              onClick={() => void props.actions.fix(exact, 'Use variables').then(() => setConfirming(false))}
            >
              Apply {exact.length}
            </button>
            <button className="audits-link muted" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <div className="audits-review-body" role="table" aria-label="Raw values">
        <div className="audits-review-row audits-review-columns" role="row">
          <span role="columnheader">Selector</span>
          <span role="columnheader">Declaration</span>
          <span role="columnheader">Suggestion</span>
          <span role="columnheader">Line</span>
          <span />
        </div>
        {grouped.map(([name, list]) => (
          <section key={name} className="audits-review-file" role="rowgroup">
            <button className="audits-review-file-head" aria-expanded={!folded.has(name)} onClick={() => fold(name)}>
              <span className="audits-chevron">{folded.has(name) ? <ChevronRightIcon size={10} /> : <ChevronDownIcon size={10} />}</span>
              <FileKindIcon file={name} kind={undefined} />
              <span className="audits-review-path" title={name}>
                {name}
              </span>
              <span className="audits-count">{list.length}</span>
            </button>
            {!folded.has(name) &&
              reviewRows(list, { collapse }).map((row) => {
                drawn += 1;
                return drawn > ROWS_MAX ? undefined : (
                  <ReviewRowView key={row.key} row={row} actions={props.actions} panel={props.panel} reviewed={props.findings} />
                );
              })}
          </section>
        ))}
        {drawn > ROWS_MAX && <p className="audits-note">Showing the first {ROWS_MAX}; narrow the filters to see the rest.</p>}
        {shown.length === 0 && <p className="audits-note">Nothing matches these filters.</p>}
      </div>
    </DockableWindow>
  );
}

function Pill(props: { readonly label: string; readonly on: boolean; readonly onToggle: () => void }) {
  return (
    <button className={`audits-pill-toggle ${props.on ? 'on' : ''}`} role="switch" aria-checked={props.on} onClick={props.onToggle}>
      {props.on && <CheckIcon size={11} />}
      {props.label}
    </button>
  );
}

function ReviewRowView(props: {
  readonly row: ReviewRow;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
  readonly reviewed: readonly AuditFinding[];
}) {
  const [open, setOpen] = useState(false);
  const [first] = props.row.findings;
  if (first === undefined) {
    return undefined;
  }
  const many = props.row.findings.length > 1;
  return (
    <>
      <ReviewLine
        finding={first}
        uses={many ? props.row.findings.length : undefined}
        onExpand={many ? () => setOpen((value) => !value) : undefined}
        actions={props.actions}
        panel={props.panel}
        all={props.row.findings}
        reviewed={props.reviewed}
      />
      {open &&
        props.row.findings.map((finding) => (
          <ReviewLine
            key={finding.id}
            finding={finding}
            uses={undefined}
            onExpand={undefined}
            actions={props.actions}
            panel={props.panel}
            all={[finding]}
            reviewed={props.reviewed}
            nested
          />
        ))}
    </>
  );
}

function ReviewLine(props: {
  readonly finding: AuditFinding;
  readonly all: readonly AuditFinding[];
  /** Every finding the window reviews, for "Ignore … in this file". */
  readonly reviewed: readonly AuditFinding[];
  readonly uses: number | undefined;
  readonly onExpand: (() => void) | undefined;
  readonly actions: Actions;
  readonly panel: AuditsPanelProps;
  readonly nested?: boolean;
}) {
  const { finding, actions } = props;
  const css = finding.css;
  const go = (): void => props.panel.onReveal(finding.file, finding.element?.path, undefined);
  const applyTo = (fix: AuditFix): Promise<void> =>
    actions.fix(
      props.all.map((each) => ({
        ...each,
        fix: each.choices?.find((choice) => choice.label === fix.label) ?? (each.fix?.label === fix.label ? each.fix : undefined),
      })),
      fix.label,
    );
  const selector = css === undefined ? finding.detail : css.selector || 'style=""';
  return (
    <div className={`audits-review-row ${props.nested === true ? 'nested' : ''}`} role="row">
      <span className="audits-review-cell audits-review-selector" title={selector}>
        {css === undefined ? <span className="audits-muted-text">{selector}</span> : <CodeInline text={selector} language="css" />}
      </span>
      <span className="audits-review-cell audits-review-declaration" title={css === undefined ? undefined : `${css.property}: ${css.value}`}>
        {css !== undefined && (
          <>
            <CodeInline text={`${css.property}:`} language="css" />
            {css.group === 'colour' && <span className="audits-swatch" style={{ background: css.token }} />}
            <RawValueField findings={props.all} actions={actions} kit={props.panel.valueKit} />
          </>
        )}
        {props.uses !== undefined && (
          <button className="audits-uses" title="Show each use" onClick={props.onExpand}>
            {props.uses}×
          </button>
        )}
      </span>
      <span className="audits-review-cell audits-review-fix">
        {finding.choices !== undefined && finding.fix !== undefined ? (
          <Dropdown<string>
            ariaLabel="Variable to use"
            className="audits-review-choice"
            menuWidthMin={220}
            value=""
            placeholder="Use variable"
            options={finding.choices.map((choice) => ({ value: choice.label, label: choice.label.replace(/^Use /, '') }))}
            onChange={(label) => {
              const chosen = finding.choices?.find((choice) => choice.label === label);
              if (chosen !== undefined) {
                void applyTo(chosen);
              }
            }}
          />
        ) : (
          finding.fix !== undefined && (
            <button
              className="audits-link audits-review-suggestion"
              title={`${finding.fix.before} → ${finding.fix.after}`}
              disabled={actions.busy}
              onClick={() => finding.fix !== undefined && void applyTo(finding.fix)}
            >
              → {finding.fix.label.replace(/^Use /, '')}
            </button>
          )
        )}
      </span>
      <span className="audits-review-cell audits-review-line">{css?.line === undefined ? '' : css.line}</span>
      <span className="audits-review-cell audits-review-actions">
        <button className="ghost audits-icon-button" aria-label="Go to the rule" title="Go to the rule" onClick={go}>
          <CrosshairIcon size={13} />
        </button>
        <MoreMenu
          className="audits-icon-button"
          title="More"
          width={200}
          items={[
            { label: 'Go to the rule', onSelect: go },
            {
              label: props.all.length > 1 ? `Ignore these ${props.all.length}` : 'Ignore this value',
              onSelect: () => void actions.ignoreAll(props.all, `Raw value kept: ${css?.token ?? finding.detail}`),
            },
            css !== undefined && {
              label: `Ignore ${css.property} in this file`,
              onSelect: () =>
                void actions.ignoreAll(
                  sameFile(props.reviewed, finding).filter((each) => each.css?.property === css.property),
                  `${css.property} kept as written`,
                ),
            },
            { label: 'Ignore this file', onSelect: () => void actions.ignoreAll(sameFile(props.reviewed, finding), 'Raw values kept in this file') },
          ]}
        />
      </span>
    </div>
  );
}

// Every reviewed finding of the same rule in the same file.
function sameFile(reviewed: readonly AuditFinding[], finding: AuditFinding): readonly AuditFinding[] {
  return reviewed.filter((each) => each.check === finding.check && each.file === finding.file);
}
