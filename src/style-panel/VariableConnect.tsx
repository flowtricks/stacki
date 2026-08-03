import { cloneElement, isValidElement, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, MutableRefObject, ReactElement, ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { streamProjectVariables, type ProjectVariable } from './lib/webflow'
import { panelBox, panelSpan } from './lib/panel-box'
import './embed-editor.css'

// Read the current value out of the wrapped <input> child, so callers don't have to
// thread it through — children IS the input element, and its `value` is the field draft.
function childValue(children: ReactNode): string {
  return isValidElement(children) && typeof (children.props as { value?: unknown }).value === 'string'
    ? (children.props as { value: string }).value
    : ''
}
// A binding's display name — parsed from the custom-property tail (…--<name> → <name>),
// used as the chip label until the exact variable name resolves from the loaded list.
function bindingName(binding: string): string {
  const inner = binding.replace(/^var\(\s*/i, '').replace(/\s*\)\s*$/i, '').split(',')[0].trim()
  const parts = inner.split('--').filter(Boolean)
  return parts[parts.length - 1] ?? inner
}

// Webflow can append a resolved value to size-variable names on either side of the
// bridge (`space/2 (12px)`). Keep both forms because some projects include that text
// in the variable's actual name while others add it only to the property readback.
function nativeVariableNames(value: string): string[] {
  const exact = value.trim()
  const withoutResolved = exact.replace(/\s+\([^()]+\)\s*$/, '').trim()
  return withoutResolved && withoutResolved !== exact ? [exact, withoutResolved] : [exact]
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// The "connect to variable" affordance (Webflow's): a dot in the input's top-left
// corner, revealed on hover of the input. Hovering the dot grows it into a purple
// "+"; clicking opens a searchable, grouped variable picker. Picking one calls
// onPick with the `var(--…)` binding to write.

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8 4v8M4 8h8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}

// Per-type variable glyphs (Webflow's), keyed by the variable's `type`; any other type
// (Size included) uses the Size glyph.
function ColorTypeIcon() {
  return (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M8 12C6.61929 12 5.5 10.8807 5.5 9.50002C5.5 9.04673 5.62524 8.59624 5.85694 8.21178L5.86179 8.20374L8.00001 4.50006L10.1434 8.21244C10.3748 8.59673 10.5 9.04697 10.5 9.50002C10.5 10.8807 9.38071 12 8 12ZM4.5 9.50002C4.5 11.433 6.067 13 8 13C9.933 13 11.5 11.433 11.5 9.50002C11.5 8.86769 11.3267 8.24048 11.0025 7.70059L8.86604 4.00006C8.48114 3.3334 7.51889 3.33339 7.13398 4.00006L4.99795 7.69979C4.67349 8.2399 4.5 8.86738 4.5 9.50002Z" fill="currentColor" /></svg>)
}
function NumberTypeIcon() {
  return (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M11.846 3.13226L11.0637 6.0007H13V7.0007H10.791L10.2455 9.0007H12V10.0007H9.9728L9.11873 13.1323L8.15397 12.8691L8.93627 10.0007H5.9728L5.11873 13.1323L4.15397 12.8691L4.93627 10.0007H3V9.0007H5.209L5.75445 7.0007H4V6.0007H6.02718L6.88124 2.86914L7.84601 3.13226L7.0637 6.0007H10.0272L10.8812 2.86914L11.846 3.13226ZM6.24552 9.0007H9.209L9.75446 7.0007H6.79098L6.24552 9.0007Z" fill="currentColor" /></svg>)
}
function PercentageTypeIcon() {
  return (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12.8538 3.85249L3.85377 12.8525C3.75995 12.9463 3.63271 12.999 3.50002 12.999C3.36734 12.999 3.24009 12.9463 3.14627 12.8525C3.05245 12.7587 2.99975 12.6314 2.99975 12.4987C2.99975 12.3661 3.05245 12.2388 3.14627 12.145L12.1463 3.14499C12.24 3.05116 12.3672 2.99842 12.4998 2.99837C12.6324 2.99831 12.7596 3.05094 12.8535 3.14467C12.9473 3.23841 13 3.36558 13.0001 3.4982C13.0001 3.63083 12.9475 3.75804 12.8538 3.85186V3.85249ZM3.15877 6.33999C2.73683 5.91796 2.49982 5.3456 2.49988 4.74883C2.49994 4.15205 2.73706 3.57974 3.15909 3.1578C3.58111 2.73585 4.15347 2.49884 4.75025 2.4989C5.34702 2.49896 5.91933 2.73608 6.34127 3.15811C6.76322 3.58014 7.00023 4.15249 7.00017 4.74927C7.00011 5.34604 6.76299 5.91835 6.34096 6.3403C5.91894 6.76224 5.34658 6.99925 4.7498 6.99919C4.15303 6.99914 3.58072 6.76201 3.15877 6.33999ZM3.50002 4.74999C3.50019 4.95552 3.55102 5.15783 3.64804 5.33903C3.74505 5.52022 3.88525 5.6747 4.05621 5.78877C4.22718 5.90285 4.42363 5.97302 4.62818 5.99305C4.83274 6.01308 5.03907 5.98237 5.22892 5.90363C5.41877 5.82488 5.58627 5.70055 5.7166 5.54162C5.84692 5.38269 5.93605 5.19408 5.97608 4.99249C6.01612 4.79089 6.00582 4.58254 5.94612 4.38587C5.88641 4.1892 5.77913 4.0103 5.63377 3.86499C5.45888 3.69015 5.23606 3.57111 4.99351 3.52294C4.75095 3.47478 4.49955 3.49963 4.27113 3.59438C4.0427 3.68912 3.84751 3.84949 3.71025 4.05519C3.57299 4.2609 3.49983 4.50269 3.50002 4.74999ZM13.5 11.25C13.4999 11.7705 13.3193 12.2749 12.989 12.6772C12.6587 13.0795 12.1991 13.3549 11.6885 13.4563C11.1779 13.5578 10.648 13.479 10.189 13.2336C9.72995 12.9881 9.37023 12.5911 9.17113 12.1101C8.97202 11.6291 8.94583 11.094 9.09703 10.5959C9.24823 10.0978 9.56746 9.66755 10.0003 9.37843C10.4332 9.08931 10.9529 8.95923 11.4709 9.01034C11.989 9.06145 12.4733 9.2906 12.8413 9.65873C13.0509 9.86722 13.217 10.1152 13.3301 10.3884C13.4432 10.6615 13.5009 10.9544 13.5 11.25ZM12.5 11.25C12.5001 10.9608 12.3999 10.6805 12.2165 10.4569C12.033 10.2333 11.7778 10.0803 11.4941 10.0238C11.2105 9.96731 10.9161 10.0109 10.661 10.1472C10.4059 10.2835 10.206 10.504 10.0953 10.7712C9.98454 11.0383 9.96988 11.3356 10.0538 11.6124C10.1377 11.8891 10.315 12.1282 10.5554 12.2889C10.7958 12.4496 11.0845 12.522 11.3723 12.4937C11.6602 12.4654 11.9293 12.3382 12.1338 12.1337C12.2502 12.018 12.3425 11.8802 12.4054 11.7285C12.4683 11.5768 12.5004 11.4142 12.5 11.25Z" fill="currentColor" /></svg>)
}
function FontFamilyTypeIcon() {
  return (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fillRule="evenodd" clipRule="evenodd" d="M8.49945 3.49902L8.50043 3.49805V2.99902L8.88422 3L8.98285 3.37012L10.4116 8.7041C11.6626 9.16833 12.7329 9.8024 13.4955 10.5137L12.8139 11.2451C12.2954 10.7615 11.5854 10.3001 10.7368 9.91699L11.2954 12H10.2602L9.58344 9.47559C9.40836 9.41951 9.22889 9.3663 9.04633 9.31738C8.17518 9.084 7.32862 8.96439 6.55707 8.94629L5.98481 11.085C5.81653 11.7126 5.4687 12.2493 5.01996 12.6016C4.57106 12.9537 3.99165 13.1394 3.4057 12.9824C2.81995 12.8253 2.41134 12.375 2.19867 11.8457C1.98617 11.3163 1.95342 10.6775 2.12152 10.0498C2.31581 9.32507 2.87878 8.80593 3.58344 8.47266C4.19709 8.18251 4.95456 8.01274 5.78656 7.96094L7.01703 3.36914L7.11664 2.99902H8.50043L8.49945 3.49902ZM5.51117 8.98828C4.91768 9.0534 4.40905 9.1879 4.01117 9.37598C3.46964 9.63206 3.18054 9.96113 3.08734 10.3086C2.96987 10.7474 3.00204 11.1626 3.12641 11.4727C3.25078 11.7822 3.45071 11.9592 3.66449 12.0166C3.87841 12.0739 4.14016 12.0205 4.40277 11.8145C4.66552 11.6081 4.90132 11.265 5.01898 10.8262L5.51117 8.98828ZM6.8227 7.95605C7.60256 7.99297 8.43418 8.12006 9.27973 8.34473L8.11664 3.99902H7.88324L6.8227 7.95605Z" fill="currentColor" /></svg>)
}
function SizeTypeIcon() {
  return (<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12 4.70711L4.70711 12H7.5V13H3V8.5H4V11.2929L11.2929 4H8.5V3H13V7.5H12V4.70711Z" fill="currentColor" /></svg>)
}
function VariableTypeIcon({ type }: { type: string }) {
  switch (type) {
    case 'Color': return <ColorTypeIcon />
    case 'Number': return <NumberTypeIcon />
    case 'Percentage': return <PercentageTypeIcon />
    case 'FontFamily': return <FontFamilyTypeIcon />
    default: return <SizeTypeIcon />
  }
}
function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

// Which variable types make sense for the property being edited: a color property
// (color / *-color / fill / stroke) shows only Color variables; font-family shows only
// FontFamily; everything else shows anything BUT Color and FontFamily (sizes / numbers /
// percentages). No prop → no filter (show all).
const COLOR_PROP_RE = /(?:^|-)color$/
// Properties whose value is a keyword/string rather than a length/number/color — a
// FontFamily (string) variable is a valid connection for these.
const STRING_PROPS = new Set([
  'font-family',
  'text-transform', 'text-align', 'text-decoration', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-skip-ink', 'font-style', 'white-space',
  'word-break', 'overflow-wrap', 'text-overflow', 'text-wrap', 'direction',
  'display', 'position', 'float', 'clear', 'visibility', 'box-sizing',
  'overflow', 'overflow-x', 'overflow-y', 'cursor', 'pointer-events',
  'flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-self',
  'justify-self', 'justify-items', 'align-content', 'place-content', 'place-items',
  'place-self', 'grid-auto-flow',
  'background-repeat', 'background-attachment', 'background-clip', 'background-origin',
  'background-blend-mode', 'mix-blend-mode', 'object-fit',
  'border-style', 'border-top-style', 'border-right-style', 'border-bottom-style',
  'border-left-style', 'outline-style', 'column-rule-style', 'column-span',
  'backface-visibility', 'transform-style', 'will-change',
])
function varTypeAllowed(prop: string | undefined, type: string): boolean {
  if (!prop) return true
  const p = prop.toLowerCase()
  if (COLOR_PROP_RE.test(p) || p === 'fill' || p === 'stroke') return type === 'Color'
  // Keyword/string props (incl. font-family) take a FontFamily or String variable —
  // both are "not a length, not a colour". A font stack that isn't named …font-family
  // (`--font-display: "Inter", sans-serif`) types as String, and a keyword variable
  // (`--h6-text-transform: none`) can only ever be String, so requiring FontFamily here
  // left those fields with an empty picker.
  if (STRING_PROPS.has(p)) return type === 'FontFamily' || type === 'String'
  return type !== 'Color' && type !== 'FontFamily'
}

// Nest variables Collection → Group → variable (a group may be empty for a variable
// that isn't in a folder). Input is pre-sorted, so map insertion order is stable.
type VarCollection = { collection: string; groups: Array<{ group: string; items: ProjectVariable[] }> }
function byCollection(vars: ProjectVariable[]): VarCollection[] {
  const colls = new Map<string, Map<string, ProjectVariable[]>>()
  for (const v of vars) {
    let groups = colls.get(v.collection)
    if (!groups) { groups = new Map(); colls.set(v.collection, groups) }
    const list = groups.get(v.group)
    if (list) list.push(v)
    else groups.set(v.group, [v])
  }
  return [...colls.entries()].map(([collection, groups]) => ({
    collection,
    groups: [...groups.entries()].map(([group, items]) => ({ group, items })),
  }))
}

// Project variables are shared across every VariableConnect instance: a native binding
// reads back as the variable's NAME (not var(…)), so to show a chip we match the field
// value against a variable's name OR its var(…) binding. Loaded once, streamed
// progressively; instances subscribe to re-render as entries (and the chip) resolve.
let sharedVars: ProjectVariable[] = []
let sharedDone = false
let sharedLoading = false
const sharedListeners = new Set<() => void>()
function ensureSharedVars() {
  if (sharedDone || sharedLoading) return
  sharedLoading = true
  const seen = new Set<string>()
  void streamProjectVariables((v) => {
    if (seen.has(v.binding)) return
    seen.add(v.binding)
    sharedVars = [...sharedVars, v]
    sharedListeners.forEach((fn) => fn())
  }, () => false).then(() => { sharedDone = true; sharedLoading = false; sharedListeners.forEach((fn) => fn()) })
}
export function useSharedVars(active: boolean): { vars: ProjectVariable[]; loading: boolean } {
  const [, force] = useState(0)
  useEffect(() => {
    if (!active) return
    ensureSharedVars()
    const fn = () => force((n) => n + 1)
    sharedListeners.add(fn)
    return () => { sharedListeners.delete(fn) }
  }, [active])
  return { vars: sharedVars, loading: !sharedDone }
}

// The popup spans the style panel, not the window — it's portaled to <body>, so it has to
// measure the panel itself (panelSpan, in lib/panel-box).

// The picker popup: search field + grouped variable list (name + value). Portaled to
// <body>, anchored to the dot and clamped into the viewport.
export function VariablePicker({ anchor, vars, loading, prop, selectedBinding, onPick, onClose }: {
  anchor: HTMLElement
  vars: ProjectVariable[]
  loading: boolean
  prop?: string
  /** The currently-applied binding — highlighted and scrolled into view on open. */
  selectedBinding?: string
  onPick: (binding: string) => void
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [q, setQ] = useState('')
  // Scroll the selected item to the middle of the list, once, when it first mounts.
  const scrolledToSelected = useRef(false)
  const selectedItemRef = (el: HTMLButtonElement | null) => {
    if (!el || scrolledToSelected.current) return
    scrolledToSelected.current = true
    const list = el.closest<HTMLElement>('.embed-editor_varpicker-list')
    if (!list) return
    const l = list.getBoundingClientRect()
    const e = el.getBoundingClientRect()
    list.scrollTop += (e.top - l.top) - (list.clientHeight - el.clientHeight) / 2
  }
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  // Measure the hidden first pass at the final width, so the height the positioning
  // effect reads is the height it will actually have.
  const [style, setStyle] = useState<CSSProperties>(() => ({ position: 'fixed', top: 0, ...panelSpan(anchor), visibility: 'hidden' }))
  const toggleCollapse = (name: string) => setCollapsed((prev) => {
    const next = new Set(prev)
    if (next.has(name)) next.delete(name); else next.add(name)
    return next
  })

  // Autofocus the search on open. React's `autoFocus` no-ops because the picker mounts
  // with `visibility: hidden` (a hidden element can't take focus); focus it on the next
  // frame, once the positioning effect has made it visible.
  useEffect(() => {
    const id = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(id)
  }, [])

  // Panel-width: flush with both style-panel edges, dropping below the input row (the
  // dot's wrapper), flipping above only if it would overflow the bottom.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const row = (anchor.parentElement ?? anchor).getBoundingClientRect()
    const { height } = el.getBoundingClientRect()
    let top = row.bottom + 4
    if (top + height > window.innerHeight - margin) top = Math.max(margin, row.top - 4 - height)
    const { left, width } = panelSpan(anchor)
    setStyle({ position: 'fixed', top, left, width, visibility: 'visible' })
  }, [anchor])

  useEffect(() => {
    let swallowClick: ((ev: Event) => void) | null = null
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node
      if (ref.current?.contains(t) || anchor.contains(t)) return
      onClose()
      // Consume the dismiss gesture: swallow the click this pointerdown becomes, so the
      // element under the pointer (e.g. a section's collapse toggle) isn't ALSO activated.
      swallowClick = (ev: Event) => { ev.stopPropagation(); ev.preventDefault(); document.removeEventListener('click', swallowClick!, true); swallowClick = null }
      document.addEventListener('click', swallowClick, true)
      window.setTimeout(() => { if (swallowClick) { document.removeEventListener('click', swallowClick, true); swallowClick = null } }, 300)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
      // NOTE: deliberately do NOT remove the swallow-click listener here. Closing the
      // popup unmounts this picker (running cleanup) BEFORE the pending click fires, so
      // removing it here would let that click through to the element underneath. It
      // removes itself once it swallows the click (or via its own 300ms fallback).
    }
  }, [anchor, onClose])

  // Lock the panel's scroll while the picker is open — it covers most of the panel, so
  // scrolling the rows behind it is disorienting (and moves the picker's anchor).
  // Hiding overflow removes the scrollbar; if it took up space (a classic, non-overlay
  // scrollbar), reserve that width as padding so the panel content doesn't shift.
  useEffect(() => {
    const scroller = panelBox(anchor)
    if (!scroller) return
    const barWidth = scroller.offsetWidth - scroller.clientWidth
    const prevOverflow = scroller.style.overflow
    const prevPad = scroller.style.paddingRight
    scroller.style.overflow = 'hidden'
    if (barWidth > 0) scroller.style.paddingRight = `${parseFloat(getComputedStyle(scroller).paddingRight) + barWidth}px`
    return () => { scroller.style.overflow = prevOverflow; scroller.style.paddingRight = prevPad }
  }, [anchor])

  // Type-filter for the property being edited, then sort for a stable Collection →
  // Group → name view.
  const typed = vars.filter((v) => varTypeAllowed(prop, v.type))
  const sorted = [...typed].sort((a, b) => a.collection.localeCompare(b.collection) || a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
  const query = q.trim().toLowerCase()
  const filtered = query ? sorted.filter((v) => `${v.collection}/${v.group}/${v.name} ${v.value}`.toLowerCase().includes(query)) : sorted

  return createPortal(
    <div ref={ref} className="embed-editor_varpicker" role="dialog" aria-label="Connect to variable" style={style}>
      <input
        ref={searchRef}
        className="u-input embed-editor_varpicker-search"
        value={q}
        placeholder="Search variables, functions"
        spellCheck={false}
        autoFocus
        onChange={(e) => setQ(e.target.value)}
        aria-label="Search variables"
      />
      <div className="embed-editor_varpicker-list">
        {loading && !vars.length ? (
          <p className="embed-editor_varpicker-empty">Loading variables…</p>
        ) : !filtered.length ? (
          <p className="embed-editor_varpicker-empty">No variables found.</p>
        ) : (
          byCollection(filtered).map(({ collection, groups }) => {
            // A search always expands (so matches aren't hidden behind a collapsed head).
            const open = !!query || !collapsed.has(collection)
            return (
              <div key={collection} className="embed-editor_varpicker-collection">
                <button type="button" className="embed-editor_varpicker-collection-head" aria-expanded={open} onClick={() => toggleCollapse(collection)}>
                  <span className="embed-editor_varpicker-collection-name">{collection}</span>
                  <span className={`embed-editor_varpicker-collection-arrow ${open ? 'is-open' : ''}`}><ChevronRightIcon /></span>
                </button>
                {open ? groups.map(({ group, items }) => (
                  <div key={group || '_'} className="embed-editor_varpicker-group">
                    {group ? <div className="embed-editor_varpicker-group-name">{group}</div> : null}
                    {items.map((v) => {
                      const selected = !!selectedBinding && v.binding === selectedBinding
                      return (
                        <button key={v.binding} ref={selected ? selectedItemRef : undefined} type="button" className={`embed-editor_varpicker-item ${selected ? 'is-selected' : ''}`} aria-current={selected || undefined} onClick={() => onPick(v.binding)} title={`${collection} / ${group ? `${group} / ` : ''}${v.name}${v.value ? ` — ${v.value}` : ''}`}>
                          <span className="embed-editor_varpicker-item-icon" aria-hidden="true"><VariableTypeIcon type={v.type} /></span>
                          <span className="embed-editor_varpicker-item-name">{v.name}</span>
                          <span className="embed-editor_varpicker-item-value">{v.value}</span>
                          {selected ? <span className="embed-editor_varpicker-item-check" aria-hidden="true"><CheckIcon /></span> : null}
                        </button>
                      )
                    })}
                  </div>
                )) : null}
              </div>
            )
          })
        )}
      </div>
    </div>,
    document.body,
  )
}

// ── Inline token editor ──────────────────────────────────────────────────────
// The applied variable renders as a purple chip *inside* the field, with editable
// text on either side (type `calc(` in front, ` + 10px)` behind, backspace to
// delete the whole chip). It's a contentEditable — a plain <input> can't hold an
// atomic, cursor-navigable token — that drives the real (hidden) <input> so the
// field's existing draft/live/commit logic runs unchanged: we push edits in via the
// native value setter + an `input` event, and mirror focus/blur so the parent's
// onFocus guard and onBlur commit still fire.

// Per-type glyphs as HTML strings (contentEditable can't take React children). Size
// covers most length fields; Color covers colour props. Others fall back to Size.
const TOKEN_GLYPH: Record<string, string> = {
  Color:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 12C6.61929 12 5.5 10.8807 5.5 9.50002C5.5 9.04673 5.62524 8.59624 5.85694 8.21178L5.86179 8.20374L8.00001 4.50006L10.1434 8.21244C10.3748 8.59673 10.5 9.04697 10.5 9.50002C10.5 10.8807 9.38071 12 8 12ZM4.5 9.50002C4.5 11.433 6.067 13 8 13C9.933 13 11.5 11.433 11.5 9.50002C11.5 8.86769 11.3267 8.24048 11.0025 7.70059L8.86604 4.00006C8.48114 3.3334 7.51889 3.33339 7.13398 4.00006L4.99795 7.69979C4.67349 8.2399 4.5 8.86738 4.5 9.50002Z" fill="currentColor"/></svg>',
  Size:
    '<svg viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M12 4.70711L4.70711 12H7.5V13H3V8.5H4V11.2929L11.2929 4H8.5V3H13V7.5H12V4.70711Z" fill="currentColor"/></svg>',
}
function tokenGlyph(type: string): string { return TOKEN_GLYPH[type] ?? TOKEN_GLYPH.Size }

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// The chip markup embedded in the contentEditable. `contenteditable="false"` makes it
// atomic (a single backspace removes it); `data-chip` marks it for serialization.
function tokenChipHtml(chipName: string, chipType: string): string {
  return (
    '<span class="embed-editor_varconnect-token" contenteditable="false" data-chip="1">' +
    `<span class="embed-editor_varconnect-token-icon">${tokenGlyph(chipType)}</span>` +
    `<span class="embed-editor_varconnect-token-name">${escapeHtml(chipName)}</span>` +
    '</span>'
  )
}

// Value → contentEditable HTML: literal text, the chip in place of the variable, more
// literal text. Zero-width spaces guarantee a caret slot on either side of the chip when
// it sits at the start/end of the value — browsers won't let you type in front of a
// leading, or behind a trailing, non-editable node (so without the leading one you can't
// type `calc(` before a variable that IS the whole value). serializeTokens strips them.
function buildTokenHtml(value: string, varText: string, chipName: string, chipType: string): string {
  const idx = varText ? value.indexOf(varText) : -1
  if (idx < 0) return escapeHtml(value)
  let before = escapeHtml(value.slice(0, idx))
  let after = escapeHtml(value.slice(idx + varText.length))
  if (before === '') before = '\u200B'
  if (after === '') after = '\u200B'
  return `${before}${tokenChipHtml(chipName, chipType)}${after}`
}

// contentEditable → value string. The chip serializes to `bare` when it stands alone and
// to `varForm` once wrapped in text. Callers pass the var(--…) binding for both, so the
// variable stays linked whether it's lone (`var(--x)`) or wrapped (`calc(var(--x) + 10px)`)
// — writing the plain variable NAME instead would make Webflow store a custom value and
// unlink it. The two params stay distinct for callers that want a different lone form.
function serializeTokens(root: HTMLElement, bare: string, varForm: string): string {
  let out = ''
  let hasText = false
  // Walk recursively: contentEditable may nest typed text inside a <div>/<span> it
  // inserts, so a flat childNodes pass could miss the chip (and capture its visible
  // label instead of the binding). A chip is atomic — record it, never descend into it.
  const walk = (node: Node) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        const t = child.textContent ?? ''
        out += t
        if (t.replace(/\u200B/g, '').trim() !== '') hasText = true
      } else if (child instanceof HTMLElement && child.dataset.chip != null) {
        out += '\u0000' // the variable — resolved below once we know if it stands alone
      } else if (child instanceof HTMLElement && child.tagName === 'BR') {
        // ignore line breaks the browser may insert
      } else {
        walk(child)
      }
    })
  }
  walk(root)
  return out.replace(/\u0000/g, hasText ? varForm : bare).replace(/\u200B/g, '')
}

