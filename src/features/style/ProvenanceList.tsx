import { centralIcon } from '../../ui/central/CentralIcon';
import { code as centralCode } from '../../ui/central/centralGeometry';
import { createContext, useContext } from 'react';
import { createPortal } from 'react-dom';
import { tooltipHost, useDelayedTooltip } from '../../ui/delayedTooltip';
import type { Contributor } from './model/resolved';
import { withImportant } from './model/styleDisplay';
import { useTranslate } from '../../lib/i18n/useTranslate';

// Lets any ProvenanceList rendered under it name a contributor's source embed
// (its full label, like "Global Styles #1") and select it on the Webflow canvas —
// without threading callbacks through every property row / label menu / popover.
const WEBFLOW_BRAND = 'Webflow'; // i18n-ignore: a product name.

export type EmbedNav = {
  open: (embedKey: string) => void;
  labelFor: (embedKey: string) => string;
};
export const ProvenanceEmbedNav = createContext<EmbedNav | undefined>(undefined);

// A little `</>` glyph, echoing the embed chip in the source dropdown.
const EmbedGlyph = centralIcon(centralCode, 12);

// The shared "which selectors set this property and which one won" list — the body
// of the orange provenance popover, reused inside the Spacing editor and every
// property label's menu so any property can show its cascade on click.
//
// When `onSelect` is provided, each row is a clickable line that jumps the panel's
// pick to that selector (and focuses `prop`'s field). A value coming from an embed
// shows that embed as a chip (clicking it selects the embed on the canvas); a
// native (Webflow class) value shows a plain "Webflow" tag.
export default function ProvenanceList({
  contributors,
  prop,
  onSelect,
}: {
  contributors: Contributor[];
  prop?: string;
  onSelect?: (selectorText: string, prop?: string) => void;
}) {
  const nav = useContext(ProvenanceEmbedNav);
  if (!contributors.length) {
    return undefined;
  }
  // Emphasize the row you're editing (the picked selector's value); with nothing
  // being edited (e.g. an orange property's popover) fall back to the winner.
  const editingIndex = contributors.findIndex((contributor) => contributor.editing);
  const activeIndex = editingIndex >= 0 ? editingIndex : contributors.findIndex((contributor) => contributor.winning);
  return (
    <ul className="embed-editor_provenance-list">
      {contributors.map((contributor, index) => (
        <ProvenanceItem
          key={index}
          contributor={contributor}
          active={index === activeIndex}
          winner={contributors.find((candidate) => candidate.winning)}
          nav={nav}
          prop={prop}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

// What a dimmed row says on hover: which declaration took its place, and the step at which this one lost.
function lossTip(contributor: Contributor, winner: Contributor | undefined, translate: ReturnType<typeof useTranslate>): string | undefined {
  if (contributor.origin === 'browser') {
    return translate('style.provenanceList.usedValueTip');
  }
  if (contributor.lossReason === undefined) {
    return undefined;
  }
  const selector = winner === undefined ? '' : (winner.display ?? winner.selectorText);
  return translate(`style.provenanceList.loss.${contributor.lossReason}`, { selector });
}

function ProvenanceItem({
  contributor,
  active,
  winner,
  nav,
  prop,
  onSelect,
}: {
  readonly contributor: Contributor;
  readonly active: boolean;
  readonly winner: Contributor | undefined;
  readonly nav: EmbedNav | undefined;
  readonly prop: string | undefined;
  readonly onSelect: ((selectorText: string, prop?: string) => void) | undefined;
}) {
  const translate = useTranslate();
  const tooltip = useDelayedTooltip();
  const className = `embed-editor_provenance-item ${active ? 'is-active' : ''}`;
  const rawValue = withImportant(contributor);
  const tip = lossTip(contributor, winner, translate);
  const browserLabel =
    contributor.display === undefined
      ? translate('style.provenanceList.usedValue')
      : translate('style.provenanceList.usedValueIn', { condition: contributor.display });
  const body = (
    <>
      <ProvenanceOrigin contributor={contributor} nav={nav} />
      <div className="embed-editor_provenance-line">
        {contributor.origin === 'browser' ? (
          <span className="embed-editor_provenance-sel">{browserLabel}</span>
        ) : (
          <code className="embed-editor_provenance-sel">{contributor.display ?? contributor.selectorText}</code>
        )}
        <span className="embed-editor_provenance-val" title={rawValue}>
          {rawValue}
        </span>
      </div>
    </>
  );
  // The row for the selector you're already editing isn't a navigation target, and a used value has no selector to jump to.
  const select = contributor.editing || contributor.origin === 'browser' ? undefined : onSelect;
  return (
    <li onMouseEnter={tip === undefined ? undefined : tooltip.show} onMouseLeave={tooltip.hide}>
      {select ? (
        <button
          type="button"
          className={`${className} is-clickable`}
          {...(tip === undefined ? { title: translate('style.provenanceList.edit', { selector: contributor.selectorText }) } : {})}
          onClick={() => select(contributor.selectorText, prop)}
        >
          {body}
        </button>
      ) : (
        <div className={className}>{body}</div>
      )}
      {tip !== undefined &&
        tooltip.value !== undefined &&
        createPortal(
          <div className="rail-tooltip below" role="tooltip" style={tooltip.value}>
            {tip}
          </div>,
          tooltipHost(undefined),
        )}
    </li>
  );
}

// Where a contributor's value comes from: a plain "Webflow" tag for a native
// class, or the source embed as a chip that selects it on the canvas.
function ProvenanceOrigin({ contributor, nav }: { contributor: Contributor; nav: EmbedNav | undefined }) {
  const translate = useTranslate();
  if (contributor.origin === 'native') {
    return <span className="embed-editor_provenance-origin">{WEBFLOW_BRAND}</span>;
  }
  if (contributor.origin === 'inline') {
    // The element's own style attribute: no stylesheet to open.
    return <span className="embed-editor_provenance-origin">{translate('style.provenanceList.styleAttribute')}</span>;
  }
  const embedKey = contributor.embedKey;
  if (!embedKey || !nav) {
    return undefined;
  }
  const embedName = nav.labelFor(embedKey);
  if (!embedName) {
    return undefined;
  }
  const componentClass = contributor.fromComponent ? 'is-component' : '';
  return (
    // A span (not a button) so it's valid inside the clickable row button;
    // stopPropagation keeps the row's selector-jump from also firing.
    <span
      className={`embed-editor_provenance-embed ${componentClass}`}
      role="button"
      title={translate('style.provenanceList.selectOnCanvas', { name: embedName })}
      onClick={(event) => {
        event.stopPropagation();
        nav.open(embedKey);
      }}
    >
      <EmbedGlyph className="embed-editor_provenance-embed-icon" />
      <span className="embed-editor_provenance-embed-label">{embedName}</span>
    </span>
  );
}
