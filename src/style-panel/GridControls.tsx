import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { GroupLabel } from './TypographySection'
import FieldLabel from './components/FieldLabel'
import { PropTip } from './components/PropTip'
import Select, { type SelectOption } from './components/Select'
import SegmentedControl, { HoverTooltip, type SegmentedOption } from './components/SegmentedControl'
import GridSettings from './GridSettings'
import VariableConnect from './VariableConnect'
import type { ResolvedProp } from './lib/resolved'
import { useHighlight } from './lib/computed-style'
import { commitInPlace } from './lib/commit-in-place'

// The grid controls in the Layout section (shown when Display is grid). Mirrors
// Webflow: Columns/Rows track counts, Direction (+ dense), Align (justify-items X /
// align-items Y), and Justify/Align CONTENT. Gap is the shared GapControl in the
// Layout section, so it isn't repeated here. Resolved-model API (blue when the
// picked selector sets it, clear menu on the label).

type SetProp = (prop: string, value: string, important: boolean) => void
type LiveSetProp = (prop: string, value: string | null, important: boolean) => void
type ClearProp = (prop: string | string[]) => void
type Read = (prop: string) => ResolvedProp | undefined

// ── value lists ──
// grid-auto-flow direction glyphs (Webflow's flow-wrap icons): row fills across then
// wraps down; column fills down then wraps across.
const FlexFlowWrapIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d="M14.207 11.5L10.8535 14.8535L10.1465 14.1465L12.293 12H3V11H12.293L10.1465 8.85352L10.8535 8.14648L14.207 11.5ZM11 4H3V3H11V4Z" fill="currentColor" />
    <path opacity="0.4" d="M11 4.20703L4.20703 11H3V10.793L9.79297 4H11V4.20703Z" fill="currentColor" />
  </svg>
)
const FlexFlowColumnWrapIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path d="M11.5 14.207L14.8535 10.8535L14.1465 10.1465L12 12.293L12 3L11 3L11 12.293L8.85352 10.1465L8.14648 10.8535L11.5 14.207ZM4 11L4 3L3 3L3 11L4 11Z" fill="currentColor" />
    <path opacity="0.4" d="M4.20703 11L11 4.20703L11 3L10.793 3L4 9.79297L4 11L4.20703 11Z" fill="currentColor" />
  </svg>
)
const GRID_FLOW: ReadonlyArray<SegmentedOption<string>> = [
  { value: 'row', label: <FlexFlowWrapIcon />, ariaLabel: 'Horizontal', tooltip: 'Horizontal' },
  { value: 'column', label: <FlexFlowColumnWrapIcon />, ariaLabel: 'Vertical', tooltip: 'Vertical' },
]
// Item alignment (justify-items = X, align-items = Y), Webflow's order.
const GRID_ITEM_ALIGN = ['start', 'center', 'end', 'stretch', 'baseline']
const GRID_CONTENT = ['start', 'center', 'end', 'stretch', 'space-between', 'space-around', 'space-evenly']

// Box alignment has flex-flavoured synonyms for the same positions, and the Flex
// settings block writes those (`justify-content: flex-start` is valid on a grid
// container and behaves as `start`). Fold them onto the grid spelling for DISPLAY, so
// a value authored there — or by hand — still lands on a preset instead of dropping
// the control into its raw-value input. The declaration itself is left alone until
// the user picks something.
const GRID_SYNONYMS: Record<string, string> = {
  'flex-start': 'start',
  'flex-end': 'end',
  'self-start': 'start',
  'self-end': 'end',
  left: 'start',
  right: 'end',
  normal: 'stretch',
}
const gridKeyword = (value: string) => GRID_SYNONYMS[value] ?? value

// Webflow's grid align-self glyphs — the Column set drives X (justify-items), the Row
// set drives Y (align-items). Keyed by grid keyword.
const GridAlignIcon = ({ paths }: { paths: ReactNode }) => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">{paths}</svg>
)
const X_ALIGN_ICONS: Record<string, ReactNode> = {
  start: <path d="M2 1V15H3V9H11.5C11.7761 9 12 8.77614 12 8.5V7.5C12 7.22386 11.7761 7 11.5 7H3V1H2Z" fill="currentColor" />,
  center: <><path d="M7 15V9H2.5C2.22386 9 2 8.77614 2 8.5V7.5C2 7.22386 2.22386 7 2.5 7H7V1H8V15H7Z" fill="currentColor" /><path d="M14 7.5C14 7.22386 13.7761 7 13.5 7H9V9H13.5C13.7761 9 14 8.77614 14 8.5V7.5Z" fill="currentColor" /></>,
  end: <path d="M13 9V15H14V1H13V7H4.5C4.22386 7 4 7.22386 4 7.5V8.5C4 8.77614 4.22386 9 4.5 9H13Z" fill="currentColor" />,
  stretch: <path d="M2 15V1H3V7H13V1H14V15H13V9H3V15H2Z" fill="currentColor" />,
  baseline: <><path d="M13 0V15H14V0H13Z" fill="currentColor" /><path d="M7.64645 1.35355L9.29289 3H3V4H9.29289L7.64645 5.64645L8.35355 6.35355L11.2071 3.5L8.35355 0.646447L7.64645 1.35355Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M3 11.3746V9.6263L11 7.27331V8.31566L8.99994 8.90393V12.0969L11 12.6852V13.7275L3 11.3746ZM7.99994 9.19806L3.9999 10.3746V10.6263L7.99994 11.8028V9.19806Z" fill="currentColor" /></>,
}
const Y_ALIGN_ICONS: Record<string, ReactNode> = {
  start: <path d="M15 2H1V3L7 3L7 11.5C7 11.7761 7.22386 12 7.5 12H8.5C8.77614 12 9 11.7761 9 11.5V3H15V2Z" fill="currentColor" />,
  center: <><path d="M9 7V2.5C9 2.22386 8.77614 2 8.5 2H7.5C7.22386 2 7 2.22386 7 2.5V7L1 7V8L15 8V7H9Z" fill="currentColor" /><path d="M9 9V13.5C9 13.7761 8.77614 14 8.5 14H7.5C7.22386 14 7 13.7761 7 13.5V9H9Z" fill="currentColor" /></>,
  end: <path d="M9 13V4.5C9 4.22386 8.77614 4 8.5 4H7.5C7.22386 4 7 4.22386 7 4.5L7 13L1 13V14L15 14V13H9Z" fill="currentColor" />,
  stretch: <path d="M1 3V2H15V3H9V13L15 13V14L1 14V13H7L7 3L1 3Z" fill="currentColor" />,
  baseline: <><path d="M13 2V8.29289L14.6464 6.64645L15.3536 7.35355L12.5 10.2071L9.64645 7.35355L10.3536 6.64645L12 8.29289V2H13Z" fill="currentColor" /><path d="M16 12L1 12V13L16 13V12Z" fill="currentColor" /><path fillRule="evenodd" clipRule="evenodd" d="M4.62582 2H6.37412L8.72712 10H7.68476L7.09649 7.99994H3.90349L3.31524 10H2.27288L4.62582 2ZM6.80237 6.99994L5.62585 2.9999H5.37409L4.19761 6.99994H6.80237Z" fill="currentColor" /></>,
}
// Axis-aware labels: start/end read Left/Right on X, Top/Bottom on Y (Webflow).
const X_ALIGN_LABELS: Record<string, string> = { start: 'Left', center: 'Center', end: 'Right', stretch: 'Stretch', baseline: 'Baseline' }
const Y_ALIGN_LABELS: Record<string, string> = { start: 'Top', center: 'Center', end: 'Bottom', stretch: 'Stretch', baseline: 'Baseline' }

