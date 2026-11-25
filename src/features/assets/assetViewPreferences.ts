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
import {
  loadProjectPreference,
  parseStoredPreferences,
  saveProjectPreference,
  type PreferenceStorage,
  type ProjectPreferenceSpec,
} from '../../lib/projectPreference';
import { ASSET_SORT_DEFAULT, ASSET_VIEW_DEFAULT, isAssetSort, isAssetView, type AssetSort, type AssetView } from './assetOrder';

export const ASSET_VIEWS_KEY = 'stacki.assetsPanel.views';

/** Projects whose choice is remembered; the least recently changed is forgotten first. */
export const ASSET_VIEW_PROJECTS_MAX = 50;

export interface AssetViewChoice {
  readonly view: AssetView;
  readonly sort: AssetSort;
}

export const ASSET_VIEW_CHOICE_DEFAULT: AssetViewChoice = { view: ASSET_VIEW_DEFAULT, sort: ASSET_SORT_DEFAULT };

export type StoredAssetViews = ReadonlyArray<readonly [string, AssetViewChoice]>;

type ViewStorage = PreferenceStorage;

function parseChoice(stored: unknown): AssetViewChoice | undefined {
  if (typeof stored !== 'object' || stored === null) {
    return undefined;
  }
  const view: unknown = Reflect.get(stored, 'view');
  const sort: unknown = Reflect.get(stored, 'sort');
  return isAssetView(view) && isAssetSort(sort) ? { view, sort } : undefined;
}

const SPEC: ProjectPreferenceSpec<AssetViewChoice> = { storageKey: ASSET_VIEWS_KEY, projectsMax: ASSET_VIEW_PROJECTS_MAX, parseValue: parseChoice };

/** The stored list, or an empty one: unreadable, malformed or oversized entries are dropped, never trusted. */
export function parseStoredAssetViews(raw: unknown): StoredAssetViews {
  return parseStoredPreferences(raw, SPEC);
}

/** The project's remembered choice, or the defaults. */
export function loadAssetViewChoice(project: string, storage?: ViewStorage): AssetViewChoice {
  return loadProjectPreference(SPEC, project, storage) ?? ASSET_VIEW_CHOICE_DEFAULT;
}

/** Remembers the project's choice, first in the list. */
export function saveAssetViewChoice(project: string, choice: AssetViewChoice, storage?: ViewStorage): void {
  saveProjectPreference(SPEC, project, choice, storage);
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
