// Number editing for every numeric field in the tool: arrow-key stepping and
// pointer scrubbing, sharing one set of step sizes so both gestures agree.
//
// Up/Down over a number the caret is inside or touching bumps it:
//   plain → nearest whole (1.8 → 2), Shift → nearest 10 (1.8 → 10),
//   Alt   → nearest 0.1 (1.8 → 1.9) — except rem, which nudges by 1px (1/16rem).
//
// A scrub (see components/useScrub.ts) drags the same number by the same steps,
// one step per screen pixel, but adds from the value it grabbed rather than
// snapping to a multiple — snapping mid-drag would stall on the first pixel.
//
// Works with any unit (px, ch, cqw, cqh, em, vw, vh, svh, lvh, %, …) and no unit
// (line-height, font-weight, …) — the unit only matters for rem's fine step.
//
// A rem project (shared/properties/lengthUnit.ts) steps lengths the way a px
// project steps px: a step is one pixel, ten with Shift, a tenth with Alt, all
// written in rem (0.0625rem at a 16px root). A px number stepped there is
// written in rem from the first step: the project never writes px.

import type { KeyboardEvent } from 'react';
import { projectLength, type LengthUnit } from '../../../../shared/properties/lengthUnit';
import { projectLengthUnit } from './lengthUnit';

export type StepMode = 'whole' | 'ten' | 'fine';

/** A number and the unit glued to it, located in the value string that holds it. */
export type NumberRun = {
  /** First character of the number (its sign, if any). */
  start: number;
  /** One past the number — where the unit begins. */
  numEnd: number;
  /** One past the unit; `numEnd` when the number is bare. */
  end: number;
  /** The number as authored (`-1.5`, `.75`), not yet parsed. */
  raw: string;
  /** The trailing unit, `''` when bare. */
  unit: string;
};

const ROOT_PX = 16;
// A number plus its optional unit (`1.8rem`, `50%`, `10ch`, `1.5`) — captured as
// two groups so the caret can sit anywhere in the number OR the unit to step it.
const NUMBER_UNIT_RE = /([-+]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]*)/g;

function stepSizeFor(mode: StepMode, unit: string, scale: number, lengthUnit: LengthUnit): number {
  if (lengthUnit.kind === 'rem' && unit === 'rem') {
    // One pixel in rem: the project's lengths move in pixels, written in rem.
    return pixelSteps(mode) * (scale / lengthUnit.rootFontPx);
  }
  if (mode === 'ten') {
    return 10 * scale;
  }
  if (mode === 'whole') {
    return scale;
  }
  // Fine step (Alt): rem keeps a 1px-equivalent nudge; every other unit steps 0.1.
  if (unit === 'rem') {
    return scale / ROOT_PX;
  }
  return 0.1 * scale;
}

// Pixels per step for each mode, matching the px steps above.
function pixelSteps(mode: StepMode): number {
  if (mode === 'ten') {
    return 10;
  }
  if (mode === 'whole') {
    return 1;
  }
  return 0.1;
}

// The number a step starts from, in the unit it will be written in: a px run in a
// rem project is read as its rem. `unitText` is what follows the new number — the
// run's own spelling when the unit is kept, so `PX` and `Rem` survive untouched.
function stepBase(text: string, run: NumberRun, lengthUnit: LengthUnit): { amount: number; unit: string; unitText: string } | undefined {
  const parsed = Number.parseFloat(run.raw);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }
  const written = projectLength(parsed, run.unit, lengthUnit);
  const unit = written.unit.toLowerCase();
  const unitText = written.unit === run.unit ? text.slice(run.numEnd, run.end) : written.unit;
  return { amount: written.amount, unit, unitText };
}

// Next multiple of `step` strictly past `value` in the given direction.
function snapStep(value: number, step: number, direction: 1 | -1): number {
  const quotient = value / step;
  const raw = direction > 0 ? (Math.floor(quotient + 1e-9) + 1) * step : (Math.ceil(quotient - 1e-9) - 1) * step;
  return Math.round(raw * 1e5) / 1e5; // shed float dust (0.1 + 0.2 …)
}

/** Every number-plus-unit run in the value, left to right. */
function numberRuns(text: string): NumberRun[] {
  NUMBER_UNIT_RE.lastIndex = 0;
  const runs: NumberRun[] = [];
  // A global regex advances `lastIndex` on every match, so each run is visited once.
  for (let match = NUMBER_UNIT_RE.exec(text); match !== null; match = NUMBER_UNIT_RE.exec(text)) {
    const start = match.index;
    const raw = match[1] ?? '';
    const unit = match[2] ?? '';
    const numberEnd = start + raw.length;
    runs.push({ start, numEnd: numberEnd, end: numberEnd + unit.length, raw, unit });
  }
  return runs;
}

/**
 * Step the number whose number-or-unit the caret sits inside/touches; undefined if none.
 *
 * `min` is a floor the step stops at — for a field whose property refuses to go
 * below it. Stepping past a floor and letting the write clamp it would leave the
 * field showing a number the page never took.
 */
