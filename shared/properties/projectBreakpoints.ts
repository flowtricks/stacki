// `.stacki/breakpoints.json`: Desktop's frame width and the breakpoints the preview bar jumps to.
//
//   { "version": 4,
//     "desktop": { "value": 90, "unit": "rem" },
//     "breakpoints": [
//       { "id": "bp-1", "name": "Large", "value": 100, "unit": "rem" },
//       { "id": "laptop",                 "value": 64,  "unit": "rem" },
//       { "id": "tablet",                 "value": 48,  "unit": "rem" },
//       { "id": "phone",                  "value": 30,  "unit": "rem" } ] }
//
// Desktop is the base of the bar. Its value here is NOT a media query and is never written into one: it is the width of the
// Desktop frame in the side-by-side (all breakpoints) view, 90rem (1440px) by default, the width the single canvas's Desktop
// button draws (scaled to fit) when the pane has no room for it (usePreviewSizing previewFrameWidth), and the line that decides
// on which side of Desktop a breakpoint falls.
//
// A breakpoint has no direction to choose: it is DERIVED from its number against Desktop's. Wider than Desktop it is an `up`
// breakpoint, the query `width >= X` (mobile first), and its canvas is exactly X (100rem is 1600px). Narrower, it is a `down`
// breakpoint, the query `width < X`, and its canvas is the largest whole pixel below it (64rem is 1023px). Equal to Desktop is not
// allowed. The project's own Lumos breakpoints (min-width 30rem, 48rem, 64rem) are the defaults, as `down` breakpoints named by
// their ids. Any rem or px numbers work.
//
// The list is strictly decreasing in pixels, Desktop included: the wider ones, Desktop, the narrower ones. So a card's neighbours are
// its limits, and Desktop may only move between the largest narrower breakpoint and the smallest wider one (it never flips one to
// the other side). A breakpoint may be removed (the list may be empty), and up to `BREAKPOINT_LIMITS.countMax` may exist. `id` is
// stable (the sync record and the preview device are named by it); `name` is optional, and absent for a built-in one it reads as the
// translated Laptop, Tablet or Phone.
//
// It is a tracked project file in the same family as `.stacki/guide.json`, shared by Desktop and Studio and committed with the
// project. The file is created by the first edit, never by reading, and never written with the defaults unless the person edited.
// Versions 1 (whole pixel widths), 2 (laptop, tablet and phone as `{ value, unit }`) and 3 (a list with a stored `direction`) are read
// as version 4 and rewritten only by an edit: Desktop is 90rem when absent, a stored direction is ignored and recomputed from the
// number (a file that disagrees with itself is simply read as derived), version 1's exactly-old-defaults read as the rem defaults,
// anything else as px entries one pixel above the old canvas width, so no canvas width moves.
//
// Boundary: `parseBreakpointsSource` takes the file's bytes (or `undefined` when there is no file) and answers a `Result`. A
// hand-edited, merged or truncated file is an error value, never a crash: callers show the defaults, say why, and refuse to write
// over the file until it is fixed. The bounds sit next to the code that enforces them (AGENTS.md section 10); shared/core/limits.ts is
// gate-defining, so they live here.
import { assert } from '../core/assert';
import { err, ok, type AppError, type Result } from '../core/result';

export const BREAKPOINTS_FILE = '.stacki/breakpoints.json';

export const BREAKPOINT_LIMITS = {
  /** The file is a handful of short entries; anything larger is not this file. */
  fileBytesMax: 8 * 1024,
  /** The narrowest boundary: the canvas cannot draw below 280px, so a boundary must leave a 280px width under it. */
  boundaryPxMin: 281,
  /** The widest boundary: the canvas draws up to 7680px (8K), one pixel under the boundary. */
  boundaryPxMax: 7_681,
  /** The root font size a `rem` boundary is read at, as everywhere the canvas converts rem to pixels. */
  remPx: 16,
  /** Characters in one typed entry: `7681px` or `479.9999rem` fit with room. */
  entryCharsMax: 16,
  /** Decimal places a rem entry keeps: enough for `62.5rem`, short enough to be a number a person meant. */
  remDecimalsMax: 4,
  /** Breakpoints in one project: the three built-in ones and eight more. */
  countMax: 11,
  /** Characters in a breakpoint's name. */
  nameCharsMax: 24,
  /** Characters in a breakpoint's id (`bp-12`). */
  idCharsMax: 24,
} as const satisfies Record<string, number>;

