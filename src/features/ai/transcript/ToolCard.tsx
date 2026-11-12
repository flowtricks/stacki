// A tool call as one line (status, what it did, how long it took) that opens to the command, the
// files it touched, its diff and its output. A card is closed unless it is an edit in a turn that
// is still running (its diff is what the person is about to approve); what the person opens or
// closes is remembered (transcriptUi.ts). Styled as Stacki is styled: background fills, never borders.
import { memo, useId, useState } from 'react';
import { CodeBlock, CodeInline } from '../../../ui/CodeBlock';
import { LoaderDots } from '../../../ui/LoaderDots';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClockIcon,
  ExternalIcon,
  FileIcon,
  PencilIcon,
  SearchIcon,
  SparkleIcon,
  TerminalIcon,
  TrashIcon,
  WarningTriangleIcon,
} from '../../../ui/Icons';
import { formatDuration } from '../chatStatus';
import type { ToolItem } from '../chatReducer';
import { DiffView } from './DiffView';
import { relativePath, relativeTitle } from './paths';
import { useNow } from './ticker';
import { clampOutput, OUTPUT_PREVIEW_CHARS, toolDurationMs } from './transcriptModel';
import { useOpenState } from './transcriptUi';

/** A command longer than this is cut in the closed line; the open card shows it whole (bounded). */
const COMMAND_CHARS_MAX = 4000;
/** About how many characters of a command fit the closed line of a narrow panel. */
const COMMAND_LINE_CHARS = 36;

export interface ToolCardProps {
  readonly item: ToolItem;
  readonly chatId: string;
  readonly projectPath: string;
  /** The turn this call belongs to is running: a diff is shown open, and a running call counts its seconds. */
  readonly live: boolean;
  /** Calls nested under this one (a subagent's own calls); zero for an ordinary call. */
  readonly childCount: number;
}

export const ToolCard = memo(function ToolCard({ item, chatId, projectPath, live, childCount }: ToolCardProps) {
  const hasOutput = item.output !== '';
  const hasDiffs = item.diffs.length > 0;
  const command = item.toolKind === 'execute' ? (item.command ?? item.title) : undefined;
  const hasBody = hasDiffs || hasOutput || item.paths.length > 0 || command !== undefined;
  const [open, change] = useOpenState(chatId, `tool:${item.id}`, { open: hasDiffs && live });
  const bodyId = useId();
  const Icon = toolIcon(item.toolKind);
  const expanded = open && hasBody;
  return (
    <div className={`ai-tool ai-tool-${item.status}${item.parent === undefined ? '' : ' ai-tool-nested'}`}>
      <button
        className="ai-tool-head"
        aria-expanded={hasBody ? expanded : undefined}
        aria-controls={expanded ? bodyId : undefined}
        disabled={!hasBody}
        onClick={() => change({ open: !open })}
      >
        {hasBody ? expanded ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} /> : <span className="ai-tool-spacer" />}
        <Icon size={14} />
        <span className="ai-tool-title">
          {command === undefined ? relativeTitle(item.title, projectPath) : <CodeInline text={closedCommand(command)} language="shell" />}
        </span>
        {childCount > 0 && <span className="ai-tool-count">{childCount === 1 ? '1 call' : `${childCount} calls`}</span>}
        <ToolTime item={item} />
        <ToolStatus item={item} />
      </button>
      {expanded && (
        <div className="ai-tool-body" id={bodyId}>
          {command !== undefined && showsCommand(command) && (
            <CodeBlock className="ai-tool-command" text={command.slice(0, COMMAND_CHARS_MAX)} language="shell" />
          )}
          {item.diffs.length === 0 && item.paths.length > 0 && !(hasOutput && item.paths.length === 1) && (
            <ul className="ai-tool-paths">
              {item.paths.map((file) => (
                <li key={file}>{relativePath(file, projectPath)}</li>
              ))}
            </ul>
          )}
          {item.diffs.map((diff, index) => (
            <DiffView key={`${diff.path}-${index}`} diff={diff} projectPath={projectPath} />
          ))}
          {hasOutput && <ToolOutput item={item} />}
        </div>
      )}
    </div>
  );
});

/** The tool's output: a preview of it, with the rest on request, in a block that scrolls and is coloured as what it is. */
function ToolOutput({ item }: { readonly item: ToolItem }) {
  const [all, setAll] = useState(false);
  const clamped = all
    ? { text: item.output, hidden: 0 }
    : clampOutput(item.output, { from: item.toolKind === 'execute' ? 'end' : 'start', limit: OUTPUT_PREVIEW_CHARS });
  const fromEnd = item.toolKind === 'execute';
  return (
    <>
      {clamped.hidden > 0 && fromEnd && <div className="ai-tool-more">{clamped.hidden.toLocaleString('en-US')} earlier characters hidden</div>}
      <CodeBlock className="ai-tool-output" text={clamped.text} filename={outputFilename(item)} label="Tool output" />
      {clamped.hidden > 0 && !fromEnd && <div className="ai-tool-more">{clamped.hidden.toLocaleString('en-US')} more characters hidden</div>}
      {clamped.hidden > 0 && (
        <button className="ai-tool-showall" onClick={() => setAll(true)}>
          Show all
        </button>
      )}
    </>
  );
}

/** How long the call took: counted live while it runs (one shared ticker), fixed once it ends; nothing under a second or without stamps. */
function ToolTime({ item }: { readonly item: ToolItem }) {
  if (item.status === 'in_progress' && item.at !== undefined) {
    return <RunningTime startedAt={item.at} />;
  }
  const duration = toolDurationMs(item);
  return duration !== undefined && duration >= 1000 ? <span className="ai-tool-time">{formatDuration(duration)}</span> : undefined;
}

function RunningTime({ startedAt }: { readonly startedAt: number }) {
  const elapsed = useNow() - startedAt;
  return elapsed >= 1000 ? <span className="ai-tool-time">{formatDuration(elapsed)}</span> : undefined;
}

function ToolStatus({ item }: { readonly item: ToolItem }) {
  switch (item.status) {
    case 'pending':
      return (
        <span className="ai-tool-status" role="img" aria-label="Waiting">
          <ClockIcon size={12} />
        </span>
      );
    case 'in_progress':
      return (
        <span className="ai-tool-status ai-status-in_progress">
          <LoaderDots label="Running" dotPx={3} />
        </span>
      );
    case 'completed':
      return item.exitCode !== undefined && item.exitCode !== 0 ? (
        <span className="ai-tool-status ai-status-failed">Exit {item.exitCode}</span>
      ) : (
        <span className="ai-tool-status ai-status-completed" role="img" aria-label="Done">
          <CheckIcon size={12} />
        </span>
      );
    case 'failed':
      return (
        <span className="ai-tool-status ai-status-failed" role="img" aria-label="Failed">
          <WarningTriangleIcon size={12} />
        </span>
      );
    default: {
      const exhaustive: never = item.status;
      return exhaustive;
    }
  }
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

/** The open card repeats the command when the closed line cut it: more than one line, or longer than fits the panel. */
function showsCommand(command: string): boolean {
  return command.includes('\n') || command.length > COMMAND_LINE_CHARS;
}

/** The first line of a command, marked when more follows, and never longer than the bound. */
function closedCommand(command: string): string {
  const line = (command.split('\n')[0] ?? '').slice(0, COMMAND_CHARS_MAX);
  return line.length < command.length ? `${line} …` : line;
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
