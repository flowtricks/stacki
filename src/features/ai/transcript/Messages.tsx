// The two kinds of message in the transcript: what the person sent (a bubble) and what the agent
// answered (text blocks). Both fold behind "Show more" when long, and show a toolbar in a row below the bubble on hover (the time, copy, for the last user message edit and resend, and for the agent's last reply retry).
//
// Presentational only: the transcript decides which message may be edited or resent and what those
// do (`onEdit`, `onResend`, `onRetry`), supplies the chips of a message that had mentions (`partsView`), and may
// control the fold (`expanded`, `onExpandedChange`) so it survives the message being re-rendered.
import { useState, type ReactNode } from 'react';
import type { ChatAttachmentName } from '../../../../shared/properties/ai/chatModel';
import type { Translator } from '../../../lib/i18n/localeContext';
import { useFormat, useTranslate } from '../../../lib/i18n/useTranslate';
import { CheckIcon, CopyIcon, PencilIcon, RefreshIcon } from '../../../ui/Icons';
import { ChatText } from '../ChatText';
import { useCopy, type CopyState } from '../../../ui/copyText';
import { SentAttachments } from './SentAttachments';
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
      <div className="ai-msg-bubble">
        <div className={`ai-user-text ai-msg-body${folding.folded ? ' ai-msg-folded' : ''}`}>{partsView ?? text}</div>
        <SentAttachments attachments={attachments} />
        <ShowMore folding={folding} />
      </div>
      {/* The actions sit below the bubble, never on its edge, so they cannot overlap or clip the text. */}
      <MessageToolbar text={text} at={at} onEdit={onEdit} onResend={onResend} onRetry={undefined} />
    </div>
  );
}

export function AgentMessage({
  text,
  at,
  onQuickReply,
  onRetry,
  ...fold
}: FoldProps & {
  readonly text: string;
  readonly at: number | undefined;
  /** Sends one of the agent's numbered options as the person's reply. Given only to the reply that may still be answered. */
  readonly onQuickReply?: ((reply: string) => void) | undefined;
  /** Asks the agent again with the prompt this reply answered. Given only to the last reply of a turn that ended normally. */
  readonly onRetry?: (() => void) | undefined;
}) {
  const folding = useFold(text, fold);
  return (
    <div className="ai-message ai-message-agent ai-msg ai-msg-agent">
      <div className={`ai-msg-body${folding.folded ? ' ai-msg-folded' : ''}`}>
        <ChatText text={text} onQuickReply={onQuickReply} />
      </div>
      <ShowMore folding={folding} />
      <MessageToolbar text={text} at={at} onEdit={undefined} onResend={undefined} onRetry={onRetry} />
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
  const translate = useTranslate();
  if (!folding.long) {
    return undefined;
  }
  return (
    <button className="ai-msg-more" aria-expanded={!folding.folded} onClick={folding.toggle}>
      {folding.folded ? translate('ai.message.showMore') : translate('ai.message.showLess')}
    </button>
  );
}

function MessageToolbar({
  text,
  at,
  onEdit,
  onResend,
  onRetry,
}: {
  readonly text: string;
  readonly at: number | undefined;
  readonly onEdit: (() => void) | undefined;
  readonly onResend: (() => void) | undefined;
  readonly onRetry: (() => void) | undefined;
}) {
  const translate = useTranslate();
  const { formatDate } = useFormat();
  const { state, copy } = useCopy();
  const time = timeLabel(at, formatDate);
  return (
    <div className="ai-msg-toolbar" role="toolbar" aria-label={translate('ai.message.actions')}>
      {time !== undefined && (
        <time className="ai-msg-time" dateTime={new Date(at ?? 0).toISOString()} title={fullTimeLabel(at, formatDate)}>
          {time}
        </time>
      )}
      <button className="ai-msg-action" title={copyTitle(state, translate)} aria-label={translate('ai.message.copy')} onClick={() => copy(text)}>
        {state === 'copied' ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
      </button>
      {onEdit !== undefined && (
        <button className="ai-msg-action" title={translate('ai.message.editTitle')} aria-label={translate('ai.message.edit')} onClick={onEdit}>
          <PencilIcon size={14} />
        </button>
      )}
      {onResend !== undefined && (
        <button className="ai-msg-action" title={translate('ai.message.resendTitle')} aria-label={translate('ai.message.resend')} onClick={onResend}>
          <RefreshIcon size={14} />
        </button>
      )}
      {onRetry !== undefined && (
        <button className="ai-msg-action" title={translate('ai.message.retryTitle')} aria-label={translate('ai.message.retry')} onClick={onRetry}>
          <RefreshIcon size={14} />
        </button>
      )}
    </div>
  );
}

function copyTitle(state: CopyState, translate: Translator): string {
  switch (state) {
    case 'copied':
      return translate('ai.common.copied');
    case 'failed':
      return translate('ai.common.copyFailed');
    case 'idle':
      return translate('ai.message.copy');
    default: {
      const exhaustive: never = state;
      return exhaustive;
    }
  }
}
