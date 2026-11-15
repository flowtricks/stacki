// `.stacki/breakpoints.json`: the breakpoints the preview bar jumps to.
//
//   { "version": 3,
//     "breakpoints": [
//       { "id": "bp-1", "name": "Large", "direction": "up",   "value": 100, "unit": "rem" },
//       { "id": "laptop",                 "direction": "down", "value": 64,  "unit": "rem" },
//       { "id": "tablet",                 "direction": "down", "value": 48,  "unit": "rem" },
//       { "id": "phone",                  "direction": "down", "value": 30,  "unit": "rem" } ] }
//
// The bar lists Desktop in the middle, always full width and always there. A `down` breakpoint is a device narrower than
// Desktop: its entry is the query boundary `width < X`, and its canvas is the largest whole pixel below it (64rem is 1023px).
// An `up` breakpoint is a device wider than Desktop: its entry is `width >= X`, mobile first, and its canvas is exactly X
// (100rem is 1600px). A project with Lumos breakpoints (min-width 30rem, 48rem, 64rem) needs no file: those are the defaults,
// as `down` breakpoints named by their ids. Any rem or px numbers work.
//
// Order is part of the file: the list is strictly decreasing in pixels, every `up` before every `down`, so a card's neighbours
// are its limits (an `up` is above all the `down` ones, whatever its unit). A breakpoint may be removed (the list may be empty),
// and up to `BREAKPOINT_LIMITS.countMax` may exist. `id` is stable (the sync record and the preview device are named by it);
// `name` is optional, and absent for a built-in one it reads as the translated Laptop, Tablet or Phone.
//
// It is a tracked project file in the same family as `.stacki/guide.json`, shared by Desktop and Studio and committed with the
// project. The file is created by the first edit, never by reading, and never written with the defaults unless the person
// edited. Versions 1 (whole pixel widths) and 2 (laptop, tablet and phone as `{ value, unit }`) are read as version 3 and
// rewritten only by an edit: version 1's exactly-old-defaults read as the rem defaults, anything else as px entries one pixel
// above the old canvas width, so no canvas width moves.
//
// Boundary: `parseBreakpointsSource` takes the file's bytes (or `undefined` when there is no file) and answers a `Result`.
// A hand-edited, merged or truncated file is an error value, never a crash: callers show the defaults, say why, and refuse to
// write over the file until it is fixed. The bounds sit next to the code that enforces them (AGENTS.md section 10);
// shared/core/limits.ts is gate-defining, so they live here.
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
  readonly direction: BreakpointDirection;
  readonly setting: BreakpointSetting;
}

/** The breakpoints, strictly decreasing in pixels, every `up` before every `down`. */
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
  const pixels = setting.unit === 'rem' ? setting.value * BREAKPOINT_LIMITS.remPx : setting.value;
  return Math.round(pixels * 1e6) / 1e6;
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
  return list.map((breakpoint) => ({ ...breakpoint, widthPx: canvasWidthPx(breakpoint) }));
}

/** The default list's widths: 1023, 767 and 479. */
export const BREAKPOINT_DEFAULTS: readonly ResolvedBreakpoint[] = resolveBreakpoints(BREAKPOINT_DEFAULT_LIST);

/** The setting as typed and shown: `64rem`, `62.5rem`, `1024px`. */
export function formatBreakpoint(setting: BreakpointSetting): string {
  return `${setting.value}${setting.unit}`;
}

/** The breakpoint as a query condition: `width < 64rem` (down) or `width >= 100rem` (up). */
export function breakpointCondition(breakpoint: Pick<Breakpoint, 'direction' | 'setting'>): string {
  return `width ${breakpoint.direction === 'down' ? '<' : '>='} ${formatBreakpoint(breakpoint.setting)}`;
}

/**
 * What a typed entry means, or why not. Accepts `64rem`, `64 rem`, `62.5rem`, `1024px` and a bare number (pixels); a px
 * entry is whole pixels. The code says what to fix: `syntax` (not a number with an optional unit), `pxWhole` (a decimal px),
 * `range` (outside the canvas's bounds).
 */
export function parseBreakpointEntry(entry: string): Result<BreakpointSetting> {
  const text = entry.trim();
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
  return ok(setting);
}

/** Which neighbour a breakpoint is out of order with: it must be smaller than the one above, or larger than the one below. */
export interface OrderConflict {
  readonly index: number;
  readonly against: Breakpoint;
  readonly relation: 'smaller' | 'larger';
}

