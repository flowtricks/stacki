import { useState } from 'react'
import type { ReactNode } from 'react'

// A reusable layer stack (background image/gradient layers, text-shadow layers):
// drag-to-reorder, click a row to open its editor, and a hover-revealed Remove (trash)
// action. The grip/trash only show on row hover. Rendering of a row's preview + label
// is delegated via `renderRow`; the owner keeps the data model.

const GripIcon = () => (
  <svg viewBox="0 0 16 16" aria-hidden="true" className="embed-editor_bg-glyph"><circle cx="6" cy="4" r="1" /><circle cx="10" cy="4" r="1" /><circle cx="6" cy="8" r="1" /><circle cx="10" cy="8" r="1" /><circle cx="6" cy="12" r="1" /><circle cx="10" cy="12" r="1" /></svg>
)
const EyeIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" /><circle cx="8" cy="8" r="2" stroke="currentColor" strokeWidth="1.2" /></svg>
)
const EyeOffIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M1.5 8S4 3.5 8 3.5c1.2 0 2.3.4 3.2 1M14.5 8s-2.5 4.5-6.5 4.5c-1.2 0-2.3-.4-3.2-1" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /><path d="M6.6 6.6a2 2 0 0 0 2.8 2.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /><path d="m2.5 2.5 11 11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" /></svg>
)
const TrashIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="embed-editor_bg-glyph"><path d="M3 4h10M6.5 4V3h3v1M5 4l.5 8.5a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1L11 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
)

export type LayerListProps = {
  /** Number of rows (top layer first). */
  count: number
  busy: boolean
  ariaLabel: string
  /** The preview swatch/thumbnail + label for a row. */
  renderRow: (index: number) => { preview: ReactNode; label: ReactNode }
  /** Open the editor for a row; `el` is the row element to anchor the editor below. */
  onOpen: (index: number, el: HTMLElement) => void
  onReorder: (from: number, to: number) => void
  onRemove: (index: number) => void
  /** Whether a row is turned off — see lib/hideable.ts. Omit for no eye at all. */
  isHidden?: (index: number) => boolean
  onToggleHidden?: (index: number) => void
}

export default function LayerList({ count, busy, ariaLabel, renderRow, onOpen, onReorder, onRemove, isHidden, onToggleHidden }: LayerListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  if (!count) return null
  return (
    <ul className="embed-editor_bg-layers" aria-label={ariaLabel}>
      {Array.from({ length: count }, (_, index) => {
        const { preview, label } = renderRow(index)
        const hidden = isHidden?.(index) ?? false
        return (
          <li
            key={index}
            className={`embed-editor_bg-layer ${dragOver === index ? 'is-drop-target' : ''} ${dragFrom === index ? 'is-dragging' : ''} ${hidden ? 'is-hidden' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragOver(index) }}
            onDrop={(event) => { event.preventDefault(); if (dragFrom != null) onReorder(dragFrom, index); setDragFrom(null); setDragOver(null) }}
          >
            <div className="embed-editor_bg-layer-row">
              <span
                className="embed-editor_bg-grip"
                draggable={!busy}
                onDragStart={(event) => { setDragFrom(index); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', String(index)) }}
                onDragEnd={() => { setDragFrom(null); setDragOver(null) }}
                title="Drag to reorder"
                aria-label="Drag to reorder"
              >
                <GripIcon />
              </span>
              <button type="button" className="embed-editor_bg-layer-main" onClick={(e) => onOpen(index, e.currentTarget.closest<HTMLElement>('li') ?? e.currentTarget)} disabled={busy} title="Edit layer">
                {preview}
                <span className="embed-editor_bg-layer-label">{label}</span>
              </button>
              {onToggleHidden ? (
                <button
                  type="button"
                  className="embed-editor_bg-layer-action embed-editor_bg-layer-eye"
                  onClick={() => onToggleHidden(index)}
                  disabled={busy}
                  aria-pressed={hidden}
                  title={hidden ? 'Show' : 'Hide'}
                  aria-label={hidden ? 'Show layer' : 'Hide layer'}
                >
                  {hidden ? <EyeOffIcon /> : <EyeIcon />}
                </button>
              ) : null}
              <button type="button" className="embed-editor_bg-layer-action embed-editor_bg-layer-trash" onClick={() => onRemove(index)} disabled={busy} title="Remove layer" aria-label="Remove layer"><TrashIcon /></button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
