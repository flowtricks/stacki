// `.stacki/breakpoints.json`: the preview breakpoints the breakpoint bar jumps to.
//
//   { "version": 2, "laptop": { "value": 64, "unit": "rem" }, "tablet": { "value": 48, "unit": "rem" }, "phone": { "value": 30, "unit": "rem" } }
//
// The bar lists four devices, largest first: Desktop (full width, no number), then these three. Each entry is the query
// boundary of its device, `width < X`, in the unit the person typed: `64rem` reads as `width < 64rem`. The defaults are the
// Lumos breakpoints (64rem, 48rem and 30rem), so a Lumos project needs no file at all. Any rem or px numbers work as long as
// each is smaller than the one above it once converted to pixels (1rem = 16px, the root font size the canvas reads rem at).
//
// The one resolver: `canvasWidthPx` turns an entry into the width the canvas shows for that device, the largest whole pixel
// below the boundary (64rem is 1023, 48rem is 767, 30rem is 479, 1024px is 1023). The preview bar, the canvas sizing and the
// all-breakpoints view read widths only through it. This file's numbers are not turned into media queries: Stacki writes no
// query from them, and the queries a person authors keep their own unit (Base reads those, baseWidth.ts).
//
// It is a tracked project file in the same family as `.stacki/guide.json` and `.stacki/variables.json`, shared by Desktop and
// Studio and committed with the project. The file is created by the first edit, never by reading, and never written with the
// defaults unless the person edited. A version 1 file (whole pixel widths, written by an earlier build) is read as if it were
// version 2 and is rewritten only by an edit: exactly the old defaults 1023/767/479 read as the rem defaults, anything else as
// px entries whose boundary is the old width plus one pixel, so the canvas widths do not move.
//
// Boundary: `parseBreakpointsSource` takes the file's bytes (or `undefined` when there is no file) and answers a `Result`.
// A hand-edited, merged or truncated file is an error value, never a crash: callers show the defaults, say why, and refuse to
// write over the file until it is fixed. The bounds sit next to the code that enforces them (AGENTS.md section 10);
// shared/core/limits.ts is gate-defining, so they live here.
import { assert } from '../core/assert';
import { err, ok, type AppError, type Result } from '../core/result';

export const BREAKPOINTS_FILE = '.stacki/breakpoints.json';

export const BREAKPOINT_LIMITS = {
  /** The file is a few short entries; anything larger is not this file. */
  fileBytesMax: 4 * 1024,
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
} as const satisfies Record<string, number>;

export const BREAKPOINT_KEYS = ['laptop', 'tablet', 'phone'] as const;
export type BreakpointKey = (typeof BREAKPOINT_KEYS)[number];

export type BreakpointUnit = 'rem' | 'px';

/** One breakpoint: the boundary of `width < value unit`. */
export interface BreakpointSetting {
  readonly value: number;
  readonly unit: BreakpointUnit;
}

/** The three configured breakpoints, strictly decreasing from laptop to phone once converted to pixels. */
export interface BreakpointSettings {
  readonly laptop: BreakpointSetting;
  readonly tablet: BreakpointSetting;
  readonly phone: BreakpointSetting;
}

/** The canvas widths the settings resolve to, in whole CSS pixels, strictly descending. */
export interface BreakpointWidths {
  readonly laptop: number;
  readonly tablet: number;
  readonly phone: number;
}

/** The Lumos breakpoints: `width < 64rem`, `width < 48rem` and `width < 30rem`. */
export const BREAKPOINT_DEFAULT_SETTINGS: BreakpointSettings = {
  laptop: { value: 64, unit: 'rem' },
  tablet: { value: 48, unit: 'rem' },
  phone: { value: 30, unit: 'rem' },
};

