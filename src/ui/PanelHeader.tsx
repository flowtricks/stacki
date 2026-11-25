// The heading row every side panel starts with: a title at the left (behind an optional back chevron) and
// the panel's actions at the right edge. One component and one set of tokens (panelHeader.css) so that Git,
// Settings, Navigator and every other panel put their title at the same x, centre it at the same y inside
// the same row height, end their actions at the same right inset and hand the content below the same top.
// A panel passes content, never layout: there is no prop for padding, height or alignment.
import { useContext, type ReactNode } from 'react';
import { ChevronLeftIcon } from './Icons';
import { PanelBackContext } from './panelBack';
import './panelHeader.css';

export interface PanelHeaderBack {
  /** Names the chevron for the tooltip and for screen readers. */
  readonly label: string;
  readonly onBack: () => void;
}

export interface PanelHeaderProps {
  /** The heading's content: plain text, or the text with a count pill, or a source switcher. */
  readonly title: ReactNode;
  /** A tooltip for the heading (a long name that is cut with an ellipsis carries its full wording). */
  readonly titleHint?: string | undefined;
  /** Extra class names for the heading element, for a panel whose heading holds a control. */
  readonly titleClassName?: string | undefined;
  /** Present on a detail view: the chevron that returns to the panel's list. Absent, the header inherits one (panelBack.ts). */
  readonly back?: PanelHeaderBack | undefined;
  /** Content between the chevron and the title, such as a connection's logo. */
  readonly lead?: ReactNode;
  /** The header's buttons, drawn flush with the right inset in the order given. */
  readonly actions?: ReactNode;
  /** Extra class names for the row, for a panel's own hook (never for geometry). */
  readonly className?: string | undefined;
}

export function PanelHeader({ title, titleHint, titleClassName, back: ownBack, lead, actions, className }: PanelHeaderProps) {
  // A panel opened from somewhere that leads back (a Settings row, panelBack.ts) inherits that chevron.
  const inherited = useContext(PanelBackContext);
  const back = ownBack ?? inherited;
  return (
    <div className={className === undefined ? 'panel-header' : `panel-header ${className}`}>
      <div className="panel-header-lead">
        {back !== undefined && (
          <button type="button" className="ghost panel-header-back" title={back.label} aria-label={back.label} onClick={back.onBack}>
            <ChevronLeftIcon size={14} className="icon-mirror-rtl" />
          </button>
        )}
        {lead}
        <h2 className={titleClassName} title={titleHint}>
          {title}
        </h2>
      </div>
      {actions ? <div className="panel-header-actions">{actions}</div> : undefined}
    </div>
  );
}