const LABELS: Record<string, string> = {
  'space-between': 'Space between', 'space-around': 'Space around', 'space-evenly': 'Space evenly',
  start: 'Start', end: 'End', center: 'Center', stretch: 'Stretch',
}
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s)

// ── content-distribution glyphs (justify-content = Columns, align-content = Rows) ──
// Webflow's grid content icons: Column variants for justify-content, Row variants for
// align-content. space-evenly (not in Webflow's set) reuses the space-around glyph.
const CONTENT_PATHS: Record<string, { col: string[]; row: string[] }> = {
  start: {
    col: [
      'M3 14V10H5.5C5.77614 10 6 9.77614 6 9.5V8.5C6 8.22386 5.77614 8 5.5 8H3V7H5.5C5.77614 7 6 6.77614 6 6.5V5.5C6 5.22386 5.77614 5 5.5 5H3V1H2V14H3Z',
      'M7 5.5C7 5.22386 7.22386 5 7.5 5H9.5C9.77614 5 10 5.22386 10 5.5V6.5C10 6.77614 9.77614 7 9.5 7H7.5C7.22386 7 7 6.77614 7 6.5V5.5Z',
      'M7 8.5C7 8.22386 7.22386 8 7.5 8H9.5C9.77614 8 10 8.22386 10 8.5V9.5C10 9.77614 9.77614 10 9.5 10H7.5C7.22386 10 7 9.77614 7 9.5V8.5Z',
    ],
    row: [
      'M15 3L11 3V5.5C11 5.77614 10.7761 6 10.5 6H9.5C9.22386 6 9 5.77614 9 5.5V3L8 3L8 5.5C8 5.77614 7.77614 6 7.5 6H6.5C6.22386 6 6 5.77614 6 5.5L6 3L2 3V2H15V3Z',
      'M6.5 7C6.22386 7 6 7.22386 6 7.5L6 9.5C6 9.77614 6.22386 10 6.5 10H7.5C7.77614 10 8 9.77614 8 9.5L8 7.5C8 7.22386 7.77614 7 7.5 7H6.5Z',
      'M9.5 7C9.22386 7 9 7.22386 9 7.5V9.5C9 9.77614 9.22386 10 9.5 10H10.5C10.7761 10 11 9.77614 11 9.5V7.5C11 7.22386 10.7761 7 10.5 7H9.5Z',
    ],
  },
  center: {
    col: [
      'M7 10V14H8V1H7V5H4.5C4.22386 5 4 5.22386 4 5.5V6.5C4 6.77614 4.22386 7 4.5 7H7V8H4.5C4.22386 8 4 8.22386 4 8.5V9.5C4 9.77614 4.22386 10 4.5 10H7Z',
      'M11.5 5H9V7H11.5C11.7761 7 12 6.77614 12 6.5V5.5C12 5.22386 11.7761 5 11.5 5Z',
      'M9 8H11.5C11.7761 8 12 8.22386 12 8.5V9.5C12 9.77614 11.7761 10 11.5 10H9V8Z',
    ],
    row: [
      'M11 7V4.5C11 4.22386 10.7761 4 10.5 4H9.5C9.22386 4 9 4.22386 9 4.5V7L8 7V4.5C8 4.22386 7.77614 4 7.5 4H6.5C6.22386 4 6 4.22386 6 4.5V7L2 7V8L15 8V7H11Z',
      'M11 9V11.5C11 11.7761 10.7761 12 10.5 12H9.5C9.22386 12 9 11.7761 9 11.5V9H11Z',
      'M8 9V11.5C8 11.7761 7.77614 12 7.5 12H6.5C6.22386 12 6 11.7761 6 11.5V9H8Z',
    ],
  },
  end: {
    col: [
      'M12 14V10H9.5C9.22386 10 9 9.77614 9 9.5V8.5C9 8.22386 9.22386 8 9.5 8H12V7H9.5C9.22386 7 9 6.77614 9 6.5V5.5C9 5.22386 9.22386 5 9.5 5H12V1H13V14H12Z',
      'M8 5.5C8 5.22386 7.77614 5 7.5 5H5.5C5.22386 5 5 5.22386 5 5.5V6.5C5 6.77614 5.22386 7 5.5 7H7.5C7.77614 7 8 6.77614 8 6.5V5.5Z',
      'M8 8.5C8 8.22386 7.77614 8 7.5 8H5.5C5.22386 8 5 8.22386 5 8.5V9.5C5 9.77614 5.22386 10 5.5 10H7.5C7.77614 10 8 9.77614 8 9.5V8.5Z',
    ],
    row: [
      'M6.5 8C6.22386 8 6 7.77614 6 7.5V5.5C6 5.22386 6.22386 5 6.5 5H7.5C7.77614 5 8 5.22386 8 5.5L8 7.5C8 7.77614 7.77614 8 7.5 8H6.5Z',
      'M6.5 9C6.22386 9 6 9.22386 6 9.5V12H2V13L15 13V12L11 12V9.5C11 9.22386 10.7761 9 10.5 9H9.5C9.22386 9 9 9.22386 9 9.5V12H8L8 9.5C8 9.22386 7.77614 9 7.5 9H6.5Z',
      'M9.5 8C9.22386 8 9 7.77614 9 7.5V5.5C9 5.22386 9.22386 5 9.5 5H10.5C10.7761 5 11 5.22386 11 5.5V7.5C11 7.77614 10.7761 8 10.5 8H9.5Z',
    ],
  },
  stretch: {
    col: [
      'M2 14V1H3V5H7.5C7.77614 5 8 5.22386 8 5.5L8 6.5C8 6.77614 7.77614 7 7.5 7H3L3 8H7.5C7.77614 8 8 8.22386 8 8.5L8 9.5C8 9.77614 7.77614 10 7.5 10H3L3 14H2Z',
      'M14 14V10H9.5C9.22386 10 9 9.77614 9 9.5V8.5C9 8.22386 9.22386 8 9.5 8H14V7H9.5C9.22386 7 9 6.77614 9 6.5V5.5C9 5.22386 9.22386 5 9.5 5H14V1H15V14H14Z',
    ],
    row: [
      'M15 3L11 3V6.5C11 6.77614 10.7761 7 10.5 7H9.5C9.22386 7 9 6.77614 9 6.5V3L8 3V6.5C8 6.77614 7.77614 7 7.5 7H6.5C6.22386 7 6 6.77614 6 6.5V3L2 3V2H15V3Z',
      'M15 13L2 13V12L6 12V8.5C6 8.22386 6.22386 8 6.5 8H7.5C7.77614 8 8 8.22386 8 8.5V12H9V8.5C9 8.22386 9.22386 8 9.5 8H10.5C10.7761 8 11 8.22386 11 8.5V12H15V13Z',
    ],
  },
  'space-between': {
    col: ['M2 14V1H3V5H5.5C5.77614 5 6 5.22386 6 5.5L6 6.5C6 6.77614 5.77614 7 5.5 7H3L3 8H5.5C5.77614 8 6 8.22386 6 8.5V9.5C6 9.77614 5.77614 10 5.5 10H3L3 14H2ZM14 14V10H11.5C11.2239 10 11 9.77614 11 9.5V8.5C11 8.22386 11.2239 8 11.5 8H14V7H11.5C11.2239 7 11 6.77614 11 6.5V5.5C11 5.22386 11.2239 5 11.5 5H14V1H15V14H14Z'],
    row: [
      'M15 2L11 2V4.5C11 4.77614 10.7761 5 10.5 5H9.5C9.22386 5 9 4.77614 9 4.5V2L8 2V4.5C8 4.77614 7.77614 5 7.5 5H6.5C6.22386 5 6 4.77614 6 4.5V2L2 2V1H15V2Z',
      'M15 14L2 14V13L6 13V10.5C6 10.2239 6.22386 10 6.5 10H7.5C7.77614 10 8 10.2239 8 10.5V13H9V10.5C9 10.2239 9.22386 10 9.5 10H10.5C10.7761 10 11 10.2239 11 10.5V13H15V14Z',
    ],
  },
  'space-around': {
    col: [
      'M3 14H2V1H3V14Z',
      'M15 14H14V1H15V14Z',
      'M6.5 8C6.77614 8 7 8.22386 7 8.5V9.5C7 9.77614 6.77614 10 6.5 10H4.5C4.22386 10 4 9.77614 4 9.5V8.5C4 8.22386 4.22386 8 4.5 8H6.5Z',
      'M12.5 8C12.7761 8 13 8.22386 13 8.5V9.5C13 9.77614 12.7761 10 12.5 10H10.5C10.2239 10 10 9.77614 10 9.5V8.5C10 8.22386 10.2239 8 10.5 8H12.5Z',
      'M6.5 5C6.77614 5 7 5.22386 7 5.5V6.5C7 6.77614 6.77614 7 6.5 7H4.5C4.22386 7 4 6.77614 4 6.5V5.5C4 5.22386 4.22386 5 4.5 5H6.5Z',
      'M12.5 5C12.7761 5 13 5.22386 13 5.5V6.5C13 6.77614 12.7761 7 12.5 7H10.5C10.2239 7 10 6.77614 10 6.5V5.5C10 5.22386 10.2239 5 10.5 5H12.5Z',
    ],
    row: [
      'M2 1H15V2L2 2V1Z',
      'M2 13L15 13V14L2 14V13Z',
      'M8 3.5C8 3.22386 7.77614 3 7.5 3L6.5 3C6.22386 3 6 3.22386 6 3.5L6 5.5C6 5.77614 6.22386 6 6.5 6L7.5 6C7.77614 6 8 5.77614 8 5.5V3.5Z',
      'M9 3.5C9 3.22386 9.22386 3 9.5 3L10.5 3C10.7761 3 11 3.22386 11 3.5V5.5C11 5.77614 10.7761 6 10.5 6L9.5 6C9.22386 6 9 5.77614 9 5.5V3.5Z',
      'M8 9.5C8 9.22386 7.77614 9 7.5 9L6.5 9C6.22386 9 6 9.22386 6 9.5L6 11.5C6 11.7761 6.22386 12 6.5 12H7.5C7.77614 12 8 11.7761 8 11.5V9.5Z',
      'M9 9.5C9 9.22386 9.22386 9 9.5 9L10.5 9C10.7761 9 11 9.22386 11 9.5V11.5C11 11.7761 10.7761 12 10.5 12H9.5C9.22386 12 9 11.7761 9 11.5V9.5Z',
    ],
  },
}
function ContentIcon({ value, vertical }: { value: string; vertical: boolean }) {
  const set = CONTENT_PATHS[value] ?? CONTENT_PATHS['space-around']
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      {(vertical ? set.row : set.col).map((d, i) => (
        <path key={i} d={d} fillRule="evenodd" clipRule="evenodd" fill="currentColor" />
      ))}
    </svg>
  )
}
const contentOptions = (vertical: boolean): ReadonlyArray<SegmentedOption<string>> => {
  // vertical → align-content (Rows); otherwise justify-content (Columns). The tooltip
  // names the property, like Webflow ("Justify Content: Center").
  const propName = vertical ? 'Align Content' : 'Justify Content'
  return GRID_CONTENT.map((v) => {
    const name = `${propName}: ${LABELS[v] ?? cap(v)}`
    return { value: v, label: <ContentIcon value={v} vertical={vertical} />, ariaLabel: name, tooltip: name }
  })
}

