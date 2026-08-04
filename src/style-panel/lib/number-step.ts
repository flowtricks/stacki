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

import type { KeyboardEvent } from 'react'

export type StepMode = 'whole' | 'ten' | 'fine'

/** A number and the unit glued to it, located in the value string that holds it. */
export type NumberRun = {
  /** First character of the number (its sign, if any). */
  start: number
  /** One past the number — where the unit begins. */
  numEnd: number
  /** One past the unit; `numEnd` when the number is bare. */
  end: number
  /** The number as authored (`-1.5`, `.75`), not yet parsed. */
  raw: string
  /** The trailing unit, `''` when bare. */
  unit: string
}

const ROOT_PX = 16
// A number plus its optional unit (`1.8rem`, `50%`, `10ch`, `1.5`) — captured as
// two groups so the caret can sit anywhere in the number OR the unit to step it.
const NUMBER_UNIT_RE = /([-+]?(?:\d+\.?\d*|\.\d+))([a-zA-Z%]*)/g

function stepSizeFor(mode: StepMode, unit: string): number {
  if (mode === 'ten') return 10
  if (mode === 'whole') return 1
  // Fine step (Alt): rem keeps a 1px-equivalent nudge; every other unit steps 0.1.
  if (unit === 'rem') return 1 / ROOT_PX
  return 0.1
}

// Next multiple of `step` strictly past `value` in the given direction.
function snapStep(value: number, step: number, dir: 1 | -1): number {
  const q = value / step
  const raw = dir > 0 ? (Math.floor(q + 1e-9) + 1) * step : (Math.ceil(q - 1e-9) - 1) * step
  return Math.round(raw * 1e5) / 1e5 // shed float dust (0.1 + 0.2 …)
}

/** Every number-plus-unit run in the value, left to right. */
function numberRuns(text: string): NumberRun[] {
  NUMBER_UNIT_RE.lastIndex = 0
  const runs: NumberRun[] = []
  let match: RegExpExecArray | null
  while ((match = NUMBER_UNIT_RE.exec(text))) {
    const start = match.index
    const numEnd = start + match[1].length
    runs.push({ start, numEnd, end: numEnd + match[2].length, raw: match[1], unit: match[2] })
  }
  return runs
}

/** Step the number whose number-or-unit the caret sits inside/touches; null if none. */
export function stepNumberAtCaret(text: string, caret: number, dir: 1 | -1, mode: StepMode): { text: string; caret: number } | null {
  const hit = numberRuns(text).find((run) => caret >= run.start && caret <= run.end)
  if (!hit) return null
  const num = Number.parseFloat(hit.raw)
  if (!Number.isFinite(num)) return null
  const nextStr = String(snapStep(num, stepSizeFor(mode, hit.unit.toLowerCase()), dir))
  // Keep the caret where it was: end of the new number if it was in the number,
  // else shift it along with the unit by the number's length change.
  const nextCaret = caret <= hit.numEnd ? hit.start + nextStr.length : caret + (nextStr.length - hit.raw.length)
  return { text: text.slice(0, hit.start) + nextStr + text.slice(hit.numEnd), caret: nextCaret }
}

// ───────────────────────────── Pointer scrubbing ─────────────────────────────

// Units a scrub is willing to drag. A number's trailing letters are only a unit if
// they're on this list — which is what keeps the scrub off `#3366ff` (unit "ff") and
// `translate3d` (unit "d"), where dragging would corrupt the value rather than edit it.
const SCRUB_UNITS = new Set([
  '', '%',
  'px', 'em', 'rem', 'ex', 'ch', 'cap', 'ic', 'lh', 'rlh',
  'vw', 'vh', 'vi', 'vb', 'vmin', 'vmax',
  'svw', 'svh', 'lvw', 'lvh', 'dvw', 'dvh',
  'cqw', 'cqh', 'cqi', 'cqb', 'cqmin', 'cqmax',
  'cm', 'mm', 'q', 'in', 'pt', 'pc',
  'deg', 'grad', 'rad', 'turn',
  's', 'ms', 'hz', 'khz',
  'dpi', 'dpcm', 'dppx', 'x', 'fr',
])

// A run is only a value if nothing glues it to the token on its left. `#` starts a hex
// colour; a word character or hyphen means we're inside an identifier (`--space-4`,
// `col-2`) where the digits are part of a name, not a length. A real minus sign is
// captured into the number itself, so a hyphen here is never a sign.
function isScrubbable(text: string, run: NumberRun): boolean {
  const before = text[run.start - 1]
  if (before !== undefined && /[\w#-]/.test(before)) return false
  return SCRUB_UNITS.has(run.unit.toLowerCase())
}

/**
 * The number a scrub starting at `caret` should drag: the run under the pointer, else
 * the nearest one (ties go left). Lets you grab any of `0 2px 4px` by pressing over it,
 * and still does the sensible thing when you land on whitespace or on `solid`.
 * Returns null when the value holds no number worth dragging.
 */
export function findScrubTarget(text: string, caret: number): NumberRun | null {
  const runs = numberRuns(text).filter((run) => isScrubbable(text, run))
  const under = runs.find((run) => caret >= run.start && caret <= run.end)
  if (under) return under
  let best: NumberRun | null = null
  let bestDistance = Infinity
  for (const run of runs) {
    const distance = caret < run.start ? run.start - caret : caret - run.end
    if (distance < bestDistance) { bestDistance = distance; best = run }
  }
  return best
}

/** True when a value has anything a scrub could drag — drives the ew-resize cursor. */
export function hasScrubTarget(text: string): boolean {
  return findScrubTarget(text, 0) !== null
}

/**
 * Move `run` by `steps` steps and splice it back into the value, leaving its unit and
 * every other character untouched. Always applied to the text as it was when the drag
 * began, so a drag is one arithmetic step from its origin — no accumulated drift, and
 * changing the modifier mid-drag rescales from the same base rather than from wherever
 * the previous mode happened to leave it.
 */
export function scrubNumber(text: string, run: NumberRun, steps: number, mode: StepMode): string {
  const base = Number.parseFloat(run.raw)
  if (!Number.isFinite(base)) return text
  const next = Math.round((base + steps * stepSizeFor(mode, run.unit.toLowerCase())) * 1e5) / 1e5
  return text.slice(0, run.start) + String(next) + text.slice(run.numEnd)
}

/** The step mode a pointer/key event's modifiers ask for — shared by both gestures. */
export function stepModeOf(event: { shiftKey: boolean; altKey: boolean }): StepMode {
  return event.shiftKey ? 'ten' : event.altKey ? 'fine' : 'whole'
}

/**
 * Handle an Up/Down key on a text field: if the caret is on a number, return the
 * stepped text + caret (the caller applies it + preventDefault). Returns null for
 * any other key or when the caret isn't on a number.
 */
export function handleArrowStep(
  event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
): { text: string; caret: number } | null {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null
  const el = event.currentTarget
  return stepNumberAtCaret(el.value, el.selectionStart ?? el.value.length, event.key === 'ArrowUp' ? 1 : -1, stepModeOf(event))
}
