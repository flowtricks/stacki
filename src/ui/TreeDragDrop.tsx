import React, { forwardRef, useEffect, useRef } from 'react';
import { ChevronDownIcon, ChevronRightIcon, DragIcon } from './Icons';
import { DropLine } from './DropLine';

export interface TreeDropBehavior {
  readonly active: boolean;
  readonly accepts: (event: React.DragEvent<HTMLDivElement>) => boolean;
  readonly enter: (event: React.DragEvent<HTMLDivElement>) => void;
  readonly drop: (event: React.DragEvent<HTMLDivElement>) => void;
}

type RowProps = Omit<React.HTMLAttributes<HTMLDivElement>, 'onDragOver' | 'onDrop'> & {
  readonly dropBehavior?: TreeDropBehavior;
};

// Both trees delegate native drag arbitration here so nested targets cannot handle one drop twice.
export const TreeDragRow = forwardRef<HTMLDivElement, RowProps>(function TreeDragRow({ dropBehavior, className, style, ...props }, ref) {
  return (
    <div
      {...props}
      ref={ref}
      className={`tree-drag-row ${className ?? ''}`}
      style={{
        ...style,
        ...(dropBehavior?.active ? { borderColor: 'var(--accent)', background: 'var(--accent-soft)' } : {}),
      }}
      {...treeDropHandlers(dropBehavior)}
    />
  );
});

export function TreeDropGap({
  depth,
  parent,
  index,
  behavior,
  layout = 'spaced',
  interactive = true,
}: {
  readonly depth: number;
  readonly parent: string | undefined;
  readonly index: number;
  readonly behavior: TreeDropBehavior;
  readonly layout?: 'spaced' | 'overlay';
  readonly interactive?: boolean;
}) {
  return (
    <div
      className={`nav-gap ${layout === 'overlay' ? 'nav-gap-overlay' : ''}`}
      data-drop-parent={parent ?? ''}
      data-drop-index={index}
      style={{ marginLeft: depth * 16, pointerEvents: interactive ? undefined : 'none' }}
      {...treeDropHandlers(behavior)}
    >
      {behavior.active && <DropLine />}
    </div>
  );
}

export function TreeDragHandle({ expansion }: { readonly expansion?: { readonly collapsed: boolean; readonly toggle: () => void } }) {
  return (
    <span
      className="drag-handle"
      style={expansion ? { cursor: 'pointer', opacity: 1 } : undefined}
      onClick={
        expansion
          ? (event) => {
              event.stopPropagation();
              expansion.toggle();
            }
          : undefined
      }
    >
      {expansion ? expansion.collapsed ? <ChevronRightIcon size={10} /> : <ChevronDownIcon size={10} /> : <DragIcon size={11} />}
    </span>
  );
}

function treeDropHandlers(behavior: TreeDropBehavior | undefined) {
  const handle = (event: React.DragEvent<HTMLDivElement>, kind: 'enter' | 'drop') => {
    if (behavior?.accepts(event)) {
      event.preventDefault();
      event.stopPropagation();
      behavior[kind](event);
    }
  };
  return {
    onDragOver: (event: React.DragEvent<HTMLDivElement>) => handle(event, 'enter'),
    onDrop: (event: React.DragEvent<HTMLDivElement>) => handle(event, 'drop'),
  };
}

// A drag may end outside either tree; one shared window lifecycle clears both indicators.
export function useTreeDragCleanup(clear: () => void): void {
  const latest = useRef(clear);
  latest.current = clear;
  useEffect(() => {
    const finish = () => latest.current();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        finish();
      }
    };
    window.addEventListener('dragend', finish);
    window.addEventListener('drop', finish);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('dragend', finish);
      window.removeEventListener('drop', finish);
      window.removeEventListener('keydown', onKey);
    };
  }, []);
}
