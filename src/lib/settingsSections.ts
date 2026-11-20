/*
 * The Settings panel's views and sections, in the one place both hosts and every feature that draws one read:
 * the views the root lists (Secrets, MCP, Instructions), the Instructions view's foldable sections, their titles, which of them the person folded (remembered per project, src/lib/projectPreference.ts),
 * what the panel hands each section while it draws (`SettingsSectionsContext`), and the request other parts of
 * the app make to open Settings at a section (the old Instructions shortcut, a link to an instruction file).
 *
 * Why here: Secrets, MCP servers and the three Instructions groups live in different features, which may not
 * import one another, and the panel's search, folding and detail views are shared by all of them. This module
 * sits below the features, so each imports it and none imports another.
 */
import { assert } from '../../shared/core/assert';
import type { MessageKey } from './i18n/localeContext';
import { loadProjectPreference, saveProjectPreference, type PreferenceStorage, type ProjectPreferenceSpec } from './projectPreference';

/** The Settings panel's root is a short list of these; each opens its own view in place of the list. */
export const SETTINGS_VIEW_IDS = ['secrets', 'mcp', 'instructions'] as const;
export type SettingsViewId = (typeof SETTINGS_VIEW_IDS)[number];

export const SETTINGS_VIEW_TITLE_KEYS: Readonly<Record<SettingsViewId, MessageKey>> = {
  secrets: 'settings.section.secrets',
  mcp: 'settings.section.mcp',
  instructions: 'settings.section.instructions',
};

/** The foldable sections of the Instructions view, in the order they are drawn. */
export const SETTINGS_SECTION_IDS = ['skills', 'rules', 'docs'] as const;
export type SettingsSectionId = (typeof SETTINGS_SECTION_IDS)[number];

/** The section's heading. Skills, Rules and Docs keep the titles the Instructions panel gave them. */
export const SETTINGS_SECTION_TITLE_KEYS: Readonly<Record<SettingsSectionId, MessageKey>> = {
  skills: 'instructionsPanel.skills.title',
  rules: 'instructionsPanel.rules.title',
  docs: 'instructionsPanel.docs.title',
};

/** The sections a view folds: only Instructions has any, the other views are single forms. */
export function sectionsOfView(view: SettingsViewId): readonly SettingsSectionId[] {
  return view === 'instructions' ? SETTINGS_SECTION_IDS : [];
}

/** What a request to open Settings names: a view, or one section of the Instructions view. */
export type SettingsFocusTarget = SettingsViewId | SettingsSectionId;

export function isSettingsSectionId(value: unknown): value is SettingsSectionId {
  return SETTINGS_SECTION_IDS.some((id) => id === value);
}

/** The view a focus request opens, the sections it expands, and the one it scrolls to. */
export function viewOfTarget(target: SettingsFocusTarget): {
  readonly view: SettingsViewId;
  readonly open: readonly SettingsSectionId[];
  readonly scrollTo: SettingsSectionId | undefined;
} {
  if (target === 'secrets' || target === 'mcp') {
    return { view: target, open: [], scrollTo: undefined };
  }
  if (target === 'instructions') {
    return { view: 'instructions', open: SETTINGS_SECTION_IDS, scrollTo: 'skills' };
  }
  return { view: 'instructions', open: [target], scrollTo: target };
}

// ---------------------------------------------------------------------------
// Folded sections, per project
// ---------------------------------------------------------------------------

export const SETTINGS_FOLDED_KEY = 'stacki.settingsPanel.folded';

/** Projects whose folded sections are remembered; the least recently changed is forgotten first. */
export const SETTINGS_FOLDED_PROJECTS_MAX = 50;

/** The folded sections as stored: a list of known ids, each once. Anything else is not a choice. */
export function parseFoldedSections(stored: unknown): readonly SettingsSectionId[] | undefined {
  if (!Array.isArray(stored)) {
    return undefined;
  }
  const items: readonly unknown[] = stored;
  if (items.length > SETTINGS_SECTION_IDS.length) {
    return undefined;
  }
  const folded: SettingsSectionId[] = [];
  for (const item of items) {
    if (!isSettingsSectionId(item) || folded.includes(item)) {
      return undefined;
    }
    folded.push(item);
  }
  return folded;
}