/** What the defaults resolve to: 1023, 767 and 479. */
export const BREAKPOINT_DEFAULTS: BreakpointWidths = {
  laptop: canvasWidthPx(BREAKPOINT_DEFAULT_SETTINGS.laptop),
  tablet: canvasWidthPx(BREAKPOINT_DEFAULT_SETTINGS.tablet),
  phone: canvasWidthPx(BREAKPOINT_DEFAULT_SETTINGS.phone),
};

/** The boundary in pixels: `64rem` is 1024. Rounded to a millionth so `rem * 16` float noise cannot move a width. */
export function boundaryPx(setting: BreakpointSetting): number {
  const pixels = setting.unit === 'rem' ? setting.value * BREAKPOINT_LIMITS.remPx : setting.value;
  return Math.round(pixels * 1e6) / 1e6;
}

/** The canvas width of a breakpoint: the largest whole pixel below its boundary (`width < 64rem` holds up to 1023). */
export function canvasWidthPx(setting: BreakpointSetting): number {
  const width = Math.ceil(boundaryPx(setting)) - 1;
  assert(Number.isSafeInteger(width), 'canvasWidthPx: a whole number of pixels');
  return width;
}

/** All three canvas widths. The only place settings become widths. */
export function resolveBreakpointWidths(settings: BreakpointSettings): BreakpointWidths {
  return { laptop: canvasWidthPx(settings.laptop), tablet: canvasWidthPx(settings.tablet), phone: canvasWidthPx(settings.phone) };
}

/** The setting as typed and shown: `64rem`, `62.5rem`, `1024px`. */
export function formatBreakpoint(setting: BreakpointSetting): string {
  return `${setting.value}${setting.unit}`;
}

/** The setting as a query condition: `width < 64rem`. */
export function breakpointCondition(setting: BreakpointSetting): string {
  return `width < ${formatBreakpoint(setting)}`;
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

/** The first row that is not smaller than the row above it (tablet against laptop, then phone against tablet), if any. */
export function firstOutOfOrder(settings: BreakpointSettings): BreakpointKey | undefined {
  if (boundaryPx(settings.tablet) >= boundaryPx(settings.laptop)) {
    return 'tablet';
  }
  if (boundaryPx(settings.phone) >= boundaryPx(settings.tablet)) {
    return 'phone';
  }
  return undefined;
}

/** Three settings checked as a set: each valid, and strictly decreasing from laptop to phone in pixels. */
export function checkedSettings(candidate: { readonly laptop: unknown; readonly tablet: unknown; readonly phone: unknown }): Result<BreakpointSettings> {
  const parsed: Partial<Record<BreakpointKey, BreakpointSetting>> = {};
  for (const key of BREAKPOINT_KEYS) {
    const entry = candidate[key];
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return failure('shape', `${key} must be an object with a value and a unit`);
    }
    const fields = new Map<string, unknown>(Object.entries(entry));
    for (const name of fields.keys()) {
      if (name !== 'value' && name !== 'unit') {
        return failure('shape', `unknown field "${name}" in ${key}`);
      }
    }
    const setting = checkedSetting({ value: fields.get('value'), unit: fields.get('unit') });
    if (!setting.ok) {
      return failure(setting.error.code.replace('breakpoints-', ''), `${key}: ${setting.error.message.replace('.stacki/breakpoints.json: ', '')}`);
    }
    parsed[key] = setting.value;
  }
  const { laptop, tablet, phone } = parsed;
  assert(laptop !== undefined, 'checkedSettings: laptop was checked above');
  assert(tablet !== undefined, 'checkedSettings: tablet was checked above');
  assert(phone !== undefined, 'checkedSettings: phone was checked above');
  const settings: BreakpointSettings = { laptop, tablet, phone };
  const outOfOrder = firstOutOfOrder(settings);
  if (outOfOrder === 'tablet') {
    return failure('order', 'tablet must be smaller than laptop');
  }
  if (outOfOrder === 'phone') {
    return failure('order', 'phone must be smaller than tablet');
  }
  return ok(settings);
}

