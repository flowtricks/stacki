// A sent pin's live line in the pin list: a status mark, what is happening on it in a designer's words ("Editing
// Hero.astro"), and the time it has taken. It is the AI panel's agents list, one agent at a time: the same marks,
// words and clock (transcript/SubagentStrip.tsx) read from the same transcript (subagents.ts), so the two never
// disagree. Which work is the pin's is pinModel.ts pinWork: its own subagent, never another pin's; or the reply
// itself when that reply works on this pin alone (one message a pin, a send of one, an answer to its question).
// A time shows only while the pin is at work. The line is one line high whatever it says, so rows never jump.
import { createPortal } from 'react-dom';
import { useTranslate } from '../../../lib/i18n/useTranslate';
import type { Translator } from '../../../lib/i18n/localeContext';
import { tooltipHost, useDelayedTooltip } from '../../../ui/delayedTooltip';
import FittedTooltip from '../../../ui/FittedTooltip';
import type { ChatView } from '../chatReducer';
import { activityText, statusLine, SubagentDot, SubagentTime } from '../transcript/SubagentStrip';
import type { SubagentStatus } from '../subagents';
import { pinWork, type PinProgress } from './pinModel';
import { progressLabel, progressTip } from './PinProgressPill';
import type { CommentPin } from '../../../../shared/properties/ai/commentPins';
import '../transcript/transcript.css';

/** What the line draws: the mark's state, the words, and the status whose clock runs (absent: no time). */
export interface PinLine {
  readonly mark: SubagentStatus;
  readonly words: string;
  readonly timed: SubagentStatus | undefined;
}

const STILL = { durationMs: undefined } as const;

/** The line for a pin that is not a draft, from how it stands and the transcript of its chat (undefined: not read here). */
export function pinLine(pin: Pick<CommentPin, 'number' | 'delivery'>, progress: PinProgress, view: ChatView | undefined, translate: Translator): PinLine {
  const said = progressLabel(progress, translate);
  const still = (mark: SubagentStatus, words: string = said): PinLine => ({ mark, words, timed: undefined });
  switch (progress.kind) {
    case 'working':
      return atWork(pin, view, translate);
    case 'attention':
      if (progress.reason === 'question') {
        return still({ kind: 'waiting', startedAt: undefined }, progress.question.question);
      }
      return atWork(pin, view, translate);
    case 'done':
      return still({ kind: 'done', ...STILL });
    case 'unfinished':
      return still(progress.reason === 'failed' ? { kind: 'failed', ...STILL } : { kind: 'stopped', ...STILL });
    case 'draft':
    case 'queued':
      return still({ kind: 'queued', startedAt: undefined });
    case 'unreported':
    case 'sent':
      return still({ kind: 'unreported' });
    default: {
      const exhaustive: never = progress;
      return exhaustive;
    }
  }
}

function atWork(pin: Pick<CommentPin, 'number' | 'delivery'>, view: ChatView | undefined, translate: Translator): PinLine {
  const work = view === undefined ? undefined : pinWork(pin, view);
  if (work?.kind === 'subagent') {
    const { agent } = work;
    return { mark: agent.status, words: statusLine(agent, translate), timed: agent.status };
  }
  if (work?.kind === 'reply' && work.activity.kind !== 'starting') {
    const running: SubagentStatus = { kind: 'running', startedAt: work.startedAt, end: 'own' };
    return { mark: running, words: activityText(work.activity, translate), timed: running };
  }
  // Nothing of the pin's own has happened yet: a quiet start, with no clock to suggest work.
  return { mark: { kind: 'queued', startedAt: undefined }, words: activityText({ kind: 'starting' }, translate), timed: undefined };
}

export function PinLiveLine({ pin, progress, view }: { readonly pin: CommentPin; readonly progress: PinProgress; readonly view: ChatView | undefined }) {
  const translate = useTranslate();
  const tip = useDelayedTooltip();
  const line = pinLine(pin, progress, view, translate);
  const detail = progress.kind === 'working' ? line.words : progressTip(progress, translate);
  return (
    <>
      <span className={`ai-pin-live is-${progress.kind}`} onMouseEnter={tip.show} onMouseLeave={tip.hide}>
        <SubagentDot status={line.mark} />
        <span className="ai-pin-live-words">{line.words}</span>
        <span className="ai-pin-live-time">{line.timed === undefined ? undefined : <SubagentTime status={line.timed} />}</span>
      </span>
      {tip.value !== undefined &&
        createPortal(
          <FittedTooltip role="tooltip" anchor={tip.value}>
            {detail}
          </FittedTooltip>,
          tooltipHost(undefined),
        )}
    </>
  );
}