export function stepNumberAtCaret(
  text: string,
  caret: number,
  direction: 1 | -1,
  mode: StepMode,
  min?: number,
  scale = 1,
  lengthUnit: LengthUnit = projectLengthUnit(),
): { text: string; caret: number } | undefined {
  const hit = numberRuns(text).find((run) => caret >= run.start && caret <= run.end);
  if (!hit) {
    return undefined;
  }
  const base = stepBase(text, hit, lengthUnit);
  if (base === undefined) {
    return undefined;
  }
  const stepped = snapStep(base.amount, stepSizeFor(mode, base.unit, scale, lengthUnit), direction);
  const nextText = String(min !== undefined && stepped < min ? min : stepped);
  // Keep the caret where it was: end of the new number if it was in the number,
  // else at the same place in the unit, which may now be spelled differently.
  const unitOffset = Math.min(caret - hit.numEnd, base.unitText.length);
  const nextCaret = caret <= hit.numEnd ? hit.start + nextText.length : hit.start + nextText.length + unitOffset;
  return { text: text.slice(0, hit.start) + nextText + base.unitText + text.slice(hit.end), caret: nextCaret };
}

// ───────────────────────────── Pointer scrubbing ─────────────────────────────

// Units a scrub is willing to drag. A number's trailing letters are only a unit if
// they're on this list — which is what keeps the scrub off `#3366ff` (unit "ff") and
// `translate3d` (unit "d"), where dragging would corrupt the value rather than edit it.
const SCRUB_UNITS = new Set([
  '',
  '%',
  'px',
  'em',
  'rem',
  'ex',
  'ch',
  'cap',
  'ic',
  'lh',
  'rlh',
  'vw',
  'vh',
  'vi',
  'vb',
  'vmin',
  'vmax',
  'svw',
  'svh',
  'lvw',
  'lvh',
  'dvw',
  'dvh',
  'cqw',
  'cqh',
  'cqi',
  'cqb',
  'cqmin',
  'cqmax',
  'cm',
  'mm',
  'q',
  'in',
  'pt',
  'pc',
  'deg',
  'grad',
  'rad',
  'turn',
  's',
  'ms',
  'hz',
  'khz',
  'dpi',
  'dpcm',
  'dppx',
  'x',
  'fr',
]);

// A run is only a value if nothing glues it to the token on its left. `#` starts a hex
// colour; a word character or hyphen means we're inside an identifier (`--space-4`,
// `col-2`) where the digits are part of a name, not a length. A real minus sign is
// captured into the number itself, so a hyphen here is never a sign.
function isScrubbable(text: string, run: NumberRun): boolean {
  const before = text[run.start - 1];
  if (before !== undefined && /[\w#-]/.test(before)) {
    return false;
  }
  return SCRUB_UNITS.has(run.unit.toLowerCase());
}

/**
 * The number a scrub starting at `caret` should drag: the run under the pointer, else
 * the nearest one (ties go left). Lets you grab any of `0 2px 4px` by pressing over it,
 * and still does the sensible thing when you land on whitespace or on `solid`.
 * Returns undefined when the value holds no number worth dragging.
 */
export function findScrubTarget(text: string, caret: number): NumberRun | undefined {
  const runs = numberRuns(text).filter((run) => isScrubbable(text, run));
  const under = runs.find((run) => caret >= run.start && caret <= run.end);
  if (under) {
    return under;
  }
  let best: NumberRun | undefined;
  let bestDistance = Infinity;
  for (const run of runs) {
    const distance = caret < run.start ? run.start - caret : caret - run.end;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = run;
    }
  }
  return best;
}

/** True when a value has anything a scrub could drag — drives the ew-resize cursor. */
export function hasScrubTarget(text: string): boolean {
  return findScrubTarget(text, 0) !== undefined;
}

/**
 * Move `run` by `steps` steps and splice it back into the value, leaving its unit and
 * every other character untouched. Always applied to the text as it was when the drag
 * began, so a drag is one arithmetic step from its origin — no accumulated drift, and
 * changing the modifier mid-drag rescales from the same base rather than from wherever
 * the previous mode happened to leave it.
 */
export function scrubNumber(text: string, run: NumberRun, steps: number, mode: StepMode, scale = 1, lengthUnit: LengthUnit = projectLengthUnit()): string {
  const base = stepBase(text, run, lengthUnit);
  if (base === undefined) {
    return text;
  }
  const next = Math.round((base.amount + steps * stepSizeFor(mode, base.unit, scale, lengthUnit)) * 1e5) / 1e5;
  return text.slice(0, run.start) + String(next) + base.unitText + text.slice(run.end);
}

/** The step mode a pointer/key event's modifiers ask for — shared by both gestures. */
export function stepModeOf(event: { shiftKey: boolean; altKey: boolean }): StepMode {
  return event.shiftKey ? 'ten' : event.altKey ? 'fine' : 'whole';
}

/**
 * Handle an Up/Down key on a text field: if the caret is on a number, return the
 * stepped text + caret (the caller applies it + preventDefault). Returns undefined for
 * any other key or when the caret isn't on a number.
 */
export function handleArrowStep(
  event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  min?: number,
  scale = 1,
): { text: string; caret: number } | undefined {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') {
    return undefined;
  }
  const element = event.currentTarget;
  return stepNumberAtCaret(element.value, element.selectionStart ?? element.value.length, event.key === 'ArrowUp' ? 1 : -1, stepModeOf(event), min, scale);
}