// ── grid-template track counting ──
function splitTracks(value: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of value.trim()) {
    if (ch === '(' || ch === '[') { depth += 1; cur += ch }
    else if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); cur += ch }
    else if (/\s/.test(ch) && depth === 0) { if (cur) { parts.push(cur); cur = '' } }
    else cur += ch
  }
  if (cur) parts.push(cur)
  return parts
}
// Number of tracks a grid-template value defines — expands `repeat(n, …)`, ignores
// [line-name] tokens. 0 when unset / none.
function countTracks(value: string): number {
  const v = value.trim().toLowerCase()
  if (!v || v === 'none') return 0
  let count = 0
  for (const t of splitTracks(v)) {
    if (t.startsWith('[')) continue
    const rep = t.match(/^repeat\(\s*(\d+)\s*,(.*)\)$/i)
    if (rep) count += parseInt(rep[1], 10) * Math.max(1, splitTracks(rep[2]).filter((x) => !x.startsWith('[')).length)
    else count += 1
  }
  return count
}
// Default size for a newly-created track: a column fills its share but can shrink to
// nothing (so content can't blow the grid out), a row is content-sized.
const NEW_COLUMN = 'minmax(0, 1fr)'
const NEW_ROW = 'auto'

// The count stepper writes N UNIFORM tracks of the axis default in Webflow's compact
// `repeat()` form — e.g. 2 columns → `repeat(2, minmax(0, 1fr))`. It's the "how many
// tracks" control, so it normalises ALL tracks, not just newly-added ones; per-track
// custom sizes are set/kept in the Configure-grid modal instead (its "+" preserves them).
const repeatTracks = (n: number, cell: string) => `repeat(${Math.max(1, n)}, ${cell})`

