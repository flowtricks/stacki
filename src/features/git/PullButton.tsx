// The title bar's pull button: a down arrow and the number of commits GitHub has that this project does not. Drawn
// only while there is something to pull or a pull is running, so a quiet project's bar is unchanged. The arrow and the
// spinner share one box, so starting a pull never changes the button's width.
import { useShortcutTip } from '../../ui/shortcutTip';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { PullIcon } from '../../ui/PullIcon';
import './pullButton.css';

/** Beyond this the badge says "99+", so a long-neglected branch cannot widen the bar; the tooltip keeps the number. */
export const PULL_BADGE_MAX = 99;

export interface PullButtonProps {
  readonly commits: number;
  readonly state: 'idle' | 'pulling' | 'waiting';
  readonly shortcut: string;
  readonly onPull: () => void;
}

export function PullButton({ commits, state, shortcut, onPull }: PullButtonProps) {
  const translate = useTranslate();
  const label = state === 'pulling' ? translate('git.busy.pulling') : translate('git.pull.commits', { count: commits });
  const { props, tip } = useShortcutTip(label, shortcut);
  return (
    <>
      <button
        type="button"
        {...props}
        className="stacki-pull-button"
        aria-label={label}
        aria-busy={state === 'pulling'}
        // Not `disabled`: the button keeps its look and its tooltip while a pull, or another git action, runs.
        aria-disabled={state !== 'idle'}
        onClick={() => {
          props.onMouseLeave();
          if (state === 'idle') {
            onPull();
          }
        }}
      >
        <span className="stacki-pull-mark">{state === 'pulling' ? <span className="mini-spinner" /> : <PullIcon size={12} />}</span>
        <span className="stacki-pull-count">{commits > PULL_BADGE_MAX ? `${PULL_BADGE_MAX}+` : commits}</span>
      </button>
      {tip}
    </>
  );
}
