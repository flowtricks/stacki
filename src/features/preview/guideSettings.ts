import { useProjectGuideSettings } from './guidePersistence';
// The guide reads shared project metadata; local storage is only a one-time migration source.

import { useEffect, useRef } from 'react';
import { assert } from '../../../shared/core/assert';
import { BOUNDARY_LIMITS } from '../../../shared/core/boundary';
import {
  GUIDE_DEFAULTS,
  GUIDE_COLUMN_COUNT_DEFAULT,
  GUIDE_LIMITS,
  clampGuideOpacity,
  guideVariableNames,
  isGuideColumnPick,
  parseGuideLength,
  parseGuideVariableName,
  resolveGuide,
  type GuideColumnSetting,
  type GuideMetrics,
  type GuideSettings,
  type GuideSize,
  type ResolvedGuide,
} from './guideModel';
import type { GuideMenuProps } from './GuideMenu';

const GUIDE_STORAGE_PREFIX = 'stacki.columnGuide:';
// A stored record is a handful of short fields; anything longer is not one.
const GUIDE_STORED_CHARS_MAX = 2_048;
// Earlier records saved the old default 12 as a literal even when never edited.
// Mark new saves so an explicitly entered 12 remains an override after reopening.
const GUIDE_COLUMN_DEFAULTS_VERSION = 1;

export type GuideUpdate = (update: (settings: GuideSettings) => GuideSettings) => void;

/** How a host reaches its preview frame: the desktop canvas and Studio each link their own way. */
export interface GuideFrameLink {
  readonly post: (message: unknown) => void;
  /** Calls the listener each time a frame loads; returns the unsubscribe. */
  readonly subscribeLoad: (listener: () => void) => () => void;
}

/** What the canvas draws: present while the guide is on and the frame has measured. */
export interface ShownGuide {
  readonly guide: ResolvedGuide;
  readonly settings: GuideSettings;
}

/**
 * The column guide of one canvas, as the desktop preview and Studio both use
 * it: the settings saved under `projectKey`, the variables the frame is told
 * to measure, and what the toolbar's menu and the overlay are drawn from.
 */
export function useColumnGuide(options: {
  readonly projectKey: string | undefined;
  readonly metrics: GuideMetrics | undefined;
  readonly available: boolean;
  readonly frame: GuideFrameLink;
}): { readonly menu: GuideMenuProps; readonly shown: ShownGuide | undefined } {
  const { settings, update, persistence } = useProjectGuideSettings(options.projectKey);
  useGuideShortcut(update);
  useGuideVariables(guideVariableNames(settings), options.frame);
  const metrics = options.metrics;
  const guide = metrics === undefined ? undefined : resolveGuide(metrics, settings);
  const menu = { settings, update, metrics, guide, persistence, available: options.available };
  if (guide === undefined) {
    return { menu, shown: undefined };
  }
  return { menu, shown: settings.visible ? { guide, settings } : undefined };
}

/** The settings for the open project, and the one way to change them. */
export function useGuideSettings(
  projectKey: string | undefined,
): readonly [GuideSettings, GuideUpdate] {
  const { settings, update } = useProjectGuideSettings(projectKey);
  useGuideShortcut(update);
  return [settings, update] as const;
}

// The frame measures the menu's variables once told their names: whenever they
// change, and on every load, since a new page starts from none. The names are
// compared as one key, and the link is read through a ref, so a host whose
// functions change on every render sends nothing extra.
function useGuideVariables(names: readonly string[], frame: GuideFrameLink): void {
  const key = names.join('\n');
  const link = useRef(frame);
  useEffect(() => {
    link.current = frame;
  });
  useEffect(() => {
    const send = (): void =>
      link.current.post({ type: 'avb:guide-variables', names: key === '' ? [] : key.split('\n') });
    send();
    return link.current.subscribeLoad(send);
  }, [key]);
}

/** A stored record as settings; every field it lacks or garbles is the default. */
export function parseGuideSettings(input: unknown): GuideSettings {
  if (typeof input !== 'object' || input === null) {
    return GUIDE_DEFAULTS;
  }
  const value = new Map<string, unknown>(Object.entries(input));
  const visible = value.get('visible');
  const numbers = value.get('numbers');
  return {
    visible: typeof visible === 'boolean' ? visible : GUIDE_DEFAULTS.visible,
    columns: storedColumns(value),
    color: colorOr(value.get('color')),
    opacity: opacityOr(value.get('opacity')),
    numbers: typeof numbers === 'boolean' ? numbers : GUIDE_DEFAULTS.numbers,
    margin: sizeOr(value.get('margin')),
    gutter: sizeOr(value.get('gutter')),
    widthMax: sizeOr(value.get('widthMax')),
  };
}

