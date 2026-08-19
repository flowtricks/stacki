// Arrow-key number stepping (a devtools-style value scrubber), shared by every
// numeric field in the tool.
//
// Up/Down over a number the caret is inside or touching bumps it:
//   plain → nearest whole (1.8 → 2), Shift → nearest 10 (1.8 → 10),
//   Alt   → nearest 0.1 (1.8 → 1.9) — except rem, which nudges by 1px (1/16rem).
//
// Works with any unit (px, ch, cqw, cqh, em, vw, vh, svh, lvh, %, …) and no unit
// (line-height, font-weight, …) — the unit only matters for rem's fine step.

import type { KeyboardEvent } from 'react'

export type StepMode = 'whole' | 'ten' | 'fine'

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

/**
 * Step the number whose number-or-unit the caret sits inside/touches; null if none.
 *
 * `min` is a floor the step stops at — for a field whose property refuses to go
 * below it. Stepping past a floor and letting the write clamp it would leave the
 * field showing a number the page never took.
 */
export function stepNumberAtCaret(text: string, caret: number, dir: 1 | -1, mode: StepMode, min?: number): { text: string; caret: number } | null {
  NUMBER_UNIT_RE.lastIndex = 0
  let hit: { start: number; numEnd: number; raw: string; unit: string } | null = null
  let match: RegExpExecArray | null
  while ((match = NUMBER_UNIT_RE.exec(text))) {
    const start = match.index
    const numEnd = start + match[1].length
    const end = numEnd + match[2].length // number + unit span
    if (caret >= start && caret <= end) { hit = { start, numEnd, raw: match[1], unit: match[2] }; break }
    if (start > caret) break
  }
  if (!hit) return null
  const num = Number.parseFloat(hit.raw)
  if (!Number.isFinite(num)) return null
  const stepped = snapStep(num, stepSizeFor(mode, hit.unit.toLowerCase()), dir)
  const nextStr = String(min != null && stepped < min ? min : stepped)
  // Keep the caret where it was: end of the new number if it was in the number,
  // else shift it along with the unit by the number's length change.
  const nextCaret = caret <= hit.numEnd ? hit.start + nextStr.length : caret + (nextStr.length - hit.raw.length)
  return { text: text.slice(0, hit.start) + nextStr + text.slice(hit.numEnd), caret: nextCaret }
}

/**
 * Handle an Up/Down key on a text field: if the caret is on a number, return the
 * stepped text + caret (the caller applies it + preventDefault). Returns null for
 * any other key or when the caret isn't on a number.
 */
export function handleArrowStep(
  event: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  min?: number,
): { text: string; caret: number } | null {
  if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return null
  const el = event.currentTarget
  const mode: StepMode = event.shiftKey ? 'ten' : event.altKey ? 'fine' : 'whole'
  return stepNumberAtCaret(el.value, el.selectionStart ?? el.value.length, event.key === 'ArrowUp' ? 1 : -1, mode, min)
}
