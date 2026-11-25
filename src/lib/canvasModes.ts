// The canvas modes the AI panel's composer offers (its "Canvas" chip, CanvasModesMenu.tsx): alternate ways of
// working on the canvas that a feature switches on and off, such as Design mode. Each feature registers its own
// row here, at load, and nothing else in the panel knows about it: removing a feature removes its row, and the
// chip hides itself when no row is left. Features may not import each other, so this registry sits in lib.
import { useSyncExternalStore, type ReactNode } from 'react';
import type { Locale } from '../../shared/core/i18n/locales';

export interface CanvasMode {
  /** Stable and unique among the modes: the row's key. */
  readonly id: string;
  /** The row's name, in the interface language. */
  readonly label: (locale: Locale) => string;
  /** What the mode does, shown in the row's tooltip. */
  readonly description: (locale: Locale) => string;
  readonly icon: ReactNode;
  readonly isActive: () => boolean;
  /** Enters the mode when it is off, leaves it when it is on. */
  readonly toggle: () => void;
}

const CANVAS_MODES_MAX = 16;

let modes: readonly CanvasMode[] = [];
const listeners = new Set<() => void>();

function announce(): void {
  for (const listener of listeners) {
    listener();
  }
}

/** Adds `mode`'s row; registering the same id again replaces it (a hot reload loads its owner twice). Returns the removal. */
export function registerCanvasMode(mode: CanvasMode): () => void {
  const others = modes.filter((other) => other.id !== mode.id);
  if (others.length >= CANVAS_MODES_MAX) {
    throw new Error('Assertion failed: registerCanvasMode: at most ' + String(CANVAS_MODES_MAX) + ' canvas modes');
  }
  modes = [...others, mode];
  announce();
  return () => {
    modes = modes.filter((other) => other !== mode);
    announce();
  };
}

/** Says that a mode's `isActive` may answer differently now, so the chip redraws. */
export function noteCanvasModesChanged(): void {
  // A new array, so a subscriber's snapshot comparison sees a change.
  modes = [...modes];
  announce();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The registered modes, in registration order. */
export function useCanvasModes(): readonly CanvasMode[] {
  return useSyncExternalStore(subscribe, () => modes);
}
