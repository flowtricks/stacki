// The in-place name field a chat row, a section header and the open chat's title turn into while renaming.
// Enter commits, Escape cancels, leaving the field commits too. A name that is empty or unchanged cancels
// quietly; one longer than the limit is refused and the field stays, since the person can still shorten it.
// A commit happens at most once: Enter closes the field, which would otherwise blur it and commit again.
import { useRef } from 'react';
import { checkName } from './sessionsModel';

export interface RenameFieldProps {
  readonly initial: string;
  readonly limit: number;
  /** The accessible name ("Chat name", "Section name"). */
  readonly label: string;
  readonly className?: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
}

export function RenameField({ initial, limit, label, className, onCommit, onCancel }: RenameFieldProps) {
  const focused = useRef(false);
  const finished = useRef(false);
  const finish = (value: string, reason: 'enter' | 'blur'): void => {
    if (finished.current) {
      return;
    }
    const check = checkName(value, limit);
    if (check.kind === 'too-long') {
      if (reason === 'blur') {
        finished.current = true;
        onCancel();
      }
      return;
    }
    finished.current = true;
    if (check.kind === 'ok' && check.name !== initial) {
      onCommit(check.name);
    } else {
      onCancel();
    }
  };
  return (
    <input
      ref={(element) => {
        // Once, when the field first mounts: focus it with the whole name selected, ready to type over.
        if (element !== null && !focused.current) {
          focused.current = true;
          element.focus();
          element.select();
        }
      }}
      className={`ai-rename${className === undefined ? '' : ` ${className}`}`}
      aria-label={label}
      defaultValue={initial}
      maxLength={limit}
      spellCheck={false}
      onBlur={(event) => finish(event.currentTarget.value, 'blur')}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        // Keys belong to the field: a letter must not reach a row's shortcut, an arrow must not move a drag.
        event.stopPropagation();
        if (event.nativeEvent.isComposing) {
          return;
        }
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value, 'enter');
        } else if (event.key === 'Escape') {
          event.preventDefault();
          if (!finished.current) {
            finished.current = true;
            onCancel();
          }
        }
      }}
    />
  );
}