// grid-auto-flow is a direction (row | column) optionally packed `dense`.
function parseFlow(value: string): { dir: string; dense: boolean } {
  const v = value.toLowerCase()
  return { dir: v.includes('column') ? 'column' : 'row', dense: v.includes('dense') }
}
const buildFlow = (dir: string, dense: boolean) => (dense ? `${dir} dense` : dir)

// ── icons ──
const ChevUp = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12"><path d="M4.6 9.4 8 6l3.4 3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const ChevDown = () => (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="12" height="12"><path d="M4.6 6.6 8 10l3.4-3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>)
const DenseIcon = () => (
  <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" width="16" height="16">
    <path d="M14.8535 11.1465 14.1465 11.8535 12.5 10.207V14H11.5v-3.793L9.85352 11.8535 9.14648 11.1465 12 8.29297 14.8535 11.1465Z" fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d="M14.1025 1.005C14.6067 1.056 15 1.482 15 2v4l-.005.103c-.048.47-.422.844-.892.892L14 7h-4c-.518 0-.944-.393-.995-.897L9 6V2c0-.552.448-1 1-1h4l.103.005ZM10 6h4V2h-4v4Z" fill="currentColor" />
    <path d="M9 9H3v4h6v1H3l-.103-.005c-.47-.048-.844-.422-.892-.892L2 13V9c0-.552.448-1 1-1h6v1Z" fill="currentColor" />
    <path fillRule="evenodd" clipRule="evenodd" d="M7.103 1.005C7.607 1.056 8 1.482 8 2v4l-.005.103c-.048.47-.422.844-.892.892L7 7H3c-.518 0-.944-.393-.995-.897L2 6V2c0-.552.448-1 1-1h4l.103.005ZM3 6h4V2H3v4Z" fill="currentColor" />
  </svg>
)
// The "customize track sizes" toggle (Webflow's grid gear) — swaps the count
// steppers for raw grid-template fields so non-uniform tracks (200px 1fr auto…) can
// be typed instead of only N equal 1fr tracks.
const CustomizeIcon = () => (
  <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
    <path fillRule="evenodd" clipRule="evenodd" d="M6.99994 3.29289C7.18748 3.10536 7.44183 3 7.70705 3H10.4999C10.7022 3 10.8845 3.12182 10.9619 3.30866C11.0393 3.4955 10.9965 3.71055 10.8535 3.85355L8.99994 5.70711V7H10.2928L12.1464 5.14645C12.2894 5.00345 12.5044 4.96067 12.6913 5.03806C12.8781 5.11545 12.9999 5.29777 12.9999 5.5V8.29289C12.9999 8.55811 12.8946 8.81246 12.707 9L10.9999 10.7071C10.8124 10.8946 10.558 11 10.2928 11H7.70705L4.85349 13.8536C4.65823 14.0488 4.34165 14.0488 4.14639 13.8536L2.14639 11.8536C1.95112 11.6583 1.95112 11.3417 2.14639 11.1464L4.99994 8.29289V5.70711C4.99994 5.44189 5.1053 5.18754 5.29283 5L6.99994 3.29289ZM9.29283 4H7.70705L5.99994 5.70711L5.99994 8.29289C5.99994 8.55811 5.89458 8.81246 5.70705 9L3.20705 11.5L4.49994 12.7929L6.99994 10.2929C7.18748 10.1054 7.44183 10 7.70705 10H10.2928L11.9999 8.29289V6.70711L10.8535 7.85355C10.7597 7.94732 10.6325 8 10.4999 8H8.49994C8.2238 8 7.99994 7.77614 7.99994 7.5V5.5C7.99994 5.36739 8.05262 5.24021 8.14639 5.14645L9.29283 4Z" fill="currentColor" />
  </svg>
)

// Whether a grid-template value is N equal tracks (representable by the count stepper):
// a single `repeat(n, <one track>)`, or N identical explicit tracks. Anything else (mixed
// sizes) is "custom" and belongs in the Configure-grid modal.
const isUniformTracks = (value: string) => {
  const t = splitTracks(value.trim()).filter((x) => !x.startsWith('['))
  if (t.length === 0) return false
  if (t.length === 1) {
    const rep = t[0].match(/^repeat\(\s*\d+\s*,(.*)\)$/i)
    if (rep) return splitTracks(rep[1]).filter((x) => !x.startsWith('[')).length === 1
  }
  return t.every((x) => x === t[0])
}

// A raw grid-template field (custom mode): commit the typed track list on blur/Enter.
function TemplateField({ value, busy, ariaLabel, onCommit }: { value: string; busy: boolean; ariaLabel: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value) }, [value])
  return (
    <VariableConnect code ariaLabel={`Connect ${ariaLabel} to a variable`} disabled={busy} prop="grid-template-columns" onPick={(binding) => onCommit(binding)}>
      <input
        className="u-input embed-editor_size-input"
        value={text}
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder="1fr 1fr"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; onCommit(text.trim()) }}
        onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
      />
    </VariableConnect>
  )
}

