import { useRef, type MouseEvent, type RefObject } from 'react';
import { assert } from '../../../shared/core/assert';
import { INSERT_GROUPS, type InsertGroup } from './insertGroups';
import type { InsertItem } from './insertItem';
import { BLOCK_PREVIEW_WIDTH, InsertPreviewSurface, SECTION_PREVIEW_WIDTH, useReportVisibility, type InsertPreviewSource } from './InsertPreview';

// The pieces of the insert grid: a card with a picture of the component, a tile without one, the pills that
// switch between sections and blocks, the large view, and the key hints.

const PILL_LABELS: Readonly<Record<InsertGroup, string>> = { sections: 'Sections', blocks: 'Blocks' };

export type EnlargeHint = 'space' | 'shift-space' | 'none';

/** The preview route's address for everything the grid draws; per item only the component differs. */
export type InsertPreviewHost = Omit<InsertPreviewSource, 'component'>;

export function previewWidthOf(group: InsertGroup): number {
  return group === 'sections' ? SECTION_PREVIEW_WIDTH : BLOCK_PREVIEW_WIDTH;
}

export const shotFitOf = (group: InsertGroup): 'fill' | 'scale' => (group === 'sections' ? 'fill' : 'scale');

export function InsertCard({
  item,
  itemKey,
  highlighted,
  mounted,
  visible,
  host,
  scrollRoot,
  onVisible,
  onHover,
  onInsert,
}: {
  readonly item: InsertItem;
  readonly itemKey: string;
  readonly highlighted: boolean;
  readonly mounted: boolean;
  readonly visible: boolean;
  readonly host: InsertPreviewHost;
  readonly scrollRoot: RefObject<HTMLElement>;
  readonly onVisible: (key: string, visible: boolean) => void;
  readonly onHover: () => void;
  readonly onInsert: () => void;
}) {
  assert(item.group !== undefined, 'A card belongs to a group');
  const ref = useRef<HTMLDivElement>(null);
  useReportVisibility(ref, scrollRoot, itemKey, onVisible);
  const uses = item.instances ?? 0;
  return (
    <div ref={ref} className={`insert-item insert-card ${highlighted ? 'highlight' : ''}`} onMouseMove={highlighted ? undefined : onHover} onClick={onInsert}>
      <InsertPreviewSurface
        source={{ ...host, component: item.preview }}
        width={previewWidthOf(item.group)}
        mounted={mounted}
        visible={visible}
        shotFit={shotFitOf(item.group)}
        icon={item.icon}
        size="card"
      />
      <div className="insert-card-foot">
        <span className="insert-item-icon">{item.icon}</span>
        <span className="insert-item-label">{item.label}</span>
        {uses > 0 && <span className="insert-item-uses">{uses}×</span>}
      </div>
    </div>
  );
}

export function InsertTile({
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
    <div className={`insert-item insert-tile ${highlighted ? 'highlight' : ''}`} onMouseMove={highlighted ? undefined : onHover} onClick={onInsert}>
      <span className="insert-item-icon">{item.icon}</span>
      <span className="insert-item-label">{item.label}</span>
      {item.sub && <span className="insert-item-sub">{item.sub}</span>}
    </div>
  );
}

export function InsertPills({
  counts,
  pill,
  onPick,
}: {
  readonly counts: Readonly<Record<InsertGroup, number>>;
  readonly pill: InsertGroup;
  readonly onPick: (group: InsertGroup) => void;
}) {
  return (
    <div className="insert-pills">
      {INSERT_GROUPS.map((group) => (
        <button
          key={group}
          className={`insert-pill ${pill === group ? 'on' : ''}`}
          aria-pressed={pill === group}
          disabled={counts[group] === 0}
          // Keep the focus in the search field: the keys that drive the grid live there.
          onMouseDown={keepFocus}
          onClick={() => onPick(group)}
        >
          <span>{PILL_LABELS[group]}</span>
          <span className="insert-pill-count">{counts[group]}</span>
        </button>
      ))}
    </div>
  );
}

export function InsertEnlarged({ item, host, onClose }: { readonly item: InsertItem; readonly host: InsertPreviewHost; readonly onClose: () => void }) {
  assert(item.group !== undefined, 'Only a card opens the large view');
  return (
    <div className="insert-enlarged" role="dialog" aria-label={`${item.label} preview`} onMouseDown={keepFocus}>
      <div className="insert-enlarged-head">
        <span className="insert-item-icon">{item.icon}</span>
        <span className="insert-item-label">{item.label}</span>
        <button className="ghost insert-enlarged-close" aria-label="Close large view" onClick={onClose}>
          Esc
        </button>
      </div>
      <InsertPreviewSurface
        source={{ ...host, component: item.preview }}
        width={previewWidthOf(item.group)}
        mounted
        visible
        shotFit={shotFitOf(item.group)}
        icon={item.icon}
        size="large"
      />
    </div>
  );
}

export function InsertHints({ enlarge }: { readonly enlarge: EnlargeHint }) {
  return (
    <div className="insert-footer">
      {enlarge === 'space' && (
        <span className="insert-hint">
          <kbd>Space</kbd> to enlarge
        </span>
      )}
      {enlarge === 'shift-space' && (
        <span className="insert-hint">
          <kbd>⇧ Space</kbd> to enlarge
        </span>
      )}
      <span className="insert-hint">
        <kbd>↵</kbd> insert
      </span>
    </div>
  );
}

function keepFocus(event: MouseEvent): void {
  event.preventDefault();
}
