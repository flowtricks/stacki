// A shared reset menu keeps field labels consistent across props and content editors.
import React, { useEffect, useRef, useState } from 'react';
import { CornerIcon, ResetIcon } from './Icons';

export interface ResetMenuProps {
  readonly position: { readonly left: number; readonly top: number };
  readonly onReset: () => void;
  readonly resetLabel?: string;
  readonly onUnbind?: (() => void) | undefined;
  readonly unbindLabel: string;
  readonly onClose: () => void;
}
export function ResetLabel(props: { readonly label: React.ReactNode; readonly active: boolean; readonly onReset: () => void }) {
  const [position, setPosition] = useState<ResetMenuProps['position']>();
  const reset = () => {
    setPosition(undefined);
    props.onReset();
  };
  return (
    <>
      <span
        className={`prop-label${props.active ? ' set' : ''}`}
        role={props.active ? 'button' : undefined}
        tabIndex={props.active ? 0 : undefined}
        title={props.active ? 'Click for Reset. ⌥-click to clear value.' : undefined}
        onClick={(event) => {
          event.preventDefault();
          if (!props.active) {
            return;
          }
          if (event.altKey) {
            reset();
          } else {
            const bounds = event.currentTarget.getBoundingClientRect();
            setPosition({ left: bounds.left, top: bounds.bottom + 4 });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.currentTarget.click();
          }
        }}
      >
        {props.label}
      </span>
      {props.active && position && <ResetMenu position={position} onReset={reset} resetLabel="Reset" unbindLabel="" onClose={() => setPosition(undefined)} />}
    </>
  );
}

export function ResetMenu({ position, onReset, resetLabel = 'Reset to default property value', onUnbind, unbindLabel, onClose }: ResetMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDown = (event: MouseEvent) => {
      if (ref.current && !(event.target instanceof window.Node && ref.current.contains(event.target))) {
        onClose();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    const onScroll = (event: Event) => {
      if (ref.current && event.target instanceof window.Node && ref.current.contains(event.target)) {
        return;
      }
      onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onClose);
    };
  }, [onClose]);

  return (
    <div ref={ref} className="prop-menu" style={{ left: position.left, top: position.top }}>
      {onUnbind && (
        <div className="prop-menu-item" onClick={onUnbind}>
          <CornerIcon size={12} />
          {unbindLabel}
        </div>
      )}
      <div className="prop-menu-item" onClick={onReset}>
        <ResetIcon size={12} />
        {resetLabel}
      </div>
    </div>
  );
}
