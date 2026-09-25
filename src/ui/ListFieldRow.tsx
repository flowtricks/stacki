import type { HTMLAttributes, MouseEventHandler, ReactNode, Ref } from 'react';
import { DragIcon, TrashIcon } from './Icons';

interface ListFieldRowProps {
  readonly children: ReactNode;
  readonly icon?: ReactNode;
  readonly grip?: ReactNode;
  readonly className?: string;
  readonly triggerClassName?: string;
  readonly rowProps?: HTMLAttributes<HTMLDivElement> & { readonly ref?: Ref<HTMLDivElement> };
  readonly expanded?: boolean;
  readonly disabled: boolean;
  readonly removeDisabled: boolean;
  readonly removeLabel: string;
  readonly onOpen: MouseEventHandler<HTMLButtonElement>;
  readonly onRemove: () => void;
}

// Property definitions and option values share one row so their sizing cannot drift apart.
export default function ListFieldRow(props: ListFieldRowProps) {
  return (
    <div {...props.rowProps} className={`list-field-row ${props.className ?? ''}`}>
      {props.grip ?? (
        <span className="list-field-grip" aria-hidden="true">
          <DragIcon size={12} />
        </span>
      )}
      <button
        type="button"
        className={`list-field-text ${props.triggerClassName ?? ''}`}
        aria-expanded={props.expanded}
        disabled={props.disabled}
        onClick={props.onOpen}
      >
        {props.icon && (
          <span className="list-field-icon" aria-hidden="true">
            {props.icon}
          </span>
        )}
        {props.children}
      </button>
      <button
        type="button"
        className="ghost list-field-remove"
        title="Remove"
        aria-label={props.removeLabel}
        disabled={props.removeDisabled}
        onClick={props.onRemove}
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}
