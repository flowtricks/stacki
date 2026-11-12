// A permission request: the agent asks before it acts. The card says what is asked (the command, or
// the file edit as a diff, both coloured as code), offers the agent's options as buttons with the
// recommended one primary, and answers to the keys 1..n and Esc. Answered, it collapses to one line
// ("Allowed · npm test"). While it waits and is scrolled out of view, PermissionPin repeats the
// question above the composer.
//
// The request does not carry the command or the diff itself; the tool call with the same `call` id
// does, so the caller passes that tool item as `tool` when it has one. Without it the card still
// works from the request's title.
import { useEffect, useRef, type ReactNode } from 'react';
import { CodeBlock, CodeInline } from '../../../ui/CodeBlock';
import { CheckIcon, CloseIcon, PencilIcon, SparkleIcon, TerminalIcon, TrashIcon, WarningTriangleIcon } from '../../../ui/Icons';
import type { PermissionItem, ToolItem } from '../chatReducer';
import { DiffView } from './DiffView';
import { registerWaiting, requestInFocus, revealRequest, setOnScreen, typesText, usePermissionAttention } from './permissionAttention';
import { askLabel, denyOption, isAllow, optionForKey, plainTitle, primaryOption, sortedOptions, verdictLabel, type PermissionOption } from './permissionModel';
import { relativePath } from './paths';
import './chrome.css';

export function PermissionCard({
  item,
  tool,
  projectPath = '',
  onAnswer,
}: {
  readonly item: PermissionItem;
  /** The tool call this request asks about (same `call`), when the transcript has it. */
  readonly tool?: ToolItem | undefined;
  readonly projectPath?: string | undefined;
  readonly onAnswer: (optionId: string | undefined) => void;
}) {
  return item.answer === undefined ? (
    <WaitingCard item={item} tool={tool} projectPath={projectPath} onAnswer={onAnswer} />
  ) : (
    <AnsweredCard item={item} tool={tool} projectPath={projectPath} />
  );
}

function AnsweredCard({ item, tool, projectPath }: { readonly item: PermissionItem; readonly tool: ToolItem | undefined; readonly projectPath: string }) {
  const verdict = verdictLabel(item) ?? 'Answered';
  const denied = verdict === 'Denied' || verdict === 'Stopped';
  const title = plainTitle(item.title, projectPath);
  return (
    <div className="ai-permission ai-permission-answered ai-ask ai-ask-done">
      {denied ? <CloseIcon size={12} /> : <CheckIcon size={12} />}
      <span className="ai-permission-outcome ai-ask-verdict">{verdict}</span>
      <span className="ai-ask-dot" aria-hidden="true">
        ·
      </span>
      <span className="ai-ask-what">{tool?.toolKind === 'execute' ? <CodeInline text={firstLine(tool.command ?? title)} language="shell" /> : title}</span>
    </div>
  );
}

