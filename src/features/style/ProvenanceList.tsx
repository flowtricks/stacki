import { createContext, useContext } from 'react';
import type { Contributor } from './model/resolved';

// Lets any ProvenanceList rendered under it name a contributor's source embed
// (its full label, like "Global Styles #1") and select it on the Webflow canvas —
// without threading callbacks through every property row / label menu / popover.
export type EmbedNav = {
  open: (embedKey: string) => void;
  labelFor: (embedKey: string) => string;
};
export const ProvenanceEmbedNav = createContext<EmbedNav | undefined>(undefined);

// A little `</>` glyph, echoing the embed chip in the source dropdown.
function EmbedGlyph() {
  return (
    <svg className="embed-editor_provenance-embed-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" />
    </svg>
  );
}

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
      {contributors.map((contributor, index) => {
        const activeClass = index === activeIndex ? 'is-active' : '';
        const className = `embed-editor_provenance-item ${activeClass}`;
        const rawValue = contributor.important ? `${contributor.value} !important` : contributor.value;
        const body = (
          <>
            <ProvenanceOrigin contributor={contributor} nav={nav} />
            <div className="embed-editor_provenance-line">
              <code className="embed-editor_provenance-sel">{contributor.selectorText}</code>
              <span className="embed-editor_provenance-val" title={rawValue}>
                {rawValue}
              </span>
            </div>
          </>
        );
        // The row for the selector you're already editing isn't a navigation
        // target — it stays a plain (non-clickable) row.
        const select = contributor.editing ? undefined : onSelect;
        return (
          <li key={index}>
            {select ? (
              <button
                type="button"
                className={`${className} is-clickable`}
                title={`Edit ${contributor.selectorText}`}
                onClick={() => select(contributor.selectorText, prop)}
              >
                {body}
              </button>
            ) : (
              <div className={className}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Where a contributor's value comes from: a plain "Webflow" tag for a native
// class, or the source embed as a chip that selects it on the canvas.
function ProvenanceOrigin({ contributor, nav }: { contributor: Contributor; nav: EmbedNav | undefined }) {
  if (contributor.origin === 'native') {
    return <span className="embed-editor_provenance-origin">Webflow</span>;
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
      title={`Select ${embedName} on the canvas`}
      onClick={(event) => {
        event.stopPropagation();
        nav.open(embedKey);
      }}
    >
      <EmbedGlyph />
      <span className="embed-editor_provenance-embed-label">{embedName}</span>
    </span>
  );
}
