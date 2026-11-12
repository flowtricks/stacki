// The agent's plan as a checklist card: one line (done of total, and the step in hand) that opens to
// every step with its live status. A step in progress shows the loader, a finished one a check, one
// not started a quiet ring. The line is pinned above the transcript while a plan exists.
import { memo, useId } from 'react';
import { assert } from '../../../../shared/core/assert';
import { LoaderDots } from '../../../ui/LoaderDots';
import { CheckIcon, ChevronDownIcon, ChevronRightIcon } from '../../../ui/Icons';
import type { ChatView } from '../chatReducer';
import { useOpenState } from './transcriptUi';

export interface PlanCardProps {
  readonly plan: NonNullable<ChatView['plan']>;
  /** The chat the plan belongs to, so the card remembers whether the person opened it; absent keeps it closed on each mount. */
  readonly chat?: string;
}

export const PlanCard = memo(function PlanCard({ plan, chat }: PlanCardProps) {
  const [open, change] = useOpenState(chat ?? '', 'plan', { open: false });
  const bodyId = useId();
  const done = plan.entries.filter((entry) => entry.status === 'completed').length;
  const current = plan.entries.find((entry) => entry.status === 'in_progress') ?? plan.entries.find((entry) => entry.status === 'pending');
  assert(done <= plan.entries.length, 'PlanCard: done is part of the plan');
  return (
    <div className="ai-plan">
      <button className="ai-plan-head" aria-expanded={open} aria-controls={open ? bodyId : undefined} onClick={() => change({ open: !open })}>
        {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        <span className="ai-plan-count">
          {done}/{plan.entries.length}
        </span>
        <span className="ai-plan-current">{current?.content ?? 'Plan complete'}</span>
      </button>
      {open && (
        <ol className="ai-plan-entries" id={bodyId}>
          {plan.entries.map((entry, index) => (
            <li key={index} className={`ai-plan-${entry.status}`}>
              <span className="ai-plan-mark">
                {entry.status === 'completed' ? (
                  <CheckIcon size={12} />
                ) : entry.status === 'in_progress' ? (
                  <LoaderDots dotPx={3} />
                ) : (
                  <span className="ai-plan-dot" />
                )}
              </span>
              <span className="ai-plan-text">{entry.content}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
});
