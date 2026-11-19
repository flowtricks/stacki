/*
 * The Assets panel's view and sort, remembered per project. They are a person's way of looking at the
 * files, not part of the site, so they live in this app's local storage (as the insert palette's folder
 * pill does, src/features/palette/insertPreferences.ts), never in a tracked `.stacki/` file.
 *
 * Stored as one short list of [project, { view, sort }] pairs, newest first. Opening many projects
 * forgets the least recently changed first; that bounds the list, never a project's assets. Storage is
 * shared with every earlier build, so what it holds is parsed like any input, and missing, full or
 * blocked storage falls back to the defaults without ever stopping the panel from drawing.
 */
import { useCallback, useState } from 'react';
import { assert } from '../../../shared/core/assert';
import { ASSET_SORT_DEFAULT, ASSET_VIEW_DEFAULT, isAssetSort, isAssetView, type AssetSort, type AssetView } from './assetOrder';

export const ASSET_VIEWS_KEY = 'stacki.assetsPanel.views';

/** Projects whose choice is remembered; the least recently changed is forgotten first. */
export const ASSET_VIEW_PROJECTS_MAX = 50;

/** One project's identity is a path or a workspace id; anything longer is not one. */
const PROJECT_KEY_CHARS_MAX = 4096;

export interface AssetViewChoice {
  readonly view: AssetView;
  readonly sort: AssetSort;
}

export const ASSET_VIEW_CHOICE_DEFAULT: AssetViewChoice = { view: ASSET_VIEW_DEFAULT, sort: ASSET_SORT_DEFAULT };

export type StoredAssetViews = ReadonlyArray<readonly [string, AssetViewChoice]>;

type ViewStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** The stored list, or an empty one: unreadable, malformed or oversized entries are dropped, never trusted. */
export function parseStoredAssetViews(raw: unknown): StoredAssetViews {
  if (typeof raw !== 'string') {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  // Read as unknowns: `Array.isArray` narrows to `any[]`, which would let an entry through unchecked.
  const stored: readonly unknown[] = parsed;
  const entries: Array<readonly [string, AssetViewChoice]> = [];
  for (const entry of stored.slice(0, ASSET_VIEW_PROJECTS_MAX)) {
    const pair = parsePair(entry);
    if (pair !== undefined && !entries.some(([project]) => project === pair[0])) {
      entries.push(pair);
    }
  }
  assert(entries.length <= ASSET_VIEW_PROJECTS_MAX, 'The stored list stays within its project count');
  return entries;
}

function parsePair(entry: unknown): readonly [string, AssetViewChoice] | undefined {
  if (!Array.isArray(entry)) {
    return undefined;
  }
  const pair: readonly unknown[] = entry;
  if (pair.length !== 2) {
    return undefined;
  }
  const project = pair[0];
  const choice = pair[1];
  if (typeof project !== 'string' || project.length === 0 || project.length > PROJECT_KEY_CHARS_MAX) {
    return undefined;
  }
  if (typeof choice !== 'object' || choice === null) {
    return undefined;
  }
  const view: unknown = Reflect.get(choice, 'view');
  const sort: unknown = Reflect.get(choice, 'sort');
  if (isAssetView(view) && isAssetSort(sort)) {
    return [project, { view, sort }];
  }
  return undefined;
}

/** The project's remembered choice, or the defaults. */
export function loadAssetViewChoice(project: string, storage?: ViewStorage): AssetViewChoice {
  try {
    // Inside the try: where storage is missing altogether, even naming it throws.
    return parseStoredAssetViews((storage ?? localStorage).getItem(ASSET_VIEWS_KEY)).find(([stored]) => stored === project)?.[1] ?? ASSET_VIEW_CHOICE_DEFAULT;
  } catch {
    return ASSET_VIEW_CHOICE_DEFAULT;
  }
}

/** Remembers the project's choice, first in the list. */
export function saveAssetViewChoice(project: string, choice: AssetViewChoice, storage?: ViewStorage): void {
  assert(project.length > 0, 'A remembered choice belongs to a project');
  try {
    const target = storage ?? localStorage;
    const others = parseStoredAssetViews(target.getItem(ASSET_VIEWS_KEY)).filter(([stored]) => stored !== project);
    const first: readonly [string, AssetViewChoice] = [project, choice];
    const next: StoredAssetViews = [first, ...others].slice(0, ASSET_VIEW_PROJECTS_MAX);
    target.setItem(ASSET_VIEWS_KEY, JSON.stringify(next));
  } catch {
    /* noop: an unsaved choice lasts until the panel closes */
  }
}

/**
 * The panel's view and sort, read from storage before the first frame (the state's initial value),
 * so the panel opens in the remembered view with no frame of the default first.
 */
export function useAssetViewChoice(project: string): readonly [AssetViewChoice, (next: AssetViewChoice) => void] {
  const [choice, setChoice] = useState(() => loadAssetViewChoice(project));
  const choose = useCallback(
    (next: AssetViewChoice): void => {
      setChoice(next);
      saveAssetViewChoice(project, next);
    },
    [project],
  );
  return [choice, choose];
}
