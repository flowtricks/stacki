import { centralIcon } from '../../ui/central/CentralIcon';
import { drag as centralDrag, eye as centralEye, eyeOff as centralEyeOff, trashCanSimple as centralTrashCanSimple } from '../../ui/central/centralGeometry';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslate } from '../../lib/i18n/useTranslate';

// A reusable layer stack (background image/gradient layers, text-shadow layers):
// drag-to-reorder, click a row to open its editor, and a hover-revealed Remove (trash)
// action. The grip/trash only show on row hover. Rendering of a row's preview + label
// is delegated via `renderRow`; the owner keeps the data model.

const GripIcon = centralIcon(centralDrag);
const EyeIcon = centralIcon(centralEye);
const EyeOffIcon = centralIcon(centralEyeOff);
const TrashIcon = centralIcon(centralTrashCanSimple);

export type LayerListProps = {
  /** Number of rows (top layer first). */
  count: number;
  busy: boolean;
  ariaLabel: string;
  /** The preview swatch/thumbnail + label for a row. */
  renderRow: (index: number) => { preview: ReactNode; label: ReactNode };
  /** Open the editor for a row; `element` is the row element to anchor the editor below. */
  onOpen: (index: number, element: HTMLElement) => void;
  onReorder: (from: number, to: number) => void;
  onRemove: (index: number) => void;
  /** Whether a row is turned off — see lib/hideable.ts. Omit for no eye at all. */
  isHidden?: (index: number) => boolean;
  onToggleHidden?: (index: number) => void;
};

export default function LayerList({ count, busy, ariaLabel, renderRow, onOpen, onReorder, onRemove, isHidden, onToggleHidden }: LayerListProps) {
  const [dragFrom, setDragFrom] = useState<number | undefined>(undefined);
  const [dragOver, setDragOver] = useState<number | undefined>(undefined);
  if (!count) {
    return undefined;
  }
  const clearDrag = () => {
    setDragFrom(undefined);
    setDragOver(undefined);
  };
  return (
    <ul className="embed-editor_bg-layers" aria-label={ariaLabel}>
      {Array.from({ length: count }, (_, index) => {
        const { preview, label } = renderRow(index);
        const hidden = isHidden?.(index) ?? false;
        return (
          <LayerRow
            key={index}
            index={index}
            busy={busy}
            hidden={hidden}
            preview={preview}
            label={label}
            dropTarget={dragOver === index}
            dragging={dragFrom === index}
            onDragOverRow={() => setDragOver(index)}
            onDropRow={() => {
              if (dragFrom !== undefined) {
                onReorder(dragFrom, index);
              }
              clearDrag();
            }}
            onDragStartRow={() => setDragFrom(index)}
            onDragEndRow={clearDrag}
            onOpen={onOpen}
            onRemove={onRemove}
            onToggleHidden={onToggleHidden}
          />
        );
      })}
    </ul>
  );
}

type LayerRowProps = {
  readonly index: number;
  readonly busy: boolean;
  readonly hidden: boolean;
  readonly preview: ReactNode;
  readonly label: ReactNode;
  readonly dropTarget: boolean;
  readonly dragging: boolean;
  readonly onDragOverRow: () => void;
  readonly onDropRow: () => void;
  readonly onDragStartRow: () => void;
  readonly onDragEndRow: () => void;
  readonly onOpen: LayerListProps['onOpen'];
  readonly onRemove: LayerListProps['onRemove'];
  readonly onToggleHidden: ((index: number) => void) | undefined;
};

// One row of the stack: the drop target, its grip, the open button, and the
// hover-revealed eye and trash actions. The list owns the drag state.
function LayerRow({
  index,
  busy,
  hidden,
  preview,
  label,
  dropTarget,
  dragging,
  onDragOverRow,
  onDropRow,
  onDragStartRow,
  onDragEndRow,
  onOpen,
  onRemove,
  onToggleHidden,
}: LayerRowProps) {
  const translate = useTranslate();
  return (
    <li
      className={`embed-editor_bg-layer ${dropTarget ? 'is-drop-target' : ''} ` + `${dragging ? 'is-dragging' : ''} ${hidden ? 'is-hidden' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        onDragOverRow();
      }}
      onDrop={(event) => {
        event.preventDefault();
        onDropRow();
      }}
    >
      <div className="embed-editor_bg-layer-row">
        <span
          className="embed-editor_bg-grip"
          draggable={!busy}
          onDragStart={(event) => {
            onDragStartRow();
            const transfer = event.dataTransfer;
            transfer.effectAllowed = 'move';
            transfer.setData('text/plain', String(index));
          }}
          onDragEnd={onDragEndRow}
          title={translate('style.layerList.dragToReorder')}
          aria-label={translate('style.layerList.dragToReorder')}
        >
          <GripIcon />
        </span>
        <button
          type="button"
          className="embed-editor_bg-layer-main"
          onClick={(event) => onOpen(index, event.currentTarget.closest<HTMLElement>('li') ?? event.currentTarget)}
          disabled={busy}
          title={translate('style.layerList.editLayer')}
        >
          {preview}
          <span className="embed-editor_bg-layer-label">{label}</span>
        </button>
        <LayerRowActions index={index} busy={busy} hidden={hidden} onRemove={onRemove} onToggleHidden={onToggleHidden} />
      </div>
    </li>
  );
}

// The hover-revealed row actions: the eye (only when hiding is supported) and
// the trash.
function LayerRowActions({ index, busy, hidden, onRemove, onToggleHidden }: Pick<LayerRowProps, 'index' | 'busy' | 'hidden' | 'onRemove' | 'onToggleHidden'>) {
  const translate = useTranslate();
  return (
    <>
      {onToggleHidden ? (
        <button
          type="button"
          className="embed-editor_bg-layer-action embed-editor_bg-layer-eye"
          onClick={() => onToggleHidden(index)}
          disabled={busy}
          aria-pressed={hidden}
          title={hidden ? translate('style.layerList.show') : translate('style.layerList.hide')}
          aria-label={hidden ? translate('style.layerList.showLayer') : translate('style.layerList.hideLayer')}
        >
          {hidden ? <EyeOffIcon /> : <EyeIcon />}
        </button>
      ) : undefined}
      <button
        type="button"
        className="embed-editor_bg-layer-action embed-editor_bg-layer-trash"
        onClick={() => onRemove(index)}
        disabled={busy}
        title={translate('style.layerList.removeLayer')}
        aria-label={translate('style.layerList.removeLayer')}
      >
        <TrashIcon />
      </button>
    </>
  );
}