export type BreakpointUnit = 'rem' | 'px';

/** `down` is `width < X` (a device narrower than Desktop); `up` is `width >= X` (a device wider than Desktop). */
export type BreakpointDirection = 'down' | 'up';

/** The boundary a breakpoint stands for: a number and its unit. */
export interface BreakpointSetting {
  readonly value: number;
  readonly unit: BreakpointUnit;
}

export interface Breakpoint {
  readonly id: string;
  /** Typed by the person; undefined for a built-in one that was never renamed. */
  readonly name: string | undefined;
  /** Derived from the number against Desktop's (`directionOf`); never stored, never chosen. */
  readonly direction: BreakpointDirection;
  readonly setting: BreakpointSetting;
}

/** The breakpoints, strictly decreasing in pixels: the `up` ones (wider than Desktop), then the `down` ones. The direction is derived, never typed. */
export type BreakpointList = readonly Breakpoint[];

/** A breakpoint with the canvas width it resolves to. */
export interface ResolvedBreakpoint extends Breakpoint {
  readonly widthPx: number;
}

/** The ids the built-in breakpoints carry; their names read in the person's language. */
export const BUILTIN_BREAKPOINT_IDS = ['laptop', 'tablet', 'phone'] as const;
export type BuiltinBreakpointId = (typeof BUILTIN_BREAKPOINT_IDS)[number];

export function isBuiltinBreakpointId(id: string): id is BuiltinBreakpointId {
  return BUILTIN_BREAKPOINT_IDS.some((builtin) => builtin === id);
}

const down = (id: string, value: number, unit: BreakpointUnit): Breakpoint => ({ id, name: undefined, direction: 'down', setting: { value, unit } });

/** The Lumos breakpoints: `width < 64rem`, `width < 48rem` and `width < 30rem`. */
export const BREAKPOINT_DEFAULT_LIST: BreakpointList = [down('laptop', 64, 'rem'), down('tablet', 48, 'rem'), down('phone', 30, 'rem')];

/** The boundary in pixels: `64rem` is 1024. Rounded to a millionth so `rem * 16` float noise cannot move a width. */
export function boundaryPx(setting: BreakpointSetting): number {
  assert(setting.unit === 'rem' || setting.unit === 'px', 'boundaryPx: the unit is rem or px');
  const pixels = setting.unit === 'rem' ? setting.value * BREAKPOINT_LIMITS.remPx : setting.value;
  const rounded = Math.round(pixels * 1e6) / 1e6;
  assert(Number.isNaN(rounded) === Number.isNaN(pixels), 'boundaryPx: rounding never turns a number into NaN or back');
  return rounded;
}

/**
 * The canvas width of a breakpoint, the one place a boundary becomes a width. `down`: the largest whole pixel below it
 * (`width < 64rem` holds up to 1023). `up`: the smallest whole pixel that is in it (`width >= 100rem` holds from 1600).
 */
export function canvasWidthPx(breakpoint: Pick<Breakpoint, 'direction' | 'setting'>): number {
  const boundary = boundaryPx(breakpoint.setting);
  const width = breakpoint.direction === 'down' ? Math.ceil(boundary) - 1 : Math.ceil(boundary);
  assert(Number.isSafeInteger(width), 'canvasWidthPx: a whole number of pixels');
  return width;
}

/** Every breakpoint with its canvas width, in list order. */
export function resolveBreakpoints(list: BreakpointList): readonly ResolvedBreakpoint[] {
  const resolved = list.map((breakpoint) => ({ ...breakpoint, widthPx: canvasWidthPx(breakpoint) }));
  assert(resolved.length === list.length, 'resolveBreakpoints: one width per breakpoint');
  return resolved;
}

/** The default list's widths: 1023, 767 and 479. */
export const BREAKPOINT_DEFAULTS: readonly ResolvedBreakpoint[] = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);

