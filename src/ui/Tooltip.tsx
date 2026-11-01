import { useId, useState } from 'react';
import Popup from './Popup';

type TooltipState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'open' | 'closed';
      readonly left: number;
      readonly top: number;
    };

// Retain the last placement during exit so the tooltip fades where it was opened.
export default function Tooltip({ text, className }: { readonly text: string; readonly className?: string }) {
  const id = useId();
  const [state, setState] = useState<TooltipState>({ kind: 'idle' });
  const close = () => setState((previous) => (previous.kind === 'idle' ? previous : { ...previous, kind: 'closed' }));
  return (
    <>
      <span
        className={className}
        aria-describedby={state.kind === 'open' ? id : undefined}
        onMouseEnter={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          setState({
            kind: 'open',
            left: Math.max(8, Math.min(bounds.left, window.innerWidth - 368)),
            top: Math.min(bounds.bottom + 8, window.innerHeight - 160),
          });
        }}
        onMouseLeave={close}
      >
        {text}
      </span>
      {state.kind !== 'idle' && (
        <Popup
          mode="popover"
          role="tooltip"
          id={id}
          open={state.kind === 'open'}
          dismissible={false}
          onClose={close}
          className="popup-tooltip"
          style={{ position: 'fixed', left: state.left, top: state.top }}
        >
          {text}
        </Popup>
      )}
    </>
  );
}
