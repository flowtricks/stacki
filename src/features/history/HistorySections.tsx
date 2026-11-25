import React from 'react';
import { ChevronDownIcon, ChevronRightIcon } from '../../ui/Icons';

export function HistorySection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  readonly title: string;
  readonly count?: number | undefined;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <div className={`history-section ${open ? 'open' : ''}`}>
      <button className="history-section-head" onClick={onToggle} aria-expanded={open}>
        <span className="history-section-title">{title}</span>
        {count !== undefined && <span className="history-section-count">{count}</span>}
        {/* The chevron ends the row, as the Style panel's section headers place it,
            so every collapsible header in the app opens and closes from the same edge. */}
        <span className="history-section-chevron" aria-hidden="true">
          {open ? <ChevronDownIcon size={12} /> : <ChevronRightIcon size={12} />}
        </span>
      </button>
      {open && children}
    </div>
  );
}