/** The setting as typed and shown: `64rem`, `62.5rem`, `1024px`. */
export function formatBreakpoint(setting: BreakpointSetting): string {
  const text = `${setting.value}${setting.unit}`;
  assert(text.endsWith(setting.unit), 'formatBreakpoint: the unit ends the text');
  return text;
}

/** The breakpoint as a query condition: `width < 64rem` (down) or `width >= 100rem` (up). */
export function breakpointCondition(breakpoint: Pick<Breakpoint, 'direction' | 'setting'>): string {
  const condition = `width ${breakpoint.direction === 'down' ? '<' : '>='} ${formatBreakpoint(breakpoint.setting)}`;
  assert(condition.startsWith('width '), 'breakpointCondition: a width condition');
  return condition;
}

/**
 * What a typed entry means, or why not. Accepts `64rem`, `64 rem`, `62.5rem`, `1024px` and a bare number (pixels); a px
 * entry is whole pixels. The code says what to fix: `syntax` (not a number with an optional unit), `pxWhole` (a decimal px),
 * `range` (outside the canvas's bounds).
 */
export function parseBreakpointEntry(entry: string): Result<BreakpointSetting> {
  const text = entry.trim();
  assert(text.length <= entry.length, 'parseBreakpointEntry: trimming never grows the entry');
  if (text.length === 0 || text.length > BREAKPOINT_LIMITS.entryCharsMax) {
    return failure('syntax', 'type a width such as 64rem or 1024px');
  }
  const match = /^(\d+(?:\.\d+)?)\s*(rem|px)?$/i.exec(text);
  if (match === null) {
    return failure('syntax', 'type a width such as 64rem or 1024px');
  }
  const number = Number(match[1]);
  const unit: BreakpointUnit = (match[2] ?? 'px').toLowerCase() === 'rem' ? 'rem' : 'px';
  if (unit === 'px' && !Number.isInteger(number)) {
    return failure('pxWhole', 'px widths are whole numbers; use rem for decimals');
  }
  const decimals = (match[1] ?? '').split('.')[1]?.length ?? 0;
  if (decimals > BREAKPOINT_LIMITS.remDecimalsMax) {
    return failure('syntax', `at most ${BREAKPOINT_LIMITS.remDecimalsMax} decimal places`);
  }
  return checkedSetting({ value: number, unit });
}

/** One setting checked: a finite positive number whose boundary the canvas can show. */
export function checkedSetting(candidate: { readonly value: unknown; readonly unit: unknown }): Result<BreakpointSetting> {
  const { value, unit } = candidate;
  if (unit !== 'rem' && unit !== 'px') {
    return failure('unit', 'the unit must be "rem" or "px"');
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return failure('type', 'a breakpoint value must be a number');
  }
  const setting: BreakpointSetting = { value, unit };
  const pixels = boundaryPx(setting);
  if (pixels < BREAKPOINT_LIMITS.boundaryPxMin || pixels > BREAKPOINT_LIMITS.boundaryPxMax) {
    return failure('range', `a breakpoint must be from ${BREAKPOINT_LIMITS.boundaryPxMin}px to ${BREAKPOINT_LIMITS.boundaryPxMax}px (or the same in rem)`);
  }
  if (unit === 'px' && !Number.isInteger(value)) {
    return failure('pxWhole', 'px widths are whole numbers; use rem for decimals');
  }
  assert(pixels >= BREAKPOINT_LIMITS.boundaryPxMin, 'checkedSetting: the boundary is at least the minimum');
  assert(pixels <= BREAKPOINT_LIMITS.boundaryPxMax, 'checkedSetting: the boundary is at most the maximum');
  return ok(setting);
}

/** The width of the Desktop frame in the side-by-side view unless the project says otherwise: 90rem, 1440px. */
export const DESKTOP_DEFAULT: BreakpointSetting = { value: 90, unit: 'rem' };

/** Desktop's frame width and the breakpoints around it. The one value a project's breakpoints are read and written as. */
export interface BreakpointConfig {
  readonly desktop: BreakpointSetting;
  readonly list: BreakpointList;
}

/** The Lumos breakpoints around a 90rem Desktop. */
export const BREAKPOINT_DEFAULT_CONFIG: BreakpointConfig = { desktop: DESKTOP_DEFAULT, list: BREAKPOINT_DEFAULT_LIST };

