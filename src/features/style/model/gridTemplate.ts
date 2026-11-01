// Model for editing grid-template-columns / -rows as an ordered list of tracks, with
// per-track sizing (a "default" single size, or a minmax(min, max) pair). Reading
// expands `repeat(n, …)` and drops [line-name] tokens so the list is one entry per
// visible track; writing emits an explicit space-separated list (Webflow's native
// API drops some CSS functions, so we avoid repeat() on write).

/** Split a track list on TOP-LEVEL whitespace (parens / brackets protect commas,
 *  minmax(), repeat(), and [line names]). */
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

/** The visible tracks a grid-template value defines — `repeat(n, a b)` expands to n×
 *  its sub-tracks; [line-name] tokens are dropped. Empty for none / unset. */
export function parseTrackList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  const out: string[] = [];
  for (const track of splitTracks(trimmed)) {
    if (track.startsWith('[')) {
      continue;
    }
    const rep = track.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/is);
    if (rep) {
      const count = parseInt(rep[1] ?? '0', 10);
      const sub = splitTracks(rep[2] ?? '').filter((x) => !x.startsWith('['));
      for (let i = 0; i < count && sub.length; i += 1) {
        out.push(...sub);
      }
    } else {
      out.push(track);
    }
  }
  return out;
}

/** Join tracks back to a grid-template value ('' → clear the property). */
export function serializeTrackList(tracks: string[]): string {
  return tracks.length
    ? tracks
        .map((track) => track.trim())
        .filter(Boolean)
        .join(' ')
    : '';
}

// Two ways of writing the same grid.
//
//   repeat(2, minmax(0, 1fr))        the count, said once
//   minmax(0, 1fr) minmax(0, 1fr)    the tracks, written out
//
// Nothing chooses between them for the reader: the first is shorter and says
// "these are all the same", the second is what you want in front of you when
// one of them is about to stop being the same. Both are the same grid, so this
// is a way of writing, not a change to the layout — and the panel's own
// controls pick one each: the count stepper writes repeat(), and editing a
// track in the grid settings writes them all out.

/**
 * How a track list is written: a single `repeat()`, tracks written out that
 * could be a repeat(), tracks that differ (so they could not), or nothing.
 */
export function trackForm(value: string): 'repeat' | 'list' | 'mixed' | 'none' {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return 'none';
  }
  const top = splitTracks(trimmed).filter((x) => !x.startsWith('['));
  if (top.length === 1) {
    // `repeat(3, 1fr)` — a count and one track. `repeat(auto-fit, …)` is not a
    // count and has its own control, so it is left alone here.
    const rep = (top[0] ?? '').match(/^repeat\(\s*\d+\s*,(.*)\)$/is);
    if (rep && splitTracks(rep[1] ?? '').filter((x) => !x.startsWith('[')).length === 1) {
      return 'repeat';
    }
  }
  const tracks = parseTrackList(trimmed);
  if (tracks.length > 1 && tracks.every((x) => x === tracks[0])) {
    return 'list';
  }
  return 'mixed';
}

/** The same tracks written out one by one, or '' if there is nothing to write. */
export function asTrackList(value: string): string {
  return serializeTrackList(parseTrackList(value));
}

/**
 * Whether the track list controls can hold this value — that is, whether it is
 * a list of tracks at all.
 *
 * `!important`, a CSS-wide keyword, `subgrid`, or a variable standing in for
 * the whole list are all values a grid can have and the track editors cannot:
 * shown as tracks they would read as one track with a strange name, and the
 * first edit would write that reading back over what was there. So the panel
 * keeps those in the expression field and says the tracks are not available.
 */
export function canEditAsTracks(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return true;
  }
  if (/!\s*important/i.test(trimmed)) {
    return false;
  }
  const lower = trimmed.toLowerCase();
  if (/^(inherit|initial|unset|revert|revert-layer)$/.test(lower)) {
    return false;
  }
  if (/\b(subgrid|masonry)\b/.test(lower)) {
    return false;
  }
  const tracks = parseTrackList(trimmed);
  if (!tracks.length) {
    return lower === 'none';
  }
  // A variable in place of ONE track is a track — the editors hold it fine. One
  // in place of the whole list only looks like a track.
  if (tracks.length === 1 && /^var\(/i.test(tracks[0] ?? '')) {
    return false;
  }
  return true;
}

