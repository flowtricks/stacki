// The length unit a project writes: one project-level setting, derived once at
// the project boundary (the scan) and read by every control that writes a length.
//
// Lumos projects never use px — LUMOS.md says "Uses no `px`. Lengths are `rem`".
// So in a Lumos project the style panel writes rem: a slider, a scrub, an arrow
// step, a default and a typed `12px` all land as rem, converted at the project's
// root font size. Every other project keeps px, exactly as before.
//
// A project is Lumos when its package.json carries the installer's `lumos` block,
// or when it has a LUMOS.md. Both are checked because the installer leaves the
// block out when GitHub's API is unavailable (LUMOS.md, "Framework releases").
//
// The root font size is 16px unless a global stylesheet sets `font-size` on
// `html` or `:root` to a static length (`62.5%`, `18px`, `1.125rem`). A fluid
// root (`clamp(…)`, a variable) has no single size to convert at, so it keeps 16.

import { assert } from '../core/assert';

/** What a length the panel writes is written in. */
export type LengthUnit = { readonly kind: 'px' } | { readonly kind: 'rem'; readonly rootFontPx: number };

/** The two units a project can write lengths in, as CSS spells them. */
export type LengthUnitName = 'px' | 'rem';

export const LENGTH_UNIT_LIMITS = {
  /** A root font size outside this range is a typo, not a design. */
  rootFontPxMin: 1,
  rootFontPxMax: 128,
  /** The browser's root font size, which rem means when nothing sets another. */
  rootFontPxDefault: 16,
  /** package.json is read whole; a larger manifest is not a project's manifest. */
  manifestCharsMax: 256 * 1024,
  /** Global stylesheets searched for the root font size. */
  stylesheetsMax: 32,
  stylesheetCharsMax: 1024 * 1024,
  /** A CSS value converted in one call; a longer one is written as typed. */
  valueCharsMax: 64 * 1024,
  /** Decimal places a converted rem keeps: 1px at 16px is 0.0625rem, exact at 4. */
  remDecimalsMax: 4,
  /** A px length beyond this is not a length anyone means; it is left alone. */
  pxMagnitudeMax: 1_000_000,
} as const satisfies Record<string, number>;

export const PX_LENGTHS: LengthUnit = { kind: 'px' };

/** The markers a project's files hold, read by the host (Desktop's scan, Studio's server). */
export interface LengthUnitMarkers {
  /** package.json's text, or undefined when the project has none. */
  readonly manifest: string | undefined;
  /** Whether the project root has a LUMOS.md. */
  readonly lumosGuide: boolean;
  /** Global stylesheets' text, in the order the site loads them where known. */
  readonly stylesheets: readonly string[];
}

/** The project's length unit, from its markers. Total: an unreadable manifest is not Lumos. */
export function detectLengthUnit(markers: LengthUnitMarkers): LengthUnit {
  assert(markers.stylesheets.length <= LENGTH_UNIT_LIMITS.stylesheetsMax, 'detectLengthUnit: stylesheet count is bounded');
  if (!markers.lumosGuide && !isLumosManifest(markers.manifest)) {
    return PX_LENGTHS;
  }
  let rootFontPx: number = LENGTH_UNIT_LIMITS.rootFontPxDefault;
  for (const sheet of markers.stylesheets) {
    const declared = rootFontPxFromCss(sheet);
    if (declared !== undefined) {
      rootFontPx = declared; // A later sheet wins, as it would in the cascade.
    }
  }
  const unit: LengthUnit = { kind: 'rem', rootFontPx };
  assertLengthUnit(unit);
  return unit;
}

/** Whether a package.json's text carries the Lumos installer's `lumos` block. */
export function isLumosManifest(manifest: string | undefined): boolean {
  if (manifest === undefined) {
    return false;
  }
  if (manifest.length > LENGTH_UNIT_LIMITS.manifestCharsMax) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifest) as unknown;
  } catch {
    // A broken package.json is the project's problem to report, not the scan's.
    return false;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const block: unknown = (parsed as Record<string, unknown>)['lumos'];
  if (typeof block !== 'object' || block === null) {
    return false;
  }
  return !Array.isArray(block);
}

