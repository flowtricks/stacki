// The pieces of a transcript: tool calls (with live status, output and a
// syntax-highlighted diff), permission requests, a turn's changes with Keep and
// Undo per file, the plan strip, notices. Styled as Stacki is styled:
// background fills, never borders.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import type { ChatDiff, ChatFileChange } from '../../../shared/properties/ai/chatModel';
import { CodeBlock, CodeInline, CodeTokens, useCodeLines } from '../../ui/CodeBlock';
import { languageFor } from '../../ui/codeHighlight';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  SearchIcon,
  SparkleIcon,
  TerminalIcon,
  PencilIcon,
  ExternalIcon,
  TrashIcon,
  WarningTriangleIcon,
} from '../../ui/Icons';
import type { ChatView, PermissionItem, ToolItem } from './chatReducer';
import { compactRows, lineDiff, type DiffRow } from './lineDiff';

export function ToolCard({ item, projectPath }: { readonly item: ToolItem; readonly projectPath: string }) {
  const [open, setOpen] = useState(item.diffs.length > 0);
  const Icon = toolIcon(item.toolKind);
  const hasBody = item.diffs.length > 0 || item.output !== '' || item.paths.length > 0;
  return (
    <div className={`ai-tool ai-tool-${item.status}${item.parent === undefined ? '' : ' ai-tool-nested'}`}>
      <button className="ai-tool-head" aria-expanded={open} disabled={!hasBody} onClick={() => setOpen((value) => !value)}>
        {hasBody ? open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} /> : <span className="ai-tool-spacer" />}
        <Icon size={14} />
        <span className="ai-tool-title">
          {item.toolKind === 'execute' ? <CodeInline text={firstLine(item.title)} language="shell" /> : relativeTitle(item.title, projectPath)}
        </span>
        <span className={`ai-status ai-status-${item.status}`}>{statusLabel(item)}</span>
      </button>
      {open && hasBody && (
        <div className="ai-tool-body">
          {item.diffs.length === 0 && item.paths.length > 0 && (
            <ul className="ai-tool-paths">
              {item.paths.map((file) => (
                <li key={file}>{relativePath(file, projectPath)}</li>
              ))}
            </ul>
          )}
          {item.diffs.map((diff, index) => (
            <DiffView key={`${diff.path}-${index}`} diff={diff} projectPath={projectPath} />
          ))}
          {item.output !== '' && <CodeBlock className="ai-tool-output" text={item.output} filename={outputFilename(item)} />}
        </div>
      )}
    </div>
  );
}

// A read of one file returns that file's text, so it is coloured as the file's
// language; any other output (a command's log, a search's matches) is not code
// in one language and shows uncoloured, in the same block.
function outputFilename(item: ToolItem): string | undefined {
  if (item.toolKind === 'read') {
    return item.paths.length === 1 ? item.paths[0] : undefined;
  }
  return undefined;
}

