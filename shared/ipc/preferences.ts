import { boolean, object } from '../core/boundary';

export const PREFERENCE_NAMES = ['sound', 'usageCountsEnabled', 'appsPersonHidden', 'aiAskBeforeTrust', 'aiTrackChanges'] as const;
export type PreferenceName = (typeof PREFERENCE_NAMES)[number];

export function parsePreferenceName(input: unknown): PreferenceName {
  const found = PREFERENCE_NAMES.find((name) => name === input);
  if (found === undefined) {
    throw new Error('Unknown preference');
  }
  return found;
}

export const parsePreferences = object({
  sound: boolean,
  usageCountsEnabled: boolean,
  appsPersonHidden: boolean,
  aiAskBeforeTrust: boolean,
  aiTrackChanges: boolean,
});
export const parsePreferenceResult = object({
  sound: boolean,
  usageCountsEnabled: boolean,
  appsPersonHidden: boolean,
  aiAskBeforeTrust: boolean,
  aiTrackChanges: boolean,
  saved: boolean,
});