/** The same tracks as a `repeat()`, or '' when they differ and it cannot say them. */
export function asRepeat(value: string): string {
  const tracks = parseTrackList(value);
  if (tracks.length < 2 || !tracks.every((x) => x === tracks[0])) {
    return '';
  }
  return `repeat(${tracks.length}, ${tracks[0]})`;
}

export type TrackSize = { mode: 'default'; value: string } | { mode: 'minmax'; min: string; max: string };

/** Parse a single track into its sizing (a minmax pair, or a single value). */
export function parseTrackSize(track: string): TrackSize {
  const match = track.trim().match(/^minmax\(\s*(.+?)\s*,\s*(.+?)\s*\)$/is);
  if (match) {
    return { mode: 'minmax', min: (match[1] ?? '').trim(), max: (match[2] ?? '').trim() };
  }
  return { mode: 'default', value: track.trim() };
}

export function serializeTrackSize(size: TrackSize): string {
  if (size.mode === 'minmax') {
    return `minmax(${size.min.trim() || 'auto'}, ${size.max.trim() || '1fr'})`;
  }
  return size.value.trim() || 'auto';
}

export type TrackKind = 'auto' | 'fr' | 'length' | 'minmax' | 'content' | 'other';

/** Coarse classification for the row icon. */
export function trackKind(track: string): TrackKind {
  const normalized = track.trim().toLowerCase();
  if (/^minmax\(/.test(normalized) || /^fit-content\(/.test(normalized)) {
    return 'minmax';
  }
  if (normalized === 'auto') {
    return 'auto';
  }
  if (normalized === 'min-content' || normalized === 'max-content') {
    return 'content';
  }
  if (/^-?[\d.]+fr$/.test(normalized)) {
    return 'fr';
  }
  if (/^-?[\d.]+(px|%|rem|em|vw|vh|ch|vmin|vmax|pt|cm|mm|in)$/.test(normalized)) {
    return 'length';
  }
  return 'other';
}

/**
 * Whether a track is a `<fixed-size>` — the only track shape CSS permits inside an
 * auto-fit / auto-fill `repeat()`. Per the Grid spec that's:
 *   • a fixed `<length-percentage>` (20rem, 50%, …), OR
 *   • `minmax(<fixed-breadth>, <track-breadth>)` — a FIXED min, any max (so
 *     `minmax(20rem, 1fr)`, the canonical responsive pattern, qualifies), OR
 *   • `minmax(<inflexible-breadth>, <fixed-breadth>)` — an inflexible min (fixed /
 *     auto / min|max-content, but NOT fr) and a FIXED max.
 * Bare `fr`, `auto`, `min|max-content`, and `fit-content()` are NOT fixed-size.
 */
export function isFixedSizeTrack(track: string): boolean {
  const isFixedBreadth = (track: string) => trackKind(track) === 'length';
  const isInflexibleBreadth = (track: string) => ['length', 'auto', 'content'].includes(trackKind(track));
  const size = parseTrackSize(track);
  if (size.mode === 'default') {
    return isFixedBreadth(size.value);
  }
  return isFixedBreadth(size.min) || (isInflexibleBreadth(size.min) && isFixedBreadth(size.max));
}

/** Short human label for a track row (Webflow-style). */
export function trackLabel(track: string): string {
  const size = parseTrackSize(track);
  if (size.mode === 'minmax') {
    return `Min/Max: ${size.min} / ${size.max}`;
  }
  const sizeValue = size.value.trim();
  return sizeValue.toLowerCase() === 'auto' || !sizeValue ? 'Auto' : sizeValue;
}

// ── grid-template-areas ──
// A named area addressed by its 1-based, inclusive cell span (start/end column and
// start/end row) — the shape Webflow's Areas editor exposes.
export type GridArea = {
  name: string;
  colStart: number;
  colEnd: number;
  rowStart: number;
  rowEnd: number;
};
// One control's edit. Each member names the fields that control owns — an
// explicit update surface rather than `Partial<T>` (AGENTS.md §4).
export type GridAreaPatch =
  Pick<GridArea, 'name'> | Pick<GridArea, 'colStart'> | Pick<GridArea, 'colEnd'> | Pick<GridArea, 'rowStart'> | Pick<GridArea, 'rowEnd'>;

/** Parse a `grid-template-areas` value into its named areas (in first-appearance
 *  order), each as the bounding box of the cells its name occupies. `.` = empty. */
export function parseAreas(value: string): GridArea[] {
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'none') {
    return [];
  }
  const rowStrings = trimmed.match(/"[^"]*"|'[^']*'/g);
  if (!rowStrings) {
    return [];
  }
  const grid = rowStrings.map((row) => row.slice(1, -1).trim().split(/\s+/).filter(Boolean));
  const bounds = new Map<string, { r0: number; r1: number; c0: number; c1: number }>();
  const order: string[] = [];
  grid.forEach((cells, rowIndex) =>
    cells.forEach((name, columnIndex) => {
      if (name === '.') {
        return;
      }
      const bound = bounds.get(name);
      if (!bound) {
        bounds.set(name, { r0: rowIndex, r1: rowIndex, c0: columnIndex, c1: columnIndex });
        order.push(name);
      } else {
        bound.r0 = Math.min(bound.r0, rowIndex);
        bound.r1 = Math.max(bound.r1, rowIndex);
        bound.c0 = Math.min(bound.c0, columnIndex);
        bound.c1 = Math.max(bound.c1, columnIndex);
      }
    }),
  );
  return order.map((name) => {
    const bound = bounds.get(name);
    if (bound === undefined) {
      throw new Error(`Grid area invariant failed for ${name}`);
    }
    return {
      name,
      colStart: bound.c0 + 1,
      colEnd: bound.c1 + 1,
      rowStart: bound.r0 + 1,
      rowEnd: bound.r1 + 1,
    };
  });
}

/** Emit a `grid-template-areas` value from named areas — paints each area's rectangle
 *  into a grid sized to the furthest extent, `.` for uncovered cells ('' → clear). */
export function serializeAreas(areas: GridArea[]): string {
  const valid = areas.filter((area) => area.name.trim() && area.colStart >= 1 && area.rowStart >= 1);
  if (!valid.length) {
    return '';
  }
  const rows = Math.max(...valid.map((area) => Math.max(area.rowStart, area.rowEnd)));
  const cols = Math.max(...valid.map((area) => Math.max(area.colStart, area.colEnd)));
  const grid: string[][] = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '.'));
  for (const area of valid) {
    const rowFirst = Math.min(area.rowStart, area.rowEnd),
      rowLast = Math.max(area.rowStart, area.rowEnd);
    const columnFirst = Math.min(area.colStart, area.colEnd),
      columnLast = Math.max(area.colStart, area.colEnd);
    for (let rowNumber = rowFirst; rowNumber <= rowLast; rowNumber += 1) {
      const row = grid[rowNumber - 1];
      if (row === undefined) {
        throw new Error(`Grid row ${rowNumber} is outside its bounds`);
      }
      for (let column = columnFirst; column <= columnLast; column += 1) {
        row[column - 1] = area.name.trim();
      }
    }
  }
  return grid.map((row) => `"${row.join(' ')}"`).join(' ');
}

/** The list-row label: `{name} Row {rowStart} / Col {colStart}` (Webflow-style). */
export function areaLabel(area: GridArea): string {
  return `${area.name} Row ${area.rowStart} / Col ${area.colStart}`;
}

/** A unique `Area` / `Area-2` / … name not already used. */
export function nextAreaName(areas: GridArea[]): string {
  const used = new Set(areas.map((area) => area.name));
  if (!used.has('Area')) {
    return 'Area';
  }
  const candidateCount = areas.length + 2;
  for (let number = 2; number <= candidateCount; number += 1) {
    if (!used.has(`Area-${number}`)) {
      return `Area-${number}`;
    }
  }
  throw new Error('Grid area name search exceeded its bound');
}
