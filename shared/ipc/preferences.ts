import { boolean, object, record } from '../core/boundary';
import { canvasScrollbarPreferenceText, parseCanvasScrollbarPreference } from '../properties/canvasScrollbarChoice';

export const PREFERENCE_NAMES = [
  'sound',
  'usageCountsEnabled',
  'appsPersonHidden',
  'aiAskBeforeTrust',
  'aiTrackChanges',
  'aiReviewChanges',
  'codeChips',
] as const;
export type PreferenceName = (typeof PREFERENCE_NAMES)[number];

export function parsePreferenceName(input: unknown): PreferenceName {
  const found = PREFERENCE_NAMES.find((name) => name === input);
  if (found === undefined) {
    throw new Error('Unknown preference');
  }
  return found;
}

/** The one preference that is not on or off: where Chromium's own scrollbar starts on the canvas (canvasScrollbar.ts). */
export const CANVAS_SCROLLBAR_SETTING = 'canvasScrollbar';

/** What `settings:set` carries: a switch flipped, or the canvas scrollbar's breakpoint as stored (`off` or an id). */
export type PreferenceChange =
  { readonly setting: PreferenceName; readonly enabled: boolean } | { readonly setting: typeof CANVAS_SCROLLBAR_SETTING; readonly value: string };

/** A `settings:set` payload. Its output parses again unchanged: the renderer sends what it parsed, and main checks it. */
export function parsePreferenceChange(input: unknown): PreferenceChange {
  const fields = record(input);
  if (fields['setting'] === CANVAS_SCROLLBAR_SETTING) {
    const value = canvasScrollbarPreferenceText(parseCanvasScrollbarPreference(fields['value']));
    return { setting: CANVAS_SCROLLBAR_SETTING, value };
  }
  return { setting: parsePreferenceName(fields['setting']), enabled: boolean(fields['enabled']) };
}

export const parsePreferences = object({
  sound: boolean,
  usageCountsEnabled: boolean,
  appsPersonHidden: boolean,
  aiAskBeforeTrust: boolean,
  aiTrackChanges: boolean,
  aiReviewChanges: boolean,
  codeChips: boolean,
  canvasScrollbar: parseCanvasScrollbarPreference,
});
export const parsePreferenceResult = object({
  sound: boolean,
  usageCountsEnabled: boolean,
  appsPersonHidden: boolean,
  aiAskBeforeTrust: boolean,
  aiTrackChanges: boolean,
  aiReviewChanges: boolean,
  codeChips: boolean,
  canvasScrollbar: parseCanvasScrollbarPreference,
  saved: boolean,
});
