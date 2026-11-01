// A collection table's columns: which fields show beside each item's name,
// how the rows are sorted, and the grid the two make. Clicking a column's name
// sorts by it, smallest first; clicking it again, largest first. The fields
// chosen as columns are remembered per collection, in this browser only: they
// are a way of looking, not part of the site.
import { useState } from 'react';
import { assert } from '../../../shared/core/assert';
import {
  CMS_REMOTE_LIMITS,
  type RemoteCell,
  type RemoteDocumentSummary,
} from '../../../shared/properties/cmsRemote';
import type { RemoteSchemaField } from '../../../shared/properties/cmsRemoteSchema';

/** A field shown as a column: its name in the CMS, and its label. */
export interface RemoteColumn {
  readonly name: string;
  readonly title: string;
}

export type RemoteSortKey = 'title' | 'status' | 'updated' | `cell:${string}`;

export interface RemoteSort {
  readonly key: RemoteSortKey;
  readonly direction: 'ascending' | 'descending';
}

/** A first click sorts smallest first; another click on the same column reverses it. */
export function nextSort(current: RemoteSort | undefined, key: RemoteSortKey): RemoteSort {
  if (current?.key === key) {
    return { key, direction: current.direction === 'ascending' ? 'descending' : 'ascending' };
  }
  return { key, direction: 'ascending' };
}

/** The rows in the sort's order; without one, in the CMS's own. Empty values go last. */
export function sortItems(
  items: readonly RemoteDocumentSummary[],
  sort: RemoteSort | undefined,
): readonly RemoteDocumentSummary[] {
  if (sort === undefined) {
    return items;
  }
  const sign = sort.direction === 'ascending' ? 1 : -1;
  const sorted = [...items].sort((left, right) => {
    const first = sortValue(left, sort.key);
    const second = sortValue(right, sort.key);
    if (first === undefined || second === undefined) {
      return first === second ? 0 : first === undefined ? 1 : -1;
    }
    return sign * compare(first, second);
  });
  assert(sorted.length === items.length, 'Sorting keeps every row');
  return sorted;
}

function sortValue(item: RemoteDocumentSummary, key: RemoteSortKey): RemoteCell | undefined {
  switch (key) {
    case 'title':
      return item.title;
    case 'status':
      return item.status;
    case 'updated': {
      const time = Date.parse(item.updatedAt);
      return Number.isNaN(time) ? undefined : time;
    }
    default:
      return item.cells?.[key.slice('cell:'.length)];
  }
}

// Numbers by size, text as a person reads it (2 before 10, case aside), switches off first.
function compare(left: RemoteCell, right: RemoteCell): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left - right;
  }
  if (typeof left === 'boolean' && typeof right === 'boolean') {
    return Number(left) - Number(right);
  }
  return String(left).localeCompare(String(right), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

/** A cell as text: a switch as Yes or No, a number as written. */
export function cellText(cell: RemoteCell | undefined): string {
  if (cell === undefined || cell === '') {
    return '—';
  }
  if (typeof cell === 'boolean') {
    return cell ? 'Yes' : 'No';
  }
  return String(cell);
}

/** Fields a column can show: the ones with a line of text, a number or a switch to read. */
export function columnFields(fields: readonly RemoteSchemaField[]): readonly RemoteColumn[] {
  return fields
    .filter((field) => {
      const { type } = field;
      if (type.kind === 'string') {
        return type.asset === undefined;
      }
      if (type.kind === 'array') {
        return type.of.every((member) => member.kind === 'string' || member.kind === 'reference');
      }
      return !['object', 'image', 'file', 'geopoint', 'richText'].includes(type.kind);
    })
    .map((field) => ({ name: field.name, title: field.title || field.name }));
}

const NAME_MIN_PX = 220;
const STATUS_PX = 110;
const COLUMN_MIN_PX = 150;
const UPDATED_PX = 130;
const PIN_PX = 36;
const LEAD_PX = 28;

/**
 * The grid of a table with these columns, and the width below which it scrolls
 * sideways instead of squeezing: every column keeps a readable width.
 */
export function tableGrid(shape: {
  readonly lead: boolean;
  readonly status: boolean;
  readonly columns: number;
}): { readonly columns: string; readonly widthPx: number } {
  assert(shape.columns <= CMS_REMOTE_LIMITS.columnsMax, 'A table shows few columns');
  const parts = [
    ...(shape.lead ? [`${LEAD_PX}px`] : []),
    `minmax(${NAME_MIN_PX}px, 2fr)`,
    ...(shape.status ? [`${STATUS_PX}px`] : []),
    ...Array.from({ length: shape.columns }, () => `minmax(${COLUMN_MIN_PX}px, 1fr)`),
    `${UPDATED_PX}px`,
    `${PIN_PX}px`,
  ];
  const widthPx =
    (shape.lead ? LEAD_PX : 0) +
    NAME_MIN_PX +
    (shape.status ? STATUS_PX : 0) +
    shape.columns * COLUMN_MIN_PX +
    UPDATED_PX +
    PIN_PX;
  assert(widthPx > NAME_MIN_PX, 'A table is wider than its name column');
  return { columns: parts.join(' '), widthPx };
}

/** The columns chosen for one collection, remembered in this browser. */
export function useColumnChoice(
  key: string,
): readonly [readonly RemoteColumn[], (columns: readonly RemoteColumn[]) => void] {
  const storageKey = `stacki:cms-columns:${key}`;
  const [columns, setColumns] = useState<readonly RemoteColumn[]>(() => readColumns(storageKey));
  const choose = (next: readonly RemoteColumn[]) => {
    const bounded = next.slice(0, CMS_REMOTE_LIMITS.columnsMax);
    setColumns(bounded);
    try {
      localStorage.setItem(storageKey, JSON.stringify(bounded));
    } catch {
      // Private windows and blocked storage: the choice lasts until the view closes.
    }
  };
  return [columns, choose];
}

// What was stored, if it is still a list of columns; anything else is no choice.
function readColumns(storageKey: string): readonly RemoteColumn[] {
  let stored: unknown;
  try {
    const raw = localStorage.getItem(storageKey);
    stored = raw === null ? [] : parseStored(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(stored)) {
    return [];
  }
  const items: readonly unknown[] = stored;
  return items.slice(0, CMS_REMOTE_LIMITS.columnsMax).flatMap((item): RemoteColumn[] => {
    const name: unknown = typeof item === 'object' && item !== null ? Reflect.get(item, 'name') : 0;
    const title: unknown =
      typeof item === 'object' && item !== null ? Reflect.get(item, 'title') : 0;
    const valid =
      typeof name === 'string' &&
      /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/.test(name) &&
      !name.startsWith('_');
    return valid && typeof title === 'string' ? [{ name, title: title.slice(0, 200) }] : [];
  });
}

// Stored text read back as a value of unknown shape, checked by its caller.
function parseStored(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  return value;
}
