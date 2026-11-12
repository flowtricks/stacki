// The pure half of the shared Menu (Menu.tsx): the row types a caller describes a menu
// with, which row a key lands on, and where a menu opens relative to what opened it.
//
// Kept apart from the component so the keyboard model and the placement can be tested
// without a browser: every function here takes values and returns values.
import type { ReactNode } from 'react';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';

/** A row that does something when chosen. */
export interface MenuItem {
  readonly kind: 'item';
  /** Stable within its menu: the React key and how a test finds the row. */
  readonly id: string;
  readonly label: string;
  /** A muted second line under the label. */
  readonly description?: string;
  readonly icon?: ReactNode;
  /** Text at the end of the row ("⌘K", "P"). It is display only: `accelerator` and `numberKey` do the work. */
  readonly shortcut?: string;
  /** The digit (1 to 9) that chooses this row while the menu is open; shown at the end when no `shortcut` is. */
  readonly numberKey?: number;
  /** A single letter that chooses this row while the menu is open. */
  readonly accelerator?: string;
  /** Given (true or false), the row is one of a single-choice list; true draws the blue check at the end of the row. */
  readonly checked?: boolean;
  /** A small filled label beside the title ("Recommended"). */
  readonly pill?: string;
  /** Explains the row in an info mark at the end of it. */
  readonly info?: string;
  readonly danger?: boolean;
  readonly disabled?: boolean;
  /** Leave the menu open after choosing (a stepper that is chosen repeatedly). */
  readonly keepOpen?: boolean;
  readonly onSelect: () => void;
}

/** A row that opens a side menu; it shows the current value and a chevron. */
export interface MenuSubmenu {
  readonly kind: 'submenu';
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  /** What is chosen inside now, muted before the chevron. */
  readonly value?: string;
  readonly disabled?: boolean;
  readonly entries: readonly MenuEntry[];
}

/** A row with an on/off switch at its end; choosing it flips the switch and leaves the menu open. */
export interface MenuToggle {
  readonly kind: 'toggle';
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly icon?: ReactNode;
  readonly info?: string;
  readonly on: boolean;
  readonly disabled?: boolean;
  readonly onChange: (next: boolean) => void;
}

/** A small caption over the rows that follow. */
export interface MenuHeading {
  readonly kind: 'heading';
  readonly id: string;
  readonly label: string;
}

/** A muted paragraph (the effort menu's "Higher effort means ..."); not focusable. */
export interface MenuNote {
  readonly kind: 'note';
  readonly id: string;
  readonly text: string;
}

/** A thin bar between groups. It is a filled strip, never a border. */
export interface MenuDivider {
  readonly kind: 'divider';
  readonly id: string;
}

export type MenuEntry = MenuItem | MenuSubmenu | MenuToggle | MenuHeading | MenuNote | MenuDivider;
export type MenuRow = MenuItem | MenuSubmenu | MenuToggle;

/** Where a menu opens: on which side of its anchor, and which edge lines up. */
export type MenuPlacement = 'below-start' | 'below-end' | 'above-start' | 'above-end' | 'right-start';

export function isMenuRow(entry: MenuEntry): entry is MenuRow {
  return entry.kind === 'item' || entry.kind === 'submenu' || entry.kind === 'toggle';
}

/** A row the keyboard can land on. */
export function isNavigable(entry: MenuEntry): boolean {
  return isMenuRow(entry) && entry.disabled !== true;
}

/** Checked once where a menu is drawn, so every function below may rely on it. */
export function assertMenuEntries(entries: readonly MenuEntry[]): void {
  assert(entries.length <= LIMITS.scanEntriesMax, 'Menu: entry limit exceeded');
  const ids = new Set<string>();
  for (const entry of entries) {
    assert(entry.id.length > 0, 'Menu: every entry has an id');
    assert(!ids.has(entry.id), `Menu: duplicate entry id ${entry.id}`);
    ids.add(entry.id);
    if (entry.kind === 'item') {
      assert(entry.numberKey === undefined || (Number.isInteger(entry.numberKey) && entry.numberKey >= 1 && entry.numberKey <= 9), 'Menu: numberKey is 1 to 9');
      assert(entry.accelerator === undefined || entry.accelerator.length === 1, 'Menu: accelerator is one character');
    }
  }
}

