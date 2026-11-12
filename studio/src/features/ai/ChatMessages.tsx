// The conversation. The frame, the bubbles, the running line and the file-changes card use Desktop's classes
// (transcript.css and diff.css, shared through the vendor tree) and Desktop's DiffView for each file's change, so a
// proposal reads like Desktop's "N files changed". What Desktop streams (tool calls, thinking, plans, background
// tasks) never reaches Studio: its model answers with one proposal, so the running line says it is working and how
// long, and the finished reply says how long it took.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ErrorToast } from '../../../vendor/stacki/src/ui/ErrorToast';
import { ChevronDownIcon, ChevronRightIcon } from '../../../vendor/stacki/src/ui/Icons';
import { LoaderDots } from '../../../vendor/stacki/src/ui/LoaderDots';
import { DiffView } from '../../../vendor/stacki/src/features/ai/transcript/DiffView';
import { buildFileDiff, countsLabel, countsOf, type ChangeCounts } from '../../../vendor/stacki/src/features/ai/transcript/diffModel';
import { useNow } from '../../../vendor/stacki/src/features/ai/transcript/ticker';
import '../../../vendor/stacki/src/features/ai/transcript/transcript.css';
import '../../../vendor/stacki/src/features/ai/transcript/diff.css';
import { ChatText } from './ChatText';
import { applyProposal, discardProposal } from './chatActions';
import { formatDuration } from './chatClock';
import { type ChatThread, type ChatMessage, type ChatProposal } from './chatState';

/** Studio's files are project-relative already, so a diff names them against an empty root. */
const PROJECT_ROOT = '';

export function ChatMessages({ chat, refresh }: { readonly chat: ChatThread; readonly refresh: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const [unread, setUnread] = useState(false);
  useEffect(() => {
    if (follow.current) {
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
    } else {
      setUnread(true);
    }
  }, [chat.messages, chat.status]);
  return (
    <div
      className="ai-transcript chat-transcript"
      ref={scroll}
      role="log"
      aria-label="Conversation"
      aria-live="polite"
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (follow.current) {
          setUnread(false);
        }
      }}
    >
      <div className="ai-transcript-flow">
        {chat.messages.map((message) => (
          <MessageItem key={message.id} chat={chat} message={message} refresh={refresh} />
        ))}
        {chat.status !== 'idle' && <RunningLine chat={chat} />}
        {chat.error && <ErrorToast message={chat.error} />}
      </div>
      {unread && (
        <button
          className="ai-latest"
          onClick={() => {
            scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
            follow.current = true;
            setUnread(false);
          }}
        >
          Latest response
        </button>
      )}
    </div>
  );
}

/** The line under a running request: the loader, what is happening, and the seconds counted live. */
function RunningLine({ chat }: { readonly chat: ChatThread }) {
  const now = useNow();
  const elapsed = chat.startedAt === undefined ? undefined : formatDuration(now - chat.startedAt);
  return (
    <div className="ai-turn-status">
      <LoaderDots dotPx={4} />
      <span className="ai-turn-label" role="status">
        {chat.status === 'working' ? 'Thinking through your request…' : 'Applying changes to the draft…'}
      </span>
      {elapsed !== undefined && chat.status === 'working' && (
        <span className="ai-turn-time" aria-hidden="true">
          {elapsed}
        </span>
      )}
    </div>
  );
}

function MessageItem({ chat, message, refresh }: { readonly chat: ChatThread; readonly message: ChatMessage; readonly refresh: () => void }) {
  const images = message.images.length > 0 && (
    <div className="chat-message-images">
      {message.images.map((image) => (
        <a key={image.id} href={image.url} download={image.name} title={`Download ${image.name}`}>
          <img src={image.url} alt={image.name} />
        </a>
      ))}
    </div>
  );
  if (message.role === 'user') {
    return (
      <article className="ai-message-user">
        {images}
        {message.content}
      </article>
    );
  }
  return (
    <article className="ai-message ai-message-agent">
      {images}
      {message.content && <ChatText text={message.content} />}
      {message.proposal && <ProposalCard chat={chat} message={message} proposal={message.proposal} refresh={refresh} />}
      {message.outcome && <p className="chat-outcome">{message.outcome}</p>}
      {message.durationMs !== undefined && <div className="ai-worked">Worked for {formatDuration(message.durationMs)}</div>}
    </article>
  );
}

/** The files a reply proposes to change, each opening to its diff, with Apply and Discard for the whole proposal. */
function ProposalCard({
  chat,
  message,
  proposal,
  refresh,
}: {
  readonly chat: ChatThread;
  readonly message: ChatMessage;
  readonly proposal: ChatProposal;
  readonly refresh: () => void;
}) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const counts = useMemo(() => proposal.changes.map((change) => countsOf(buildFileDiff(change.before || undefined, change.after))), [proposal.changes]);
  const total = totalOf(counts);
  const idle = chat.status === 'idle';
  return (
    <div className="ai-changes-card" aria-label="Proposed changes">
      <div className="ai-changes-card-head">
        <span className="ai-changes-card-title">
          <span>
            {proposal.changes.length} file{proposal.changes.length === 1 ? '' : 's'} to change
          </span>
          {total !== undefined && <span className="ai-changes-total">{countsLabel(total)}</span>}
        </span>
        <span className="ai-changes-bulk">
          <button disabled={!idle} onClick={() => discardProposal(chat.id, message.id)}>
            Discard
          </button>
          <button className="ai-changes-keep" disabled={!idle} onClick={() => void applyProposal(chat.id, message.id, refresh)}>
            Apply to draft
          </button>
        </span>
      </div>
      {proposal.changes.map((change, index) => {
        const isOpen = open.has(change.file);
        const slash = change.file.lastIndexOf('/');
        const fileCounts = counts[index];
        return (
          <div className={`ai-file ai-file-pending${isOpen ? ' ai-file-open' : ''}`} key={change.file}>
            <div className="ai-file-row">
              <button
                className="ai-file-toggle"
                aria-expanded={isOpen}
                title={change.file}
                onClick={() =>
                  setOpen((previous) => {
                    const next = new Set(previous);
                    if (!next.delete(change.file)) {
                      next.add(change.file);
                    }
                    return next;
                  })
                }
              >
                {isOpen ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
                <span className="ai-file-text">
                  <span className="ai-file-line">
                    <span className="ai-file-name">{change.file.slice(slash + 1)}</span>
                    {!change.before && <span className="ai-file-kind ai-file-kind-created">New</span>}
                  </span>
                  {slash >= 0 && <span className="ai-file-folder">{change.file.slice(0, slash)}</span>}
                </span>
                {fileCounts !== undefined && (
                  <span className="ai-file-counts">
                    <span className="ai-file-added">+{fileCounts.added}</span> <span className="ai-file-removed">{`−${fileCounts.removed}`}</span>
                  </span>
                )}
              </button>
            </div>
            {isOpen && (
              <div className="ai-file-body">
                <DiffView diff={{ path: change.file, oldText: change.before || undefined, newText: change.after }} projectPath={PROJECT_ROOT} header="none" />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** The sum of the counts, but only when every file has them: a total that leaves a file out would read as the whole. */
function totalOf(all: readonly (ChangeCounts | undefined)[]): ChangeCounts | undefined {
  let added = 0;
  let removed = 0;
  for (const counts of all) {
    if (counts === undefined) {
      return undefined;
    }
    added += counts.added;
    removed += counts.removed;
  }
  return { added, removed };
}
