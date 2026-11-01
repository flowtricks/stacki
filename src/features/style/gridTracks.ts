// Grid tracks and flow as text: splitting and counting a template, building
// repeat(), reading and writing grid-auto-flow (GridControls.tsx).

// Grid-template track counting.
export function splitTracks(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value.trim()) {
    if (ch === '(' || ch === '[') {
      depth += 1;
      current += ch;
    } else if (ch === ')' || ch === ']') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (/\s/.test(ch) && depth === 0) {
      if (current) {
        parts.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}
// Number of tracks a grid-template value defines — expands `repeat(n, …)`, ignores
// [line-name] tokens. 0 when unset / none.
export function countTracks(value: string): number {
  const normalized = value.trim().toLowerCase();
  if (!normalized || normalized === 'none') {
    return 0;
  }
  let count = 0;
  for (const track of splitTracks(normalized)) {
    if (track.startsWith('[')) {
      continue;
    }
    const rep = track.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/i);
    if (rep) {
      count += parseInt(rep[1] ?? '0', 10) * Math.max(1, splitTracks(rep[2] ?? '').filter((x) => !x.startsWith('[')).length);
    } else {
      count += 1;
    }
  }
  return count;
}
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

// Whether a grid-template value is N equal tracks (representable by the count stepper):
// a single `repeat(n, <one track>)`, or N identical explicit tracks. Anything else (mixed
// sizes) is "custom" and belongs in the Configure-grid modal.
export const isUniformTracks = (value: string) => {
  const tracks = splitTracks(value.trim()).filter((x) => !x.startsWith('['));
  if (tracks.length === 0) {
    return false;
  }
  if (tracks.length === 1) {
    const rep = (tracks[0] ?? '').match(/^repeat\(\s*\d+\s*,(.*)\)$/i);
    if (rep) {
      return splitTracks(rep[1] ?? '').filter((x) => !x.startsWith('[')).length === 1;
    }
  }
  return tracks.every((x) => x === tracks[0]);
};

// grid-auto-flow is a preset when every token is row / column / dense; anything else
// (a CSS-wide keyword, var(), …) is a custom value edited in the text field.
export function isPresetFlow(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return true;
  }
  return normalized.split(/\s+/).every((token) => token === 'row' || token === 'column' || token === 'dense');
}
