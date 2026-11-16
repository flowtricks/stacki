// Grid tracks and flow as text: building
// repeat(), reading and writing grid-auto-flow (GridControls.tsx).

// Default size for a newly-created track: a column fills its share but can shrink to
// nothing (so content can't blow the grid out), a row is content-sized.
export const NEW_COLUMN = 'minmax(0, 1fr)';
export const NEW_ROW = 'auto';

// The count stepper writes N UNIFORM tracks of the axis default in Webflow's compact
// `repeat()` form — e.g. 2 columns → `repeat(2, minmax(0, 1fr))`. It's the "how many
// tracks" control, so it normalises ALL tracks, not just newly-added ones; per-track
// custom sizes are set/kept in the Configure-grid modal instead (its "+" preserves them).
export const repeatTracks = (count: number, cell: string) => `repeat(${Math.max(1, count)}, ${cell})`;

// grid-auto-flow is a direction (row | column) optionally packed `dense`.
export interface Flow {
  readonly direction: string;
  readonly dense: boolean;
}
export function parseFlow(value: string): Flow {
  const lowered = value.toLowerCase();
  return {
    direction: lowered.includes('column') ? 'column' : 'row',
    dense: lowered.includes('dense'),
  };
}
export const buildFlow = ({ direction, dense }: Flow) => (dense ? `${direction} dense` : direction);

// grid-auto-flow is a preset when every token is row / column / dense; anything else
// (a CSS-wide keyword, var(), …) is a custom value edited in the text field.
export function isPresetFlow(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized.split(/\s+/).every((token) => token === 'row' || token === 'column' || token === 'dense');
}
