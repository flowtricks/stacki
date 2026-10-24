import DateField from '../../../vendor/stacki/src/ui/DateField';
import HtmlField from '../../../vendor/stacki/src/ui/HtmlField';
import { calendarValue } from '../../../vendor/stacki/src/ui/dateFieldModel';
import { containsHTML } from '../../../vendor/stacki/src/ui/htmlFieldModel';
import { useId } from 'react';
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { record } from '../validation';

interface Props {
  readonly value: unknown;
  readonly change: (value: unknown) => void;
  readonly label: string;
  readonly depth?: number;
  readonly template?: unknown;
}
export function ValueFields({ value, change, label, depth = 0, template }: Props) {
  if (depth > 8) {
    return <p>Open source to edit deeply nested content.</p>;
  }
  if (Array.isArray(value)) {
    return (
      <ListFields value={value} change={change} label={label} depth={depth} template={template} />
    );
  }
  if (value !== null && typeof value === 'object') {
    const fields = record(value);
    return (
      <div className="value-fields">
        {Object.entries(fields)
          .slice(0, 200)
          .map(([key, child]) => (
            <div className="studio-field" key={key}>
              <span>{key}</span>
              <ValueFields
                value={child}
                label={label + '.' + key}
                depth={depth + 1}
                change={(next) => change({ ...fields, [key]: next })}
              />
            </div>
          ))}
      </div>
    );
  }
  if (typeof value === 'boolean') {
    return (
      <select
        aria-label={label}
        value={String(value)}
        onChange={(event) => change(event.target.value === 'true')}
      >
        <option value="true">True</option>
        <option value="false">False</option>
      </select>
    );
  }
  if (typeof value === 'number') {
    return (
      <input
        aria-label={label}
        type="number"
        value={value}
        onChange={(event) => {
          const next = Number(event.target.value);
          if (Number.isFinite(next)) {
            change(next);
          }
        }}
      />
    );
  }
  return <StringField value={value} label={label} change={change} />;
}
function StringField({ value, label, change }: Pick<Props, 'value' | 'label' | 'change'>) {
  const text = typeof value === 'string' ? value : '';
  if (containsHTML(text)) {
    return <HtmlField value={text} label={label} onChange={change} />;
  }
  if (calendarValue(text)) {
    return <DateField value={text} label={label} onChange={change} />;
  }
  return (
    <textarea
      aria-label={label}
      rows={2}
      value={typeof value === 'string' ? value : ''}
      onChange={(event) => change(event.target.value)}
    />
  );
}
function ListFields({ value, change, label, depth = 0, template }: Props & { value: unknown[] }) {
  const prefix = useId();
  const ids = value.map((_, index) => `${prefix}-${index}`);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
  );
  function drop(event: DragEndEvent) {
    if (!event.over) {
      return;
    }
    const from = ids.indexOf(String(event.active.id));
    const to = ids.indexOf(String(event.over.id));
    if (from >= 0 && to >= 0 && from !== to) {
      change(arrayMove(value, from, to));
    }
  }
  return (
    <div className="value-list">
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={drop}>
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {value.slice(0, 200).map((item, index) => (
            <ListItem
              key={ids[index]}
              id={`${prefix}-${index}`}
              label={`${label} item ${index + 1}`}
              remove={() => change(value.filter((_, position) => position !== index))}
            >
              <ValueFields
                value={item}
                label={`${label}.${index}`}
                depth={depth + 1}
                change={(next) =>
                  change(value.map((previous, position) => (position === index ? next : previous)))
                }
              />
            </ListItem>
          ))}
        </SortableContext>
      </DndContext>
      <button
        type="button"
        disabled={value.length >= 200}
        onClick={() => change([...value, template ?? emptyValue(value[0])])}
      >
        Add item
      </button>
    </div>
  );
}
function ListItem({
  id,
  label,
  remove,
  children,
}: {
  id: string;
  label: string;
  remove: () => void;
  children: React.ReactNode;
}) {
  const sortable = useSortable({ id });
  return (
    <div
      ref={sortable.setNodeRef}
      className="value-list-item"
      style={{
        transform: CSS.Transform.toString(sortable.transform),
        transition: sortable.transition,
        opacity: sortable.isDragging ? 0.5 : 1,
      }}
    >
      <div className="value-list-controls">
        <button
          type="button"
          aria-label={`Drag ${label}`}
          style={{ touchAction: 'none' }}
          {...sortable.attributes}
          {...sortable.listeners}
        >
          ⠿
        </button>
        <button type="button" aria-label={`Remove ${label}`} onClick={remove}>
          ×
        </button>
      </div>
      {children}
    </div>
  );
}
function emptyValue(value: unknown, depth = 0): unknown {
  if (depth > 8) {
    return '';
  }
  if (Array.isArray(value)) {
    return [];
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, emptyValue(child, depth + 1)]),
    );
  }
  if (typeof value === 'number') {
    return 0;
  }
  if (typeof value === 'boolean') {
    return false;
  }
  return '';
}
