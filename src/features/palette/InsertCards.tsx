import { useCallback, useRef, type MouseEvent, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import { insertFolderLabel, type InsertFolderKey } from './insertFolders';
import type { InsertPill } from './insertGrid';
import type { InsertItem } from './insertItem';
import { InsertPreviewSurface, useReportVisibility, type InsertPreviewSource } from './InsertPreview';

// The pieces of the insert palette: a card with a live picture of the component (Components tab), a row of the
// plain list (the other tabs), the folder pills that filter the grid, and the key hints.

/** The preview route's address for everything the grid draws; per item only the component differs. */
export type InsertPreviewHost = Omit<InsertPreviewSource, 'component'>;

export function InsertCard({
  item,
  itemKey,
  highlighted,
  mounted,
  host,
  scrollRoot,
  onVisible,
  onSettled,
  onHover,
  onInsert,
}: {
  readonly item: InsertItem;
  readonly itemKey: string;
  readonly highlighted: boolean;
  readonly mounted: boolean;
  readonly host: InsertPreviewHost;
  readonly scrollRoot: RefObject<HTMLElement>;
  readonly onVisible: (key: string, visible: boolean) => void;
  /** The card's frame answered or gave up; the grid may start another. */
  readonly onSettled: (key: string) => void;
  readonly onHover: () => void;
  readonly onInsert: () => void;
}) {
  assert(item.card !== undefined, 'Only a card item renders as a card');
  const ref = useRef<HTMLDivElement>(null);
  useReportVisibility(ref, scrollRoot, itemKey, onVisible);
  const uses = item.instances ?? 0;
  const settle = useCallback(() => onSettled(itemKey), [onSettled, itemKey]);
  return (
    <div ref={ref} className={`insert-item insert-card ${highlighted ? 'highlight' : ''}`} onMouseMove={highlighted ? undefined : onHover} onClick={onInsert}>
      <InsertPreviewSurface source={{ ...host, component: item.preview }} mounted={mounted} icon={item.icon} onSettled={settle} />
      <div className="insert-card-foot">
        <span className="insert-item-icon">{item.icon}</span>
        <span className="insert-item-label">{item.label}</span>
        {uses > 0 && <span className="insert-item-uses">{uses}×</span>}
      </div>
    </div>
  );
}

/** A row of the plain list the All results, Elements and Other tabs show: icon, label and where it comes from. */
export function InsertRow({
  item,
  highlighted,
  onHover,
  onInsert,
}: {
  readonly item: InsertItem;
  readonly highlighted: boolean;
  readonly onHover: () => void;
  readonly onInsert: () => void;
}) {
  return (
    <div className={`insert-item ${highlighted ? 'highlight' : ''}`} onMouseMove={highlighted ? undefined : onHover} onClick={onInsert}>
      <span className="insert-item-icon">{item.icon}</span>
      <span className="insert-item-label">{item.label}</span>
      {item.sub && <span className="insert-item-sub">{item.sub}</span>}
    </div>
  );
}

/**
 * The folder pills: optional filters, at most one selected. A click on the selected pill clears it,
 * on another switches to it. A pill with no hits stays visible but cannot be picked, unless it is the
 * selected one, which must stay clearable.
 */
export function InsertPills({
  pills,
  selected,
  onPick,
}: {
  readonly pills: readonly InsertPill[];
  readonly selected: InsertFolderKey | undefined;
  readonly onPick: (folder: InsertFolderKey) => void;
}) {
  return (
    <div className="insert-pills" role="group" aria-label="Component folders">
      {pills.map((pill) => {
        const on = pill.key === selected;
        return (
          <button
            key={pill.key}
            type="button"
            className={`insert-pill ${on ? 'on' : ''}`}
            aria-pressed={on}
            disabled={pill.count === 0 && !on}
            // Keep the focus in the search field on a click: the keys that drive the grid live there.
            onMouseDown={keepFocus}
            onClick={() => onPick(pill.key)}
          >
            <span>{insertFolderLabel(pill.key)}</span>
            <span className="insert-pill-count">{pill.count}</span>
          </button>
        );
      })}
    </div>
  );
}

export function InsertHints() {
  return (
    <div className="insert-footer">
      <span className="insert-hint">
        <kbd>↵</kbd> insert
      </span>
    </div>
  );
}

function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}
