// The empty state a panel shows when a list has nothing to list: a centred card with a Central icon in a
// soft tinted disc, a short title, one dim sentence, and at most one quiet action. One component so every
// panel's "nothing here" reads the same way; the card sits in the middle of the space it is given
// when `align="center"` (`margin-block: auto` inside a column), else it sits at the top; it uses logical properties only, so it mirrors for right-to-left.
// The caller owns every string (so each is translated where it is chosen) and the action's behaviour.
import type { ReactNode } from 'react';
import './emptyState.css';

export interface EmptyStateProps {
  /** A Central icon, already sized by the caller. Decorative: the title says what it means. */
  readonly icon: ReactNode;
  readonly title: string;
  readonly description?: string;
  /** A quiet secondary button, or nothing. */
  readonly action?: ReactNode;
  /** Where the card sits in the space it is given: the top (default) or the middle. */
  readonly align?: 'start' | 'center';
}

export function EmptyState({ icon, title, description, action, align = 'start' }: EmptyStateProps) {
  return (
    <div className={`ui-empty-state ui-empty-state-${align}`} role="status">
      <span className="ui-empty-state-icon" aria-hidden="true">
        {icon}
      </span>
      <div className="ui-empty-state-title">{title}</div>
      {description !== undefined && <p className="ui-empty-state-description">{description}</p>}
      {action !== undefined && <div className="ui-empty-state-action">{action}</div>}
    </div>
  );
}