// Move a collapsed caret across the atomic chip when it sits right at the chip's edge —
// browsers otherwise stall there, so you can't arrow behind a lone variable to type
// `!important`. Returns true when it handled the key (so the caller preventDefaults).
function jumpCaretPastChip(root: HTMLElement, dir: 'left' | 'right'): boolean {
  const sel = window.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return false
  const chip = root.querySelector<HTMLElement>('[data-chip]')
  if (!chip) return false
  const { startContainer: node, startOffset: off } = sel.getRangeAt(0)
  const before = chip.previousSibling
  const after = chip.nextSibling
  const place = (n: Node, o: number) => {
    const r = document.createRange()
    r.setStart(n, o); r.collapse(true)
    sel.removeAllRanges(); sel.addRange(r)
  }
  // Caret is immediately before the chip (end of the preceding text node, or the root
  // slot just before it) → drop it just after the chip, and vice-versa.
  const beforeLen = before?.textContent?.length ?? 0
  const rightAdjacent = (node === before && off === beforeLen) || (node === root && root.childNodes[off] === chip)
  const leftAdjacent = (node === after && off === 0) || (node === root && root.childNodes[off - 1] === chip)
  if (dir === 'right' && rightAdjacent && after) { place(after, 0); return true }
  if (dir === 'left' && leftAdjacent && before) { place(before, beforeLen); return true }
  return false
}