/**
 * The side of Desktop a number is on: wider is `up` (`width >= X`), narrower is `down` (`width < X`), and a number equal to Desktop's
 * is on neither side (undefined) and is refused. The one derivation: the bar, Settings, the sync and the style panel all read it.
 */
export function directionOf(setting: BreakpointSetting, desktop: BreakpointSetting): BreakpointDirection | undefined {
  const pixels = boundaryPx(setting);
  const base = boundaryPx(desktop);
  if (pixels === base) {
    return undefined;
  }
  const side = pixels > base ? 'up' : 'down';
  assert(pixels !== base, 'directionOf: a number equal to Desktop never gets a side');
  return side;
}

/** The width of the Desktop frame in the side-by-side view, in pixels. Never a media query. */
export function desktopFramePx(desktop: BreakpointSetting): number {
  const frame = Math.ceil(boundaryPx(desktop));
  assert(Number.isSafeInteger(frame), 'desktopFramePx: a whole number of pixels');
  return frame;
}

/** The list with each direction set from its number against Desktop. A number equal to Desktop's keeps its old direction (it is refused by `checkedConfig`). */
export function withDerivedDirections(desktop: BreakpointSetting, list: BreakpointList): BreakpointList {
  const derived = list.map((breakpoint) => ({ ...breakpoint, direction: directionOf(breakpoint.setting, desktop) ?? breakpoint.direction }));
  assert(derived.length === list.length, 'withDerivedDirections: no breakpoint is added or lost');
  return derived;
}

/** One place in the whole descending sequence: Desktop or a breakpoint. */
export interface SequenceEntry {
  readonly id: string;
  /** undefined for a breakpoint with no name of its own (a built-in one), and for Desktop. */
  readonly breakpoint: Breakpoint | undefined;
  readonly setting: BreakpointSetting;
}

/** The ids reserved for Desktop. */
export const DESKTOP_ID = 'desktop';

/**
 * The wider breakpoints, Desktop, then the narrower ones: the order the cards and the bar draw, and the order the numbers must descend
 * in. A breakpoint is on the side its `direction` says, in the list's order, so an edit that keeps a card in its place is checked against
 * the cards around it (and Desktop) and not re-sorted.
 */
export function sequenceOf(config: BreakpointConfig): readonly SequenceEntry[] {
  const entry = (breakpoint: Breakpoint): SequenceEntry => ({ id: breakpoint.id, breakpoint, setting: breakpoint.setting });
  const wider = config.list.filter((breakpoint) => breakpoint.direction === 'up').map(entry);
  const narrower = config.list.filter((breakpoint) => breakpoint.direction === 'down').map(entry);
  assert(wider.length + narrower.length === config.list.length, 'sequenceOf: every breakpoint is on one side of Desktop');
  const sequence = [...wider, { id: DESKTOP_ID, breakpoint: undefined, setting: config.desktop }, ...narrower];
  assert(sequence.length === config.list.length + 1, 'sequenceOf: the breakpoints and Desktop');
  return sequence;
}

/** Which neighbour an entry is out of order with: it must be smaller than the one above, or larger than the one below. */
export interface OrderConflict {
  readonly against: SequenceEntry;
  readonly relation: 'smaller' | 'larger';
}

/** How the entry `id` conflicts with its neighbours, from its own side: smaller than the one above, else larger than the one below. */
export function conflictAt(config: BreakpointConfig, id: string): OrderConflict | undefined {
  const sequence = sequenceOf(config);
  const index = sequence.findIndex((entry) => entry.id === id);
  assert(index >= -1, 'conflictAt: an index is a position or -1');
  assert(index < sequence.length, 'conflictAt: the position is inside the sequence');
  const current = sequence[index];
  if (current === undefined) {
    return undefined;
  }
  const above = sequence[index - 1];
  if (above !== undefined && boundaryPx(current.setting) >= boundaryPx(above.setting)) {
    return { against: above, relation: 'smaller' };
  }
  const below = sequence[index + 1];
  if (below !== undefined && boundaryPx(current.setting) <= boundaryPx(below.setting)) {
    return { against: below, relation: 'larger' };
  }
  return undefined;
}

