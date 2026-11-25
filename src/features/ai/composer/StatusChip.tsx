// The quiet buttons of the status line (model, mode): text on no fill until hovered or open, the way
// Claude's desktop composer draws them. The chip only draws; the menu it opens is the caller's.
import type { ReactNode, RefCallback } from 'react';

export function StatusChip({
  buttonRef,
  open,
  disabled,
  tone,
  ariaLabel,
  title,
  onClick,
  children,
}: {
  readonly buttonRef: RefCallback<HTMLElement>;
  readonly open: boolean;
  readonly disabled: boolean;
  /** `danger` tints the chip for a mode that asks for nothing. */
  readonly tone: 'plain' | 'danger';
  readonly ariaLabel: string;
  readonly title: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  const classes = ['ai-chip'];
  if (open) {
    classes.push('is-open');
  }
  if (tone === 'danger') {
    classes.push('is-danger');
  }
  return (
    <button
      ref={buttonRef}
      type="button"
      className={classes.join(' ')}
      aria-label={ariaLabel}
      aria-haspopup="menu"
      aria-expanded={open}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
