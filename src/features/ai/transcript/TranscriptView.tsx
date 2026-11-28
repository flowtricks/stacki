// The conversation: the messages, the agent's work folded into activity groups, its plan's state,
// permission requests, the changes of each turn, compactions, and the quiet rows (notices, stops, a
// failed reply). Under it, while a turn runs, the loader with what the agent is doing and a live
// timer; above the composer's edge, the tray of background work. A subagent's own words are not drawn
// here: they belong to its transcript (SubagentPane.tsx), which is this same view given the
// subagent's items, so both are drawn by one renderer. Each subagent is one unit (SubagentCard.tsx) that
// holds its own calls, so the coordinator's groups hold only its own work. Subagents are listed by the
// strip above, so the tray keeps the commands and other calls left running.
//
// Scrolling: the view follows the newest line while the person is at the bottom, stops following the
// moment they scroll up (wheel, touch, keys or the scrollbar), and offers "Jump to latest" until they
// return. Following is instant, so repeated programmatic scrolls never fight the person's own.
//
// A long chat draws a window of its newest rows (`ROWS_SHOWN_MAX`) with "Show earlier" above, and rows
// are memoized by item identity, so a streamed word re-renders the last row and not the thousand above it.
//
// Keys while focus is in the transcript (chatShortcuts.ts): ⌘F / Ctrl+F opens the find bar
// (ChatFindBar.tsx; the composer asks for it through `requestChatFind`) and ⌘⇧O / Ctrl+Shift+O starts
// a new chat. While a query is typed the window grows (FIND_LIMITS.rowsShownMax) so earlier messages
// can be found.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChatId, SentPart, TurnId, TurnStop } from '../../../../shared/properties/ai/chatModel';
import { ArrowDownIcon } from '../../../ui/Icons';
import { currentDesktopPlatform } from '../../../lib/shortcutLabel';
import { answerPermission, newChat, preferredAgent, sendPrompt, readSentImage, resendMessage, setDraft, stopChat } from '../aiStore';
import { chatShortcut } from '../chatShortcuts';
import { waitingPermissions, type ChatView, type ToolItem, type TranscriptItem } from '../chatReducer';
import { useFormat, useTranslate, useTranslateDescribed } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import { formatDuration } from '../chatStatus';
import type { SignInReading } from '../signInTranscript';
import { deriveSubagentWork, type SubagentWork } from '../subagents';
import { ActivityGroup } from './ActivityGroup';
import { BackgroundTasks } from './BackgroundTasks';
import { ChangesCard } from './ChangesCard';
import { ChatFindBar } from './ChatFindBar';
import { FIND_LIMITS, useChatFindRequests } from './chatFind';
import { UntrackedChangesNote } from './UntrackedChangesNote';
import { CompactionRow } from './CompactionRow';
import { ErrorRow } from './ErrorRow';
import { AgentMessage, UserMessage } from './Messages';
import { answerableMessageId, lastUserMessageId } from './messageModel';
import { PermissionCard, PermissionPin } from './PermissionCard';
import { relativePath } from './paths';
import { sentPartsView } from './SentParts';
import { copyWithChips } from './chipCopy';
import { segmentsOfSent, sentReadableText, sentTypedText } from '../../../../shared/properties/ai/sentMessage';
import { SubagentCard } from './SubagentCard';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolCard } from './ToolCard';
import { TurnStatus } from './TurnStatus';
import { PinsMessage } from '../pins/PinsMessage';
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
  empty,
  reveal,
  onOpenSubagent,
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
  /** What an empty transcript says; the chat's invitation by default. */
  readonly empty?: string | undefined;
  /** The subagent unit the strip asked for, with a count that grows with each ask, so asking twice scrolls twice. */
  readonly reveal?: { readonly call: string; readonly count: number } | undefined;
  /** Opens one subagent's full transcript; without it a unit offers none. */
  readonly onOpenSubagent?: ((call: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const scroll = useRef<HTMLDivElement>(null);
  const flow = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const scrolling = useRef(false);
  const [away, setAway] = useState(false);
  const [shown, setShown] = useState(ROWS_SHOWN_MAX);
  const [find, setFind] = useState<{ readonly open: boolean; readonly query: string; readonly focus: number }>({ open: false, query: '', focus: 0 });
  const findRequests = useChatFindRequests(chatId);
  const findRequestsSeen = useRef({ chat: chatId, count: findRequests });
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

  // The subagents and the calls each made: those calls are drawn inside their unit, not in the coordinator's groups.
  const previousWork = useRef<SubagentWork | undefined>(undefined);
  const work = useMemo(() => {
    const derived = deriveSubagentWork(view, previousWork.current);
    previousWork.current = derived;
    return derived;
  }, [view]);
  const previousRows = useRef<readonly TranscriptRow[]>([]);
  const rows = useMemo(() => {
    const positioned: PositionedItem[] = [];
    view.items.forEach((item, index) => {
      if (!reading.hidden.has(index) && !isSubagentText(item) && !(item.kind === 'tool' && work.unitOf.has(item.call))) {
        positioned.push({ item, index });
      }
    });
    const built = buildRows(positioned, previousRows.current);
    previousRows.current = built;
    return built;
  }, [view.items, reading, work]);
  // A unit the strip asks for is drawn even when it sits above the window of newest rows. Only a new ask
  // moves the window (the rows are read through a ref), so rows growing afterwards do not hold it open.
  const rowsNow = useRef(rows);
  rowsNow.current = rows;
  useEffect(() => {
    if (reveal === undefined) {
      return;
    }
    const current = rowsNow.current;
    const at = current.findIndex((row) => row.kind === 'subagent' && row.item.call === reveal.call);
    if (at !== -1) {
      setShown((count) => Math.max(count, current.length - at));
    }
  }, [reveal]);
  const windowed = windowRows(rows, find.open && find.query !== '' ? Math.max(shown, FIND_LIMITS.rowsShownMax) : shown);
  const openFind = useCallback((): void => setFind((previous) => ({ open: true, query: previous.open ? previous.query : '', focus: previous.focus + 1 })), []);
  const closeFind = useCallback((): void => setFind((previous) => ({ open: false, query: '', focus: previous.focus })), []);
  const flowElement = useCallback((): HTMLElement | undefined => flow.current ?? undefined, []);
  // The composer asked for find (its ⌘F or `/find`): a count that grew since the last look at this chat opens the bar.
  useEffect(() => {
    const seen = findRequestsSeen.current;
    if (seen.chat === chatId && findRequests > seen.count) {
      openFind();
    }
    findRequestsSeen.current = { chat: chatId, count: findRequests };
  }, [chatId, findRequests, openFind]);

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
  // Another chat opens at its end, with no find bar.
  useEffect(() => {
    follow.current = true;
    setAway(false);
    setShown(ROWS_SHOWN_MAX);
    closeFind();
    scrollToEnd();
  }, [chatId, scrollToEnd, closeFind]);

  const lastEndIndex = view.items.map((item) => item.kind).lastIndexOf('turn-end');
  const lastEnd = view.items[lastEndIndex];
  const canRetry = view.running === undefined && lastEnd?.kind === 'turn-end' && lastEnd.stop !== 'end_turn' && view.lastPrompt !== undefined;
  // An error turn carries its Retry inside its row; a sign-in turn's belongs to the sign-in card; the rest keep the plain button.
  const standaloneRetry = canRetry && lastEnd?.kind === 'turn-end' && lastEnd.stop !== 'error' && (lastEnd.stop !== 'sign-in' || !retryHeldByCard);
  const retryLast = (): void => {
    if (view.lastPrompt !== undefined) {
      void resendMessage(chatId, view.lastPrompt);
    }
  };
  const lastUser = lastUserMessageId(view.items);
  // The agent's last reply may be asked for again, once the turn ended normally (a failed one has its own Retry).
  const retryReplyPrompt = view.running === undefined && lastEnd?.kind === 'turn-end' && lastEnd.stop === 'end_turn' ? view.lastPrompt : undefined;
  const answerable = answerableMessageId(view.items, { running: view.running !== undefined });
  const toolsByCall = useMemo(() => toolItemsByCall(view.items), [view.items]);
  const waiting = useMemo(() => waitingPermissions(view), [view]);
  const lastItem = useMemo(() => lastOwnItem(view.items), [view.items]);
  const finished = useMemo(
    () => finishedTasks(view.items, { limit: FINISHED_TASKS_SHOWN, scanMax: FINISHED_TASKS_SCAN_ITEMS }).filter((task) => task.kind !== 'subagent'),
    [view.items],
  );
  const tasks = useMemo(() => view.activeTasks.filter((task) => task.kind !== 'subagent'), [view.activeTasks]);
  const stop = useCallback((): void => void stopChat(chatId), [chatId]);

  return (
    <div
      className="ai-transcript"
      ref={scroll}
      onCopy={copyWithChips}
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
      onKeyDown={(event) => {
        scrolling.current = false;
        if (event.defaultPrevented) {
          return;
        }
        const shortcut = chatShortcut(event, currentDesktopPlatform());
        if (shortcut === 'find') {
          // Taken here, so the app's ⌘F (the insert palette) does not also open.
          event.preventDefault();
          openFind();
        } else if (shortcut === 'new-chat') {
          event.preventDefault();
          void newChat(preferredAgent());
        }
      }}
    >
      {find.open && (
        <ChatFindBar
          chatId={chatId}
          items={view.items}
          flow={flowElement}
          focusRequests={find.focus}
          onQueryChange={(query) => setFind((previous) => ({ ...previous, query }))}
          onClose={closeFind}
        />
      )}
      <div className="ai-transcript-flow" ref={flow}>
        {view.items.length === 0 && <p className="ai-empty">{empty ?? translate('ai.transcript.empty')}</p>}
        {windowed.hidden > 0 && (
          <button className="ai-earlier" onClick={() => setShown((count) => count + ROWS_SHOWN_MAX)}>
            {translate('ai.transcript.showEarlier', { count: Math.min(windowed.hidden, ROWS_SHOWN_MAX) })}
          </button>
        )}
        {windowed.shown.map((row) =>
          row.kind === 'group' ? (
            <ActivityGroup key={`g${row.key}`} run={row} chatId={chatId} projectPath={projectPath} working={view.running === row.turn} />
          ) : row.kind === 'subagent' ? (
            <UnitRow
              key={`a${row.key}`}
              item={row.item}
              work={work}
              chatId={chatId}
              projectPath={projectPath}
              options={view.options}
              live={view.running === row.item.turn}
              reveal={reveal?.call === row.item.call ? reveal.count : undefined}
              onOpenTranscript={onOpenSubagent}
            />
          ) : row.item.kind === 'user' && pinsPartOf(row.item) !== undefined ? (
            // A message of comment pins follows its pins' progress, so it reads the whole view (and is outside Item's memo).
            <PinsRow key={`i${row.key}`} item={row.item} chatId={chatId} view={view} onOpenSubagent={onOpenSubagent} />
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
              answerable={row.item.id === answerable}
              retryPrompt={row.item.id === answerable ? retryReplyPrompt : undefined}
              streaming={view.running !== undefined && row === rows[rows.length - 1] && row.item === lastItem}
            />
          ),
        )}
        <BackgroundTasks tasks={tasks} finished={finished} chatId={chatId} onStop={stop} />
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

/** A subagent's unit; a unit call the work does not know (it cannot happen: both read the same items) is drawn as a plain call. */
function UnitRow({
  item,
  work,
  chatId,
  projectPath,
  options,
  live,
  reveal,
  onOpenTranscript,
}: {
  readonly item: ToolItem;
  readonly work: SubagentWork;
  readonly chatId: ChatId;
  readonly projectPath: string;
  readonly options: ChatView['options'];
  readonly live: boolean;
  readonly reveal: number | undefined;
  readonly onOpenTranscript: ((call: string) => void) | undefined;
}) {
  const unit = work.units.get(item.call);
  if (unit === undefined) {
    return <ToolCard item={item} chatId={chatId} projectPath={projectPath} live={live} childCount={0} />;
  }
  return <SubagentCard unit={unit} chatId={chatId} projectPath={projectPath} options={options} reveal={reveal} onOpenTranscript={onOpenTranscript} />;
}

/** The newest item this transcript draws (a subagent's words streaming after it are drawn elsewhere). */
function lastOwnItem(items: readonly TranscriptItem[]): TranscriptItem | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item !== undefined && !isSubagentText(item)) {
      return item;
    }
  }
  return undefined;
}

