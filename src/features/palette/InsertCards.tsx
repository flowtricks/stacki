import { useRef, type MouseEvent, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import { insertFolderLabel, type InsertFolderKey } from './insertFolders';
import type { InsertPill } from './insertGrid';
import { useTranslate } from '../../lib/i18n/useTranslate';
import { insertItemLabel, insertItemSub, type InsertItem } from './insertItem';
import { InsertPreviewSurface, useReportVisibility, type InsertPreviewSource } from './InsertPreview';

// The pieces of the insert palette: a card with a picture of the component (Components tab), a row of the
// plain list (the other tabs), the folder pills that filter the grid, and the key hints.

/** The preview route's address for everything the grid draws; per item only the component differs. */
export type InsertPreviewHost = Omit<InsertPreviewSource, 'component'>;

export function InsertCard({
  item,
  itemKey,
  highlighted,
  host,
  scrollRoot,
  onVisible,
  showFolder,
  onHover,
  onInsert,
  describedBy,
}: {
  readonly item: InsertItem;
  readonly itemKey: string;
  readonly highlighted: boolean;
  readonly host: InsertPreviewHost;
  readonly scrollRoot: RefObject<HTMLElement>;
  readonly onVisible: (key: string, visible: boolean) => void;
  /** Whether the label row names the card's folder pill; redundant, and so left out, while a pill filters the grid. */
  readonly showFolder: boolean;
  readonly onHover: () => void;
  readonly onInsert: () => void;
  /** The id of the element that says why the card cannot be inserted here (InsertPlacementTip). */
  readonly describedBy?: string | undefined;
}) {
  assert(item.card !== undefined, 'Only a card item renders as a card');
  const translate = useTranslate();
  const ref = useRef<HTMLDivElement>(null);
  useReportVisibility(ref, scrollRoot, itemKey, onVisible);
  const uses = item.instances ?? 0;
  const folder = showFolder && item.card.folder !== undefined ? insertFolderLabel(item.card.folder) : undefined;
  return (
    <div
      ref={ref}
      className={`insert-item insert-card ${highlighted ? 'highlight' : ''}`}
      aria-describedby={describedBy}
      onMouseMove={highlighted ? undefined : onHover}
      onClick={onInsert}
    >
      <InsertPreviewSurface source={{ ...host, component: item.preview }} icon={item.icon} />
      <div className="insert-card-foot">
        <span className="insert-item-icon">{item.icon}</span>
        <span className="insert-item-label">{insertItemLabel(item, translate)}</span>
        {folder !== undefined && <span className="insert-card-folder">· {folder}</span>}
        {uses > 0 && <span className="insert-item-uses">{uses}×</span>}
      </div>
    </div>
  );
}

/**
 * A row of the plain list the All results, Elements and Other tabs show: icon, label and where it comes
 * from. A component says where with its folder pill's name, as its card does.
 */
export function InsertRow({
  item,
  highlighted,
  onHover,
  onInsert,
  describedBy,
}: {
  readonly item: InsertItem;
  readonly highlighted: boolean;
  readonly onHover: () => void;
  readonly onInsert: () => void;
  /** The id of the element that says why the row cannot be inserted here (InsertPlacementTip). */
  readonly describedBy?: string | undefined;
}) {
  const translate = useTranslate();
  const where = item.card?.folder === undefined ? insertItemSub(item, translate) : insertFolderLabel(item.card.folder);
  return (
    <div
      className={`insert-item ${highlighted ? 'highlight' : ''}`}
      aria-describedby={describedBy}
      onMouseMove={highlighted ? undefined : onHover}
      onClick={onInsert}
    >
      <span className="insert-item-icon">{item.icon}</span>
      <span className="insert-item-label">{insertItemLabel(item, translate)}</span>
      {where !== undefined && where !== '' && <span className="insert-item-sub">{where}</span>}
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
  const translate = useTranslate();
  return (
    <div className="insert-pills" role="group" aria-label={translate('palette.insert.folders')}>
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
  const translate = useTranslate();
  return (
    <div className="insert-footer">
      <span className="insert-hint">
        <kbd>↵</kbd> {translate('palette.insert.hint')}
      </span>
    </div>
  );
}

function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}