// grid-auto-flow is a preset when every token is row / column / dense; anything else
// (a CSS-wide keyword, var(), …) is a custom value edited in the text field.
function isPresetFlow(value: string): boolean {
  const v = value.trim().toLowerCase()
  if (!v) return true
  return v.split(/\s+/).every((t) => t === 'row' || t === 'column' || t === 'dense')
}
function parseImportant(input: string): { value: string; important: boolean } {
  const m = input.match(/!\s*important\s*$/i)
  return m ? { value: input.slice(0, m.index).trim(), important: true } : { value: input.trim(), important: false }
}

// The grid Direction control: the row/column segments (with Horizontal/Vertical
// tooltips) + a dense toggle, plus a chevron menu with a "Custom" escape hatch that
// swaps the bar for a free-value grid-auto-flow field (mirrors the other button lists).
function GridDirectionControl({ value, busy, onSet, onCommitCustom }: {
  value: string
  busy: boolean
  onSet: (value: string) => void
  onCommitCustom: (value: string, important: boolean) => void
}) {
  const { dir, dense } = value ? parseFlow(value) : { dir: 'row', dense: false }
  const [forceCustom, setForceCustom] = useState(false)
  const customMode = forceCustom || (!!value.trim() && !isPresetFlow(value))
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  // Focus the field after switching to Custom, once its `unset` write settles.
  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const enterCustom = () => { setOpen(false); setForceCustom(true); wantFocus.current = true; onCommitCustom('unset', false) }
  const pickPreset = (d: string) => { setOpen(false); setForceCustom(false); onSet(buildFlow(d, dense)) }
  const commitCustom = () => { const p = parseImportant(draft); if (p.value) onCommitCustom(p.value, p.important) }

  return (
    <div ref={rootRef} className="embed-editor_grid-direction">
      {/* The segments (or custom field) + the dropdown arrow share one pill so the
          arrow belongs to the direction control; the dense toggle sits outside it. */}
      <div className={`embed-editor_grid-dir-bar ${customMode ? 'is-custom' : ''}`}>
        {customMode ? (
          <input
            ref={inputRef}
            className="embed-editor_value-input embed-editor_display-input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={() => { focused.current = true }}
            onBlur={() => { focused.current = false; commitCustom() }}
            onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
            disabled={busy}
            spellCheck={false}
            placeholder="e.g. row dense"
            aria-label="Grid auto flow"
          />
        ) : (
          <SegmentedControl value={dir} options={GRID_FLOW} ariaLabel="Grid direction" disabled={busy} onChange={(d) => onSet(buildFlow(d, dense))} />
        )}
        <button type="button" className="embed-editor_display-arrow" aria-haspopup="menu" aria-expanded={open} aria-label="More direction options" disabled={busy} onClick={() => setOpen((v) => !v)}>
          <ChevDown />
        </button>
        {open ? (
          <div className="embed-editor_display-menu" role="menu">
            {customMode ? (
              <>
                <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={() => pickPreset('row')}>Horizontal</button>
                <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={() => pickPreset('column')}>Vertical</button>
              </>
            ) : (
              <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={enterCustom}>Custom</button>
            )}
          </div>
        ) : null}
      </div>
      {!customMode ? (
        <button type="button" className={`embed-editor_icon-btn ${dense ? 'is-active' : ''}`} disabled={busy} aria-pressed={dense} title="Dense — backfill earlier gaps in the grid" onClick={() => onSet(buildFlow(dir, !dense))}>
          <DenseIcon />
        </button>
      ) : null}
    </div>
  )
}

