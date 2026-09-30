import { createContext, useContext } from 'react'
import type { Contributor } from './lib/resolved'

// Lets any ProvenanceList rendered under it name a contributor's source embed
// (its full label, like "Global Styles #1") and select it on the Webflow canvas —
// without threading callbacks through every property row / label menu / popover.
export type EmbedNav = {
  open: (embedKey: string) => void
  labelFor: (embedKey: string) => string
}
export const ProvenanceEmbedNav = createContext<EmbedNav | null>(null)

// A little `</>` glyph, echoing the embed chip in the source dropdown.
function EmbedGlyph() {
  return (
    <svg className="embed-editor_provenance-embed-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 5.5 3.5 8 6 10.5M10 5.5 12.5 8 10 10.5" />
    </svg>
  )
}

// The shared "which selectors set this property and which one won" list — the body
// of the orange provenance popover, reused inside the Spacing editor and every
// property label's menu so any property can show its cascade on click.
//
// When `onSelect` is provided, each row is a clickable line that jumps the panel's
// pick to that selector (and focuses `prop`'s field). A value coming from an embed
// shows that embed as a chip (clicking it selects the embed on the canvas); a
// native (Webflow class) value shows a plain "Webflow" tag.
export default function ProvenanceList({ contributors, prop, onSelect }: {
  contributors: Contributor[]
  prop?: string
  onSelect?: (selectorText: string, prop?: string) => void
}) {
  const nav = useContext(ProvenanceEmbedNav)
  if (!contributors.length) {return null}
  // Emphasize the row you're editing (the picked selector's value); with nothing
  // being edited (e.g. an orange property's popover) fall back to the winner.
  const editingIdx = contributors.findIndex((c) => c.editing)
  const activeIdx = editingIdx >= 0 ? editingIdx : contributors.findIndex((c) => c.winning)
  return (
    <ul className="embed-editor_provenance-list">
      {contributors.map((c, index) => {
        const cls = `embed-editor_provenance-item ${index === activeIdx ? 'is-active' : ''}`
        const embedName = c.embedKey && nav ? nav.labelFor(c.embedKey) : null
        const origin = c.inheritedDepth !== undefined
          ? <span className="embed-editor_provenance-origin" title="Handed down by an ancestor">Inherited</span>
          : c.origin === 'native'
          ? <span className="embed-editor_provenance-origin">Webflow</span>
          : c.embedKey && nav && embedName
            ? (
              // A span (not a button) so it's valid inside the clickable row button;
              // stopPropagation keeps the row's selector-jump from also firing.
              <span
                className={`embed-editor_provenance-embed ${c.fromComponent ? 'is-component' : ''}`}
                role="button"
                title={`Select ${embedName} on the canvas`}
                onClick={(event) => { event.stopPropagation(); nav.open(c.embedKey!) }}
              >
                <EmbedGlyph />
                <span className="embed-editor_provenance-embed-label">{embedName}</span>
              </span>
            )
            : null
        const rawValue = c.important ? `${c.value} !important` : c.value
        const body = (
          <>
            {origin}
            <div className="embed-editor_provenance-line">
              <code className="embed-editor_provenance-sel">{c.selectorText}</code>
              <span className="embed-editor_provenance-val" title={rawValue}>{rawValue}</span>
            </div>
          </>
        )
        // The row for the selector you're already editing isn't a navigation
        // target — it stays a plain (non-clickable) row.
        const clickable = Boolean(onSelect) && !c.editing
        return (
          <li key={index}>
            {clickable ? (
              <button
                type="button"
                className={`${cls} is-clickable`}
                title={`Edit ${c.selectorText}`}
                onClick={() => onSelect!(c.selectorText, prop)}
              >
                {body}
              </button>
            ) : (
              <div className={cls}>{body}</div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