/** Words a subagent said: its own transcript draws them, re-rooted, so here they are left out. */
function isSubagentText(item: TranscriptItem): boolean {
  return item.kind === 'text' && item.parent !== undefined;
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
  answerable,
  retryPrompt,
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
  /** The agent's last reply, once it is done: its numbered options may be answered with a click. */
  readonly answerable: boolean;
  /** The prompt the agent's last reply answered, given to that reply alone so it can be asked for again. */
  readonly retryPrompt: ChatView['lastPrompt'];
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
        <AgentRow item={item} chatId={chatId} streaming={streaming} answerable={answerable} retryPrompt={retryPrompt} />
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
type PinsPart = Extract<SentPart, { readonly kind: 'pins' }>;

/** The comment pins a message carried ("Send all"), when it carried any. */
function pinsPartOf(item: UserItem): PinsPart | undefined {
  return item.parts?.find((part): part is PinsPart => part.kind === 'pins');
}

/** A message of comment pins: drawn whole by PinsMessage, with no Edit or Resend, since its text is only a summary. */
function PinsRow({
  item,
  chatId,
  view,
  onOpenSubagent,
}: {
  readonly item: UserItem;
  readonly chatId: ChatId;
  readonly view: ChatView;
  readonly onOpenSubagent: ((call: string) => void) | undefined;
}) {
  const part = pinsPartOf(item);
  if (part === undefined) {
    return undefined;
  }
  return (
    <PinsMessage chat={chatId} turn={item.turn} mode={part.mode} pins={part.pins} attachments={item.attachments} view={view} onOpenSubagent={onOpenSubagent} />
  );
}
type TextItem = Extract<TranscriptItem, { readonly kind: 'text' }>;

/** The person's message. Edit and resend are given only to the last one while the chat is idle: an older one would branch a session that cannot branch. */
function UserRow({ item, chatId, resendable }: { readonly item: UserItem; readonly chatId: ChatId; readonly resendable: boolean }) {
  const [expanded, change] = useOpenState(chatId, `message:${item.id}`, { open: false });
  return (
    <UserMessage
      text={item.text}
      attachments={item.attachments}
      loadImage={(image) => readSentImage(chatId, image)}
      at={item.at}
      partsView={sentPartsView(item.parts)}
      copyText={sentReadableText(item.text, item.parts)}
      foldText={sentTypedText(segmentsOfSent(item.text, item.parts))}
      expanded={expanded}
      onExpandedChange={(open) => change({ open })}
      // Edit and Resend put back the message as it was typed, chips and the code they captured included.
      onEdit={resendable ? () => setDraft(chatId, (draft) => ({ ...draft, segments: segmentsOfSent(item.text, item.parts) })) : undefined}
      onResend={resendable ? () => void resendMessage(chatId, item) : undefined}
    />
  );
}

/** The agent's reply. One still arriving is drawn whole, so it does not jump as it grows. */
function AgentRow({
  item,
  chatId,
  streaming,
  answerable,
  retryPrompt,
}: {
  readonly item: TextItem;
  readonly chatId: ChatId;
  readonly streaming: boolean;
  readonly answerable: boolean;
  readonly retryPrompt: ChatView['lastPrompt'];
}) {
  const [expanded, change] = useOpenState(chatId, `message:${item.id}`, { open: false });
  return (
    <AgentMessage
      text={item.text}
      at={item.at}
      collapsible={streaming ? 'none' : 'clamp'}
      expanded={expanded}
      onExpandedChange={(open) => change({ open })}
      onQuickReply={answerable ? (reply) => void sendPrompt(chatId, reply) : undefined}
      onRetry={retryPrompt === undefined ? undefined : () => void resendMessage(chatId, retryPrompt)}
    />
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
