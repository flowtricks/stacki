// The pure half of useSectionedDrag: a list of sections, each holding ordered items, and
// the decisions about moving an item inside it or between sections. Nothing here touches
// the DOM, so every refusal (dropping on itself, into a collapsed section, outside the
// list) is tested as a plain function.
//
// The model is deliberately ignorant of what the items are: the chat list passes chat ids,
// but anything with string ids in sections works.
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

export interface DragSection {
  readonly id: string;
  /** Items in a collapsed section are not on screen, so nothing may be dropped into it. */
  readonly collapsed: boolean;
  readonly itemIds: readonly string[];
}

/** Where a dragged item would land: in `sectionId`, before `beforeId`, or at the end when that is undefined. */
export interface DropTarget {
  readonly sectionId: string;
  readonly beforeId: string | undefined;
}

export type DropRefusal = 'unknown-item' | 'unknown-section' | 'unknown-anchor' | 'self' | 'collapsed' | 'no-change';

export interface DropMove extends DropTarget {
  readonly itemId: string;
  /** Position in the target section once the item has been taken out of it. */
  readonly index: number;
}

export type DropDecision = { readonly kind: 'move'; readonly move: DropMove } | { readonly kind: 'none'; readonly reason: DropRefusal };

/** Every id appears once in the whole list: a duplicate would make "before this item" ambiguous. */
export function assertDragSections(sections: readonly DragSection[]): void {
  const seen = new Set<string>();
  let total = 0;
  for (const section of sections) {
    assert(!seen.has(`section:${section.id}`), `sectioned drag: duplicate section ${section.id}`);
    seen.add(`section:${section.id}`);
    for (const itemId of section.itemIds) {
      assert(!seen.has(`item:${itemId}`), `sectioned drag: duplicate item ${itemId}`);
      seen.add(`item:${itemId}`);
      total += 1;
    }
  }
  assert(total <= LIMITS.scanEntriesMax, 'sectioned drag: item limit exceeded');
}

export function resolveDrop(sections: readonly DragSection[], itemId: string, target: DropTarget): DropDecision {
  const source = sections.find((section) => section.itemIds.includes(itemId));
  if (source === undefined) {
    return { kind: 'none', reason: 'unknown-item' };
  }
  const destination = sections.find((section) => section.id === target.sectionId);
  if (destination === undefined) {
    return { kind: 'none', reason: 'unknown-section' };
  }
  if (target.beforeId === itemId) {
    return { kind: 'none', reason: 'self' };
  }
  if (destination.collapsed) {
    return { kind: 'none', reason: 'collapsed' };
  }
  if (target.beforeId !== undefined && !destination.itemIds.includes(target.beforeId)) {
    return { kind: 'none', reason: 'unknown-anchor' };
  }
  const others = destination.itemIds.filter((id) => id !== itemId);
  const index = target.beforeId === undefined ? others.length : others.indexOf(target.beforeId);
  assert(index >= 0, 'resolveDrop: the anchor is among the other items');
  assert(index <= others.length, 'resolveDrop: the index is inside the section');
  if (source.id === destination.id && index === source.itemIds.indexOf(itemId)) {
    return { kind: 'none', reason: 'no-change' };
  }
  return { kind: 'move', move: { itemId, sectionId: destination.id, beforeId: target.beforeId, index } };
}

/** The sections after `move`; the input is not changed. Every other item keeps its order. */
export function applyMove(sections: readonly DragSection[], move: DropMove): readonly DragSection[] {
  const next = sections.map((section) => {
    const without = section.itemIds.filter((id) => id !== move.itemId);
    if (section.id !== move.sectionId) {
      return { ...section, itemIds: without };
    }
    assert(move.index >= 0, 'applyMove: the index is not negative');
    assert(move.index <= without.length, 'applyMove: the index is inside the section');
    return { ...section, itemIds: [...without.slice(0, move.index), move.itemId, ...without.slice(move.index)] };
  });
  assert(
    next.reduce((total, section) => total + section.itemIds.length, 0) === sections.reduce((total, section) => total + section.itemIds.length, 0),
    'applyMove: no item is lost or duplicated',
  );
  return next;
}

/**
 * Where Alt+Up or Alt+Down sends an item: one place up or down inside its section, and past
 * the end into the nearest section that is open. Undefined at the very top or bottom.
 */
export function stepTarget(sections: readonly DragSection[], itemId: string, direction: 'up' | 'down'): DropTarget | undefined {
  const sectionIndex = sections.findIndex((section) => section.itemIds.includes(itemId));
  if (sectionIndex < 0) {
    return undefined;
  }
  const section = sections[sectionIndex];
  if (section === undefined) {
    return undefined;
  }
  const index = section.itemIds.indexOf(itemId);
  if (direction === 'up') {
    const previous = section.itemIds[index - 1];
    if (previous !== undefined) {
      return { sectionId: section.id, beforeId: previous };
    }
    for (let cursor = sectionIndex - 1; cursor >= 0; cursor -= 1) {
      const candidate = sections[cursor];
      if (candidate !== undefined && !candidate.collapsed) {
        return { sectionId: candidate.id, beforeId: undefined };
      }
    }
    return undefined;
  }
  if (index < section.itemIds.length - 1) {
    // Past the next sibling means before the one after it, or the end.
    return { sectionId: section.id, beforeId: section.itemIds[index + 2] };
  }
  for (let cursor = sectionIndex + 1; cursor < sections.length; cursor += 1) {
    const candidate = sections[cursor];
    if (candidate !== undefined && !candidate.collapsed) {
      return { sectionId: candidate.id, beforeId: candidate.itemIds[0] };
    }
  }
  return undefined;
}

export interface RowBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
}
export interface SectionBox {
  readonly id: string;
  readonly top: number;
  readonly bottom: number;
  readonly collapsed: boolean;
  readonly rows: readonly RowBox[];
}

/**
 * The drop target under a pointer at height `y`: the section nearest to it (a pointer in a
 * gap or past either end belongs to the closest), then the first row whose middle is
 * below the pointer, or the end of the section. Undefined only when there are no sections.
 */
export function locateDrop(layout: readonly SectionBox[], y: number): DropTarget | undefined {
  assert(Number.isFinite(y), 'locateDrop: y is finite');
  let nearest: SectionBox | undefined;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const section of layout) {
    const distance = y < section.top ? section.top - y : y > section.bottom ? y - section.bottom : 0;
    if (distance < nearestDistance) {
      nearest = section;
      nearestDistance = distance;
    }
  }
  if (nearest === undefined) {
    return undefined;
  }
  if (nearest.collapsed) {
    return { sectionId: nearest.id, beforeId: undefined };
  }
  const row = nearest.rows.find((candidate) => y < candidate.top + (candidate.bottom - candidate.top) / 2);
  return { sectionId: nearest.id, beforeId: row?.id };
}
