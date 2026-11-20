// The (i) beside "N fixes ready": what Apply will do, read from the fix plan (fixPlan.ts) that Apply itself
// writes from. Resting the pointer on it for a moment opens the list; a click or keyboard focus pins it open
// until Escape, a press elsewhere or another click, so the list can be read and its rows used. Each row names the
// audit (its icon and title), the one-line change and where it is; a click goes to the element as the audit's own
// rows do. The surface is the shared Popup, filled and borderless like the app's menus.
import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { assert } from '../../../shared/core/assert';
import type { AuditFinding } from '../../../shared/page/auditFindings';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { centralIcon } from '../../ui/central/CentralIcon';
import { info as centralInfo } from '../../ui/central/centralGeometry';
import { TOOLTIP_DELAY_MS } from '../../ui/delayedTooltip';
import { popupBox } from '../../ui/Dropdown';
import Popup from '../../ui/Popup';
import { AUDIT_ICONS } from './AuditIcons';
import type { FixPlan } from './fixPlan';
import { useAuditText } from './useAuditText';

const InfoIcon = centralIcon(centralInfo, 12);

/** The hover list lets the pointer cross the gap to it before it closes. */
const HOVER_CLOSE_MS = 150;
const POPUP_WIDTH_PX = 280;
const POPUP_EDGE_PX = 8;
/** A row's height and the popup's padding, for placing it before it is drawn (audits.css `.audits-fix-item`). */
const ROW_PX = 52;
const POPUP_PADDING_PX = 12;

type Mode = 'closed' | 'hover' | 'pinned';

export function FixesInfo(props: { readonly plan: FixPlan; readonly onGo: (finding: AuditFinding) => void }) {
  assert(props.plan.descriptions.length > 0, 'FixesInfo: there is a fix to describe');
  const translate = useTranslate();
  const [mode, setMode] = useState<Mode>('closed');
  const [box, setBox] = useState<CSSProperties | undefined>(undefined);
  const button = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const rows = props.plan.descriptions.length + (props.plan.hiddenCount > 0 ? 1 : 0);
  const place = (next: Mode): void => {
    const rect = button.current?.getBoundingClientRect();
    if (rect !== undefined) {
      const width = Math.min(POPUP_WIDTH_PX, window.innerWidth - 2 * POPUP_EDGE_PX);
      const left = Math.max(POPUP_EDGE_PX, Math.min(rect.left - 12, window.innerWidth - width - POPUP_EDGE_PX));
      setBox({ position: 'fixed', left, width, ...popupBox(rect, rows * ROW_PX + POPUP_PADDING_PX, window.innerHeight) });
    }
    setMode(next);
  };
  const later = (delayMs: number, action: () => void): void => {
    clearTimeout(timer.current);
    timer.current = setTimeout(action, delayMs);
  };
  const closeHover = (): void => {
    later(HOVER_CLOSE_MS, () => setMode((current) => (current === 'hover' ? 'closed' : current)));
  };
  return (
    <>
      <button
        ref={button}
        type="button"
        className="audits-info"
        aria-label={translate('auditsUi.fixes.info')}
        aria-haspopup="dialog"
        aria-expanded={mode !== 'closed'}
        onMouseEnter={() => mode === 'closed' && later(TOOLTIP_DELAY_MS, () => place('hover'))}
        onMouseLeave={() => (mode === 'hover' ? closeHover() : clearTimeout(timer.current))}
        // Keyboard focus pins at once; a click's own focus must not, or the click would close it again.
        onFocus={(event) => event.currentTarget.matches(':focus-visible') && place('pinned')}
        onClick={() => {
          clearTimeout(timer.current);
          if (mode === 'pinned') {
            setMode('closed');
          } else {
            place('pinned');
          }
        }}
      >
        <InfoIcon />
      </button>
      {box !== undefined && (
        <FixList
          open={mode !== 'closed'}
          anchor={button.current ?? undefined}
          box={box}
          plan={props.plan}
          onEnter={() => clearTimeout(timer.current)}
          onLeave={() => mode === 'hover' && closeHover()}
          onClose={() => setMode('closed')}
          onGo={(finding) => {
            setMode('closed');
            props.onGo(finding);
          }}
        />
      )}
    </>
  );
}

function FixList(props: {
  readonly open: boolean;
  readonly anchor: HTMLElement | undefined;
  readonly box: CSSProperties;
  readonly plan: FixPlan;
  readonly onEnter: () => void;
  readonly onLeave: () => void;
  readonly onClose: () => void;
  readonly onGo: (finding: AuditFinding) => void;
}) {
  const translate = useTranslate();
  const auditText = useAuditText();
  const { plan } = props;
  const count = plan.descriptions.length + plan.hiddenCount;
  const [first] = plan.findings.slice(plan.descriptions.length);
  return (
    <Popup
      mode="popover"
      open={props.open}
      anchor={props.anchor}
      within={props.anchor}
      onClose={props.onClose}
      className="more-menu audits-fixes"
      role="dialog"
      label={translate('auditsUi.fixes.title', { count })}
      style={props.box}
      onMouseEnter={props.onEnter}
      onMouseLeave={props.onLeave}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <p className="audits-fixes-title">{translate('auditsUi.fixes.title', { count })}</p>
      {plan.descriptions.map((description) => {
        const Icon = AUDIT_ICONS[description.check];
        const where = [
          description.file,
          description.element === undefined ? undefined : description.element.tag,
          description.element?.line === undefined ? undefined : translate('auditsUi.fixes.line', { line: description.element.line }),
        ]
          .filter((part) => part !== undefined)
          .join(' · ');
        const change = `${description.change.before.length > 0 ? description.change.before : '∅'} → ${description.change.after.length > 0 ? description.change.after : '∅'}`;
        return (
          <button key={description.id} type="button" className="audits-fix-item" onClick={() => props.onGo(description.finding)}>
            <span className="audits-fix-icon">
              <Icon size={14} />
            </span>
            <span className="audits-fix-text">
              <span className="audits-fix-name" title={auditText.checkTitle(description.check)}>
                {auditText.checkTitle(description.check)}
              </span>
              <span className="audits-fix-change" title={change}>
                {change}
              </span>
              <span className="audits-fix-where" title={where}>
                {where}
              </span>
            </span>
          </button>
        );
      })}
      {plan.hiddenCount > 0 && first !== undefined && (
        <button type="button" className="audits-fix-more" onClick={() => props.onGo(first)}>
          {translate('auditsUi.fixes.more', { count: plan.hiddenCount })}
        </button>
      )}
    </Popup>
  );
}