/** The row to focus when a menu opens: the one marked as current, else the first. */
export function initialIndex(entries: readonly MenuEntry[]): number | undefined {
  let first: number | undefined;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry === undefined || !isNavigable(entry)) {
      continue;
    }
    if (entry.kind === 'item' && entry.checked === true) {
      return index;
    }
    if (first === undefined) {
      first = index;
    }
  }
  return first;
}

/** The next row the keyboard can land on from `from`, wrapping, or undefined when there is none. */
export function stepIndex(entries: readonly MenuEntry[], from: number | undefined, delta: 1 | -1): number | undefined {
  assert(from === undefined || (Number.isInteger(from) && from >= 0 && from < entries.length), 'stepIndex: from is inside the entries');
  const count = entries.length;
  if (count === 0) {
    return undefined;
  }
  const origin = from ?? (delta === 1 ? -1 : 0);
  for (let taken = 1; taken <= count; taken += 1) {
    const index = (((origin + delta * taken) % count) + count) % count;
    const entry = entries[index];
    if (entry !== undefined && isNavigable(entry)) {
      return index;
    }
  }
  return undefined;
}

function edgeIndex(entries: readonly MenuEntry[], side: 'first' | 'last'): number | undefined {
  if (side === 'first') {
    return stepIndex(entries, undefined, 1);
  }
  return stepIndex(entries, undefined, -1);
}

export function indexOfNumberKey(entries: readonly MenuEntry[], digit: number): number | undefined {
  const index = entries.findIndex((entry) => entry.kind === 'item' && entry.numberKey === digit && entry.disabled !== true);
  return index < 0 ? undefined : index;
}

export function indexOfAccelerator(entries: readonly MenuEntry[], key: string): number | undefined {
  const wanted = key.toLowerCase();
  const index = entries.findIndex((entry) => entry.kind === 'item' && entry.accelerator?.toLowerCase() === wanted && entry.disabled !== true);
  return index < 0 ? undefined : index;
}

export interface KeyModifiers {
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
}

/** What a key press means for a menu. */
export type MenuKeyDecision =
  | { readonly kind: 'focus'; readonly index: number }
  | { readonly kind: 'choose'; readonly index: number }
  | { readonly kind: 'open-submenu'; readonly index: number }
  | { readonly kind: 'close-submenu' }
  | { readonly kind: 'close' }
  | { readonly kind: 'ignore' };

/**
 * Decide what `key` does when the row at `focused` (undefined when none has focus) is current.
 * Escape is not decided here: the popup closes its topmost layer itself, which is what
 * lets a submenu close before the menu that owns it.
 */
export function decideKey(entries: readonly MenuEntry[], focused: number | undefined, key: string, modifiers: KeyModifiers): MenuKeyDecision {
  assert(focused === undefined || (focused >= 0 && focused < entries.length), 'decideKey: focused is inside the entries');
  if (modifiers.altKey || modifiers.ctrlKey || modifiers.metaKey) {
    return { kind: 'ignore' };
  }
  const focusedEntry = focused === undefined ? undefined : entries[focused];
  switch (key) {
    case 'ArrowDown':
    case 'ArrowUp': {
      const index = stepIndex(entries, focused, key === 'ArrowDown' ? 1 : -1);
      return index === undefined ? { kind: 'ignore' } : { kind: 'focus', index };
    }
    case 'Home':
    case 'End': {
      const index = edgeIndex(entries, key === 'Home' ? 'first' : 'last');
      return index === undefined ? { kind: 'ignore' } : { kind: 'focus', index };
    }
    case 'ArrowRight': {
      if (focused !== undefined && focusedEntry?.kind === 'submenu' && focusedEntry.disabled !== true) {
        return { kind: 'open-submenu', index: focused };
      }
      return { kind: 'ignore' };
    }
    case 'ArrowLeft':
      return { kind: 'close-submenu' };
    case 'Enter':
    case ' ': {
      if (focused === undefined || focusedEntry === undefined || !isNavigable(focusedEntry)) {
        return { kind: 'ignore' };
      }
      return focusedEntry.kind === 'submenu' ? { kind: 'open-submenu', index: focused } : { kind: 'choose', index: focused };
    }
    case 'Tab':
      // Focus must not wander into the page behind a popover.
      return { kind: 'close' };
    default:
      return decideShortcut(entries, key);
  }
}

