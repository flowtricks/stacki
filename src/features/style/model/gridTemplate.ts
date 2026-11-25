// Model for grid-template-columns / -rows: the tracks of a value, per-track sizing
// (a "default" single size, or a minmax(min, max) pair), which values a count can say
// (classifyTrackCount) and what a typed track list may write (checkTrackExpression).
import { ENGLISH_TRANSLATE } from '../../../../shared/properties/i18n/englishTranslator';
import type { Translator } from '../../../../shared/properties/i18n/messageRef';

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

/**
 * What the Columns and Rows count control can say about a value.
 *
 * A count is faithful only when the value IS "N equal tracks": a number of tracks
 * that are all `1fr`, `minmax(0, 1fr)` or `auto` (the sizes the stepper itself writes),
 * said as `repeat(N, track)` or written out. Writing a count replaces the value with
 * `repeat(N, track)`, so for anything else the number would be a lie and the write
 * would destroy what was there. Those values are an `expression`: the control shows
 * the value itself as text (`subgrid` says whether it is a subgrid, which has its own
 * switch). Never decided by typing a count: only the explicit "Switch to count" turns
 * an expression into a count.
 *
 * Expressions: auto-fit / auto-fill repeats, a variable count, a variable for the
 * list, `subgrid`, `masonry`, named lines, mixed sizes (`100px 1fr`, `1fr 2fr`),
 * fixed lengths, `minmax()` with any non-fr bound, `calc()` / `clamp()` / `min()` /
 * `max()` / `fit-content()` sizes, `min-content` / `max-content`, a repeat of several
 * tracks, a count outside 1..500, `!important` and CSS-wide keywords.
 */
export type TrackCount = { readonly kind: 'count'; readonly count: number } | { readonly kind: 'expression'; readonly subgrid: boolean };

// The sizes that make equal tracks countable: what the count stepper writes.
const EQUAL_TRACK = /^(1fr|auto|minmax\(\s*0(px)?\s*,\s*1fr\s*\))$/i;

/** The largest count the stepper writes (GridFlowControls clampCount). */
const TRACK_COUNT_MAX = 500;

/** Classify a `grid-template-columns` / `-rows` value (with its `!important`, if any) for the count control. */
export function classifyTrackCount(value: string): TrackCount {
  const trimmed = value.trim();
  const lower = trimmed.toLowerCase();
  if (!trimmed || lower === 'none') {
    return { kind: 'count', count: 0 };
  }
  const expression: TrackCount = { kind: 'expression', subgrid: /\bsubgrid\b/.test(lower) };
  if (/!\s*important/.test(lower)) {
    return expression;
  }
  const tokens = splitTracks(trimmed);
  const first = tokens[0] ?? '';
  const repeated = tokens.length === 1 ? first.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/is) : undefined;
  if (repeated) {
    const count = parseInt(repeated[1] ?? '0', 10);
    const sizes = splitTracks(repeated[2] ?? '');
    const size = sizes[0] ?? '';
    const countable = sizes.length === 1 && EQUAL_TRACK.test(size) && count >= 1 && count <= TRACK_COUNT_MAX;
    return countable ? { kind: 'count', count } : expression;
  }
  const equal = tokens.length <= TRACK_COUNT_MAX && tokens.every((token) => EQUAL_TRACK.test(token) && token.replace(/\s+/g, '') === first.replace(/\s+/g, ''));
  return equal ? { kind: 'count', count: tokens.length } : expression;
}

/** Why a typed track list cannot be written: nothing in it, or text that is not one value. */
export type TrackExpressionProblem = 'empty' | 'malformed';

export type TrackExpressionCheck =
  { readonly kind: 'ok'; readonly value: string; readonly important: boolean } | { readonly kind: 'invalid'; readonly problem: TrackExpressionProblem };

/**
 * Check a typed track list before it is written: not empty, parentheses and
 * brackets balanced and in order, and nothing that would end the declaration
 * (`;`, braces). A trailing `!important` is the flag, not part of the value.
 */
export function checkTrackExpression(text: string): TrackExpressionCheck {
  let value = text.trim();
  const flag = value.match(/!\s*important\s*$/i);
  if (flag) {
    value = value.slice(0, flag.index).trim();
  }
  if (!value) {
    return { kind: 'invalid', problem: 'empty' };
  }
  if (/[;{}]/.test(value)) {
    return { kind: 'invalid', problem: 'malformed' };
  }
  const closers: string[] = [];
  for (const ch of value) {
    if (ch === '(') {
      closers.push(')');
    } else if (ch === '[') {
      closers.push(']');
    } else if (ch === ')' || ch === ']') {
      if (closers.pop() !== ch) {
        return { kind: 'invalid', problem: 'malformed' };
      }
    }
  }
  return closers.length === 0 ? { kind: 'ok', value, important: flag !== null } : { kind: 'invalid', problem: 'malformed' };
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

/** Short human label for a track row (Webflow-style). */
export function trackLabel(track: string, translate: Translator = ENGLISH_TRANSLATE): string {
  const size = parseTrackSize(track);
  if (size.mode === 'minmax') {
    return translate('styleModel.grid.track.minMax', { min: size.min, max: size.max });
  }
  const sizeValue = size.value.trim();
  return sizeValue.toLowerCase() === 'auto' || !sizeValue ? translate('styleModel.grid.track.auto') : sizeValue;
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
export function areaLabel(area: GridArea, translate: Translator = ENGLISH_TRANSLATE): string {
  return translate('styleModel.grid.area.position', { name: area.name, row: area.rowStart, column: area.colStart });
}

/** A unique `Area` / `Area-2` / … name not already used. */
export function nextAreaName(areas: GridArea[]): string {
  const used = new Set(areas.map((area) => area.name));
  if (!used.has('Area')) {
    // i18n-ignore: the generated name is an identifier written into the user's grid-template-areas.
    return 'Area';
  }
  const candidateCount = areas.length + 2;
  for (let number = 2; number <= candidateCount; number += 1) {
    if (!used.has(`Area-${number}`)) {
      // i18n-ignore: the generated name is an identifier written into the user's grid-template-areas.
      return `Area-${number}`;
    }
  }
  throw new Error('Grid area name search exceeded its bound');
}
