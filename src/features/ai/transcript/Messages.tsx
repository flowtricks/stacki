// The two kinds of message in the transcript: what the person sent (a bubble) and what the agent
// answered (text blocks). Both fold behind "Show more" when long, and show a toolbar on hover (copy,
// the time, and for the last user message edit and resend).
//
// Presentational only: the transcript decides which message may be edited or resent and what those
// do (`onEdit`, `onResend`), supplies the chips of a message that had mentions (`partsView`), and may
// control the fold (`expanded`, `onExpandedChange`) so it survives the message being re-rendered.
import { useState, type ReactNode } from 'react';
import type { ChatAttachmentName } from '../../../../shared/properties/ai/chatModel';
import { CheckIcon, CopyIcon, PencilIcon, RefreshIcon } from '../../../ui/Icons';
import { ChatText } from '../ChatText';
import { useCopy, type CopyState } from './copyText';
import { exceedsClamp, fullTimeLabel, timeLabel } from './messageModel';
import './chrome.css';

/** `clamp` folds a long message behind "Show more"; `none` always shows it whole. */
export type MessageFold = 'clamp' | 'none';

interface FoldProps {
  readonly collapsible?: MessageFold | undefined;
  /** Controls the fold from outside; without it the message keeps its own. */
  readonly expanded?: boolean | undefined;
  readonly onExpandedChange?: ((expanded: boolean) => void) | undefined;
}

export function UserMessage({
  text,
  attachments,
  at,
  partsView,
  onEdit,
  onResend,
  ...fold
}: FoldProps & {
  readonly text: string;
  readonly attachments: readonly ChatAttachmentName[];
  readonly at: number | undefined;
  /** The message drawn with its mention chips; the plain `text` is what Copy gives either way. */
  readonly partsView?: ReactNode | undefined;
  /** Puts the message back in the composer to change and send again. Given only to the last user message. */
  readonly onEdit?: (() => void) | undefined;
  /** Sends the message again. Given only to the last user message. */
  readonly onResend?: (() => void) | undefined;
}) {
  const folding = useFold(text, fold);
  return (
    <div className="ai-message ai-message-user ai-msg ai-msg-user">
      <div className={`ai-user-text ai-msg-body${folding.folded ? ' ai-msg-folded' : ''}`}>{partsView ?? text}</div>
      {attachments.length > 0 && <div className="ai-message-attachments">{attachments.map((attachment) => attachment.name).join(', ')}</div>}
      <ShowMore folding={folding} />
      <MessageToolbar text={text} at={at} onEdit={onEdit} onResend={onResend} />
    </div>
  );
}

export function AgentMessage({ text, at, ...fold }: FoldProps & { readonly text: string; readonly at: number | undefined }) {
  const folding = useFold(text, fold);
  return (
    <div className="ai-message ai-message-agent ai-msg ai-msg-agent">
      <div className={`ai-msg-body${folding.folded ? ' ai-msg-folded' : ''}`}>
        <ChatText text={text} />
      </div>
      <ShowMore folding={folding} />
      <MessageToolbar text={text} at={at} onEdit={undefined} onResend={undefined} />
    </div>
  );
}

interface Folding {
  readonly long: boolean;
  readonly folded: boolean;
  readonly toggle: () => void;
}

function useFold(text: string, props: FoldProps): Folding {
  const [own, setOwn] = useState(false);
  const long = (props.collapsible ?? 'clamp') === 'clamp' && exceedsClamp(text);
  const expanded = props.expanded ?? own;
  return {
    long,
    folded: long && !expanded,
    toggle: () => {
      setOwn(!expanded);
      props.onExpandedChange?.(!expanded);
    },
  };
}

function ShowMore({ folding }: { readonly folding: Folding }) {
  if (!folding.long) {
    return undefined;
  }
  return (
    <button className="ai-msg-more" aria-expanded={!folding.folded} onClick={folding.toggle}>
      {folding.folded ? 'Show more' : 'Show less'}
    </button>
  );
}

function MessageToolbar({
  text,
  at,
  onEdit,
  onResend,
}: {
  readonly text: string;
  readonly at: number | undefined;
  readonly onEdit: (() => void) | undefined;
  readonly onResend: (() => void) | undefined;
}) {
  const { state, copy } = useCopy();
  const time = timeLabel(at);
  return (
    <div className="ai-msg-toolbar" role="toolbar" aria-label="Message actions">
      {time !== undefined && (
        <time className="ai-msg-time" dateTime={new Date(at ?? 0).toISOString()} title={fullTimeLabel(at)}>
          {time}
        </time>
      )}
      <button className="ai-msg-action" title={copyTitle(state)} aria-label="Copy message" onClick={() => copy(text)}>
        {state === 'copied' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
      </button>
      {onEdit !== undefined && (
        <button className="ai-msg-action" title="Edit and send again" aria-label="Edit message" onClick={onEdit}>
          <PencilIcon size={13} />
        </button>
      )}
      {onResend !== undefined && (
        <button className="ai-msg-action" title="Send again" aria-label="Send message again" onClick={onResend}>
          <RefreshIcon size={13} />
        </button>
      )}
    </div>
  );
}

function copyTitle(state: CopyState): string {
  switch (state) {
    case 'copied':
      return 'Copied';
    case 'failed':
      return 'Couldn’t copy';
    case 'idle':
      return 'Copy';
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
