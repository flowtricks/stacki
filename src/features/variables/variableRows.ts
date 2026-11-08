import type { VariableBlock, VariableCell, VariableRow } from '../../ipc/variablesBridge';
import { assert } from '../../../shared/core/assert';
import { LIMITS } from '../../../shared/core/limits';

interface SlotBase {
  readonly block: VariableBlock;
  readonly bi: number;
}
export type VariableSlot = (SlotBase & { readonly kind: 'heading' | 'end' }) | (SlotBase & { readonly kind: 'row'; readonly row: VariableRow });
export type VariableMove = {
  readonly file: string;
  readonly selector: string;
  readonly name: string;
} & ({ readonly at: number } | { readonly target: string | undefined });
export type DropPlan =
  | {
      readonly kind: 'heading';
      readonly block: VariableBlock;
      readonly before: string | undefined;
    }
  | { readonly kind: 'rows'; readonly moves: readonly VariableMove[] };
export interface VariableRename {
  readonly from: string;
  readonly to: string;
}

export function dropPlan(slots: readonly VariableSlot[], from: number, to: number): DropPlan | undefined {
  assertSlots(slots, from, to);
  const source = slots[from];
  if (!source) {
    return undefined;
  }
  let landing: VariableRow | undefined;
  for (let index = to; index < slots.length; index++) {
    const slot = slots[index];
    if (slot?.kind === 'row') {
      landing = slot.row;
      break;
    }
  }
  if (source.kind === 'heading') {
    const here = slots.indexOf(source);
    if (to === here || to === here + 1) {
      return undefined;
    }
    return { kind: 'heading', block: source.block, before: landing ? landing.name : undefined };
  }
  if (source.kind !== 'row') {
    return undefined;
  }
  return { kind: 'rows', moves: movesForDrop(slots, from, to) };
}

export function movesForDrop(slots: readonly VariableSlot[], from: number, to: number): readonly VariableMove[] {
  assertSlots(slots, from, to);
  const source = slots[from];
  if (!source || source.kind !== 'row') {
    return [];
  }
  assert(source.row.cells.length <= LIMITS.scanEntriesMax, 'Variable rows: column limit exceeded');
  let landing: VariableSlot | undefined;
  for (let index = to; index < slots.length; index++) {
    const slot = slots[index];
    if (slot?.kind === 'row' || slot?.kind === 'heading') {
      landing = slot;
      break;
    }
  }
  if (landing?.kind === 'row' && landing.row === source.row) {
    return [];
  }
  return source.row.cells.flatMap((cell, index) => (cell ? [moveToSlot(cell, index, landing)] : []));
}

export function stemOf(block: VariableBlock): string {
  assert(block.rows.length <= LIMITS.scanEntriesMax, 'Variable rows: row limit exceeded');
  const row = block.rows.find((row) => row.name);
  if (!row?.name) {
    return '--';
  }
  assert(row.label.length <= row.name.length, 'Variable rows: label exceeds name');
  return row.name.slice(0, row.name.length - row.label.length) || '--';
}
export function sectionPrefix(block: VariableBlock): string | undefined {
  const title = block.title;
  assert(block.rows.length <= LIMITS.scanEntriesMax, 'Variable rows: row limit exceeded');
  if (!title || block.kind === 'matrix') {
    return undefined;
  }
  const rows = block.rows.filter((row) => row.name);
  if (!rows.length) {
    return undefined;
  }
  return rows.every((row) => row.name?.startsWith('--' + title + '-')) ? title : undefined;
}
export function rowRenames(block: VariableBlock, row: VariableRow, typed: string): readonly VariableRename[] {
  assert(typed.length <= LIMITS.attrCharsMax, 'Variable rows: name limit exceeded');
  assert(row.cells.length <= LIMITS.scanEntriesMax, 'Variable rows: column limit exceeded');
  const next = typed.trim().replace(/^--/, '');
  if (!next) {
    return [];
  }
  if (block.kind === 'matrix') {
    return row.cells
      .flatMap((cell) =>
        cell
          ? [
              {
                from: cell.name,
                to: '--' + cell.name.slice(2, cell.name.length - row.label.length - 1) + '-' + next,
              },
            ]
          : [],
      )
      .filter((rename) => rename.from !== rename.to);
  }
  if (!row.name) {
    return [];
  }
  const to = stemOf(block) + next;
  return to === row.name ? [] : [{ from: row.name, to }];
}

function moveToSlot(cell: VariableCell, index: number, landing: VariableSlot | undefined): VariableMove {
  const base = { file: cell.file, selector: cell.selector, name: cell.name };
  if (landing?.kind === 'heading') {
    if (typeof landing.block.titleStart === 'number') {
      return { ...base, at: landing.block.titleStart };
    }
    assert(landing.block.rows.length <= LIMITS.scanEntriesMax, 'Variable rows: row limit exceeded');
    const firstRow = landing.block.rows.find((row) => row.cells[index]);
    return { ...base, target: firstRow?.cells[index]?.name ?? undefined };
  }
  const target = landing?.kind === 'row' ? landing.row.cells[index] : undefined;
  return { ...base, target: target?.name ?? undefined };
}
function assertSlots(slots: readonly VariableSlot[], from: number, to: number): void {
  assert(slots.length <= LIMITS.scanEntriesMax, 'Variable rows: slot limit exceeded');
  assert(Number.isSafeInteger(from), 'Variable rows: source index must be an integer');
  assert(Number.isSafeInteger(to), 'Variable rows: target index must be an integer');
  assert(from >= 0, 'Variable rows: source index must be nonnegative');
  assert(to >= 0, 'Variable rows: target index must be nonnegative');
}

export interface SlotOffset {
  readonly head: number;
  readonly rows: number;
}
export function buildSheetSlots(blocks: readonly VariableBlock[]) {
  assert(blocks.length <= LIMITS.scanEntriesMax, 'Variable rows: block limit exceeded');
  const slots: VariableSlot[] = [];
  const offsets: SlotOffset[] = [];
  blocks.forEach((block, index) => {
    const heading = block.title !== undefined ? 1 : 0;
    assert(slots.length + heading + block.rows.length + 1 <= LIMITS.scanEntriesMax, 'Variable rows: slot limit exceeded');
    offsets.push({ head: slots.length, rows: slots.length + heading });
    if (heading) {
      slots.push({ kind: 'heading', block, bi: index });
    }
    for (const row of block.rows) {
      slots.push({ kind: 'row', block, row, bi: index });
    }
    slots.push({ kind: 'end', block, bi: index });
  });
  assert(offsets.length === blocks.length, 'Variable rows: block offsets must correspond');
  return { slots, offsets };
}