// The grid content control (justify-content / align-content): the preset icon
// segments + a dropdown arrow whose menu swaps to a free-value field (a value outside
// the presets — a CSS-wide keyword, var(), … — shows the field automatically).
// Mirrors GridDirectionControl.
function GridContentControl({ value, prop, vertical, ariaLabel, busy, onSet, onCommitCustom }: {
  value: string
  /** The property this bar edits — its computed value highlights an unset control. */
  prop: string
  vertical: boolean
  ariaLabel: string
  busy: boolean
  onSet: (value: string) => void
  onCommitCustom: (value: string, important: boolean) => void
}) {
  const cur = gridKeyword(value.trim().toLowerCase())
  const shownContent = gridKeyword(useHighlight('', cur ? '' : prop, [...GRID_CONTENT, ...Object.keys(GRID_SYNONYMS)], 'stretch'))
  const [forceCustom, setForceCustom] = useState(false)
  const customMode = forceCustom || (!!cur && !GRID_CONTENT.includes(cur))
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  useEffect(() => {
    if (customMode && wantFocus.current && !busy) {
      wantFocus.current = false
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [customMode, busy])

  const enterCustom = () => { setOpen(false); setForceCustom(true); wantFocus.current = true }
  const pickPreset = (v: string) => { setOpen(false); setForceCustom(false); onSet(v) }
  const commitCustom = () => { const p = parseImportant(draft); if (p.value) onCommitCustom(p.value, p.important) }
  // Unset → show stretch selected (grid's default); a known value shows itself.
  const segValue = cur ? (GRID_CONTENT.includes(cur) ? cur : '') : shownContent

  return (
    <div ref={rootRef} className={`embed-editor_grid-dir-bar ${customMode ? 'is-custom' : ''}`}>
      {customMode ? (
        <input
          ref={inputRef}
          className="embed-editor_value-input embed-editor_display-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => { focused.current = true }}
          onBlur={() => { focused.current = false; commitCustom() }}
          onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
          disabled={busy}
          spellCheck={false}
          placeholder="custom value"
          aria-label={ariaLabel}
        />
      ) : (
        <SegmentedControl value={segValue} options={contentOptions(vertical)} ariaLabel={ariaLabel} disabled={busy} onChange={onSet} />
      )}
      <button type="button" className="embed-editor_display-arrow" aria-haspopup="menu" aria-expanded={open} aria-label={`More ${ariaLabel} options`} disabled={busy} onClick={() => setOpen((v) => !v)}>
        <ChevDown />
      </button>
      {open ? (
        <div className="embed-editor_display-menu" role="menu">
          {customMode
            ? GRID_CONTENT.map((v) => (
                <button key={v} type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={() => pickPreset(v)}>{LABELS[v] ?? cap(v)}</button>
              ))
            : <button type="button" role="menuitem" className="embed-editor_display-menu-item" onClick={enterCustom}>Custom</button>}
        </div>
      ) : null}
    </div>
  )
}

// A whole-number track-count field with ▲▼ steppers (Webflow's Columns/Rows inputs).
function CountField({ value, busy, ariaLabel, onCommit }: { value: number; busy: boolean; ariaLabel: string; onCommit: (n: number) => void }) {
  const [text, setText] = useState(value > 0 ? String(value) : '')
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setText(value > 0 ? String(value) : '') }, [value])
  const clampN = (n: number) => Math.min(500, Math.max(1, n))
  const commit = (t: string) => {
    const n = parseInt(t, 10)
    if (Number.isNaN(n)) { setText(value > 0 ? String(value) : ''); return }
    onCommit(clampN(n))
  }
  // Step from the DISPLAYED value and update it immediately: while the input is focused
  // (arrow-key stepping) the `value`→`text` sync is suppressed, so without this the field
  // would freeze on the old number even though the write went through. Basing the step on
  // `text` also keeps rapid presses correct while the native write round-trips.
  const step = (delta: number) => {
    const base = parseInt(text, 10)
    const next = clampN((Number.isNaN(base) ? (value || 0) : base) + delta)
    setText(String(next))
    onCommit(next)
  }
  return (
    <div className="embed-editor_grid-count">
      <input
        className="u-input embed-editor_size-input"
        value={text}
        inputMode="numeric"
        spellCheck={false}
        disabled={busy}
        aria-label={ariaLabel}
        placeholder="0"
        onChange={(e) => setText(e.target.value)}
        onFocus={() => { focused.current = true }}
        onBlur={() => { focused.current = false; commit(text) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { commitInPlace(e.currentTarget); return }
          if (e.key === 'ArrowUp') { e.preventDefault(); step(1) }
          else if (e.key === 'ArrowDown') { e.preventDefault(); step(-1) }
        }}
      />
      <div className="embed-editor_grid-count-steppers">
        <button type="button" tabIndex={-1} disabled={busy} aria-label="Increase" onClick={() => step(1)}><ChevUp /></button>
        <button type="button" tabIndex={-1} disabled={busy} aria-label="Decrease" onClick={() => step(-1)}><ChevDown /></button>
      </div>
    </div>
  )
}