/** The file's bytes to settings. `undefined` (no file yet) reads as the defaults. */
export function parseBreakpointsSource(source: string | undefined): Result<BreakpointSettings> {
  if (source === undefined) {
    return ok(BREAKPOINT_DEFAULT_SETTINGS);
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

/** A parsed JSON value to settings, every field checked. Version 1 (whole pixel widths) is migrated in memory. */
export function parseBreakpoints(input: unknown): Result<BreakpointSettings> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return failure('shape', 'expected an object');
  }
  const fields = new Map<string, unknown>(Object.entries(input));
  const version = fields.get('version');
  if (version !== 1 && version !== 2) {
    return failure('version', 'unsupported version, expected 2');
  }
  for (const name of fields.keys()) {
    if (name !== 'version' && !isBreakpointKey(name)) {
      return failure('shape', `unknown field "${name}"`);
    }
  }
  const candidate = { laptop: fields.get('laptop'), tablet: fields.get('tablet'), phone: fields.get('phone') };
  if (version === 2) {
    return checkedSettings(candidate);
  }
  return migrateVersionOne(candidate);
}

// Version 1 held canvas widths in whole pixels, 280 to 7680, strictly descending. The boundary is the width plus one pixel, so
// every canvas width stays what it was; exactly the old defaults become the rem defaults, which resolve to the same widths.
function migrateVersionOne(candidate: { readonly laptop: unknown; readonly tablet: unknown; readonly phone: unknown }): Result<BreakpointSettings> {
  const widths: Partial<Record<BreakpointKey, number>> = {};
  for (const key of BREAKPOINT_KEYS) {
    const width = candidate[key];
    if (typeof width !== 'number') {
      return failure('type', `${key} must be a number`);
    }
    if (!Number.isSafeInteger(width)) {
      return failure('integer', `${key} must be a whole number of pixels`);
    }
    widths[key] = width;
  }
  const { laptop, tablet, phone } = widths;
  assert(laptop !== undefined, 'migrateVersionOne: laptop was read above');
  assert(tablet !== undefined, 'migrateVersionOne: tablet was read above');
  assert(phone !== undefined, 'migrateVersionOne: phone was read above');
  if (laptop === BREAKPOINT_DEFAULTS.laptop && tablet === BREAKPOINT_DEFAULTS.tablet && phone === BREAKPOINT_DEFAULTS.phone) {
    return ok(BREAKPOINT_DEFAULT_SETTINGS);
  }
  return checkedSettings({
    laptop: { value: laptop + 1, unit: 'px' },
    tablet: { value: tablet + 1, unit: 'px' },
    phone: { value: phone + 1, unit: 'px' },
  });
}

/** The pretty-printed version 2 file text: fixed key order, two-space indent, a trailing newline, so equal values are equal bytes. */
export function serializeBreakpoints(settings: BreakpointSettings): string {
  const checked = checkedSettings(settings);
  assert(checked.ok, 'serializeBreakpoints: the settings are a valid set');
  const entry = (setting: BreakpointSetting): { readonly value: number; readonly unit: BreakpointUnit } => ({ value: setting.value, unit: setting.unit });
  const text =
    JSON.stringify({ version: 2, laptop: entry(settings.laptop), tablet: entry(settings.tablet), phone: entry(settings.phone) }, undefined, 2) + '\n';
  assert(text.length <= BREAKPOINT_LIMITS.fileBytesMax, 'serializeBreakpoints: within the file bound');
  return text;
}

export function breakpointsEqual(first: BreakpointSettings, second: BreakpointSettings): boolean {
  return BREAKPOINT_KEYS.every((key) => first[key].value === second[key].value && first[key].unit === second[key].unit);
}

function isBreakpointKey(name: string): name is BreakpointKey {
  return BREAKPOINT_KEYS.some((key) => key === name);
}

function failure(code: string, detail: string): Result<never, AppError> {
  return err({ code: `breakpoints-${code}`, message: `.stacki/breakpoints.json: ${detail}` });
}