function decideShortcut(entries: readonly MenuEntry[], key: string): MenuKeyDecision {
  if (key.length !== 1) {
    return { kind: 'ignore' };
  }
  if (key >= '1' && key <= '9') {
    const index = indexOfNumberKey(entries, Number(key));
    return index === undefined ? { kind: 'ignore' } : { kind: 'choose', index };
  }
  const index = indexOfAccelerator(entries, key);
  return index === undefined ? { kind: 'ignore' } : { kind: 'choose', index };
}

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}
export interface Size {
  readonly width: number;
  readonly height: number;
}
export interface MenuPosition {
  readonly left: number;
  readonly top: number;
  /** Set when the menu is taller than the window can show; the menu then scrolls. */
  readonly heightMax: number | undefined;
}

export const MENU_GAP_PX = 6;
export const MENU_EDGE_PX = 8;
// A submenu overlaps its parent's padding so the pointer crosses no dead gap on the way over.
const SUBMENU_OVERLAP_PX = 4;
// Lines the first row of a side menu up with the row that opened it (the menu's own padding).
const SUBMENU_TOP_OFFSET_PX = 6;

/**
 * Where a menu of `size` opens next to `anchor`, kept inside the window.
 * It flips to the other side when the preferred one has no room and the other has more,
 * and caps its height when neither fits.
 */
export function placeMenu(anchor: Box, size: Size, viewport: Size, placement: MenuPlacement): MenuPosition {
  assert(size.width > 0, 'placeMenu: the menu has width');
  assert(size.height > 0, 'placeMenu: the menu has height');
  assert(viewport.width > 0, 'placeMenu: the window has width');
  assert(viewport.height > 0, 'placeMenu: the window has height');
  const roomHeight = viewport.height - 2 * MENU_EDGE_PX;
  const height = Math.min(size.height, roomHeight);
  const heightMax = size.height > roomHeight ? roomHeight : undefined;
  const clampLeft = (left: number): number => Math.max(MENU_EDGE_PX, Math.min(left, viewport.width - size.width - MENU_EDGE_PX));
  const clampTop = (top: number): number => Math.max(MENU_EDGE_PX, Math.min(top, viewport.height - height - MENU_EDGE_PX));
  if (placement === 'right-start') {
    const spaceRight = viewport.width - (anchor.left + anchor.width) - MENU_EDGE_PX;
    const spaceLeft = anchor.left - MENU_EDGE_PX;
    const fitsRight = size.width <= spaceRight + SUBMENU_OVERLAP_PX;
    const left = fitsRight || spaceRight >= spaceLeft ? anchor.left + anchor.width - SUBMENU_OVERLAP_PX : anchor.left - size.width + SUBMENU_OVERLAP_PX;
    return { left: clampLeft(left), top: clampTop(anchor.top - SUBMENU_TOP_OFFSET_PX), heightMax };
  }
  const alignEnd = placement === 'below-end' || placement === 'above-end';
  const left = clampLeft(alignEnd ? anchor.left + anchor.width - size.width : anchor.left);
  const spaceBelow = viewport.height - (anchor.top + anchor.height) - MENU_GAP_PX - MENU_EDGE_PX;
  const spaceAbove = anchor.top - MENU_GAP_PX - MENU_EDGE_PX;
  const wantsAbove = placement === 'above-start' || placement === 'above-end';
  const fitsPreferred = wantsAbove ? height <= spaceAbove : height <= spaceBelow;
  const above = fitsPreferred ? wantsAbove : spaceAbove > spaceBelow;
  const top = above ? anchor.top - MENU_GAP_PX - height : anchor.top + anchor.height + MENU_GAP_PX;
  return { left, top: clampTop(top), heightMax };
}
