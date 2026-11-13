// The conversation: the messages, the agent's work folded into activity groups, its plan's state,
// permission requests, the changes of each turn, compactions, and the quiet rows (notices, stops, a
// failed reply). Under it, while a turn runs, the loader with what the agent is doing and a live
// timer; above the composer's edge, the tray of background work.
//
// Scrolling: the view follows the newest line while the person is at the bottom, stops following the
// moment they scroll up (wheel, touch, keys or the scrollbar), and offers "Jump to latest" until they
// return. Following is instant, so repeated programmatic scrolls never fight the person's own.
//
// A long chat draws a window of its newest rows (`ROWS_SHOWN_MAX`) with "Show earlier" above, and rows
// are memoized by item identity, so a streamed word re-renders the last row and not the thousand above it.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatId, TurnId, TurnStop } from '../../../../shared/properties/ai/chatModel';
import { ArrowDownIcon } from '../../../ui/Icons';
import { answerPermission, draftWithText, sendPrompt, setDraft, stopChat } from '../aiStore';
import { waitingPermissions, type ChatView, type ToolItem, type TranscriptItem } from '../chatReducer';
import { useFormat, useTranslate, useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import { formatDuration } from '../chatStatus';
import type { SignInReading } from '../signInTranscript';
import { ActivityGroup } from './ActivityGroup';
import { BackgroundTasks } from './BackgroundTasks';
import { ChangesCard } from './ChangesCard';
import { UntrackedChangesNote } from './UntrackedChangesNote';
import { CompactionRow } from './CompactionRow';
import { ErrorRow } from './ErrorRow';
import { AgentMessage, UserMessage } from './Messages';
import { lastUserMessageId } from './messageModel';
import { PermissionCard, PermissionPin } from './PermissionCard';
import { relativePath } from './paths';
import { sentPartsView } from './SentParts';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { TurnStatus } from './TurnStatus';
import { buildRows, finishedTasks, windowRows, type PositionedItem, type TranscriptRow } from './transcriptModel';
import { useOpenState } from './transcriptUi';
import './transcript.css';

/** Rows drawn at once, and how many "Show earlier" adds. Why: 50 000 events can stand behind one chat; the DOM never holds them all. */
export const ROWS_SHOWN_MAX = 400;
/** Within this many pixels of the bottom counts as "at the bottom". */
const NEAR_BOTTOM_PX = 80;
/** Finished background tasks listed in the tray, and how far back the transcript is searched for them. */
const FINISHED_TASKS_SHOWN = 5;
const FINISHED_TASKS_SCAN_ITEMS = 2000;

/** Settles one file of a turn. Returns the review's promise: a drifted undo waits for the merge editor, and the card's bulk actions wait for it. */
type ReviewHandler = (turn: TurnId, path: string, action: 'keep' | 'undo') => void | Promise<void>;

export function Transcript({
  view,
  reading,
  retryHeldByCard,
  projectPath,
  chatId,
  onReview,
  onOpenFile,
}: {
  readonly view: ChatView;
  /** What of the transcript is a sign-in problem (the sign-in card draws it, not the transcript). */
  readonly reading: SignInReading;
  /** The sign-in card or its "Signed in" strip offers the retry now, so the transcript does not. */
  readonly retryHeldByCard: boolean;
  readonly projectPath: string;
  readonly chatId: ChatId;
  readonly onReview: ReviewHandler;
  /** Shows a changed file in the editor; without it a changes card has no "Open file". */
  readonly onOpenFile?: ((path: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const scroll = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrolling = useRef(false);
  const [away, setAway] = useState(false);
  const [shown, setShown] = useState(ROWS_SHOWN_MAX);
  // The latest review handler, behind a stable function, so memoized rows are not re-rendered when the parent is.
  const reviewRef = useRef(onReview);
  reviewRef.current = onReview;
  const review = useCallback<ReviewHandler>((turn, path, action) => reviewRef.current(turn, path, action), []);
  const openFileRef = useRef(onOpenFile);
  openFileRef.current = onOpenFile;
  const canOpenFile = onOpenFile !== undefined;
  // The editor opens project-relative paths; the ledger may name a file absolutely.
  const openFile = useMemo(
    () => (canOpenFile ? (path: string): void => openFileRef.current?.(relativePath(path, projectPath)) : undefined),
    [canOpenFile, projectPath],
  );

  const previousRows = useRef<readonly TranscriptRow[]>([]);
  const rows = useMemo(() => {
    const positioned: PositionedItem[] = [];
    view.items.forEach((item, index) => {
      if (!reading.hidden.has(index)) {
        positioned.push({ item, index });
      }
    });
    const built = buildRows(positioned, previousRows.current);
    previousRows.current = built;
    return built;
  }, [view.items, reading]);
  const windowed = windowRows(rows, shown);

  const scrollToEnd = useCallback((): void => {
    const element = scroll.current;
    if (element === null) {
      return;
    }
    const target = element.scrollHeight - element.clientHeight;
    if (element.scrollTop < target - 1) {
      scrolling.current = true;
      element.scrollTop = target;
    }
  }, []);
  useEffect(() => {
    if (follow.current) {
      scrollToEnd();
    }
  }, [view.items, view.running, shown, scrollToEnd]);
  // A card opened or a block grown while the person is at the bottom keeps the bottom in view.
  useEffect(() => {
    const content = flow.current;
    if (content === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      if (follow.current) {
        scrollToEnd();
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollToEnd]);
  // Another chat opens at its end.
  useEffect(() => {
    follow.current = true;
    setAway(false);
    setShown(ROWS_SHOWN_MAX);
    scrollToEnd();
  }, [chatId, scrollToEnd]);

  const lastEndIndex = view.items.map((item) => item.kind).lastIndexOf('turn-end');
  const lastEnd = view.items[lastEndIndex];
  const canRetry = view.running === undefined && lastEnd?.kind === 'turn-end' && lastEnd.stop !== 'end_turn' && view.lastPrompt !== undefined;
  // An error turn carries its Retry inside its row; a sign-in turn's belongs to the sign-in card; the rest keep the plain button.
  const standaloneRetry = canRetry && lastEnd?.kind === 'turn-end' && lastEnd.stop !== 'error' && (lastEnd.stop !== 'sign-in' || !retryHeldByCard);
  const retryLast = (): void => void sendPrompt(chatId, view.lastPrompt?.text ?? '');
  const lastUser = lastUserMessageId(view.items);
  const toolsByCall = useMemo(() => toolItemsByCall(view.items), [view.items]);
  const waiting = useMemo(() => waitingPermissions(view), [view]);
  const lastItem = view.items[view.items.length - 1];
  const finished = useMemo(() => finishedTasks(view.items, { limit: FINISHED_TASKS_SHOWN, scanMax: FINISHED_TASKS_SCAN_ITEMS }), [view.items]);
  const stop = useCallback((): void => void stopChat(chatId), [chatId]);

  return (
    <div
      className="ai-transcript"
      ref={scroll}
      role="log"
      aria-label={translate('ai.transcript.label')}
      onScroll={(event) => {
        const element = event.currentTarget;
        const near = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
        if (scrolling.current) {
          // Our own scroll to the end: it says nothing about the person's intent, until it arrives.
          if (near) {
            scrolling.current = false;
          }
          return;
        }
        follow.current = near;
        setAway(!near);
      }}
      // The person moving the view themselves takes over from any scroll of ours.
      onWheel={() => {
        scrolling.current = false;
      }}
      onTouchMove={() => {
        scrolling.current = false;
      }}
      onPointerDown={() => {
        scrolling.current = false;
      }}
      onKeyDown={() => {
        scrolling.current = false;
      }}
    >
      <div className="ai-transcript-flow" ref={flow}>
        {view.items.length === 0 && <p className="ai-empty">{translate('ai.transcript.empty')}</p>}
        {windowed.hidden > 0 && (
          <button className="ai-earlier" onClick={() => setShown((count) => count + ROWS_SHOWN_MAX)}>
            {translate('ai.transcript.showEarlier', { count: Math.min(windowed.hidden, ROWS_SHOWN_MAX) })}
          </button>
        )}
        {windowed.shown.map((row) =>
          row.kind === 'group' ? (
            <ActivityGroup key={`g${row.key}`} run={row} chatId={chatId} projectPath={projectPath} working={view.running === row.turn} />
          ) : (
            <Item
              key={`i${row.key}`}
              item={row.item}
              chatId={chatId}
              projectPath={projectPath}
              onReview={review}
              onOpenFile={openFile}
              tool={row.item.kind === 'permission' ? toolsByCall.get(row.item.call) : undefined}
              onRetry={canRetry && row.index === lastEndIndex ? retryLast : undefined}
              resendable={view.running === undefined && row.item.id === lastUser}
              streaming={view.running !== undefined && row === rows[rows.length - 1] && row.item === lastItem}
            />
          ),
        )}
        <BackgroundTasks tasks={view.activeTasks} finished={finished} chatId={chatId} onStop={stop} />
        <TurnStatus view={view} />
        {standaloneRetry && (
          <button className="ai-retry" onClick={retryLast}>
            {translate('ui.retry')}
          </button>
        )}
      </div>
      <PermissionPin permissions={waiting} projectPath={projectPath} onAnswer={(item, optionId) => void answerPermission(chatId, item.request, optionId)} />
      {away && (
        <button
          className="ai-latest"
          onClick={() => {
            const element = scroll.current;
            follow.current = true;
            scrolling.current = true;
            setAway(false);
            if (element !== null) {
              element.scrollTo({ top: element.scrollHeight, behavior: 'smooth' });
            }
          }}
        >
          <ArrowDownIcon size={12} />
          {translate('ai.transcript.jumpLatest')}
        </button>
      )}
    </div>
  );
}

/** The tool calls of a transcript by call id, so a permission request finds the call it asks about. */
function toolItemsByCall(items: readonly TranscriptItem[]): ReadonlyMap<string, ToolItem> {
  const tools = new Map<string, ToolItem>();
  for (const item of items) {
    if (item.kind === 'tool') {
      tools.set(item.call, item);
    }
  }
  return tools;
}

const Item = memo(function Item({
  item,
  chatId,
  projectPath,
  onReview,
  onOpenFile,
  tool,
  onRetry,
  resendable,
  streaming,
}: {
  readonly item: TranscriptItem;
  readonly chatId: ChatId;
  readonly projectPath: string;
  readonly onReview: ReviewHandler;
  readonly onOpenFile: ((path: string) => void) | undefined;
  /** The tool call a permission request asks about, when the transcript has it. */
  readonly tool: ToolItem | undefined;
  /** Sends the last message again; given only to the last turn's end. */
  readonly onRetry: (() => void) | undefined;
  /** The person's last message while the chat is idle: it may be edited or sent again. */
  readonly resendable: boolean;
  /** The reply is still arriving: it is drawn whole, never cut to a preview. */
  readonly streaming: boolean;
}) {
  const translate = useTranslate();
  const translateDescribed = useTranslateDescribed();
  switch (item.kind) {
    case 'user':
      return <UserRow item={item} chatId={chatId} resendable={resendable} />;
    case 'text':
      // Thoughts and tool calls normally live in an activity group; these two arms keep the switch total.
      return item.role === 'thought' ? (
        <ThinkingBlock item={item} chatId={chatId} live={streaming} />
      ) : (
        <AgentRow item={item} chatId={chatId} streaming={streaming} />
      );
    case 'tool':
      return <ToolCard item={item} chatId={chatId} projectPath={projectPath} live={false} childCount={0} />;
    case 'permission':
      return (
        <PermissionCard item={item} tool={tool} projectPath={projectPath} onAnswer={(optionId) => void answerPermission(chatId, item.request, optionId)} />
      );
    case 'compaction':
      return <CompactionRow item={item} />;
    case 'changes':
      return (
        <ChangesCard
          files={item.files}
          projectPath={projectPath}
          source={{ chat: chatId, turn: item.turn }}
          onOpenFile={onOpenFile}
          onReview={(path, action) => onReview(item.turn, path, action)}
        />
      );
    case 'changes-untracked':
      return <UntrackedChangesNote reason={item.reason} />;
    case 'notice':
      return <div className={`ai-notice ai-notice-${item.severity}`}>{translateDescribed({ message: item.text, messageRef: item.textRef })}</div>;
    case 'turn-end':
      if (item.stop === 'end_turn') {
        return <WorkedFor startedAt={item.startedAt} endedAt={item.at} />;
      }
      // A failed reply is its own quiet row. (A sign-in stop never reaches here: the sign-in card draws it.)
      return item.stop === 'error' ? (
        <ErrorRow message={item.message} onRetry={onRetry} />
      ) : (
        <div className="ai-notice ai-notice-warning">{turnEndText(item.stop, item.message, translate)}</div>
      );
    case 'unsupported':
      return <div className="ai-notice ai-notice-info">{translateDescribed({ message: item.label, messageRef: item.labelRef })}</div>;
    default: {
      const exhaustive: never = item;
      return exhaustive;
    }
  }
});

type UserItem = Extract<TranscriptItem, { readonly kind: 'user' }>;
type TextItem = Extract<TranscriptItem, { readonly kind: 'text' }>;

/** The person's message. Edit and resend are given only to the last one while the chat is idle: an older one would branch a session that cannot branch. */
function UserRow({ item, chatId, resendable }: { readonly item: UserItem; readonly chatId: ChatId; readonly resendable: boolean }) {
  const [expanded, change] = useOpenState(chatId, `message:${item.id}`, { open: false });
  return (
    <UserMessage
      text={item.text}
      attachments={item.attachments}
      at={item.at}
      partsView={sentPartsView(item.parts)}
      expanded={expanded}
      onExpandedChange={(open) => change({ open })}
      onEdit={resendable ? () => setDraft(chatId, (draft) => draftWithText(draft, item.text)) : undefined}
      onResend={resendable ? () => void sendPrompt(chatId, item.text) : undefined}
    />
  );
}

/** The agent's reply. One still arriving is drawn whole, so it does not jump as it grows. */
function AgentRow({ item, chatId, streaming }: { readonly item: TextItem; readonly chatId: ChatId; readonly streaming: boolean }) {
  const [expanded, change] = useOpenState(chatId, `message:${item.id}`, { open: false });
  return (
    <AgentMessage text={item.text} at={item.at} collapsible={streaming ? 'none' : 'clamp'} expanded={expanded} onExpandedChange={(open) => change({ open })} />
  );
}

/** "Worked for 2m 14s" after a finished turn; nothing for a turn this view did not see begin or one under a second. */
function WorkedFor({ startedAt, endedAt }: { readonly startedAt: number | undefined; readonly endedAt: number }) {
  const translate = useTranslate();
  const { formatNumber } = useFormat();
  if (startedAt === undefined || endedAt - startedAt < 1000) {
    return undefined;
  }
  return <div className="ai-worked">{translate('ai.transcript.workedFor', { duration: formatDuration(endedAt - startedAt, formatNumber) })}</div>;
}

function turnEndText(stop: TurnStop, message: string | undefined, translate: Translator): string {
  switch (stop) {
    case 'cancelled':
      return translate('ai.turn.stopped');
    case 'max_tokens':
      return translate('ai.turn.maxTokens');
    case 'max_turn_requests':
      return translate('ai.turn.maxRequests');
    case 'refusal':
      return translate('ai.turn.refusal');
    case 'end_turn':
      return translate('ai.turn.done');
    case 'sign-in':
      return message ?? translate('ai.turn.signIn');
    case 'error':
      return message ?? translate('ai.turn.error');
    default: {
      const exhaustive: never = stop;
      return exhaustive;
    }
  }
}
