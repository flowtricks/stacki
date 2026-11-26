// The AI panel's modes: ways of working that change how the canvas behaves while the chat is open (comment pins,
// pins/pinStore.ts). Each mode registers itself here, on its own; the header (sessions/ModeButtons.tsx) draws one
// button per registered mode and knows none of them by name. Why a registry: a mode can be added or removed (an
// experiment that ships for a while, then goes) by adding or deleting the one file that registers it, and the
// header and the other modes stay as they are. A mode that is not registered has no button.
//
// A mode is on or off. Turning one on turns the others off, so the canvas is never asked to be two things at once.
import { useSyncExternalStore, type ReactNode } from 'react';
import { assert } from '../../../shared/core/assert';
import type { Translator } from '../../lib/i18n/localeContext';

/** Modes registered at once. Why: each is a button in the header, and more would crowd the chat's title out. */
export const PANEL_MODES_MAX = 8;

export interface PanelMode {
  /** Stable: the button's key. */
  readonly id: string;
  /** Where its button sits: lower first (before "+"). Ties keep registration order. */
  readonly order: number;
  /** The mode's name: its button's tooltip and accessible name. */
  readonly label: (translate: Translator) => string;
  readonly icon: () => ReactNode;
  readonly isActive: () => boolean;
  readonly setActive: (active: 'on' | 'off') => void;
  /** Tells `listener` when `isActive` may have changed; returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

let modes: readonly PanelMode[] = [];
const listeners = new Set<() => void>();
let version = 0;

/** Adds a mode (its header button); returns its removal. A second registration of an id replaces the first. */
export function registerPanelMode(mode: PanelMode): () => void {
  assert(mode.id.length > 0, 'registerPanelMode: a mode has an id');
  const others = modes.filter((entry) => entry.id !== mode.id);
  assert(others.length < PANEL_MODES_MAX, 'registerPanelMode: the modes are bounded');
  modes = [...others, mode].sort((left, right) => left.order - right.order);
  const unsubscribe = mode.subscribe(changed);
  changed();
  return () => {
    unsubscribe();
    modes = modes.filter((entry) => entry !== mode);
    changed();
  };
}

/** The registered modes, in menu order. */
export function panelModes(): readonly PanelMode[] {
  return modes;
}

/** Turns `id` on (and every other mode off) or off. An id nobody registered is ignored. */
export function setPanelMode(id: string, active: 'on' | 'off'): void {
  const mode = modes.find((entry) => entry.id === id);
  if (mode === undefined) {
    return;
  }
  if (active === 'on') {
    for (const other of modes) {
      if (other !== mode && other.isActive()) {
        other.setActive('off');
      }
    }
  }
  mode.setActive(active);
}

/** The mode that is on, if any. */
export function activePanelMode(): PanelMode | undefined {
  return modes.find((mode) => mode.isActive());
}

/** Re-renders on any registration and on any mode turning on or off. */
export function usePanelModes(): { readonly modes: readonly PanelMode[]; readonly active: PanelMode | undefined } {
  useSyncExternalStore(subscribe, currentVersion, currentVersion);
  return { modes, active: activePanelMode() };
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function currentVersion(): number {
  return version;
}

function changed(): void {
  version += 1;
  assert(Number.isSafeInteger(version), 'panelModes: the version stays an integer');
  for (const listener of [...listeners]) {
    listener();
  }
}
