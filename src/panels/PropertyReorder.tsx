import { assert } from '../../shared/assert';
import { PROPERTY_LIMITS } from '../../shared/component-properties';
import { DragIcon } from '../ui/Icons';

// Drop targets are gaps before removal, matching the shared list gesture hook.
export function movePropertyItem<Value>(
  items: readonly Value[],
  source: number,
  gap: number
): readonly Value[] {
  assert(items.length <= PROPERTY_LIMITS.fieldsMax, 'Property list exceeds bounds');
  assert(Number.isSafeInteger(source), 'Property source index must be an integer');
  assert(Number.isSafeInteger(gap), 'Property drop gap must be an integer');
  assert(source >= 0, 'Property source index must be nonnegative');
  assert(source < items.length, 'Property source index is out of bounds');
  assert(gap >= 0, 'Property drop gap must be nonnegative');
  assert(gap <= items.length, 'Property drop gap is out of bounds');
  const target = gap > source ? gap - 1 : gap;
  if (source === target) {
    return items;
  }
  const next = [...items];
  const moved = next.splice(source, 1);
  next.splice(target, 0, ...moved);
  assert(next.length === items.length, 'Reordering must preserve the property count');
  return next;
}

export function PropertyGrip({
  label,
  index,
  count,
  disabled,
  onMove,
}: {
  readonly label: string;
  readonly index: number;
  readonly count: number;
  readonly disabled: boolean;
  readonly onMove: (source: number, gap: number) => void;
}) {
  return (
    <button
      type="button"
      className="list-field-grip"
      data-drag-through
      aria-label={`Reorder ${label}`}
      title="Drag to reorder (or use arrow keys)"
      disabled={disabled || count < 2}
      onKeyDown={(event) => {
        if (event.key === 'ArrowUp' && index > 0) {
          event.preventDefault();
          onMove(index, index - 1);
        }
        if (event.key === 'ArrowDown' && index < count - 1) {
          event.preventDefault();
          onMove(index, index + 2);
        }
      }}
    >
      <DragIcon size={12} />
    </button>
  );
}