/**
 * The breakpoint that would end up on the other side of Desktop (or on it) if Desktop were `next`, or undefined when it can move
 * there: Desktop may only stay between the largest narrower breakpoint and the smallest wider one.
 */
export function desktopBlocker(config: BreakpointConfig, next: BreakpointSetting): Breakpoint | undefined {
  const nextPx = boundaryPx(next);
  assert(!Number.isNaN(nextPx), 'desktopBlocker: the next Desktop width is a number');
  return config.list.find((breakpoint) => {
    const pixels = boundaryPx(breakpoint.setting);
    return breakpoint.direction === 'up' ? pixels <= nextPx : pixels >= nextPx;
  });
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Whether a name is storable: 1 to 24 characters, no control characters, not only spaces. */
export function isBreakpointName(name: string): boolean {
  return name.trim().length > 0 && name.length <= BREAKPOINT_LIMITS.nameCharsMax && !/[\u0000-\u001f\u007f]/.test(name);
}

/** Desktop and the breakpoints as a set: each valid, ids and names unique, the count bounded, none equal to Desktop, strictly decreasing, directions derived. */
export function checkedConfig(config: BreakpointConfig): Result<BreakpointConfig> {
  const desktop = checkedSetting(config.desktop);
  if (!desktop.ok) {
    return failure(desktop.error.code.replace('breakpoints-', ''), `desktop: ${desktop.error.message.replace('.stacki/breakpoints.json: ', '')}`);
  }
  if (config.list.length > BREAKPOINT_LIMITS.countMax) {
    return failure('count', `at most ${BREAKPOINT_LIMITS.countMax} breakpoints`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const breakpoint of config.list) {
    if (breakpoint.id.length === 0 || breakpoint.id.length > BREAKPOINT_LIMITS.idCharsMax || !ID_PATTERN.test(breakpoint.id) || breakpoint.id === DESKTOP_ID) {
      return failure('id', 'a breakpoint id is lower-case letters, digits and hyphens');
    }
    if (ids.has(breakpoint.id)) {
      return failure('duplicate', `two breakpoints share the id "${breakpoint.id}"`);
    }
    ids.add(breakpoint.id);
    if (breakpoint.name !== undefined) {
      if (!isBreakpointName(breakpoint.name)) {
        return failure('name', 'a name is 1 to 24 characters with no control characters');
      }
      const lowered = breakpoint.name.trim().toLowerCase();
      if (names.has(lowered)) {
        return failure('name-duplicate', `two breakpoints are named "${breakpoint.name}"`);
      }
      names.add(lowered);
    }
    const setting = checkedSetting(breakpoint.setting);
    if (!setting.ok) {
      return setting;
    }
    if (directionOf(breakpoint.setting, config.desktop) === undefined) {
      return failure('desktop-equal', `${breakpoint.id} must differ from Desktop`);
    }
  }
  const derived: BreakpointConfig = { desktop: desktop.value, list: withDerivedDirections(desktop.value, config.list) };
  const sequence = derived.list.map((breakpoint) => boundaryPx(breakpoint.setting));
  for (let index = 1; index < sequence.length; index += 1) {
    if ((sequence[index] ?? 0) >= (sequence[index - 1] ?? 0)) {
      return failure('order', `${derived.list[index - 1]?.id ?? ''} must be larger than ${derived.list[index]?.id ?? ''}`);
    }
  }
  assert(derived.list.length === config.list.length, 'checkedConfig: no breakpoint is lost');
  assert(sequence.length === derived.list.length, 'checkedConfig: one boundary per breakpoint');
  return ok(derived);
}

/** The file's bytes to the configuration. `undefined` (no file yet) reads as the defaults. */
export function parseBreakpointsSource(source: string | undefined): Result<BreakpointConfig> {
  if (source === undefined) {
    return ok(BREAKPOINT_DEFAULT_CONFIG);
  }
  if (source.length > BREAKPOINT_LIMITS.fileBytesMax) {
    return failure('limit', `larger than ${BREAKPOINT_LIMITS.fileBytesMax} bytes`);
  }
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (error: unknown) {
    return failure('unreadable', `not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return parseBreakpoints(input);
}

/** A parsed JSON value to the configuration, every field checked. Versions 1, 2 and 3 are migrated in memory. */
export function parseBreakpoints(input: unknown): Result<BreakpointConfig> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'expected an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  assert(!Array.isArray(input), 'parseBreakpoints: an object, not an array');
  const version = fields.get('version');
  if (version === 4 || version === 3) {
    return parseListed(fields, version);
  }
  if (version === 1 || version === 2) {
    return parseLegacy(fields, version);
  }
  return failure('version', 'unsupported version, expected 4');
}

function parseListed(fields: ReadonlyMap<string, unknown>, version: 3 | 4): Result<BreakpointConfig> {
  const allowed = version === 4 ? ['version', 'desktop', 'breakpoints'] : ['version', 'breakpoints'];
  for (const name of fields.keys()) {
    if (!allowed.includes(name)) {
      return failure('shape', `unknown field "${name}"`);
    }
  }
  let desktop: BreakpointSetting = DESKTOP_DEFAULT;
  if (version === 4 && fields.has('desktop')) {
    const raw = fields.get('desktop');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return failure('shape', 'desktop must be an object with a value and a unit');
    }
    const inner = new Map<string, unknown>(Object.entries(raw));
    for (const name of inner.keys()) {
      if (name !== 'value' && name !== 'unit') {
        return failure('shape', `unknown field "${name}" in desktop`);
      }
    }
    const setting = checkedSetting({ value: inner.get('value'), unit: inner.get('unit') });
    if (!setting.ok) {
      return failure(setting.error.code.replace('breakpoints-', ''), `desktop: ${setting.error.message.replace('.stacki/breakpoints.json: ', '')}`);
    }
    desktop = setting.value;
  }
  const entries = fields.get('breakpoints');
  if (!Array.isArray(entries)) {
    return failure('shape', 'breakpoints must be an array');
  }
  if (entries.length > BREAKPOINT_LIMITS.countMax) {
    return failure('count', `at most ${BREAKPOINT_LIMITS.countMax} breakpoints`);
  }
  const list: Breakpoint[] = [];
  // The array is bounded above, so this loop is too.
  for (const entry of entries) {
    const breakpoint = parseEntry(entry, version);
    if (!breakpoint.ok) {
      return breakpoint;
    }
    list.push(breakpoint.value);
  }
  assert(list.length === entries.length, 'parseListed: one breakpoint per entry');
  assert(list.length <= BREAKPOINT_LIMITS.countMax, 'parseListed: within the count bound');
  return checkedConfig({ desktop, list: withDerivedDirections(desktop, list) });
}

// Version 3 held a `direction` per breakpoint: it is read and ignored, the direction being recomputed from the number.
function parseEntry(input: unknown, version: 3 | 4): Result<Breakpoint> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'a breakpoint must be an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  const allowed = version === 3 ? ['id', 'name', 'direction', 'value', 'unit'] : ['id', 'name', 'value', 'unit'];
  for (const name of fields.keys()) {
    if (!allowed.includes(name)) {
      return failure('shape', `unknown field "${name}" in a breakpoint`);
    }
  }
  const id = fields.get('id');
  const name = fields.get('name');
  if (typeof id !== 'string') {
    return failure('id', 'a breakpoint needs an id');
  }
  if (name !== undefined && typeof name !== 'string') {
    return failure('name', 'a name must be text');
  }
  if (version === 3) {
    const stored = fields.get('direction');
    if (stored !== 'up' && stored !== 'down') {
      return failure('direction', 'direction must be "up" or "down"');
    }
  }
  const setting = checkedSetting({ value: fields.get('value'), unit: fields.get('unit') });
  if (!setting.ok) {
    return setting;
  }
  assert(name === undefined || typeof name === 'string', 'parseEntry: the name is text or absent');
  return ok({ id, name, direction: 'down', setting: setting.value });
}

// Versions 1 and 2 held laptop, tablet and phone only. Version 2: `{ value, unit }` each. Version 1: whole pixel canvas widths,
// whose boundary is one pixel more; exactly the old defaults become the rem defaults, which resolve to the same widths.
function parseLegacy(fields: ReadonlyMap<string, unknown>, version: 1 | 2): Result<BreakpointConfig> {
  for (const name of fields.keys()) {
    if (name !== 'version' && !isBuiltinBreakpointId(name)) {
      return failure('shape', `unknown field "${name}"`);
    }
  }
  const settings: BreakpointSetting[] = [];
  const widths: number[] = [];
  for (const id of BUILTIN_BREAKPOINT_IDS) {
    const entry = fields.get(id);
    if (version === 1) {
      if (typeof entry !== 'number') {
        return failure('type', `${id} must be a number`);
      }
      if (!Number.isSafeInteger(entry)) {
        return failure('integer', `${id} must be a whole number of pixels`);
      }
      widths.push(entry);
      continue;
    }
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return failure('shape', `${id} must be an object with a value and a unit`);
    }
    const inner = new Map<string, unknown>(Object.entries(entry));
    for (const name of inner.keys()) {
      if (name !== 'value' && name !== 'unit') {
        return failure('shape', `unknown field "${name}" in ${id}`);
      }
    }
    const setting = checkedSetting({ value: inner.get('value'), unit: inner.get('unit') });
    if (!setting.ok) {
      return failure(setting.error.code.replace('breakpoints-', ''), `${id}: ${setting.error.message.replace('.stacki/breakpoints.json: ', '')}`);
    }
    settings.push(setting.value);
  }
  if (version === 1) {
    const [laptop, tablet, phone] = widths;
    assert(laptop !== undefined, 'parseLegacy: laptop was read above');
    assert(tablet !== undefined, 'parseLegacy: tablet was read above');
    assert(phone !== undefined, 'parseLegacy: phone was read above');
    if (laptop === 1023 && tablet === 767 && phone === 479) {
      return ok(BREAKPOINT_DEFAULT_CONFIG);
    }
    for (const width of widths) {
      settings.push({ value: width + 1, unit: 'px' });
    }
  }
  const list = BUILTIN_BREAKPOINT_IDS.map((id, index): Breakpoint => {
    const setting = settings[index];
    assert(setting !== undefined, 'parseLegacy: a setting exists for each built-in breakpoint');
    return { id, name: undefined, direction: 'down', setting };
  });
  return checkedConfig({ desktop: DESKTOP_DEFAULT, list: withDerivedDirections(DESKTOP_DEFAULT, list) });
}

/** The pretty-printed version 4 file text: fixed key order, two-space indent, a trailing newline, no stored direction, so equal configurations are equal bytes. */
export function serializeBreakpoints(config: BreakpointConfig): string {
  const checked = checkedConfig(config);
  assert(checked.ok, 'serializeBreakpoints: the configuration is valid');
  const entries = config.list.map((breakpoint) => ({
    id: breakpoint.id,
    ...(breakpoint.name === undefined ? {} : { name: breakpoint.name }),
    value: breakpoint.setting.value,
    unit: breakpoint.setting.unit,
  }));
  const text = JSON.stringify({ version: 4, desktop: { value: config.desktop.value, unit: config.desktop.unit }, breakpoints: entries }, undefined, 2) + '\n';
  assert(text.length <= BREAKPOINT_LIMITS.fileBytesMax, 'serializeBreakpoints: within the file bound');
  return text;
}

/** Whether two configurations are the same (the direction is derived from the numbers, so it is not compared). */
export function breakpointsEqual(first: BreakpointConfig, second: BreakpointConfig): boolean {
  return (
    first.desktop.value === second.desktop.value &&
    first.desktop.unit === second.desktop.unit &&
    first.list.length === second.list.length &&
    first.list.every((breakpoint, index) => {
      const other = second.list[index];
      return (
        other !== undefined &&
        breakpoint.id === other.id &&
        breakpoint.name === other.name &&
        breakpoint.setting.value === other.setting.value &&
        breakpoint.setting.unit === other.setting.unit
      );
    })
  );
}

/** The configuration with a breakpoint inserted where its number puts it, its direction derived. */
export function withBreakpointAdded(config: BreakpointConfig, breakpoint: Pick<Breakpoint, 'id' | 'name' | 'setting'>): BreakpointConfig {
  const pixels = boundaryPx(breakpoint.setting);
  const created: Breakpoint = { ...breakpoint, direction: directionOf(breakpoint.setting, config.desktop) ?? 'down' };
  const at = config.list.findIndex((other) => boundaryPx(other.setting) < pixels);
  const list = at === -1 ? [...config.list, created] : [...config.list.slice(0, at), created, ...config.list.slice(at)];
  assert(list.length === config.list.length + 1, 'withBreakpointAdded: exactly one breakpoint is added');
  assert(at >= -1, 'withBreakpointAdded: the place is an index or the end');
  return { desktop: config.desktop, list: withDerivedDirections(config.desktop, list) };
}

export function withBreakpointRemoved(config: BreakpointConfig, id: string): BreakpointConfig {
  const list = config.list.filter((breakpoint) => breakpoint.id !== id);
  assert(list.length <= config.list.length, 'withBreakpointRemoved: a removal never adds');
  assert(
    list.every((breakpoint) => breakpoint.id !== id),
    'withBreakpointRemoved: the id is gone',
  );
  return { desktop: config.desktop, list };
}

/** One breakpoint's number changed in place (its direction follows the new number). */
export function withBreakpointSetting(config: BreakpointConfig, id: string, setting: BreakpointSetting): BreakpointConfig {
  const list = config.list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, setting } : breakpoint));
  assert(list.length === config.list.length, 'withBreakpointSetting: the count does not change');
  return { desktop: config.desktop, list: withDerivedDirections(config.desktop, list) };
}

export function withBreakpointName(config: BreakpointConfig, id: string, name: string | undefined): BreakpointConfig {
  const list = config.list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, name } : breakpoint));
  assert(list.length === config.list.length, 'withBreakpointName: the count does not change');
  return { desktop: config.desktop, list };
}

/** Desktop's frame width changed; the directions are recomputed (the caller has checked `desktopBlocker`). */
export function withDesktop(config: BreakpointConfig, desktop: BreakpointSetting): BreakpointConfig {
  const list = withDerivedDirections(desktop, config.list);
  assert(list.length === config.list.length, 'withDesktop: the count does not change');
  return { desktop, list };
}

/** An id no breakpoint in the list has: `bp-1`, `bp-2`, … */
export function nextBreakpointId(list: BreakpointList): string {
  const taken = new Set(list.map((breakpoint) => breakpoint.id));
  for (let number = 1; number <= BREAKPOINT_LIMITS.countMax + 1; number += 1) {
    const id = `bp-${number}`;
    if (!taken.has(id)) {
      assert(!taken.has(id), 'nextBreakpointId: the id is free');
      return id;
    }
  }
  throw new Error('nextBreakpointId: the list is full');
}

/** `name`, or `name 2`, `name 3` … when the list already has a breakpoint by that name (compared without case). */
export function uniqueBreakpointName(list: BreakpointList, name: string, label: (breakpoint: Breakpoint) => string): string {
  const taken = new Set(list.map((breakpoint) => label(breakpoint).trim().toLowerCase()));
  const base = name.slice(0, BREAKPOINT_LIMITS.nameCharsMax - 3).trim();
  let candidate = base;
  for (let number = 2; taken.has(candidate.toLowerCase()) && number <= BREAKPOINT_LIMITS.countMax + 2; number += 1) {
    candidate = `${base} ${number}`;
  }
  assert(candidate.startsWith(base), 'uniqueBreakpointName: the name keeps its base');
  assert(candidate.length <= BREAKPOINT_LIMITS.nameCharsMax, 'uniqueBreakpointName: within the name bound');
  return candidate;
}

function failure(code: string, detail: string): Result<never, AppError> {
  assert(code.length > 0, 'failure: a code names the problem');
  assert(detail.length > 0, 'failure: a detail says what to fix');
  return err({ code: `breakpoints-${code}`, message: `.stacki/breakpoints.json: ${detail}` });
}

/** One breakpoint's number replaced WITHOUT deriving directions: the card keeps its place, to be checked against its neighbours with `conflictAt`. */
export function withSettingInPlace(config: BreakpointConfig, id: string, setting: BreakpointSetting): BreakpointConfig {
  const list = config.list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, setting } : breakpoint));
  assert(list.length === config.list.length, 'withSettingInPlace: the count does not change');
  return { desktop: config.desktop, list };
}