export const SETTINGS_FOLDED_SPEC: ProjectPreferenceSpec<readonly SettingsSectionId[]> = {
  storageKey: SETTINGS_FOLDED_KEY,
  projectsMax: SETTINGS_FOLDED_PROJECTS_MAX,
  parseValue: parseFoldedSections,
};

/** The sections the project's person folded; none when nothing is stored. */
export function loadFoldedSections(project: string, storage?: PreferenceStorage): ReadonlySet<SettingsSectionId> {
  return new Set(loadProjectPreference(SETTINGS_FOLDED_SPEC, project, storage) ?? []);
}

export function saveFoldedSections(project: string, folded: ReadonlySet<SettingsSectionId>, storage?: PreferenceStorage): void {
  // Written in the sections' own order, so one fold state is one stored text.
  saveProjectPreference(
    SETTINGS_FOLDED_SPEC,
    project,
    SETTINGS_SECTION_IDS.filter((id) => folded.has(id)),
    storage,
  );
}

// ---------------------------------------------------------------------------
// What the Instructions view hands its sections
// ---------------------------------------------------------------------------

/** A bulk fold: every section and folder at once. `serial` changes with each request so one repeats. */
export interface SettingsBulkRequest {
  readonly serial: number;
  readonly mode: 'expand' | 'collapse' | undefined;
}

export interface SettingsSectionsContext {
  /** The search text, never remembered. */
  readonly query: string;
  /** Whether the query has a word: results are shown, every section with a match open. */
  readonly searching: boolean;
  /** Counts up on Refresh; a section reads again when it changes. */
  readonly refreshSerial: number;
  readonly bulk: SettingsBulkRequest;
  /** Whether the section is drawn open: always while searching, else unless the person folded it. */
  readonly isOpen: (id: SettingsSectionId) => boolean;
  readonly toggle: (id: SettingsSectionId) => void;
  readonly open: (id: SettingsSectionId) => void;
  /** A section tells the panel how many rows match (`undefined` while it has not read yet), so the panel can say when none do. */
  readonly report: (id: SettingsSectionId, matches: number | undefined) => void;
  readonly clearSearch: () => void;
}

// ---------------------------------------------------------------------------
// Opening Settings at a section
// ---------------------------------------------------------------------------

interface FocusRequest {
  readonly target: SettingsFocusTarget;
  readonly serial: number;
}

let focusRequest: FocusRequest | undefined;
let focusSerial = 0;
const focusListeners = new Set<() => void>();
/** The panel is the one listener; a few more for tests and hosts. */
const FOCUS_LISTENERS_MAX = 8;

/** Asks Settings to open at `target` the next time it shows (or now, when it is open). The panel otherwise opens on its root. */
export function requestSettingsSection(target: SettingsFocusTarget): void {
  focusSerial += 1;
  focusRequest = { target, serial: focusSerial };
  for (const listener of focusListeners) {
    listener();
  }
}

/** The request waiting to be shown, taken so it is shown once. */
export function takeSettingsRequest(): SettingsFocusTarget | undefined {
  const taken = focusRequest;
  focusRequest = undefined;
  return taken?.target;
}

/** Counts every request; a panel subscribed to it looks for one to take when it changes. */
export function settingsRequestSerial(): number {
  return focusSerial;
}

export function subscribeSettingsRequests(listener: () => void): () => void {
  assert(focusListeners.size < FOCUS_LISTENERS_MAX, 'Settings request listeners are bounded');
  focusListeners.add(listener);
  return () => {
    focusListeners.delete(listener);
  };
}

// ---------------------------------------------------------------------------
// The view Settings shows
// ---------------------------------------------------------------------------

let shownView: SettingsViewId | undefined;

/** The panel publishes the view it shows (undefined: the root, or closed), so a shortcut can tell "open" from "toggle". */
export function publishSettingsView(view: SettingsViewId | undefined): void {
  shownView = view;
}

export function shownSettingsView(): SettingsViewId | undefined {
  return shownView;
}