/** One file's change, coloured as code, with a few lines of context around each change. */
export function DiffView({ diff, projectPath }: { readonly diff: ChatDiff; readonly projectPath: string }) {
  const rows = compactRows(lineDiff(diff.oldText, diff.newText), 3);
  const codeRows = rows.filter((row): row is DiffRow => row.kind !== 'gap');
  const lines = useCodeLines(codeRows.map((row) => row.text).join('\n'), languageFor(diff.path));
  let codeIndex = 0;
  return (
    <div className="ai-diff">
      <div className="ai-diff-path">
        {diff.oldText === undefined ? 'New file · ' : ''}
        {relativePath(diff.path, projectPath)}
      </div>
      <div className="history-diff-scroll" tabIndex={0} aria-label={`Changes to ${relativePath(diff.path, projectPath)}`}>
        <div className="history-diff-lines">
          {rows.map((row, index) => {
            if (row.kind === 'gap') {
              return (
                <div key={index} className="history-diff-line hunk">
                  <span className="history-diff-heading">
                    {row.hidden} unchanged line{row.hidden === 1 ? '' : 's'}
                  </span>
                </div>
              );
            }
            const line = lines[codeIndex];
            codeIndex += 1;
            return (
              <div key={index} className={`history-diff-line ${row.kind}`}>
                <span className="history-diff-number">{'before' in row ? row.before : ''}</span>
                <span className="history-diff-number">{'after' in row ? row.after : ''}</span>
                <span className="history-diff-sign">{row.kind === 'added' ? '+' : row.kind === 'deleted' ? '−' : ' '}</span>
                <span className="history-diff-code">{row.text === '' ? ' ' : <CodeTokens line={line} />}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function PermissionCard({ item, onAnswer }: { readonly item: PermissionItem; readonly onAnswer: (optionId: string | undefined) => void }) {
  if (item.answer !== undefined) {
    const chosen = item.options.find((option) => option.id === item.answer?.optionId);
    return (
      <div className="ai-permission ai-permission-answered">
        <span>{item.title}</span>
        <span className="ai-permission-outcome">{item.answer.outcome === 'cancelled' ? 'Stopped' : (chosen?.name ?? 'Answered')}</span>
      </div>
    );
  }
  // Allow first, then reject: the order the person reads the question in.
  const options = [...item.options].sort((left, right) => rank(left.kind) - rank(right.kind));
  return (
    <div className="ai-permission" role="group" aria-label="Permission request">
      <div className="ai-permission-title">
        <WarningTriangleIcon size={14} />
        <span>{item.title}</span>
      </div>
      <div className="ai-permission-actions">
        {options.map((option) => (
          <button key={option.id} className={option.kind.startsWith('allow') ? 'ai-allow' : 'ai-reject'} onClick={() => onAnswer(option.id)}>
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChangesCard({
  files,
  projectPath,
  onReview,
}: {
  readonly files: readonly ChatFileChange[];
  readonly projectPath: string;
  readonly onReview: (path: string, action: 'keep' | 'undo') => void;
}) {
  const pending = files.filter((file) => file.review === 'pending');
  return (
    <div className="ai-changes" aria-label="Changes in this turn">
      <div className="ai-changes-head">
        <span>
          {files.length} file{files.length === 1 ? '' : 's'} changed
        </span>
        {pending.length > 1 && (
          <button className="ghost" onClick={() => pending.forEach((file) => onReview(file.path, 'keep'))}>
            Keep all
          </button>
        )}
      </div>
      {files.map((file) => (
        <div key={file.path} className={`ai-change ai-change-${file.review}`}>
          <span className={`ai-change-kind ai-change-${file.change}`}>
            {file.change === 'created' ? 'New' : file.change === 'deleted' ? 'Deleted' : 'Edited'}
          </span>
          <span className="ai-change-path" title={file.path}>
            {relativePath(file.path, projectPath)}
          </span>
          {file.review === 'pending' ? (
            <span className="ai-change-actions">
              <button onClick={() => onReview(file.path, 'keep')}>Keep</button>
              <button onClick={() => onReview(file.path, 'undo')}>Undo</button>
            </span>
          ) : (
            <span className="ai-change-done">{file.review === 'kept' ? 'Kept' : 'Undone'}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export function PlanStrip({ plan }: { readonly plan: NonNullable<ChatView['plan']> }) {
  const [open, setOpen] = useState(false);
  const done = plan.entries.filter((entry) => entry.status === 'completed').length;
  const current = plan.entries.find((entry) => entry.status === 'in_progress') ?? plan.entries.find((entry) => entry.status === 'pending');
  assert(done <= plan.entries.length, 'PlanStrip: done is part of the plan');
  return (
    <div className="ai-plan">
      <button className="ai-plan-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="ai-plan-count">
          {done}/{plan.entries.length}
        </span>
        <span className="ai-plan-current">{current?.content ?? 'Plan complete'}</span>
      </button>
      {open && (
        <ol className="ai-plan-entries">
          {plan.entries.map((entry, index) => (
            <li key={index} className={`ai-plan-${entry.status}`}>
              {entry.status === 'completed' ? <CheckIcon size={12} /> : <span className="ai-plan-dot" />}
              {entry.content}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function relativePath(file: string, projectPath: string): string {
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return file.startsWith(root) ? file.slice(root.length) : file;
}

function relativeTitle(title: string, projectPath: string): string {
  const root = projectPath.endsWith('/') ? projectPath : `${projectPath}/`;
  return title.split(root).join('');
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length < text.length ? `${line} …` : line;
}

function statusLabel(item: ToolItem): string {
  switch (item.status) {
    case 'pending':
      return 'Waiting';
    case 'in_progress':
      return 'Running';
    case 'completed':
      return item.exitCode !== undefined && item.exitCode !== 0 ? `Exit ${item.exitCode}` : 'Done';
    case 'failed':
      return 'Failed';
    default: {
      const exhaustive: never = item.status;
      return exhaustive;
    }
  }
}

function toolIcon(kind: ToolItem['toolKind']) {
  switch (kind) {
    case 'read':
      return FileIcon;
    case 'edit':
    case 'move':
      return PencilIcon;
    case 'delete':
      return TrashIcon;
    case 'search':
      return SearchIcon;
    case 'execute':
      return TerminalIcon;
    case 'fetch':
      return ExternalIcon;
    case 'think':
    case 'switch_mode':
    case 'other':
      return SparkleIcon;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function rank(kind: PermissionItem['options'][number]['kind']): number {
  return ['allow_once', 'allow_always', 'reject_once', 'reject_always'].indexOf(kind);
}