/**
 * The first breakpoint that is not smaller than the one above it, as `smaller` against that neighbour. `up` breakpoints come
 * before `down` ones, so an `up` that is not larger than a `down` shows as the `down` not being smaller than it.
 */
export function firstOrderConflict(list: BreakpointList): OrderConflict | undefined {
  for (let index = 1; index < list.length; index += 1) {
    const above = list[index - 1];
    const current = list[index];
    assert(above !== undefined, 'firstOrderConflict: the neighbour above exists');
    assert(current !== undefined, 'firstOrderConflict: the breakpoint exists');
    if (boundaryPx(current.setting) >= boundaryPx(above.setting)) {
      return { index, against: above, relation: 'smaller' };
    }
  }
  return undefined;
}

/** How the breakpoint at `index` conflicts with its neighbours, from its own side: smaller than above, else larger than below. */
export function conflictAt(list: BreakpointList, index: number): OrderConflict | undefined {
  const current = list[index];
  if (current === undefined) {
    return undefined;
  }
  const above = list[index - 1];
  if (above !== undefined && boundaryPx(current.setting) >= boundaryPx(above.setting)) {
    return { index, against: above, relation: 'smaller' };
  }
  const below = list[index + 1];
  if (below !== undefined && boundaryPx(current.setting) <= boundaryPx(below.setting)) {
    return { index, against: below, relation: 'larger' };
  }
  return undefined;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

/** Whether a name is storable: 1 to 24 characters, no control characters, not only spaces. */
export function isBreakpointName(name: string): boolean {
  return name.trim().length > 0 && name.length <= BREAKPOINT_LIMITS.nameCharsMax && !/[\u0000-\u001f\u007f]/.test(name);
}

/** The list as a set of breakpoints: each valid, ids and names unique, the count bounded, strictly decreasing. */
export function checkedList(list: BreakpointList): Result<BreakpointList> {
  if (list.length > BREAKPOINT_LIMITS.countMax) {
    return failure('count', `at most ${BREAKPOINT_LIMITS.countMax} breakpoints`);
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  let seenDown = false;
  for (const breakpoint of list) {
    if (breakpoint.id.length === 0 || breakpoint.id.length > BREAKPOINT_LIMITS.idCharsMax || !ID_PATTERN.test(breakpoint.id)) {
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
    if (breakpoint.direction === 'down') {
      seenDown = true;
    } else if (seenDown) {
      return failure('order', 'every wider breakpoint comes before every narrower one');
    }
  }
  const conflict = firstOrderConflict(list);
  if (conflict !== undefined) {
    return failure('order', `${conflict.against.id} must be larger than ${list[conflict.index]?.id ?? ''}`);
  }
  return ok(list);
}

/** The file's bytes to the list. `undefined` (no file yet) reads as the defaults. */
export function parseBreakpointsSource(source: string | undefined): Result<BreakpointList> {
  if (source === undefined) {
    return ok(BREAKPOINT_DEFAULT_LIST);
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

/** A parsed JSON value to the list, every field checked. Versions 1 and 2 are migrated in memory. */
export function parseBreakpoints(input: unknown): Result<BreakpointList> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'expected an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  const version = fields.get('version');
  if (version === 3) {
    return parseVersionThree(fields);
  }
  if (version === 1 || version === 2) {
    return parseLegacy(fields, version);
  }
  return failure('version', 'unsupported version, expected 3');
}

function parseVersionThree(fields: ReadonlyMap<string, unknown>): Result<BreakpointList> {
  for (const name of fields.keys()) {
    if (name !== 'version' && name !== 'breakpoints') {
      return failure('shape', `unknown field "${name}"`);
    }
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
    const breakpoint = parseEntry(entry);
    if (!breakpoint.ok) {
      return breakpoint;
    }
    list.push(breakpoint.value);
  }
  return checkedList(list);
}

function parseEntry(input: unknown): Result<Breakpoint> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'a breakpoint must be an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  for (const name of fields.keys()) {
    if (name !== 'id' && name !== 'name' && name !== 'direction' && name !== 'value' && name !== 'unit') {
      return failure('shape', `unknown field "${name}" in a breakpoint`);
    }
  }
  const id = fields.get('id');
  const name = fields.get('name');
  const direction = fields.get('direction');
  if (typeof id !== 'string') {
    return failure('id', 'a breakpoint needs an id');
  }
  if (name !== undefined && typeof name !== 'string') {
    return failure('name', 'a name must be text');
  }
  if (direction !== 'up' && direction !== 'down') {
    return failure('direction', 'direction must be "up" or "down"');
  }
  const setting = checkedSetting({ value: fields.get('value'), unit: fields.get('unit') });
  if (!setting.ok) {
    return setting;
  }
  return ok({ id, name, direction, setting: setting.value });
}

// Versions 1 and 2 held laptop, tablet and phone only. Version 2: `{ value, unit }` each. Version 1: whole pixel canvas widths,
// whose boundary is one pixel more; exactly the old defaults become the rem defaults, which resolve to the same widths.
function parseLegacy(fields: ReadonlyMap<string, unknown>, version: 1 | 2): Result<BreakpointList> {
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
      return ok(BREAKPOINT_DEFAULT_LIST);
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
  return checkedList(list);
}

/** The pretty-printed version 3 file text: fixed key order, two-space indent, a trailing newline, so equal lists are equal bytes. */
export function serializeBreakpoints(list: BreakpointList): string {
  const checked = checkedList(list);
  assert(checked.ok, 'serializeBreakpoints: the breakpoints are a valid list');
  const entries = list.map((breakpoint) => ({
    id: breakpoint.id,
    ...(breakpoint.name === undefined ? {} : { name: breakpoint.name }),
    direction: breakpoint.direction,
    value: breakpoint.setting.value,
    unit: breakpoint.setting.unit,
  }));
  const text = JSON.stringify({ version: 3, breakpoints: entries }, undefined, 2) + '\n';
  assert(text.length <= BREAKPOINT_LIMITS.fileBytesMax, 'serializeBreakpoints: within the file bound');
  return text;
}

export function breakpointsEqual(first: BreakpointList, second: BreakpointList): boolean {
  return (
    first.length === second.length &&
    first.every((breakpoint, index) => {
      const other = second[index];
      return (
        other !== undefined &&
        breakpoint.id === other.id &&
        breakpoint.name === other.name &&
        breakpoint.direction === other.direction &&
        breakpoint.setting.value === other.setting.value &&
        breakpoint.setting.unit === other.setting.unit
      );
    })
  );
}

/** The list with a breakpoint inserted where its boundary puts it: ups before downs, each strictly decreasing. */
export function withBreakpointAdded(list: BreakpointList, breakpoint: Breakpoint): BreakpointList {
  const pixels = boundaryPx(breakpoint.setting);
  const at = list.findIndex((other) => boundaryPx(other.setting) < pixels);
  return at === -1 ? [...list, breakpoint] : [...list.slice(0, at), breakpoint, ...list.slice(at)];
}

export function withBreakpointRemoved(list: BreakpointList, id: string): BreakpointList {
  return list.filter((breakpoint) => breakpoint.id !== id);
}

export function withBreakpointSetting(list: BreakpointList, id: string, setting: BreakpointSetting): BreakpointList {
  return list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, setting } : breakpoint));
}

export function withBreakpointName(list: BreakpointList, id: string, name: string | undefined): BreakpointList {
  return list.map((breakpoint) => (breakpoint.id === id ? { ...breakpoint, name } : breakpoint));
}

/** An id no breakpoint in the list has: `bp-1`, `bp-2`, … */
export function nextBreakpointId(list: BreakpointList): string {
  const taken = new Set(list.map((breakpoint) => breakpoint.id));
  for (let number = 1; number <= BREAKPOINT_LIMITS.countMax + 1; number += 1) {
    const id = `bp-${number}`;
    if (!taken.has(id)) {
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
  return candidate;
}

/** The `up` breakpoints, widest first, then Desktop's place, then the `down` ones. The bar and the cards draw this order. */
export function barOrder(list: BreakpointList): { readonly up: readonly Breakpoint[]; readonly down: readonly Breakpoint[] } {
  return { up: list.filter((breakpoint) => breakpoint.direction === 'up'), down: list.filter((breakpoint) => breakpoint.direction === 'down') };
}

function failure(code: string, detail: string): Result<never, AppError> {
  return err({ code: `breakpoints-${code}`, message: `.stacki/breakpoints.json: ${detail}` });
}