/** A colour the guide can paint: a literal CSS colour, within the length bound. */
export function parseGuideColor(input: unknown): string | undefined {
  if (typeof input !== 'string') {
    return undefined;
  }
  const value = input.trim();
  if (value.length === 0) {
    return undefined;
  }
  if (value.length > GUIDE_LIMITS.colorCharsMax) {
    return undefined;
  }
  // A variable means nothing in the app's document, where the guide is drawn.
  if (value.includes('var(')) {
    return undefined;
  }
  return CSS.supports('color', value) ? value : undefined;
}

// ⇧G shows or hides the guide, outside fields. The canvas replays it as the
// key "G" with no modifier flags (electron/preload/frameDesign.ts), so the
// capital letter is what says Shift.
function useGuideShortcut(update: GuideUpdate): void {
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key !== 'G') {
        return;
      }
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.closest('input, textarea, select, [contenteditable="true"]')) {
          return;
        }
      }
      event.preventDefault();
      update((settings) => ({ ...settings, visible: !settings.visible }));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [update]);
}

function storageKey(projectKey: string): string {
  assert(projectKey.length > 0, 'Guide settings: project key is non-empty');
  assert(projectKey.length <= BOUNDARY_LIMITS.pathLengthMax, 'Guide settings: key within limit');
  return GUIDE_STORAGE_PREFIX + projectKey;
}

// Undefined when nothing was stored, so there is nothing to migrate into the project file.
export function loadLegacyGuideSettings(projectKey: string | undefined): GuideSettings | undefined {
  if (projectKey === undefined) {
    return undefined;
  }
  const key = storageKey(projectKey);
  try {
    const raw = localStorage.getItem(key) ?? undefined;
    if (raw === undefined) {
      return undefined;
    }
    if (raw.length > GUIDE_STORED_CHARS_MAX) {
      return GUIDE_DEFAULTS;
    }
    const stored: unknown = JSON.parse(raw);
    return parseGuideSettings(stored);
  } catch {
    // Unreadable storage or a corrupt record: the defaults, never a failed load.
    return GUIDE_DEFAULTS;
  }
}

function storedColumns(value: ReadonlyMap<string, unknown>): GuideColumnSetting {
  const columns = columnsOr(value.get('columns'), value.get('columnVariable'));
  if (value.get('columnDefaultsVersion') !== GUIDE_COLUMN_DEFAULTS_VERSION) {
    if (columns.kind === 'count') {
      if (columns.count === GUIDE_COLUMN_COUNT_DEFAULT) {
        return GUIDE_DEFAULTS.columns;
      }
    }
  }
  return columns;
}

// Old versions stored a preset number or "project" with a separate variable.
// Keep deliberate choices while migrating the old automatic default.
function columnsOr(input: unknown, legacyVariable: unknown): GuideColumnSetting {
  if (isGuideColumnPick(input)) {
    return { kind: 'count', count: input };
  }
  if (input === 'project') {
    const name = parseGuideVariableName(legacyVariable);
    return name === undefined ? GUIDE_DEFAULTS.columns : { kind: 'variable', name };
  }
  if (typeof input !== 'object' || input === null) {
    return GUIDE_DEFAULTS.columns;
  }
  const value = new Map<string, unknown>(Object.entries(input));
  switch (value.get('kind')) {
    case 'automatic':
      return GUIDE_DEFAULTS.columns;
    case 'count': {
      const count = value.get('count');
      return isGuideColumnPick(count) ? { kind: 'count', count } : GUIDE_DEFAULTS.columns;
    }
    case 'variable': {
      const name = parseGuideVariableName(value.get('name'));
      return name === undefined ? GUIDE_DEFAULTS.columns : { kind: 'variable', name };
    }
    default:
      return GUIDE_DEFAULTS.columns;
  }
}

function colorOr(input: unknown): string {
  return parseGuideColor(input) ?? GUIDE_DEFAULTS.color;
}

function opacityOr(input: unknown): number {
  if (typeof input === 'number') {
    return Number.isFinite(input) ? clampGuideOpacity(input) : GUIDE_DEFAULTS.opacity;
  }
  return GUIDE_DEFAULTS.opacity;
}

// A menu value is stored as the record it is, and read back through the
// parsers a typed one goes through, so both answer to the same bounds. Absent
// or unreadable, it is unset: the default applies.
function sizeOr(input: unknown): GuideSize | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const value = new Map<string, unknown>(Object.entries(input));
  switch (value.get('kind')) {
    case 'length':
      return storedLength(value.get('length'));
    case 'variable': {
      const name = parseGuideVariableName(value.get('name'));
      return name === undefined ? undefined : { kind: 'variable', name };
    }
    default:
      return undefined;
  }
}

function storedLength(input: unknown): GuideSize | undefined {
  if (typeof input !== 'object' || input === null) {
    return undefined;
  }
  const value = new Map<string, unknown>(Object.entries(input));
  const amount = value.get('amount');
  const unit = value.get('unit');
  if (typeof amount !== 'number') {
    return undefined;
  }
  if (unit !== 'px') {
    if (unit !== 'rem') {
      return undefined;
    }
  }
  const length = parseGuideLength(`${amount}${unit}`);
  return length === undefined ? undefined : { kind: 'length', length };
}