function TokenField({
  value, varText, chipBare, chipVar, chipName, chipType, className, ariaLabel, disabled,
  editorRef, onFocusField, onCommit, onChipClick,
}: {
  value: string
  varText: string
  chipBare: string
  chipVar: string
  chipName: string
  chipType: string
  className: string
  ariaLabel: string
  disabled?: boolean
  editorRef: MutableRefObject<HTMLDivElement | null>
  onFocusField: () => void
  /** Serialized value on blur — pushed to the field and committed there. No live writes
   *  fire while typing: a partial expression (`calc(var(…)`, or `cvar(…)` mid-keystroke)
   *  is invalid CSS and Webflow coerces it to 0 on the canvas. The finished value applies
   *  on blur instead. */
  onCommit: (value: string) => void
  onChipClick: () => void
}) {
  // Tracks the value the DOM already reflects, so our own edits (which round-trip back
  // through `value`) don't rebuild innerHTML and reset the caret.
  const synced = useRef<string | null>(null)

  useLayoutEffect(() => {
    const el = editorRef.current
    if (!el || value === synced.current) return
    synced.current = value
    el.innerHTML = buildTokenHtml(value, varText, chipName, chipType)
  }, [value, varText, chipName, chipType, editorRef])

  // Refresh the chip label if it resolves later (async variable load) — but only while
  // unfocused, so an active caret is never disturbed.
  useEffect(() => {
    const el = editorRef.current
    if (!el || document.activeElement === el) return
    synced.current = value
    el.innerHTML = buildTokenHtml(value, varText, chipName, chipType)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [varText, chipName, chipType])

  return (
    <div
      ref={editorRef}
      className={className}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="false"
      aria-label={ariaLabel}
      spellCheck={false}
      onFocus={onFocusField}
      onBlur={() => {
        const el = editorRef.current
        onCommit(el ? serializeTokens(el, chipBare, chipVar) : '')
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); return }
        if (e.key === 'ArrowRight' && jumpCaretPastChip(e.currentTarget, 'right')) e.preventDefault()
        else if (e.key === 'ArrowLeft' && jumpCaretPastChip(e.currentTarget, 'left')) e.preventDefault()
      }}
      onMouseDown={(e) => {
        if ((e.target as HTMLElement).closest('[data-chip]')) { e.preventDefault(); onChipClick() }
      }}
    />
  )
}

