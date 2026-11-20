// The left panel a window opens on: the one the last session left open for the project, when the rail still has it.
// The boot snapshot (shared/properties/bootSnapshot.ts) stores the panel's id as text, so an id an earlier build
// wrote is read here, never trusted: one the rail no longer has opens the Navigator. The Instructions panel became
// sections of Settings, so a snapshot that left it open reopens Settings with those sections expanded.
import type { LeftTab } from '../appTypes';

export interface SeededLeftTab {
  readonly tab: NonNullable<LeftTab>;
  /** Whether the Settings panel must open with the Instructions sections shown (the migration of the old panel id). */
  readonly showInstructions: boolean;
}

/** The panels a session restores. The rest (Apps, Audits, AI, Properties) open on demand, as before. */
const RESTORED: Readonly<Record<string, NonNullable<LeftTab>>> = {
  pages: 'pages',
  navigator: 'navigator',
  components: 'components',
  assets: 'assets',
  cms: 'cms',
  variables: 'variables',
  selectors: 'selectors',
  code: 'code',
  history: 'history',
  projectSettings: 'projectSettings',
  // The retired Instructions panel id.
  instructions: 'projectSettings',
};

export function seededLeftTabOf(remembered: string | undefined): SeededLeftTab {
  if (remembered === undefined) {
    return { tab: 'navigator', showInstructions: false };
  }
  const tab = Object.hasOwn(RESTORED, remembered) ? RESTORED[remembered] : undefined;
  return { tab: tab ?? 'navigator', showInstructions: remembered === 'instructions' };
}