function WaitingCard({
  item,
  tool,
  projectPath,
  onAnswer,
}: {
  readonly item: PermissionItem;
  readonly tool: ToolItem | undefined;
  readonly projectPath: string;
  readonly onAnswer: (optionId: string | undefined) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const answer = useRef(onAnswer);
  useEffect(() => {
    answer.current = onAnswer;
  });
  const options = sortedOptions(item.options);
  const primary = primaryOption(item.options);
  const request = item.request;
  // Waiting cards are registered so one of them (the oldest) owns the keys and the pinned strip.
  useEffect(() => {
    const element = root.current ?? undefined;
    const clear = registerWaiting(request, element);
    // The composer keeps focus after a message is sent; an empty one hands it to the card so the number keys work at once.
    const active = document.activeElement ?? undefined;
    if (element !== undefined && (active === undefined || active === document.body || (typesText(active) && isEmptyField(active)))) {
      element.focus({ preventScroll: true });
    }
    let observer: IntersectionObserver | undefined;
    if (element !== undefined && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver((entries) => {
        const last = entries[entries.length - 1];
        if (last !== undefined) {
          setOnScreen(request, last.isIntersecting ? 'visible' : 'hidden');
        }
      });
      observer.observe(element);
    }
    return () => {
      observer?.disconnect();
      clear();
    };
  }, [request]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return;
      }
      if (requestInFocus() !== request || typesText(event.target ?? undefined)) {
        return;
      }
      const chosen = event.key === 'Escape' ? denyOption(item.options) : optionForKey(item.options, event.key);
      if (chosen !== undefined) {
        event.preventDefault();
        answer.current(chosen.id);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request, item.options]);
  const preview = previewOf(tool, projectPath);
  const Icon = askIcon(tool);
  return (
    <div
      ref={root}
      className="ai-permission ai-ask"
      role="group"
      aria-label="Permission request"
      aria-keyshortcuts="1 2 3 Escape"
      tabIndex={-1}
      data-request={request}
    >
      <div className="ai-permission-title ai-ask-head">
        <Icon size={13} />
        <span className="ai-ask-label">{askLabel(tool?.toolKind)}</span>
      </div>
      {preview !== undefined ? preview : <div className="ai-ask-title">{plainTitle(item.title, projectPath)}</div>}
      <div className="ai-permission-actions ai-ask-actions">
        {options.map((option, index) => (
          <button
            key={option.id}
            className={optionClass(option, primary)}
            data-key={index < 9 ? String(index + 1) : undefined}
            aria-keyshortcuts={index < 9 ? String(index + 1) : undefined}
            onClick={() => answer.current(option.id)}
          >
            {option.name}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The command or the edit the request is about; undefined when the transcript has no tool call for it. */
function previewOf(tool: ToolItem | undefined, projectPath: string): ReactNode | undefined {
  if (tool === undefined) {
    return undefined;
  }
  if (tool.toolKind === 'execute') {
    return <CodeBlock className="ai-ask-code" text={tool.command ?? tool.title} language="shell" label="Command to run" />;
  }
  const first = tool.diffs[0];
  if (first !== undefined) {
    return (
      <div className="ai-ask-diff">
        <DiffView diff={first} projectPath={projectPath} size="compact" />
        {tool.diffs.length > 1 && (
          <span className="ai-ask-more">
            and {tool.diffs.length - 1} more file{tool.diffs.length === 2 ? '' : 's'}
          </span>
        )}
      </div>
    );
  }
  if (tool.paths.length > 0) {
    return (
      <ul className="ai-ask-paths">
        {tool.paths.slice(0, 5).map((file) => (
          <li key={file}>{relativePath(file, projectPath)}</li>
        ))}
      </ul>
    );
  }
  return undefined;
}

function optionClass(option: PermissionOption, primary: PermissionOption | undefined): string {
  if (!isAllow(option)) {
    return 'ai-reject';
  }
  return option.id === primary?.id ? 'ai-allow' : 'ai-allow ai-allow-secondary';
}

function askIcon(tool: ToolItem | undefined) {
  const kind = tool?.toolKind;
  switch (kind) {
    case 'execute':
      return TerminalIcon;
    case 'edit':
    case 'move':
      return PencilIcon;
    case 'delete':
      return TrashIcon;
    case 'read':
    case 'search':
    case 'fetch':
    case 'think':
    case 'switch_mode':
    case 'other':
      return SparkleIcon;
    case undefined:
      return WarningTriangleIcon;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.length < text.length ? `${line} …` : line;
}

function isEmptyField(element: Element): boolean {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return element.value === '';
  }
  return (element.textContent ?? '').replace(/￼/g, '').trim() === '';
}

/**
 * The oldest waiting request, repeated as a strip when its card has scrolled out of view: what is
 * asked, the recommended answer, the deny option and "Show". It draws nothing while the card is on
 * screen, so it can be mounted at the foot of the transcript unconditionally.
 */
export function PermissionPin({
  permissions,
  projectPath = '',
  onAnswer,
}: {
  /** The unanswered requests, oldest first (`waitingPermissions(view)`). */
  readonly permissions: readonly PermissionItem[];
  readonly projectPath?: string | undefined;
  readonly onAnswer: (item: PermissionItem, optionId: string) => void;
}) {
  const attention = usePermissionAttention();
  const request = attention.waiting[0];
  const item = permissions.find((candidate) => candidate.request === request && candidate.answer === undefined);
  if (request === undefined || item === undefined || !attention.hidden.has(request)) {
    return undefined;
  }
  const allow = primaryOption(item.options);
  const deny = denyOption(item.options);
  return (
    <div className="ai-ask-pin" role="status">
      <WarningTriangleIcon size={13} />
      <span className="ai-ask-pin-text">Waiting: {plainTitle(item.title, projectPath)}</span>
      <span className="ai-ask-pin-actions">
        {allow !== undefined && (
          <button className="ai-allow" onClick={() => onAnswer(item, allow.id)}>
            {allow.name}
          </button>
        )}
        {deny !== undefined && (
          <button className="ai-reject" onClick={() => onAnswer(item, deny.id)}>
            {deny.name}
          </button>
        )}
        <button className="ai-reject" onClick={() => revealRequest(request)}>
          Show
        </button>
      </span>
    </div>
  );
}