// The item-alignment preview box (Webflow's grid Align widget): a 3×3 grid of click
// targets under a single item that lays out with the real justify-items (screen X) and
// align-items (screen Y). Clicking a target sets both to start/center/end; Stretch is
// picked from the axis dropdowns and shows the item filling that axis. Reuses the flex
// AlignControl's box CSS (dots + well) with a grid preview.
function GridAlignBox({ justifyItems, alignItems, busy, onSet }: {
  justifyItems: string
  alignItems: string
  busy: boolean
  onSet: (prop: string, value: string) => void
}) {
  // Grid's initial justify-items / align-items behave as stretch, so an unset control
  // shows a full-bleed item.
  const ji = justifyItems || 'stretch'
  const ai = alignItems || 'stretch'
  // A small fixed square (Webflow keeps it ~20px) so the surrounding dots stay visible;
  // a stretched axis drops to auto so the item fills that direction into a bar.
  const itemStyle: CSSProperties = {
    width: ji === 'stretch' ? 'auto' : '16px',
    height: ai === 'stretch' ? 'auto' : '16px',
  }
  const positions = ['start', 'center', 'end']
  return (
    <div className="embed-editor_align-box">
      <div className="embed-editor_align-dots">
        {positions.map((ry) => positions.map((cx) => (
          <button
            key={`${ry}-${cx}`}
            type="button"
            className="embed-editor_align-dot"
            disabled={busy}
            aria-label={`Align ${cap(cx)} ${cap(ry)}`}
            onClick={() => { onSet('justify-items', cx); onSet('align-items', ry) }}
          >
            <span />
          </button>
        )))}
      </div>
      <div className="embed-editor_grid-align-preview" style={{ justifyItems: ji, alignItems: ai }} aria-hidden="true">
        <span className="embed-editor_grid-align-item" style={itemStyle} />
      </div>
    </div>
  )
}

const AXIS_CUSTOM = '__custom__'

// The free-text field shown in Custom mode: commits on blur, clears the property when
// emptied (mirrors the flex align axis; no live channel here).
function GridAxisCustomInput({ value, busy, ariaLabel, autoFocus, onCommit, onClear }: {
  value: string
  busy: boolean
  ariaLabel: string
  autoFocus: boolean
  onCommit: (value: string) => void
  onClear: () => void
}) {
  const [draft, setDraft] = useState(value)
  const focused = useRef(false)
  useEffect(() => { if (!focused.current) setDraft(value) }, [value])
  const commit = () => { const t = draft.trim(); if (t) onCommit(t); else onClear() }
  return (
    <input
      className="u-select-custom-input"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onFocus={() => { focused.current = true }}
      onBlur={() => { focused.current = false; commit() }}
      onKeyDown={(e) => { if (e.key === 'Enter') commitInPlace(e.currentTarget) }}
      disabled={busy}
      spellCheck={false}
      placeholder="unset"
      aria-label={ariaLabel}
      autoFocus={autoFocus}
    />
  )
}

