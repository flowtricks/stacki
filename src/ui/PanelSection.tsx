// A collapsible section of a side panel: a small uppercase heading with its count and a chevron, header
// actions that appear on hover or focus, and a body of rows. Settings draws every one of its sections
// (Secrets, MCP servers, Skills, Rules, Docs) through this, so they look and fold the same; the rows and
// the empty line are the caller's. Sections are set apart by spacing, never by a border or a divider.
import type { ReactNode } from 'react';
import { ChevronDownIcon, ChevronRightIcon } from './Icons';
import './panelSection.css';

export interface PanelSectionProps {
  /** A stable name for the section, kept on the element so a request can scroll to it. */
  readonly id: string;
  readonly title: string;
  readonly count: number;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly actions?: ReactNode;
  readonly children: ReactNode;
}

export function PanelSection({ id, title, count, open, onToggle, actions, children }: PanelSectionProps) {
  return (
    <section className="panel-block" data-panel-section={id} aria-label={title}>
      <div className="panel-block-head">
        <button type="button" className="panel-block-toggle" aria-expanded={open} onClick={onToggle}>
          <span className="panel-block-chevron">{open ? <ChevronDownIcon size={10} /> : <ChevronRightIcon size={10} />}</span>
          <span className="panel-block-title">{title}</span>
          {count > 0 && <span className="panel-block-count">{count}</span>}
        </button>
        <div className="panel-block-actions">{actions}</div>
      </div>
      {open && (
        <div className="panel-block-body" role="tree" aria-label={title}>
          {children}
        </div>
      )}
    </section>
  );
}

/** A section header's icon button. */
export function PanelSectionAction({ label, icon, onClick }: { readonly label: string; readonly icon: ReactNode; readonly onClick: () => void }) {
  return (
    <button type="button" className="ghost" title={label} aria-label={label} onClick={onClick}>
      {icon}
    </button>
  );
}

/** The one line a section shows when it has nothing, or a note under its rows. */
export function PanelSectionNote({ children, role }: { readonly children: ReactNode; readonly role?: 'alert' | 'status' }) {
  return (
    <div className="panel-block-note" role={role}>
      {children}
    </div>
  );
}