// Update the hidden input's DOM value before invoking its controlled onChange handler.
// The handler is called directly by VariableConnect below; dispatching a native `input`
// event from inside the contentEditable's blur proved timing-sensitive in React.
function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
}

export default function VariableConnect({ onPick, disabled, ariaLabel = 'Connect to variable', className, prop, children }: {
  onPick: (binding: string) => void
  disabled?: boolean
  ariaLabel?: string
  /** Layout modifier for the wrapper (e.g. 'is-fill' to grow inside a flex row). */
  className?: string
  /** The CSS property being edited — filters the list to variable types that fit it
   *  (color props → Color only; font-family → FontFamily; else no color/font). */
  prop?: string
  children: ReactNode
}) {
  const [open, setOpen] = useState(false)
  // True while the token editor's contentEditable holds focus — keeps it mounted even if
  // the user edits the value down to a non-variable mid-type (so focus/caret aren't lost).
  const [active, setActive] = useState(false)
  const dotRef = useRef<HTMLButtonElement>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // A variable is applied when the value contains a var(…) — pure, or inside an expression
  // like calc(var(…) + 10px) — or when a bare value equals a project variable's NAME (a
  // native binding reads back as its "group/leaf" name). Load the shared list only when
  // the value could carry a variable (so numbers, lengths, colors don't trigger it).
  const value = childValue(children)
  const raw = value.replace(/!\s*important\s*$/i, '').trim()
  const embedVar = raw.match(/var\(\s*--[A-Za-z0-9_-]+[^)]*\)/i)?.[0]
  // Native size variables may read back as `group/name (resolved value)`. Match using
  // the name portion while keeping the complete raw text as the replaceable token.
  const nativeNames = nativeVariableNames(raw)
  const nameLike = !embedVar && nativeNames.some((name) => name !== '' && /[A-Za-z]/.test(name) && !name.includes('(') && !/^[#.\d]/.test(name))
  const { vars, loading } = useSharedVars(open || !!embedVar || nameLike)

  // Resolve the applied variable — by its var() binding, or by NAME / "group/leaf" path.
  const fullPath = (v: ProjectVariable) => (v.group ? `${v.group}/${v.name}` : v.name)
  const cur = embedVar
    ? vars.find((v) => v.binding === embedVar)
    : (nameLike ? vars.find((v) => {
        if (!varTypeAllowed(prop, v.type)) return false
        const catalogNames = [...nativeVariableNames(v.name), ...nativeVariableNames(fullPath(v))]
        return nativeNames.some((name) => catalogNames.includes(name))
      }) : undefined)

  const isVar = !!embedVar || !!cur
  const binding = cur?.binding ?? embedVar
  const chipName = cur?.name ?? (embedVar ? bindingName(embedVar) : raw)
  const chipType = cur?.type ?? 'Size'
  // The exact substring of the value that IS the variable — the token editor splits
  // around it. For a native binding the whole (bare) value is the variable.
  const varText = embedVar ?? (cur ? raw : '')
  // Render the token editor while a variable is applied, or while it still has focus.
  const showToken = isVar || active

  // Hand the token editor a ref to the real <input> so it can push serialized edits back
  // through the field's own onChange/commit; merge with any ref the child already carries.
  const child = isValidElement(children) ? children : null
  const attachRef = (el: HTMLInputElement | null) => {
    inputRef.current = el
    const r = child ? (child as unknown as { ref?: unknown }).ref : null
    if (typeof r === 'function') (r as (n: HTMLInputElement | null) => void)(el)
    else if (r && typeof r === 'object') (r as MutableRefObject<HTMLInputElement | null>).current = el
  }
  const prepared = child ? cloneElement(child as ReactElement<{ ref?: unknown }>, { ref: attachRef }) : children
  const childClass = child ? ((child.props as { className?: string }).className ?? 'u-input') : 'u-input'
  // The wrapped input's own focus/blur handlers (draft guard + commit). We call them
  // directly from the token editor rather than dispatching synthetic focus events —
  // React's focusin/focusout delegation isn't a reliable target, and missing the blur
  // would leave the edit uncommitted. On commit we first push the finished value into the
  // input via the native setter (flushSync so the parent's draft state is up to date),
  // then invoke its onBlur so commit() reads the final value.
  const childHandlers = child?.props as {
    onChange?: (e: unknown) => void
    onFocus?: (e: unknown) => void
    onBlur?: (e: unknown) => void
  } | undefined
  // …but onBlur's commit() closes over the input's `draft`. Our flushSync push re-renders
  // the input with a NEW closure (draft = the serialized value); the handler we captured
  // this render still sees the PRE-edit draft and would commit that (e.g. the bare
  // variable name, dropping the calc() we just typed). Read the LATEST handler via a ref,
  // updated after the flushSync re-render, so commit() reads the pushed value.
  const childHandlersRef = useRef(childHandlers)
  childHandlersRef.current = childHandlers
  const fakeEvent = () => ({ preventDefault() {}, stopPropagation() {}, target: inputRef.current, currentTarget: inputRef.current })

  const anchor = showToken ? editorRef.current : dotRef.current

  return (
    <span className={`embed-editor_varconnect${className ? ` ${className}` : ''}${showToken ? ' is-token' : ''}`}>
      {prepared}
      {showToken ? (
        <TokenField
          value={value}
          varText={varText}
          chipBare={binding ?? varText}
          chipVar={binding ?? varText}
          chipName={chipName}
          chipType={chipType}
          className={`${childClass} embed-editor_varconnect-editor`}
          ariaLabel={ariaLabel}
          disabled={disabled}
          editorRef={editorRef}
          onFocusField={() => { setActive(true); childHandlers?.onFocus?.(fakeEvent()) }}
          onCommit={(final) => {
            const el = inputRef.current
            if (el) {
              // Drive the controlled field directly. This guarantees its draft becomes
              // the serialized expression before the latest blur closure commits it;
              // a synthetic DOM input event could remain batched and commit the original
              // bare variable instead.
              flushSync(() => {
                setInputValue(el, final)
                childHandlersRef.current?.onChange?.(fakeEvent())
              })
            }
            childHandlersRef.current?.onBlur?.(fakeEvent())
            setActive(false)
          }}
          onChipClick={() => { if (!disabled) setOpen(true) }}
        />
      ) : (
        <button
          ref={dotRef}
          type="button"
          className="embed-editor_varconnect-dot"
          disabled={disabled}
          title={ariaLabel}
          aria-label={ariaLabel}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          <PlusIcon />
        </button>
      )}
      {open && anchor ? (
        <VariablePicker
          anchor={anchor}
          vars={vars}
          loading={loading}
          prop={prop}
          selectedBinding={isVar ? binding : undefined}
          onPick={(b) => { onPick(b); setOpen(false) }}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  )
}
