// The marks at the right end of a Navigator row: what the canvas reports about the node.
//
// They are STATE indicators, never buttons. There is no hide or show action on a row, so a mark
// says only what is true of the element right now, and a visible element carries none:
//   - hidden: the element is on the page with `display: none`. The slashed eye, the one icon for "hidden".
//   - renders nothing: the node put no element on the page with its current props. A dashed frame,
//     "an empty place", so it is never mistaken for a hidden element.
//   - inert: `pointer-events: none`.
// A <script>, <style> and their kin never draw anything by nature (the browser gives them
// `display: none`, and Astro hoists scripts out of the page), so a mark there only reads as a problem
// where there is none. Those rows carry no mark.

import { createPortal } from 'react-dom';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { centralIcon } from '../../ui/central/CentralIcon';
import { placeholder as centralPlaceholder } from '../../ui/central/centralGeometry';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import { HideIcon, PointerEventsNoneIcon } from '../../ui/Icons';
import type { NavigatorNode } from './structureModel';

const RendersNothingIcon = centralIcon(centralPlaceholder, 12);

// Tags that never draw on the canvas, whatever the page does.
const NEVER_RENDERED_TAGS: ReadonlySet<string> = new Set(['script', 'style', 'link', 'meta', 'title', 'base', 'template', 'noscript']);

// Node kinds that are code or notes, not markup the canvas could draw.
const NEVER_RENDERED_KINDS: ReadonlySet<string> = new Set(['raw', 'comment', 'frontmatter']);

export function drawsOnCanvas(node: NavigatorNode): boolean {
  if (NEVER_RENDERED_KINDS.has(node.kind)) {
    return false;
  }
  if (node.kind === 'element' && 'name' in node) {
    return !NEVER_RENDERED_TAGS.has(node.name.toLowerCase());
  }
  return true;
}

export interface NodeStatusProps {
  readonly node: NavigatorNode;
  readonly rendersNothing: boolean;
  readonly hidden: boolean;
  readonly inert: boolean;
}

export default function NodeStatus({ node, rendersNothing, hidden, inert }: NodeStatusProps) {
  const translate = useTranslate();
  const reportable = drawsOnCanvas(node);
  const showEmpty = reportable && rendersNothing;
  // A node that put no element on the page cannot also be a hidden one.
  const showHidden = reportable && hidden && !rendersNothing;
  const showInert = reportable && inert;
  if (!showEmpty && !showHidden && !showInert) {
    return undefined;
  }
  return (
    <span className="node-empty">
      {showEmpty && (
        <StatusMark kind="empty" text={translate('structure.status.empty')}>
          <RendersNothingIcon size={12} />
        </StatusMark>
      )}
      {showHidden && (
        <StatusMark kind="hidden" text={translate('structure.status.hidden')}>
          <HideIcon size={12} />
        </StatusMark>
      )}
      {showInert && (
        <StatusMark kind="inert" text={translate('structure.status.inert')}>
          <PointerEventsNoneIcon size={12} />
        </StatusMark>
      )}
    </span>
  );
}

function StatusMark({ kind, text, children }: { readonly kind: 'empty' | 'hidden' | 'inert'; readonly text: string; readonly children: React.ReactNode }) {
  const tooltip = useDelayedTooltip();
  return (
    <>
      <span role="img" aria-label={text} data-status={kind} onMouseEnter={tooltip.show} onMouseLeave={tooltip.hide}>
        {children}
      </span>
      {tooltip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={tooltip.value}>
            {text}
          </div>,
          tooltipHost(undefined),
        )}
    </>
  );
}