// One grid align axis (X = justify-items, Y = align-items): the icon dropdown plus a
// trailing "Custom" option that seeds `unset` and swaps in a free-value field for any
// keyword the presets don't cover (matching the flex Align axes). The X / Y label owns
// clear / provenance for that axis's property, so the two reset independently.
function GridAlignAxis({ axis, prop, value, busy, read, onSet, onPreview, onClear, onProvenance, onSelectSelector }: {
  axis: 'X' | 'Y'
  prop: string
  value: string
  busy: boolean
  read: Read
  onSet: (value: string) => void
  /** Live-preview the hovered option; `null` restores the committed value. */
  onPreview: (value: string | null) => void
  onClear: () => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const [forceCustom, setForceCustom] = useState(false)
  const present = Boolean(value)
  const shown = gridKeyword(value)
  const known = GRID_ITEM_ALIGN.includes(shown)
  const customMode = forceCustom || (present && !known)
  // Unset → what the page computes for this element before falling back to grid's
  // own `stretch` default.
  const shownAlign = useHighlight('', present ? '' : prop, GRID_ITEM_ALIGN, 'stretch')
  const labels = axis === 'X' ? X_ALIGN_LABELS : Y_ALIGN_LABELS
  const icons = axis === 'X' ? X_ALIGN_ICONS : Y_ALIGN_ICONS
  const options: SelectOption<string>[] = GRID_ITEM_ALIGN.map((v) => ({ value: v, label: labels[v], icon: <GridAlignIcon paths={icons[v]} /> }))
  options.push({ value: AXIS_CUSTOM, label: 'Custom' })
  const pick = (v: string) => {
    if (v === AXIS_CUSTOM) { setForceCustom(true); onSet('unset'); return }
    setForceCustom(false)
    onSet(v)
  }
  return (
    <div className="embed-editor_align-axis">
      <GroupLabel
        label={axis}
        props={[prop]}
        read={read}
        busy={busy}
        onClear={onClear}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      {/* Grid's initial justify-items / align-items behave as stretch, so an unset axis
          shows Stretch (Webflow's default). Clear via this axis's X / Y label. */}
      <Select
        value={customMode ? AXIS_CUSTOM : (known ? shown : shownAlign)}
        options={options}
        ariaLabel={`Align ${axis}`}
        disabled={busy}
        hideTriggerIcon
        onChange={pick}
        onPreview={(v) => onPreview(v === AXIS_CUSTOM ? null : v)}
        customInput={customMode ? (
          <GridAxisCustomInput
            value={value}
            busy={busy}
            ariaLabel={`Align ${axis}`}
            autoFocus={forceCustom}
            onCommit={(v) => onSet(v)}
            onClear={() => { setForceCustom(false); onClear() }}
          />
        ) : undefined}
      />
    </div>
  )
}

export default function GridControls({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  read: Read; busy: boolean; setProp: SetProp; clearProp: ClearProp; liveSetProp: LiveSetProp
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const val = (prop: string) => {
    const r = read(prop)
    if (!r) return ''
    return (r.source === 'selected' && r.selectedValue ? r.selectedValue.value : r.winner.value).trim()
  }

  const colsRaw = val('grid-template-columns')
  const rowsRaw = val('grid-template-rows')
  const cols = countTracks(colsRaw)
  const rows = countTracks(rowsRaw)
  const flow = val('grid-auto-flow')
  // The inline row shows raw grid-template fields (instead of count steppers) when a
  // track list isn't just N equal 1fr tracks — those can't be represented as a count.
  // The gear opens the full Grid settings modal for per-track sizing / reordering.
  const nonUniform = (!!colsRaw && !isUniformTracks(colsRaw)) || (!!rowsRaw && !isUniformTracks(rowsRaw))
  const customTracks = nonUniform
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Rich "Configure grid" tooltip on the gear, shown after a short hover (matches the
  // Direction / Content segmented tooltips instead of the OS-native `title`).
  const gearRef = useRef<HTMLButtonElement>(null)
  const [gearTip, setGearTip] = useState(false)
  const gearTimer = useRef<number | null>(null)
  const clearGearTimer = () => { if (gearTimer.current != null) { window.clearTimeout(gearTimer.current); gearTimer.current = null } }
  useEffect(() => clearGearTimer, [])

  const alignAxis = (axis: 'X' | 'Y', prop: string) => (
    <GridAlignAxis
      axis={axis}
      prop={prop}
      value={val(prop).toLowerCase()}
      busy={busy}
      read={read}
      onSet={(v) => setProp(prop, v, false)}
      onPreview={(v) => liveSetProp(prop, v, false)}
      onClear={() => clearProp(prop)}
      onProvenance={onProvenance}
      onSelectSelector={onSelectSelector}
    />
  )
  // Content distribution as a Webflow-style icon segmented control. `vertical` rotates
  // the glyphs for the Rows (align-content) axis; the row's label owns clear/provenance.
  const contentRow = (label: string, prop: string, vertical: boolean) => (
    <div className="embed-editor_size-row">
      <GroupLabel label={label} props={[prop]} read={read} busy={busy} onClear={() => clearProp(prop)} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      <GridContentControl
        value={val(prop)}
        prop={prop}
        vertical={vertical}
        ariaLabel={label}
        busy={busy}
        onSet={(v) => setProp(prop, v, false)}
        onCommitCustom={(v, imp) => setProp(prop, v, imp)}
      />
    </div>
  )

  return (
    <>
      <div className="embed-editor_size-row embed-editor_bg-row-top">
        <GroupLabel label="Grid" props={['grid-template-columns', 'grid-template-rows']} read={read} busy={busy} onClear={() => clearProp(['grid-template-columns', 'grid-template-rows'])} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <div className="embed-editor_grid-tracks">
          <div className="embed-editor_gap-cell">
            {/* Always the track COUNT — changing it adds/removes tracks while keeping the
                earlier tracks' sizes. Per-track values live behind the configure gear. */}
            <CountField value={cols} busy={busy} ariaLabel="Grid columns" onCommit={(n) => setProp('grid-template-columns', repeatTracks(n, NEW_COLUMN), false)} />
            <GroupLabel label="Columns" props={['grid-template-columns']} read={read} busy={busy} onClear={() => clearProp('grid-template-columns')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
          </div>
          <div className="embed-editor_gap-cell">
            <CountField value={rows} busy={busy} ariaLabel="Grid rows" onCommit={(n) => setProp('grid-template-rows', repeatTracks(n, NEW_ROW), false)} />
            <GroupLabel label="Rows" props={['grid-template-rows']} read={read} busy={busy} onClear={() => clearProp('grid-template-rows')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
          </div>
          <button
            ref={gearRef}
            type="button"
            className={`embed-editor_icon-btn embed-editor_grid-gear ${customTracks ? 'is-active' : ''}`}
            disabled={busy}
            aria-label="Configure grid"
            onMouseEnter={() => { clearGearTimer(); gearTimer.current = window.setTimeout(() => setGearTip(true), 500) }}
            onMouseLeave={() => { clearGearTimer(); setGearTip(false) }}
            onClick={() => { clearGearTimer(); setGearTip(false); setSettingsOpen(true) }}
          >
            <CustomizeIcon />
          </button>
          {gearTip && gearRef.current ? <HoverTooltip anchor={gearRef.current}>Configure grid</HoverTooltip> : null}
        </div>
      </div>

      <div className="embed-editor_size-row">
        <GroupLabel label="Direction" props={['grid-auto-flow']} read={read} busy={busy} onClear={() => clearProp('grid-auto-flow')} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <GridDirectionControl
          value={flow}
          busy={busy}
          onSet={(v) => setProp('grid-auto-flow', v, false)}
          onCommitCustom={(v, important) => setProp('grid-auto-flow', v, important)}
        />
      </div>

      <div className="embed-editor_size-row embed-editor_bg-row-top embed-editor_align-row">
        {/* Inert caption — the X / Y labels below own clear / provenance per axis. */}
        <FieldLabel className="embed-editor_size-label" active={false} disabled={busy} onReset={() => {}} tooltip={<PropTip props={['justify-items', 'align-items']} />}>Align</FieldLabel>
        <div className="embed-editor_align">
          <GridAlignBox justifyItems={gridKeyword(val('justify-items').toLowerCase())} alignItems={gridKeyword(val('align-items').toLowerCase())} busy={busy} onSet={(p, v) => setProp(p, v, false)} />
          <div className="embed-editor_align-axes">
            {alignAxis('X', 'justify-items')}
            {alignAxis('Y', 'align-items')}
          </div>
        </div>
      </div>

      {contentRow('Columns', 'justify-content', false)}
      {contentRow('Rows', 'align-content', true)}

      {settingsOpen ? (
        <GridSettings read={read} busy={busy} setProp={setProp} clearProp={clearProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} onClose={() => setSettingsOpen(false)} />
      ) : null}
    </>
  )
}