// `html { … }` or `:root { … }` at the top of a sheet, and the font-size inside it.
const ROOT_RULE = /(?:^|[}\s;])(?:html|:root)\s*\{([^{}]*)\}/g;
const ROOT_FONT_SIZE = /(?:^|[\s;{])font-size\s*:\s*(\d+(?:\.\d+)?|\.\d+)(px|%|rem|em)\s*(?:!important\s*)?(?:;|$)/i;

/** The root font size a stylesheet sets in px, or undefined when it sets none it can state statically. */
export function rootFontPxFromCss(css: string): number | undefined {
  if (css.length > LENGTH_UNIT_LIMITS.stylesheetCharsMax) {
    return undefined;
  }
  let found: number | undefined;
  ROOT_RULE.lastIndex = 0;
  // A global regex visits each rule once; the sheet's length bounds the loop.
  for (let match = ROOT_RULE.exec(css); match !== null; match = ROOT_RULE.exec(css)) {
    const size = ROOT_FONT_SIZE.exec((match[1] ?? '').trim());
    if (size !== null) {
      const px = rootSizePx(Number(size[1]), (size[2] ?? '').toLowerCase());
      if (px >= LENGTH_UNIT_LIMITS.rootFontPxMin && px <= LENGTH_UNIT_LIMITS.rootFontPxMax) {
        found = px;
      }
    }
  }
  return found;
}

// A root font-size in px: relative units are relative to the browser's 16px.
function rootSizePx(amount: number, unit: string): number {
  assert(Number.isFinite(amount), 'rootSizePx: the amount is a number');
  if (unit === 'px') {
    return amount;
  }
  if (unit === '%') {
    return (amount * LENGTH_UNIT_LIMITS.rootFontPxDefault) / 100;
  }
  assert(unit === 'rem' || unit === 'em', `rootSizePx: unknown unit ${unit}`);
  return amount * LENGTH_UNIT_LIMITS.rootFontPxDefault;
}

/** Parse a length unit crossing a boundary (the scan payload). Throws on any other shape. */
export function parseLengthUnit(input: unknown): LengthUnit {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('LengthUnit: expected object');
  }
  const record = input as Record<string, unknown>;
  if (record['kind'] === 'px') {
    return PX_LENGTHS;
  }
  if (record['kind'] !== 'rem') {
    throw new Error('LengthUnit.kind: expected "px" or "rem"');
  }
  const rootFontPx = record['rootFontPx'];
  if (typeof rootFontPx !== 'number' || !Number.isFinite(rootFontPx)) {
    throw new Error('LengthUnit.rootFontPx: expected a finite number');
  }
  if (rootFontPx < LENGTH_UNIT_LIMITS.rootFontPxMin) {
    throw new Error('LengthUnit.rootFontPx: below the minimum');
  }
  if (rootFontPx > LENGTH_UNIT_LIMITS.rootFontPxMax) {
    throw new Error('LengthUnit.rootFontPx: above the maximum');
  }
  return { kind: 'rem', rootFontPx };
}

/** The unit a length is written in. */
export function lengthUnitName(unit: LengthUnit): LengthUnitName {
  return unit.kind;
}

/** Whether two settings write the same lengths (a rescan builds a new object each time). */
export function sameLengthUnit(left: LengthUnit, right: LengthUnit): boolean {
  if (left.kind === 'px') {
    return right.kind === 'px';
  }
  if (right.kind === 'px') {
    return false;
  }
  return left.rootFontPx === right.rootFontPx;
}

/** px → rem at a root font size, rounded to LENGTH_UNIT_LIMITS.remDecimalsMax places. */
export function pxToRem(px: number, rootFontPx: number): number {
  assert(Number.isFinite(px), 'pxToRem: px is a finite number');
  assertRootFontPx(rootFontPx);
  const rem = roundDecimals(px / rootFontPx);
  assert(Number.isFinite(rem), 'pxToRem: the result is a finite number');
  assert(Math.sign(rem) === Math.sign(px) || rem === 0, 'pxToRem: conversion keeps the sign');
  return rem;
}

/** rem → px at a root font size. */
export function remToPx(rem: number, rootFontPx: number): number {
  assert(Number.isFinite(rem), 'remToPx: rem is a finite number');
  assertRootFontPx(rootFontPx);
  const px = Math.round(rem * rootFontPx * 1e6) / 1e6; // Shed float dust, keep sub-pixels.
  assert(Number.isFinite(px), 'remToPx: the result is a finite number');
  return px;
}

/**
 * A length given in px, written in the project's unit: `12px` or `0.75rem`.
 * Sliders work in px so their steps are whole pixels in either unit.
 */
export function formatPxLength(px: number, unit: LengthUnit): string {
  assert(Number.isFinite(px), 'formatPxLength: px is a finite number');
  if (unit.kind === 'px') {
    return `${numberText(Math.round(px * 1e4) / 1e4)}px`;
  }
  return `${numberText(pxToRem(px, unit.rootFontPx))}rem`;
}

/**
 * A number and its unit as the project writes it: px becomes rem in a rem
 * project; every other unit (em, %, deg, …) and every px project is untouched.
 */
export function projectLength(amount: number, unit: string, lengthUnit: LengthUnit): { readonly amount: number; readonly unit: string } {
  assert(Number.isFinite(amount), 'projectLength: the amount is a finite number');
  if (lengthUnit.kind === 'rem' && unit.toLowerCase() === 'px') {
    return { amount: pxToRem(amount, lengthUnit.rootFontPx), unit: 'rem' };
  }
  return { amount, unit };
}

/** The unit a control defaults to: a px default becomes the project's length unit. */
export function projectDefaultUnit(defaultUnit: string, lengthUnit: LengthUnit): string {
  return defaultUnit.toLowerCase() === 'px' ? lengthUnitName(lengthUnit) : defaultUnit;
}

/** How many px one unit of a length spans, or undefined for a unit that isn't px or rem. */
export function pxPerLengthUnit(unit: string, lengthUnit: LengthUnit): number | undefined {
  const normalized = unit.toLowerCase();
  if (normalized === 'px') {
    return 1;
  }
  if (normalized === 'rem') {
    return lengthUnit.kind === 'rem' ? lengthUnit.rootFontPx : LENGTH_UNIT_LIMITS.rootFontPxDefault;
  }
  return undefined;
}

// A px length in a value: the number (sign included) and `px`, not glued to an
// identifier (`--space-2px`), a hex colour or another number on its left, and
// not running on into a longer word. Strings and url()s are matched first so
// their contents are passed over whole.
const PX_TOKEN = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|url\([^)]*\))|(?<![\w.#-])(-?(?:\d+\.?\d*|\.\d+))px(?![\w-])/gi;

/**
 * A CSS value with every px length rewritten in the project's unit. A px
 * project gets the value back unchanged; so does a value over the length bound.
 */
export function convertPxLengths(value: string, lengthUnit: LengthUnit): string {
  if (lengthUnit.kind === 'px') {
    return value;
  }
  if (value.length > LENGTH_UNIT_LIMITS.valueCharsMax) {
    return value;
  }
  const converted = value.replace(PX_TOKEN, (match: string, quoted: string | undefined, number: string | undefined) => {
    if (quoted !== undefined || number === undefined) {
      return match;
    }
    const px = Number(number);
    if (!Number.isFinite(px) || Math.abs(px) > LENGTH_UNIT_LIMITS.pxMagnitudeMax) {
      return match;
    }
    return `${numberText(pxToRem(px, lengthUnit.rootFontPx))}rem`;
  });
  assert(converted.length <= value.length * 2 + 16, 'convertPxLengths: conversion stays near the input length');
  return converted;
}

function assertLengthUnit(unit: LengthUnit): void {
  if (unit.kind === 'rem') {
    assertRootFontPx(unit.rootFontPx);
  }
}

function assertRootFontPx(rootFontPx: number): void {
  assert(Number.isFinite(rootFontPx), 'root font size is a finite number');
  assert(rootFontPx >= LENGTH_UNIT_LIMITS.rootFontPxMin, 'root font size is at least the minimum');
  assert(rootFontPx <= LENGTH_UNIT_LIMITS.rootFontPxMax, 'root font size is at most the maximum');
}

function roundDecimals(value: number): number {
  const factor = 10 ** LENGTH_UNIT_LIMITS.remDecimalsMax;
  return Math.round(value * factor) / factor;
}

// A number as CSS reads it: no `-0`, no exponent for the magnitudes the limits allow.
function numberText(value: number): string {
  assert(Math.abs(value) <= LENGTH_UNIT_LIMITS.pxMagnitudeMax, 'numberText: magnitude is bounded');
  return String(Object.is(value, -0) ? 0 : value);
}
