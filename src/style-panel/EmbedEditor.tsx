import { forwardRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent, ReactNode } from 'react'
import { CodeEditor } from './components/CodeEditor'
import FieldLabel from './components/FieldLabel'
import Select, { type SelectOption } from './components/Select'
import SegmentedControl, { type SegmentedOption } from './components/SegmentedControl'
import useScrub from './components/useScrub'
import DisplayControl from './DisplayControl'
import DirectionControl from './DirectionControl'
import AlignControl from './AlignControl'
import ElementTokenPicker from './ElementTokenPicker'
import { loadEmbedSource, saveEmbedSource } from './shared/tool-prefs'
import { handleArrowStep } from './lib/number-step'
import { hslaToRgba } from './lib/color'
import { filterCssProperties } from './lib/css-properties'
import { panelSpan } from './lib/panel-box'
import SizeSection from './SizeSection'
import GapControl from './GapControl'
import GridControls from './GridControls'
import SpacingSection, { SpacingCenterButton } from './SpacingSection'
import BordersSection from './BordersSection'
import BackgroundSection from './BackgroundSection'
import PositionSection from './PositionSection'
import TypographySection, { GroupLabel } from './TypographySection'
import FlexChildSection from './FlexChildSection'
import EffectsSection from './EffectsSection'
import ProvenanceList, { ProvenanceEmbedNav } from './ProvenanceList'
import VariableConnect from './VariableConnect'
import { computeRuleModel, type DeclStatus, type MatchedRule, type RuleModel } from './lib/cascade'
import { groupDeclarations, groupProps } from './lib/sections'
import { selectorToClassTokens, snapshotTokens, tokensToSelector } from './lib/element-tokens'
import { resolveStyle, indexContexts, contextKeyOf, listMatchedSelectors, selectorKey, selectorsMatch, stateForSelector, STATES, type ContextInfo, type ContextKey, type MatchedSelector, type ResolvedProp, type ResolvedStyle, type SourceKey, type StateKey, type StyleContext } from './lib/resolved'
import { breakpointTier, buildStyleContexts, mediaParamsForBreakpoint, nativeContribsFor, nativeHasValues, nativeSelectorChips, optionsFor, selectedNativeIndexFor, type NativeStyleOptions } from './lib/native-styles'
import type { AtRule, Declaration } from 'postcss'
import {
  addDeclaration,
  appendDecl,
  directDecls,
  createRuleAtRoot,
  createRuleInAtRule,
  createNestedRule,
  createRuleInMedia,
  createRuleInQuery,
  ensureNestPath,
  ensureQueryBlock,
  listAtRuleBlocks,
  parseNestedInput,
  type NestStep,
  removeDeclaration,
  removeRule,
  removeRuleIfEmpty,
  reorderDeclarations,
  replaceRuleCss,
  setDeclarationValue,
  splitRuleSelectorAt,
} from './lib/css'
import { canonicalCompound, compareSpecificity, formatSpecificity, parseSelectorList, type MatchTarget } from './lib/selectors'
import {
  applyNativePropertyAt,
  applyNativeToNewBaseClass,
  buildSnapshot,
  dedupeByKey,
  embedSourceClassSuffix,
  getCurrentBreakpoint,
  loadEmbedDocs,
  navigateToEmbed,
  readNativeStyleByName,
  readNativeStyles,
  onDocsReloaded,
  rebuildRules,
  removeNativePropertyAt,
  resolveIdentityElement,
  resolveTarget,
  scanAllComponents,
  scanHasElement,
  scanPage,
  serializeElementId,
  liveSetNativeProperty,
  nativeStylingAvailable,
  webflowApi,
  webflowClassToCss,
  writeEmbedDoc,
  type EmbedDoc,
  type EmbedScan,
  type NativeWriteTarget,
} from './lib/webflow'
import type { BreakpointId, ElementSnapshot, NativeModel, ParsedDeclaration, ParsedRule, Specificity } from './lib/types'
import './embed-editor.css'
import { splitTopLevelSpaces } from './lib/background'

type ScanState = {
  rootSnapshot: ElementSnapshot | undefined
  model: RuleModel
  /** Empty "add a rule here" scaffolds for queries that don't target the element yet. */
  placeholders: Placeholder[]
  embedCount: number
  componentEmbedCount: number
  /** Page-level embeds carried over from the last full page scan (in-component). */
  rememberedPageEmbedCount: number
  errors: Array<{ label: string; message: string }>
  inComponentContext: boolean
}

type Phase = 'idle' | 'scanning' | 'ready' | 'no-selection' | 'unsupported'

// Placeholder resolved-style so the panel frame (chips, selectors, sections) can
// render immediately while embeds are still scanning — every section shows unset
// and fills in the moment the real resolved model arrives.
const EMPTY_RESOLVED: ResolvedStyle = { props: new Map(), selectedRule: null, contexts: [], states: STATES }
const EMPTY_RULE_MODEL: RuleModel = { base: [], conditional: [], matchedRuleCount: 0 }

// ─────────────────────────── Value helpers ───────────────────────────

function fullValue(decl: ParsedDeclaration): string {
  return decl.important ? `${decl.value} !important` : decl.value
}

function parseImportant(input: string): { value: string; important: boolean } {
  const match = input.match(/!\s*important\s*$/i)
  if (match) return { value: input.slice(0, match.index).trim(), important: true }
  return { value: input.trim(), important: false }
}

function headerLabel(snapshot: ElementSnapshot | undefined): string {
  if (!snapshot) return 'None'
  const tag = snapshot.tag ?? snapshot.webflowType.toLowerCase()
  const id = snapshot.id ? `#${snapshot.id}` : ''
  // Show classes in their Webflow CSS form, de-duplicated (the snapshot keeps the raw
  // display name too — e.g. `Div Block` alongside `div-block` — for matching).
  const formatted = [...new Set(snapshot.classes.map(webflowClassToCss).filter(Boolean))]
  const classes = formatted.length ? `.${formatted.slice(0, 5).join('.')}` : ''
  return `${tag}${id}${classes}` || tag
}

// A selector Webflow can represent as one base class without an element carrying it.
// Interaction states remain native-capable; complex selectors and other pseudos need
// an embed because the Style API has no standalone selector object for them.
function standaloneNativeClass(selector: string): string | null {
  const match = selector.trim().match(/^\.([_a-z-][\w-]*)(?::(?:hover|focus|active))?$/i)
  return match ? webflowClassToCss(match[1]) : null
}

// ─────────────────────────── Query scaffolds ───────────────────────────

// An empty "add a rule here" card for the selected element inside an existing
// conditional query (@media/@container/…) that doesn't target it yet.
type Placeholder = {
  key: string
  atContext: string[]
  selector: string
  embedKey: string
  atRuleNode: AtRule
}

function normalizeSelector(selector: string): string {
  return selector.replace(/\s+/g, ' ').trim()
}

// For each conditional query in the given (writable, current-context) embeds,
// offer a scaffold for the element's primary class and full combo chain —
// skipping any the query already contains.
function computePlaceholders(docs: EmbedDoc[], classList: string[]): Placeholder[] {
  if (!classList.length) return []
  const primary = `.${classList[0]}`
  const full = `.${classList.join('.')}`
  const candidates = full === primary ? [primary] : [primary, full]

  const out: Placeholder[] = []
  for (const doc of docs) {
    doc.regions.forEach((region, regionIndex) => {
      for (const block of listAtRuleBlocks(region)) {
        const existing = new Set(block.selectors.map(normalizeSelector))
        for (const selector of candidates) {
          if (existing.has(normalizeSelector(selector))) continue
          out.push({
            key: `${doc.source.key}:${regionIndex}:${block.atContext.join('>')}:${selector}`,
            atContext: block.atContext,
            selector,
            embedKey: doc.source.key,
            atRuleNode: block.node,
          })
        }
      }
    })
  }
  return out
}

// ─────────────────────────── Icons ───────────────────────────

function PencilIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
      <path d="M11.5 2.5l2 2L6 12l-2.5.5L4 10l7.5-7.5z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
    </svg>
  )
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" width="13" height="13">
      <path d="M3.5 4.5h9M6.5 4V2.8h3V4M5 4.5l.5 8h5l.5-8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function EmbedIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7.73438 11.5H6.70996L8.26562 4.5H9.29004L7.73438 11.5Z" fill="currentColor" />
      <path d="M6.35352 6.85352L5.20703 8L6.35352 9.14648L5.64648 9.85352L3.79297 8L5.64648 6.14648L6.35352 6.85352Z" fill="currentColor" />
      <path d="M12.207 8L10.3535 9.85352L9.64648 9.14648L10.793 8L9.64648 6.85352L10.3535 6.14648L12.207 8Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M13 2C13.5523 2 14 2.44772 14 3V13C14 13.5523 13.5523 14 13 14H3C2.44772 14 2 13.5523 2 13V3C2 2.44772 2.44772 2 3 2H13ZM3 13H13V3H3V13Z" fill="currentColor" />
    </svg>
  )
}

// Webflow's component glyph — labels a component subheader in the source dropdown.
function ComponentIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path fillRule="evenodd" clipRule="evenodd" d="M8.47885 1.69144C8.18037 1.52863 7.81963 1.52863 7.52115 1.69144L2.52115 4.41871C2.19989 4.59395 2 4.93066 2 5.29661V10.703C2 11.0689 2.19989 11.4056 2.52115 11.5809L7.52115 14.3081C7.81963 14.471 8.18037 14.471 8.47885 14.3081L13.4789 11.5809C13.8001 11.4056 14 11.0689 14 10.703V5.29661C14 4.93066 13.8001 4.59395 13.4789 4.41871L8.47885 1.69144ZM3.54416 4.99979L8 2.56934L12.4558 4.99979L8 7.43025L3.54416 4.99979ZM3 5.84206L3 10.703L7.5 13.1575V8.29661L3 5.84206ZM8.5 13.1575L13 10.703V5.84206L8.5 8.29661V13.1575Z" fill="currentColor" />
    </svg>
  )
}

// Header save state: spinner while writing, check when everything is saved, an
// error mark (with the reason on hover) if the last write failed, or an unsaved
// dot (reason on hover) when edits are deferred until you exit the component.
// Rendered into the tool header's accessory slot (replaces the "Pro" tag).
function SpinnerIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeOpacity="0.25" strokeWidth="2" />
      <path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  )
}
function CheckIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M3.5 8.5 6.5 11.5 12.5 5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
function UnsavedIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="3.5" fill="currentColor" />
    </svg>
  )
}
function SaveIndicator({ busy, error, pending }: { busy: boolean; error: string | null; pending: string | null }) {
  const [target, setTarget] = useState<HTMLElement | null>(null)
  // Re-acquire the slot every render (no dep array) so the indicator follows it if the
  // selector row remounts; the functional update no-ops when it's unchanged, so there's
  // no render loop. The slot sits next to the `div.test` label, right-aligned.
  useEffect(() => {
    const el = document.getElementById('embed-editor_save-slot')
    setTarget((prev) => (prev === el ? prev : el))
  })
  if (!target) return null
  // Native `title` tooltips are unreliable inside the Designer iframe, so we
  // render our own hover/focus tooltip (styled to match the dark UI).
  const state = busy
    ? { cls: 'is-saving', tip: 'Saving…', icon: <SpinnerIcon /> }
    : error
      ? { cls: 'is-error', tip: error, icon: <span className="embed-editor_save-mark">!</span> }
      : pending
        ? { cls: 'is-unsaved', tip: pending, icon: <UnsavedIcon /> }
        : { cls: 'is-saved', tip: 'All changes saved', icon: <CheckIcon /> }
  const node = (
    <span className={`embed-editor_save ${state.cls}`} tabIndex={0} aria-label={state.tip}>
      {state.icon}
      <span className="embed-editor_tip" role="tooltip">{state.tip}</span>
    </span>
  )
  return createPortal(node, target)
}


// Webflow's native breakpoint glyphs (tablet / mobile-landscape / mobile),
// shown beside the responsive contexts in the style-context dropdown.
function TabletBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M9.5 11H6.5V12H9.5V11Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M3 3C3 2.44772 3.44772 2 4 2H12C12.5523 2 13 2.44772 13 3V13C13 13.5523 12.5523 14 12 14H4C3.44772 14 3 13.5523 3 13V3ZM4 3H12V13H4V3Z" fill="currentColor" />
    </svg>
  )
}
function MobileLandscapeBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12 9V7H11V9H12Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M4 12C2.89543 12 2 11.1046 2 10L2 6C2 4.89543 2.89543 4 4 4L12 4C13.1046 4 14 4.89543 14 6V10C14 11.1046 13.1046 12 12 12H4ZM3 10L3 6C3 5.44772 3.44772 5 4 5L12 5C12.5523 5 13 5.44772 13 6V10C13 10.5523 12.5523 11 12 11L4 11C3.44772 11 3 10.5523 3 10Z" fill="currentColor" />
    </svg>
  )
}
function MobileBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M7 12H9V11H7V12Z" fill="currentColor" />
      <path fillRule="evenodd" clipRule="evenodd" d="M4 4C4 2.89543 4.89543 2 6 2H10C11.1046 2 12 2.89543 12 4V12C12 13.1046 11.1046 14 10 14H6C4.89543 14 4 13.1046 4 12V4ZM6 3H10C10.5523 3 11 3.44772 11 4V12C11 12.5523 10.5523 13 10 13H6C5.44772 13 5 12.5523 5 12V4C5 3.44772 5.44772 3 6 3Z" fill="currentColor" />
    </svg>
  )
}
function DesktopBreakpointIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M12 5.36602L10.1519 6.43301L9.65192 5.56699L11.5 4.5L9.65193 3.43301L10.1519 2.56699L12 3.63397V1.5H13V3.63397L14.8481 2.56699L15.3481 3.43301L13.5 4.5L15.3481 5.56699L14.8481 6.43301L13 5.36602V7.5H12V5.36602Z" fill="currentColor" />
      <path d="M3 4H8V5H3V12H13V9H14V12H16V13H0V12H2V5C2 4.44772 2.44772 4 3 4Z" fill="currentColor" />
    </svg>
  )
}
function breakpointIcon(id: BreakpointId | null): ReactNode {
  switch (id) {
    case 'main': return <DesktopBreakpointIcon />
    case 'medium': return <TabletBreakpointIcon />
    case 'small': return <MobileLandscapeBreakpointIcon />
    case 'tiny': return <MobileBreakpointIcon />
    default: return undefined
  }
}

// ─────────────────────────── Declaration row ───────────────────────────

// The value reads as a single scrollable line when idle. Once focused, it
// expands to a full-width, auto-height field the moment its content is too long
// to sit on one line — so long values wrap and grow tall instead of scrolling.
const ValueField = forwardRef<HTMLTextAreaElement, {
  value: string
  important: boolean
  busy: boolean
  /** Marks the field with [data-prop] so it can be focused programmatically. */
  dataProp?: string
  onCommit: (value: string, important: boolean) => void
  /** Fires (debounced) on every keystroke/step to push the value to the embed live. */
  onLiveCommit: (value: string, important: boolean) => void
}>(function ValueField({ value, important, busy, dataProp, onCommit, onLiveCommit }, forwardedRef) {
  const external = important ? `${value} !important` : value
  const [draft, setDraft] = useState(external)
  const [expanded, setExpanded] = useState(false)
  const focused = useRef(false)
  const ref = useRef<HTMLTextAreaElement>(null)
  // Keep the local ref (used for sizing/caret work) and hand the same node to
  // whoever wrapped us.
  const attachRef = (el: HTMLTextAreaElement | null) => {
    ;(ref as { current: HTMLTextAreaElement | null }).current = el
    if (typeof forwardedRef === 'function') forwardedRef(el)
    else if (forwardedRef) (forwardedRef as { current: HTMLTextAreaElement | null }).current = el
  }
  const liveTimer = useRef<number | null>(null)

  // Mirror external edits, but never clobber what the user is typing.
  useEffect(() => { if (!focused.current) setDraft(external) }, [value, important])

  // Push the current draft to the embed as you type/scrub — debounced so the
  // canvas updates in near-real-time without a write per keystroke.
  const cancelLive = () => {
    if (liveTimer.current != null) { window.clearTimeout(liveTimer.current); liveTimer.current = null }
  }
  // Undelayed live write for the scrub, which throttles its own — see useScrub.
  const liveNow = (text: string) => {
    const parsed = parseImportant(text)
    if (parsed.value) onLiveCommit(parsed.value, parsed.important)
  }
  const scheduleLive = (text: string) => {
    cancelLive()
    liveTimer.current = window.setTimeout(() => { liveTimer.current = null; liveNow(text) }, 100)
  }
  useEffect(() => cancelLive, [])

  // Expand the instant the collapsed single line can no longer hold the content.
  const maybeExpand = () => {
    const el = ref.current
    if (!el || !focused.current || expanded) return
    if (el.scrollWidth > el.clientWidth + 1) setExpanded(true)
  }

  // Grow the expanded field to fit its content (no inner scroll); reset on collapse.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (expanded) {
      el.style.height = 'auto'
      el.style.height = `${el.scrollHeight}px`
    } else {
      el.style.height = ''
    }
  }, [expanded, draft])

  const commit = (text = draft) => {
    const parsed = parseImportant(text)
    if (parsed.value && (parsed.value !== value || parsed.important !== important)) {
      onCommit(parsed.value, parsed.important)
    }
  }

  const scrub = useScrub({
    value: draft,
    disabled: busy,
    onPreview: setDraft,
    onInput: liveNow,
    onCommit: (text) => { setDraft(text); commit(text) },
  })

  return (
    <textarea
      {...scrub.input}
      ref={attachRef}
      data-prop={dataProp}
      className={`u-input embed-editor_value-input ${expanded ? 'is-expanded' : 'is-collapsed'}`}
      rows={1}
      value={draft}
      onChange={(event) => { setDraft(event.target.value); maybeExpand(); scheduleLive(event.target.value) }}
      onFocus={() => { focused.current = true; maybeExpand() }}
      // Blur is the authoritative commit — cancel any pending live write first.
      onBlur={() => { focused.current = false; setExpanded(false); cancelLive(); commit() }}
      // Enter commits — a CSS value is one line, so we never insert a hard break.
      // Up/Down scrub the number under the caret (Shift = ×10, Alt = per-px).
      onKeyDown={(event) => {
        if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); return }
        const stepped = handleArrowStep(event)
        if (!stepped) return
        event.preventDefault()
        const el = event.currentTarget
        el.value = stepped.text
        el.setSelectionRange(stepped.caret, stepped.caret)
        setDraft(stepped.text)
        maybeExpand()
        scheduleLive(stepped.text)
      }}
      disabled={busy}
      spellCheck={false}
      aria-label="Value"
    />
  )
})

function DeclRow({
  decl,
  status,
  busy,
  reorderable = true,
  draggable,
  dragging,
  dropTarget,
  onGrab,
  onUngrab,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
  onCommitValue,
  onLiveCommitValue,
  onRemove,
}: {
  decl: ParsedDeclaration
  status: DeclStatus | undefined
  busy: boolean
  /** When false the label isn't a drag handle (fixed canonical order sections). */
  reorderable?: boolean
  draggable: boolean
  dragging: boolean
  dropTarget: boolean
  onGrab: () => void
  onUngrab: () => void
  onDragStart: () => void
  onDragOver: () => void
  onDrop: () => void
  onDragEnd: () => void
  onCommitValue: (value: string, important: boolean) => void
  onLiveCommitValue: (value: string, important: boolean) => void
  onRemove: () => void
}) {
  const overridden = status && !status.winning
  // `display` always uses the dedicated control — it handles custom values too.
  const isDisplay = decl.prop.toLowerCase() === 'display'

  return (
    <div
      className={`embed-editor_decl ${isDisplay ? 'is-control' : ''} ${overridden ? 'is-overridden' : ''} ${dragging ? 'is-dragging' : ''} ${dropTarget ? 'is-drop-target' : ''}`}
      draggable={draggable}
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = 'move'
        event.dataTransfer.setData('text/plain', decl.declId)
        onDragStart()
      }}
      onDragOver={(event) => { event.preventDefault(); onDragOver() }}
      onDrop={(event) => { event.preventDefault(); onDrop() }}
      onDragEnd={onDragEnd}
      // A press that never became a drag (a plain click) disarms here so the row
      // doesn't stay draggable — the click still bubbles to the label's menu.
      onMouseUp={onUngrab}
    >
      {/* The label is the drag handle: press-and-drag reorders, a plain click
          opens the menu to remove the declaration (Option-click removes at once). */}
      <FieldLabel
        className="embed-editor_prop-label"
        active
        disabled={busy}
        onReset={onRemove}
        resetLabel="Remove property"
        title={
          overridden
            ? `Overridden by ${status?.overriddenBy ?? 'a stronger rule'}${reorderable ? ' · drag to reorder' : ''}`
            : reorderable ? 'Drag to reorder · click for options' : 'Click for options'
        }
        onMouseDown={busy || !reorderable ? undefined : onGrab}
      >
        {decl.prop}
      </FieldLabel>
      {isDisplay ? (
        <DisplayControl value={decl.value} important={decl.important} busy={busy} onCommit={onCommitValue} />
      ) : (
        <VariableConnect
          ariaLabel={`Connect ${decl.prop} to a variable`}
          disabled={busy}
          prop={decl.prop}
          onPick={(binding) => onCommitValue(binding, decl.important)}
        >
          <ValueField value={decl.value} important={decl.important} busy={busy} onCommit={onCommitValue} onLiveCommit={onLiveCommitValue} />
        </VariableConnect>
      )}
    </div>
  )
}

// ─────────────────────────── Add-property row ───────────────────────────

// The property-name field with an autocomplete of every CSS property. The suggestion
// list is portaled to <body> and positioned above the input (the add row sits at the
// panel bottom), flipping below only when there's more room there. Arrow keys move the
// highlight, Enter/Tab/click pick it; Enter with nothing highlighted submits the row and
// Escape closes the list (a second Escape cancels the row).
function PropertyCombobox({ value, busy, onChange, onPick, onEnter, onEscape }: {
  value: string
  busy: boolean
  onChange: (value: string) => void
  onPick: (prop: string) => void
  onEnter: () => void
  onEscape: () => void
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const matches = useMemo(() => filterCssProperties(value), [value])
  const [pos, setPos] = useState<CSSProperties>({ position: 'fixed', visibility: 'hidden' })

  // Reset the highlight to the top whenever the query (and so the list) changes.
  useEffect(() => { setActive(0) }, [value])

  // Position the list vertically against the input (above it, flipping below only when
  // there's more room there); span the full panel width, like the variable picker, so
  // long property names aren't truncated in the input's narrow column. The panel is
  // measured — it's a column of the window here, not the window itself.
  useLayoutEffect(() => {
    if (!open) return
    const input = inputRef.current
    if (!input) return
    const r = input.getBoundingClientRect()
    const span = panelSpan(input)
    const margin = 8
    const gap = 4
    const spaceAbove = r.top - margin
    const spaceBelow = window.innerHeight - r.bottom - margin
    const up = spaceAbove >= spaceBelow
    const maxHeight = Math.max(120, Math.min(340, (up ? spaceAbove : spaceBelow) - gap))
    setPos(up
      ? { position: 'fixed', left: span.left, width: span.width, bottom: window.innerHeight - r.top + gap, maxHeight, visibility: 'visible' }
      : { position: 'fixed', left: span.left, width: span.width, top: r.bottom + gap, maxHeight, visibility: 'visible' })
  }, [open, matches.length, value])

  // Keep the highlighted option scrolled into view during keyboard nav.
  useEffect(() => {
    if (!open) return
    const el = listRef.current?.children[active] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const choose = (prop: string) => { onPick(prop); setOpen(false) }

  return (
    <div className="embed-editor_propcombo">
      <input
        ref={inputRef}
        className="u-input embed-editor_prop-input"
        value={value}
        autoFocus
        role="combobox"
        aria-expanded={open}
        aria-autocomplete="list"
        disabled={busy}
        onChange={(event) => { onChange(event.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault()
            if (!open) { setOpen(true); return }
            setActive((a) => Math.min(a + 1, matches.length - 1))
          } else if (event.key === 'ArrowUp') {
            event.preventDefault()
            if (open) setActive((a) => Math.max(a - 1, 0))
          } else if (event.key === 'Enter') {
            if (open && matches[active]) { event.preventDefault(); choose(matches[active]) }
            else onEnter()
          } else if (event.key === 'Tab') {
            if (open && matches[active]) { event.preventDefault(); choose(matches[active]) }
          } else if (event.key === 'Escape') {
            if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false) }
            else onEscape()
          }
        }}
        placeholder="property"
        spellCheck={false}
        aria-label="New property name"
      />
      {open && matches.length ? createPortal(
        <div ref={listRef} className="embed-editor_propsuggest" style={pos} role="listbox" aria-label="CSS properties">
          {matches.map((prop, i) => (
            <button
              key={prop}
              type="button"
              role="option"
              aria-selected={i === active}
              className={`embed-editor_propsuggest-item${i === active ? ' is-active' : ''}`}
              onMouseEnter={() => setActive(i)}
              // mousedown (not click) + preventDefault so the input never blurs first.
              onMouseDown={(event) => { event.preventDefault(); choose(prop) }}
            >
              {prop}
            </button>
          ))}
        </div>,
        document.body,
      ) : null}
    </div>
  )
}

function AddPropertyRow({ busy, onAdd }: { busy: boolean; onAdd: (prop: string, value: string, important: boolean) => void }) {
  const [expanded, setExpanded] = useState(false)
  const [prop, setProp] = useState('')
  const [value, setValue] = useState('')
  const valueRef = useRef<HTMLInputElement>(null)
  const ready = prop.trim() !== '' && value.trim() !== ''

  const cancel = () => { setProp(''); setValue(''); setExpanded(false) }
  const submit = () => {
    if (!ready) return
    const parsed = parseImportant(value)
    onAdd(prop.trim(), parsed.value, parsed.important)
    setProp('') // keep the row open + cleared so several can be added in a row
    setValue('')
  }

  if (!expanded) {
    return (
      <button className="embed-editor_add-btn" type="button" onClick={() => setExpanded(true)} disabled={busy}>
        <span className="embed-editor_add-plus" aria-hidden="true">+</span> Add property
      </button>
    )
  }

  return (
    <div className="embed-editor_decl is-add">
      <button className="embed-editor_icon-btn" type="button" onClick={cancel} title="Cancel" aria-label="Cancel adding property">✕</button>
      <PropertyCombobox
        value={prop}
        busy={busy}
        onChange={setProp}
        onPick={(picked) => { setProp(picked); valueRef.current?.focus() }}
        onEnter={submit}
        onEscape={cancel}
      />
      <input
        ref={valueRef}
        className="u-input embed-editor_value-input"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') submit(); if (event.key === 'Escape') cancel() }}
        placeholder="value"
        spellCheck={false}
        aria-label="New value"
      />
      <button className="embed-editor_icon-btn" type="button" onClick={submit} disabled={busy || !ready} title="Add property" aria-label="Add property">+</button>
    </div>
  )
}

// ─────────────────────────── Section block ───────────────────────────

// A collapsible section header (Webflow's chevron + label) wrapping a group of
// controls. Open by default; collapse state is local to the block.
function SectionBlock({ label, headerAction, defaultOpen = true, children }: { label: string; headerAction?: ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen)
  const toggle = () => setOpen((value) => !value)
  return (
    <div className={`embed-editor_section-block ${open ? '' : 'is-collapsed'}`}>
      {/* A row (not one big button) so an optional action can sit next to the chevron
          without nesting a button inside a button. */}
      <div className="embed-editor_section-header">
        <button type="button" className="embed-editor_section-toggle" aria-expanded={open} onClick={toggle}>
          <span className="embed-editor_section-title">{label}</span>
        </button>
        {headerAction}
        <button
          type="button"
          className="embed-editor_section-chevron-btn"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
          onClick={toggle}
        >
          <svg className="embed-editor_section-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.2 6.2 8 10l3.8-3.8" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
      {open ? <div className="embed-editor_section-body">{children}</div> : null}
    </div>
  )
}

// ─────────────────────────── Provenance popover ───────────────────────────

// Lists every selector that sets an "orange" property (applied through a selector
// other than the picked one): its value + the cascade winner, so you can see who
// wins and where a style comes from.
function ProvenancePopover({ prop, anchor, resolved, onClose, onAnchorReclick, onSelectSelector }: { prop: string; anchor: DOMRect; resolved: ResolvedProp; onClose: () => void; onAnchorReclick: (prop: string) => void; onSelectSelector: (selectorText: string, prop?: string) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const headerLabel = prop
  // Anchor to the clicked label's bottom-left, then clamp into the viewport and
  // flip above the label if it would run off the bottom. Portaled to the body so
  // no card overflow / stacking context can clip it.
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: anchor.left, top: anchor.bottom + 6 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const margin = 8
    const { width, height } = el.getBoundingClientRect()
    // Horizontally the popover belongs to the panel, not the window — clamping
    // to the viewport would let it hang off the panel's left edge.
    const span = panelSpan(el)
    let left = anchor.left
    let top = anchor.bottom + 6
    if (left + width > span.left + span.width) left = span.left + span.width - width
    if (left < span.left) left = span.left
    if (top + height > window.innerHeight - margin) {
      const above = anchor.top - 6 - height
      top = above >= margin ? above : Math.max(margin, window.innerHeight - margin - height)
    }
    setPos({ left, top })
  }, [anchor])

  // Dismiss on a pointerdown anywhere outside the popover, or on Escape. Mounted
  // after the opening click, so that click can't immediately close it.
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      if (ref.current?.contains(event.target as Node)) return
      // Pressing back on the label that opened this popover toggles it closed —
      // flag it so that label's click doesn't immediately re-open it.
      if (
        event.clientX >= anchor.left && event.clientX <= anchor.right &&
        event.clientY >= anchor.top && event.clientY <= anchor.bottom
      ) {
        onAnchorReclick(prop)
      }
      onClose()
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, onAnchorReclick, anchor, prop])

  return createPortal(
    <div
      ref={ref}
      className="embed-editor_provenance"
      role="dialog"
      aria-label={`Selectors setting ${headerLabel}`}
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="embed-editor_provenance-head">
        <code>{headerLabel}</code>
        <button type="button" className="embed-editor_icon-btn" onClick={onClose} aria-label="Close">✕</button>
      </div>
      <ProvenanceList
        contributors={resolved.contributors}
        prop={prop}
        onSelect={(sel, p) => { onSelectSelector(sel, p); onClose() }}
      />
    </div>,
    document.body,
  )
}

// ─────────────────────────── Resolved property row ───────────────────────────

// A generic property row from the resolved model: blue when the picked selector
// sets it (editable + removable), orange when another selector does (value from
// the cascade winner; clicking the label opens provenance; editing it adds the
// property to the picked selector — turning it blue).
function ResolvedRow({ prop, resolved, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  prop: string
  resolved: ResolvedProp
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  liveSetProp: (prop: string, value: string | null, important: boolean) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const isSelected = resolved.source === 'selected'
  const display = isSelected && resolved.selectedValue
    ? resolved.selectedValue
    : { value: resolved.winner.value, important: resolved.winner.important }
  const isDisplay = prop === 'display'

  return (
    <div className={`embed-editor_decl ${isDisplay ? 'is-control' : ''}`}>
      {isSelected ? (
        <FieldLabel
          className={`embed-editor_prop-label is-blue ${resolved.overridden ? 'is-overridden' : ''}`}
          active
          disabled={busy}
          onReset={() => clearProp(prop)}
          resetLabel="Remove property"
          title={resolved.overridden ? `Overridden by ${resolved.winner.selectorText}` : undefined}
          menuNote={(close) => <ProvenanceList contributors={resolved.contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
        >
          {prop}
        </FieldLabel>
      ) : (
        <button
          type="button"
          className="embed-editor_prop-label embed-editor_prop-orange"
          disabled={busy}
          title={`Set by ${resolved.winner.selectorText} — click to see all selectors`}
          onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}
        >
          {prop}
        </button>
      )}
      {isDisplay ? (
        <DisplayControl value={display.value} important={display.important} busy={busy} onCommit={(value, important) => setProp(prop, value, important)} />
      ) : (
        <VariableConnect
          ariaLabel={`Connect ${prop} to a variable`}
          disabled={busy}
          prop={prop}
          onPick={(binding) => setProp(prop, binding, false)}
        >
          <ValueField value={display.value} important={display.important} busy={busy} dataProp={prop} onCommit={(value, important) => setProp(prop, value, important)} onLiveCommit={(value, important) => liveSetProp(prop, value, important)} />
        </VariableConnect>
      )}
    </div>
  )
}

// The Display control is always shown (Webflow parity), even when no selector
// sets `display`. In that case we assume the browser default (block) so there's
// always a value to edit; the label stays dim to signal it isn't set yet.
function DisplayRow({ resolved, busy, setProp, clearProp, onProvenance, onSelectSelector }: {
  resolved: ResolvedProp | undefined
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const isSelected = resolved?.source === 'selected'
  const current = resolved
    ? (isSelected && resolved.selectedValue ? resolved.selectedValue : { value: resolved.winner.value, important: resolved.winner.important })
    : { value: 'block', important: false }
  return (
    <div className="embed-editor_size-row">
      {!resolved ? (
        <FieldLabel className="embed-editor_size-label" active={false} disabled={busy} onReset={() => {}}>Display</FieldLabel>
      ) : isSelected ? (
        <FieldLabel
          className="embed-editor_size-label"
          active
          disabled={busy}
          onReset={() => clearProp('display')}
          resetLabel="Remove property"
          menuNote={(close) => <ProvenanceList contributors={resolved.contributors} prop="display" onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
        >
          Display
        </FieldLabel>
      ) : (
        <button
          type="button"
          className="embed-editor_size-label embed-editor_prop-orange"
          disabled={busy}
          title={`Set by ${resolved.winner.selectorText} — click to see all selectors`}
          onClick={(event) => onProvenance('display', event.currentTarget.getBoundingClientRect())}
        >
          Display
        </button>
      )}
      <DisplayControl value={current.value} important={current.important} busy={busy} onCommit={(value, important) => setProp('display', value, important)} />
    </div>
  )
}

// Align Y = `vertical-align`. It only affects inline-level / table-cell boxes, so
// the whole row dims (but stays editable) when Display isn't one of those. Values
// mirror Webflow's dropdown.
const VALIGN_OPTIONS: readonly SelectOption<string>[] = [
  { value: 'baseline', label: 'Baseline' },
  { value: 'sub', label: 'Sub' },
  { value: 'super', label: 'Super' },
  { value: 'top', label: 'Top' },
  { value: 'text-top', label: 'Text top' },
  { value: 'middle', label: 'Middle' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'text-bottom', label: 'Text bottom' },
]
const VALIGN_VALUES = new Set(VALIGN_OPTIONS.map((option) => option.value))
// Display values for which `vertical-align` actually applies (else the row dims).
const VALIGN_DISPLAYS = new Set(['inline', 'inline-block', 'inline-flex', 'inline-grid', 'inline-table', 'table-cell'])

function VerticalAlignRow({ resolved, dimmed, busy, setProp, clearProp, onProvenance, onSelectSelector }: {
  resolved: ResolvedProp | undefined
  /** Display isn't inline/table-cell — fade the row but keep it editable. */
  dimmed: boolean
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const prop = 'vertical-align'
  const isSelected = resolved?.source === 'selected'
  const src = resolved ? (isSelected && resolved.selectedValue ? resolved.selectedValue : resolved.winner) : null
  const raw = src ? src.value.trim() : ''
  const matched = VALIGN_VALUES.has(raw.toLowerCase()) ? raw.toLowerCase() : undefined
  const overridden = resolved?.overridden ?? false

  // Surface a pre-existing non-preset value (e.g. a length) as a trailing option so
  // the trigger reflects it instead of silently snapping back to Baseline.
  const options: SelectOption<string>[] = matched == null && raw
    ? [...VALIGN_OPTIONS, { value: raw, label: raw }]
    : [...VALIGN_OPTIONS]
  const pick = (value: string) => setProp(prop, value, false)

  return (
    <div
      className={`embed-editor_size-row ${dimmed ? 'is-inactive' : ''}`}
      title={dimmed ? 'Align Y applies when Display is inline or table-cell' : undefined}
    >
      {!resolved ? (
        <FieldLabel className="embed-editor_size-label" active={false} disabled={busy} onReset={() => {}}>Align Y</FieldLabel>
      ) : isSelected ? (
        <FieldLabel
          className={`embed-editor_size-label ${overridden ? 'is-overridden' : ''}`}
          active
          disabled={busy}
          onReset={() => clearProp(prop)}
          resetLabel="Remove property"
          title={overridden ? `Overridden by ${resolved.winner.selectorText}` : undefined}
          menuNote={(close) => <ProvenanceList contributors={resolved.contributors} prop={prop} onSelect={(sel, p) => { onSelectSelector(sel, p); close() }} />}
        >
          Align Y
        </FieldLabel>
      ) : (
        <button
          type="button"
          className="embed-editor_size-label embed-editor_prop-orange"
          disabled={busy}
          title={`Set by ${resolved.winner.selectorText} — click to see all selectors`}
          onClick={(event) => onProvenance(prop, event.currentTarget.getBoundingClientRect())}
        >
          Align Y
        </button>
      )}
      <Select
        value={matched ?? (raw || 'baseline')}
        options={options}
        onChange={pick}
        ariaLabel="Align Y"
        disabled={busy}
      />
    </div>
  )
}

// The effective (winner, else selected) value of a resolved prop, lowercased.
// Whether a value is one the property will actually accept (via CSS.supports).
// Gates LIVE writes so a half-typed / invalid value is never pushed at Webflow's
// native style API (which errors and gets stuck). var()/custom props pass; fails
// open only when CSS.supports is unavailable.
function isSupportedCssValue(prop: string, value: string): boolean {
  const v = value.trim()
  if (!v) return false
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') return true
  try { return CSS.supports(prop, v) } catch { return false }
}

function effectiveValue(resolved: ResolvedProp | undefined): string {
  if (!resolved) return ''
  const v = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue.value : resolved.winner.value
  return v.trim().toLowerCase()
}

// The effective raw value + !important flag (not lowercased) — for free-value fields.
function rawEffective(resolved: ResolvedProp | undefined): { value: string; important: boolean } {
  if (!resolved) return { value: '', important: false }
  const src = resolved.source === 'selected' && resolved.selectedValue ? resolved.selectedValue : resolved.winner
  return { value: src.value, important: src.important }
}

// The current flex flow as a normalized `<direction> [wrap]` string (matching the
// Direction control's option values). Prefers the `flex-direction` / `flex-wrap`
// longhands (what the control writes), falling back to any legacy `flex-flow`
// shorthand for each axis. `nowrap` is omitted (e.g. just `row`).
const FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse']
const FLEX_WRAPS = ['nowrap', 'wrap', 'wrap-reverse']
function currentFlexFlow(read: (prop: string) => ResolvedProp | undefined): string {
  let direction = 'row'
  let wrap = 'nowrap'
  const flowTokens = splitTopLevelSpaces(effectiveValue(read('flex-flow')))
  const dir = effectiveValue(read('flex-direction'))
  const wr = effectiveValue(read('flex-wrap'))
  if (FLEX_DIRECTIONS.includes(dir)) direction = dir
  else { const t = flowTokens.find((token) => FLEX_DIRECTIONS.includes(token)); if (t) direction = t }
  if (FLEX_WRAPS.includes(wr)) wrap = wr
  else { const t = flowTokens.find((token) => FLEX_WRAPS.includes(token)); if (t) wrap = t }
  return wrap === 'nowrap' ? direction : `${direction} ${wrap}`
}

// Layout props owned by dedicated controls (Display + Direction + Gap) — kept out of the
// generic property-row list so they aren't shown twice. Gap covers all three spellings:
// the modern longhands, the legacy `grid-*` aliases, and the shorthand — otherwise a rule
// using `row-gap` got a second, generic row for it beside the Gap control.
const LAYOUT_CONTROL_PROPS = new Set([
  'display', 'vertical-align', 'flex-flow', 'flex-direction', 'flex-wrap',
  'gap', 'row-gap', 'column-gap', 'grid-gap', 'grid-row-gap', 'grid-column-gap',
])

// Properties that can only apply as raw CSS — Webflow exposes no Designer API to
// populate its native Transitions UI, so `transition` (and its longhands) always
// write to the embed (custom code) rather than the native class.
const EMBED_ONLY_PROPS = new Set(['transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay'])
// Effects props owned by dedicated controls in EffectsSection — kept out of the
// generic fall-through rows (like TYPOGRAPHY_CONTROL_PROPS).
const EFFECTS_CONTROL_PROPS = new Set([
  'mix-blend-mode', 'opacity', 'outline-style', 'outline-width', 'outline-offset', 'outline-color', 'box-shadow',
  'transform', 'filter', 'backdrop-filter', 'clip-path', '-webkit-clip-path', 'cursor', 'pointer-events',
  // The Transitions layered editor owns the shorthand + all its longhands.
  'transition', 'transition-property', 'transition-duration', 'transition-timing-function', 'transition-delay', 'transition-behavior',
])

// Typography props owned by dedicated controls in TypographySection — kept out of the
// generic row list. Anything else in the section (text-shadow, -webkit-text-stroke,
// …) still renders as a generic row below.
const TYPOGRAPHY_CONTROL_PROPS = new Set([
  'font-family', 'font-weight', 'font-size', 'line-height', 'color',
  'text-align', 'letter-spacing', 'text-indent', 'column-count',
  'font-style', 'text-transform', 'direction',
  // The Decor bar + its "…" popover (line via the shorthand; thickness / skip-ink longhands).
  'text-decoration', 'text-decoration-line', 'text-decoration-style', 'text-decoration-color',
  'text-decoration-thickness', 'text-decoration-skip-ink',
  // The Breaking row (Word / Line dropdowns) + the Wrap row.
  'word-break', 'white-space', 'overflow-wrap',
  // The multi-column "…" popover (Gap / divider rule / span).
  'column-gap', 'column-rule-style', 'column-rule-width', 'column-rule-color', 'column-span',
  // The Truncate / Stroke / Text-shadows rows.
  'text-overflow', '-webkit-text-stroke', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'text-shadow',
])


// The flex Direction control — only rendered when `display` is flex. Writes the
// `flex-direction` + `flex-wrap` longhands; the label clears them (and any legacy
// `flex-flow`).
function DirectionRow({ read, busy, setProp, clearProp, onProvenance, onSelectSelector }: {
  read: (prop: string) => ResolvedProp | undefined
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  return (
    <div className="embed-editor_size-row">
      <GroupLabel
        label="Direction"
        props={['flex-flow', 'flex-direction', 'flex-wrap']}
        read={read}
        busy={busy}
        onClear={() => clearProp(['flex-flow', 'flex-direction', 'flex-wrap'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <DirectionControl
        value={currentFlexFlow(read)}
        rawDirection={rawEffective(read('flex-direction')).value}
        important={rawEffective(read('flex-direction')).important}
        busy={busy}
        onCommit={(direction, wrap) => {
          // Two longhand writes: safe together — native ops serialize, and two edits
          // to one embed rule both land before either save.
          setProp('flex-direction', direction, false)
          setProp('flex-wrap', wrap, false)
        }}
        onCommitCustom={(value, important) => setProp('flex-direction', value, important)}
      />
    </div>
  )
}

// The flex Align control — only rendered when `display` is flex. Its X / Y dropdowns
// write `justify-content` / `align-items` (mapped to the screen axis via the current
// flex-direction); the combined "Align" label clears both.
const ALIGN_PROPS = new Set(['justify-content', 'align-items'])
// Grid props owned by the dedicated GridControls block (and the "Configure grid"
// panel) — kept out of the generic fall-through rows when the element is a grid
// container (they'd otherwise double up). grid-auto-columns/-rows live in Configure grid.
const GRID_CONTROL_PROPS = new Set([
  'grid-template-columns', 'grid-template-rows', 'grid-template-areas',
  'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
  'justify-items', 'align-items', 'justify-content', 'align-content',
])

function AlignRow({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector }: {
  read: (prop: string) => ResolvedProp | undefined
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  liveSetProp: (prop: string, value: string | null, important: boolean) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
}) {
  const column = currentFlexFlow(read).startsWith('column')
  return (
    <div className="embed-editor_size-row embed-editor_align-row">
      <GroupLabel
        label="Align"
        props={['justify-content', 'align-items']}
        read={read}
        busy={busy}
        onClear={() => clearProp(['justify-content', 'align-items'])}
        onProvenance={onProvenance}
        onSelectSelector={onSelectSelector}
      />
      <AlignControl
        justify={effectiveValue(read('justify-content'))}
        align={effectiveValue(read('align-items'))}
        column={column}
        busy={busy}
        onSet={(prop, value) => setProp(prop, value, false)}
        onLive={(prop, value) => liveSetProp(prop, value, false)}
        onClear={(prop) => clearProp(prop)}
      />
    </div>
  )
}

const ChevronRightIcon = () => (
  <svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true">
    <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

// Which layout-mode disclosure a Display value implies. `grid` wins over `inline` for
// `inline-grid`, `flex` over `inline` for `inline-flex`; a custom value (e.g.
// `grid !important`, `var(--grid)`) matches by substring so it still opens its section.
function layoutMode(display: string): 'grid' | 'flex' | 'inline' | null {
  const v = display.toLowerCase()
  if (v.includes('grid')) return 'grid'
  if (v.includes('flex')) return 'flex'
  if (v.includes('inline')) return 'inline'
  return null
}

// A collapsible disclosure (Webflow's "More alignment options" button): a full-width
// header whose chevron rotates open to reveal its rows.
function LayoutDisclosure({ label, open, onToggle, children }: {
  label: string; open: boolean; onToggle: () => void; children: ReactNode
}) {
  return (
    <div className={`embed-editor_disclosure ${open ? 'is-open' : ''}`}>
      <button type="button" className="embed-editor_disclosure-btn" aria-expanded={open} onClick={onToggle}>
        <span className={`embed-editor_disclosure-arrow ${open ? 'is-open' : ''}`}><ChevronRightIcon /></span>
        <span className="embed-editor_disclosure-label">{label}</span>
      </button>
      {open ? <div className="embed-editor_disclosure-body">{children}</div> : null}
    </div>
  )
}

// Flex / Grid / Inline settings as collapsible disclosures. All three always render
// (nothing is hidden by Display); changing Display auto-opens the matching one and
// closes the others, while each stays hand-toggleable between Display changes.
function LayoutModeSections({ read, busy, setProp, clearProp, liveSetProp, onProvenance, onSelectSelector, activeSelector }: {
  read: (prop: string) => ResolvedProp | undefined
  busy: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  liveSetProp: (prop: string, value: string | null, important: boolean) => void
  onProvenance: (prop: string, anchor: DOMRect) => void
  onSelectSelector: (selector: string, prop?: string) => void
  activeSelector: string
}) {
  const display = effectiveValue(read('display'))
  const mode = layoutMode(display)
  const [open, setOpen] = useState({ flex: mode === 'flex', grid: mode === 'grid', inline: mode === 'inline' })
  // Re-sync whenever the Display's mode changes; hand-toggles persist between changes.
  useEffect(() => {
    setOpen({ flex: mode === 'flex', grid: mode === 'grid', inline: mode === 'inline' })
  }, [mode])
  const toggle = (key: 'flex' | 'grid' | 'inline') => setOpen((o) => ({ ...o, [key]: !o[key] }))
  // A gap set in ANY spelling keeps the Gap row visible (it reads all of them).
  const hasGridGap = ['row-gap', 'column-gap', 'grid-row-gap', 'grid-column-gap', 'gap']
    .some((prop) => read(prop) != null)
  return (
    <>
      <LayoutDisclosure label="Flex settings" open={open.flex} onToggle={() => toggle('flex')}>
        <DirectionRow read={read} busy={busy} setProp={setProp} clearProp={clearProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
        <AlignRow read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      </LayoutDisclosure>
      <LayoutDisclosure label="Grid settings" open={open.grid} onToggle={() => toggle('grid')}>
        <GridControls read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={onProvenance} onSelectSelector={onSelectSelector} />
      </LayoutDisclosure>
      {/* Gap is shared by flex + grid — always mounted (keeps its link-toggle state),
          shown whenever the element is a flex/grid container. */}
      <GapControl
        key={activeSelector}
        show={mode === 'flex' || mode === 'grid' || hasGridGap}
        read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp}
        onProvenance={onProvenance} onSelectSelector={onSelectSelector}
      />
      <LayoutDisclosure label="Inline settings" open={open.inline} onToggle={() => toggle('inline')}>
        {/* Align Y = vertical-align: the inline-level alignment property. Dimmed unless
            Display is inline-level or table-cell, where it actually applies. */}
        <VerticalAlignRow
          resolved={read('vertical-align')}
          dimmed={!VALIGN_DISPLAYS.has(display || 'block')}
          busy={busy} setProp={setProp} clearProp={clearProp}
          onProvenance={onProvenance} onSelectSelector={onSelectSelector}
        />
      </LayoutDisclosure>
    </>
  )
}

// ─────────────────────────── Style card ───────────────────────────

// One entry in the source dropdown: the Webflow class layer, or a specific embed.
// `value` is 'native' or the embed's key; `marked` dots embeds that already carry
// a rule for this element; `fromComponent` flags a component-shared embed.
type SourceOption = {
  value: string
  label: string
  marked?: boolean
  fromComponent?: boolean
  /** A non-selectable component subheader grouping the embeds beneath it. */
  heading?: boolean
  /** Nested under a component subheader (indented in the list). */
  indent?: boolean
  /** Full name shown on the closed trigger (e.g. "Global Styles #1"), while the
   *  list row stays the group-scoped "Embed #1". */
  triggerLabel?: string
}

// A selector the element can be targeted by, offered as an autocomplete suggestion:
// its tag, each class, each data attribute (presence then valued), and its combo
// class chains.
type SelectorSuggestion = { selector: string; kind: 'tag' | 'class' | 'attribute' | 'attribute-value' | 'combo' }
const SUGGESTION_KIND_LABEL: Record<SelectorSuggestion['kind'], string> = {
  tag: 'tag', class: 'class', attribute: 'attribute', 'attribute-value': 'attribute', combo: 'combo',
}

// A selector that says nothing about *this* element — `:target`, `:focus-visible`,
// `*`, `::selection`, `body > *`. They match almost everything on the page, so a
// project with a couple of them tacks them onto every element's chip list and
// buries the selectors that actually describe what's selected. Kept behind a
// toggle instead. A class, id or attribute anywhere in the selector (including
// inside `:is(...)`) makes it specific enough to show.
function isGlobalSelector(text: string): boolean {
  if (/[.#[]/.test(text)) return false
  return canonicalCompound(text).tokens.length === 0
}

// The selector picker: a chip per selector that styles the element (its own
// classes, stateful, and complex/ancestor selectors), plus an input to add a new
// one. Clicking a chip makes it the edit target (like clicking a combo class);
// the active selector's chip is highlighted, a not-yet-created one dashed. The
// input offers an autocomplete list of the element's targetable selectors:
// ↑/↓ move, Enter applies the highlighted one (or the typed text), Tab fills it
// into the input to keep typing.
function SelectorPicker({ selectors, suggestions, activeSelector, activePicked, busy, onSelect, onDeselect, onAdd }: {
  selectors: MatchedSelector[]
  suggestions: SelectorSuggestion[]
  activeSelector: string
  /** True when the active selector is one the user clicked or typed, rather than
   *  the panel's auto-composed default. */
  activePicked: boolean
  busy: boolean
  onSelect: (selector: string) => void
  onDeselect: () => void
  onAdd: (selector: string) => void
}) {
  const [draft, setDraft] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(-1)
  const [inputOpen, setInputOpen] = useState(false)
  const [showGlobals, setShowGlobals] = useState(false)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const wantFocus = useRef(false)
  // The selector that was active when the add input took focus — restored on blur
  // if no new selector was added (cleared once one is, or a chip is clicked instead).
  const restoreRef = useRef<string | null>(null)

  // The add input stays hidden until you click into the well (like Webflow's Style
  // selector) — including while selectors are still loading, so the empty box shows
  // as just the black well (with its min-height) rather than an add-selector field.
  const showInput = inputOpen

  // Global selectors are folded away behind a count chip. The one exception is a
  // global the user PICKED — it has to stay on screen for the panel below it to
  // make sense. A global that is merely the current default target stays hidden,
  // so the checkbox means what it says.
  const globals = useMemo(() => selectors.filter((sel) => isGlobalSelector(sel.text)), [selectors])
  const shownSelectors = useMemo(
    () =>
      showGlobals
        ? selectors
        : selectors.filter(
            (sel) =>
              !isGlobalSelector(sel.text) ||
              (activePicked && selectorsMatch(sel.text, activeSelector)),
          ),
    [selectors, showGlobals, activeSelector, activePicked],
  )

  const q = draft.trim().toLowerCase()
  const filtered = useMemo(
    () => suggestions.filter((s) => !q || s.selector.toLowerCase().includes(q)),
    [suggestions, q],
  )
  const showList = open && filtered.length > 0

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    if (!showList || highlight < 0) return
    ;(listRef.current?.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }, [highlight, showList])

  // Focus the input once it's revealed by a well click (it may have just mounted).
  useEffect(() => {
    if (showInput && wantFocus.current) { wantFocus.current = false; inputRef.current?.focus() }
  }, [showInput])

  // Clicking empty space in the well reveals + focuses the add input; clicks on a
  // chip (select/deselect), the input, or the suggestion list are left alone.
  const onWellMouseDown = (event: ReactMouseEvent<HTMLDivElement>) => {
    if (busy) return
    const target = event.target as HTMLElement
    // Clicking a chip selects/deselects it — don't let the input's blur restore the
    // previously-active selector over that choice.
    if (target.closest('.embed-editor_selector-chip')) { restoreRef.current = null; return }
    if (target.closest('.embed-editor_selector-suggest')) return
    if (inputRef.current && target === inputRef.current) return
    event.preventDefault() // keep focus on the input rather than blurring it
    if (showInput) inputRef.current?.focus()
    else { wantFocus.current = true; setInputOpen(true) }
  }

  const apply = (text: string) => {
    const t = text.trim()
    if (!t) return
    restoreRef.current = null // a new selector is now the active one — nothing to restore
    onAdd(t)
    setDraft('')
    setOpen(false)
    setHighlight(-1)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setOpen(true)
      setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setHighlight((h) => Math.max(h - 1, -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      apply(showList && highlight >= 0 && filtered[highlight] ? filtered[highlight].selector : draft)
    } else if (event.key === 'Tab') {
      // Fill the highlighted (or first) suggestion into the input to keep editing.
      const pick = highlight >= 0 ? filtered[highlight] : filtered[0]
      if (showList && pick) { event.preventDefault(); setDraft(pick.selector); setHighlight(-1) }
    } else if (event.key === 'Escape' && open) {
      event.preventDefault()
      setOpen(false)
      setHighlight(-1)
    }
  }

  return (
    <>
    <div className="embed-editor_selectors">
      {/* One grey well wraps the selector tags; clicking empty space reveals the add
          input at its bottom (the input has no chrome of its own). */}
      <div className="embed-editor_selector-well" onMouseDown={onWellMouseDown}>
        {shownSelectors.length ? (
          <div className="embed-editor_selector-chips">
            {shownSelectors.map((sel) => {
              const active = selectorsMatch(sel.text, activeSelector)
              const dimmed = sel.inContext === false
              // Nested rules show their nesting (`.hero { .title }`); selection/matching
              // still uses the resolved selector (sel.text).
              const label = sel.display ?? sel.text
              return (
                <button
                  key={sel.key}
                  type="button"
                  className={`embed-editor_selector-chip ${active ? 'is-active' : ''} ${sel.pending ? 'is-pending' : ''} ${dimmed ? 'is-dimmed' : ''}`}
                  disabled={busy}
                  // Click the active chip again to deselect (show all winners read-only).
                  onClick={() => (active ? onDeselect() : onSelect(sel.text))}
                  title={active ? `${label} — click to deselect` : dimmed ? `${label} — styled in another query` : sel.pending ? `${label} — no styles yet` : label}
                >
                  {label}
                </button>
              )
            })}
          </div>
        ) : null}
        {showInput ? (
          <div className="embed-editor_selector-field">
            <input
              ref={inputRef}
              className="u-input embed-editor_selector-add"
              value={draft}
              placeholder="Add a selector (e.g. .card:hover)"
              spellCheck={false}
              disabled={busy}
              role="combobox"
              aria-expanded={showList}
              aria-autocomplete="list"
              // Focusing the add field clears the active pick — you're composing a new
              // selector, so the panel drops back to showing all winners read-only. Stash
              // the previously-active selector to restore if you leave without adding one.
              onFocus={() => { restoreRef.current = activeSelector || null; onDeselect(); setOpen(true) }}
              // On blur: collapse the empty input, and if no new selector was added,
              // re-select whatever was active before (rather than leaving it deselected).
              onBlur={() => {
                setOpen(false)
                if (!draft.trim()) setInputOpen(false)
                if (restoreRef.current) { onSelect(restoreRef.current); restoreRef.current = null }
              }}
              onChange={(event) => { setDraft(event.target.value); setOpen(true); setHighlight(-1) }}
              onKeyDown={onKeyDown}
              aria-label="Add a selector"
            />
            {showList ? (
              <div className="embed-editor_selector-suggest" ref={listRef} role="listbox" aria-label="Selector suggestions">
                {filtered.map((s, i) => (
                  <button
                    key={`${s.kind}:${s.selector}`}
                    type="button"
                    role="option"
                    aria-selected={i === highlight}
                    className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
                    // Keep the input focused so its blur doesn't close the list before the click.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => setHighlight(i)}
                    onClick={() => apply(s.selector)}
                  >
                    <span className="embed-editor_suggest-sel">{s.selector}</span>
                    <span className="embed-editor_suggest-kind">{SUGGESTION_KIND_LABEL[s.kind]}</span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
    {/* Outside the well's box — a view option, not one of the selectors. */}
    {globals.length ? (
      <label
        className="embed-editor_check embed-editor_globals-check"
        title="Selectors like :target, :focus-visible and * match nearly every element on the page"
      >
        <input
          type="checkbox"
          checked={showGlobals}
          disabled={busy}
          onChange={(event) => setShowGlobals(event.target.checked)}
        />
        <span>Show global selectors ({globals.length})</span>
      </label>
    ) : null}
    </>
  )
}

// Sentinel option value for the "Add query" row in the context dropdown — a real
// context key is '' or an `@…` / `bp:…` string, so this can't collide.
const ADD_QUERY = '\0add-query'

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
      <path d="M8 3.5v9M3.5 8h9" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

const QUERY_MODES: SegmentedOption<'wrap' | 'nest'>[] = [
  { value: 'wrap', label: 'Wrap', tooltip: 'New block — @query { selector { … } }' },
  { value: 'nest', label: 'Nest', tooltip: 'Inside the selector — selector { @query { … } }' },
]

type QuerySuggestion = { query: string; kind: string }

// Common queries offered after any already used in the project — user-preference,
// interaction, orientation/aspect-ratio, container, and feature queries.
const COMMON_QUERIES: QuerySuggestion[] = [
  { query: '@media (hover: hover)', kind: 'hover' },
  { query: '@media (pointer: coarse)', kind: 'touch' },
  { query: '@media (pointer: fine)', kind: 'pointer' },
  { query: '@media (prefers-color-scheme: dark)', kind: 'dark mode' },
  { query: '@media (prefers-color-scheme: light)', kind: 'light mode' },
  { query: '@media (prefers-reduced-motion: reduce)', kind: 'reduced motion' },
  { query: '@media (prefers-contrast: more)', kind: 'contrast' },
  { query: '@media (orientation: landscape)', kind: 'orientation' },
  { query: '@media (orientation: portrait)', kind: 'orientation' },
  { query: '@media (min-aspect-ratio: 16 / 9)', kind: 'aspect ratio' },
  { query: '@container (width < 50em)', kind: 'container' },
  { query: '@container (width > 30em)', kind: 'container' },
  { query: '@media (min-width: 48em)', kind: 'width' },
  { query: '@media (max-width: 47.99em)', kind: 'width' },
  { query: '@supports (display: grid)', kind: 'supports' },
]

// Inline form to add a custom query (@media/@container/@supports) to the current
// selector, choosing whether it WRAPS the selector (a new at-rule block) or NESTS
// inside the selector's existing rule (CSS nesting). Nesting needs a picked selector.
// The controls sit ABOVE the input so the suggestion list (opened below it) can't
// cover them; the input pre-fills `@` and offers project + common queries.
function AddQueryForm({ canNest, suggestions, onAdd, onCancel }: {
  canNest: boolean
  suggestions: QuerySuggestion[]
  onAdd: (query: string, mode: 'wrap' | 'nest') => void
  onCancel: () => void
}) {
  const [draft, setDraft] = useState('@')
  const [mode, setMode] = useState<'wrap' | 'nest'>('nest')
  const [open, setOpen] = useState(true)
  const [highlight, setHighlight] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  // Focus with the caret after the pre-filled `@`.
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [])

  const q = draft.trim().toLowerCase()
  const filtered = useMemo(
    () => suggestions.filter((s) => !q || q === '@' || s.query.toLowerCase().includes(q)),
    [suggestions, q],
  )
  const showList = open && filtered.length > 0
  useEffect(() => {
    if (!showList || highlight < 0) return
    ;(listRef.current?.children[highlight] as HTMLElement | undefined)?.scrollIntoView({ block: 'nearest' })
  }, [highlight, showList])

  const submit = (text: string) => { const t = text.trim(); if (t && t !== '@') onAdd(t, canNest ? mode : 'wrap') }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); setOpen(true); setHighlight((h) => Math.min(h + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); setHighlight((h) => Math.max(h - 1, -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      submit(showList && highlight >= 0 && filtered[highlight] ? filtered[highlight].query : draft)
    } else if (event.key === 'Tab') {
      const pick = highlight >= 0 ? filtered[highlight] : filtered[0]
      if (showList && pick) { event.preventDefault(); setDraft(pick.query); setHighlight(-1) }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      if (open && draft.trim() !== '@') setOpen(false)
      else onCancel()
    }
  }

  return (
    <div className="embed-editor_add-query">
      <div className="embed-editor_add-query-controls">
        <SegmentedControl
          className="embed-editor_add-query-mode"
          options={QUERY_MODES}
          value={canNest ? mode : 'wrap'}
          onChange={setMode}
          ariaLabel="How to add the query"
          disabled={!canNest}
          widthMode="hug"
        />
        <div className="embed-editor_add-query-actions">
          <button type="button" className="u-button is-ghost is-small" onClick={onCancel}>Cancel</button>
          <button type="button" className="u-button is-primary is-small" onClick={() => submit(draft)} disabled={draft.trim() === '' || draft.trim() === '@'}>Add</button>
        </div>
      </div>
      {!canNest ? (
        <p className="embed-editor_add-query-note">Pick a selector to nest inside it.</p>
      ) : null}
      <div className="embed-editor_add-query-field">
        <input
          ref={inputRef}
          className="u-input embed-editor_add-query-input"
          value={draft}
          placeholder="@media (width < 50em)"
          spellCheck={false}
          role="combobox"
          aria-expanded={showList}
          aria-autocomplete="list"
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(event) => { setDraft(event.target.value); setOpen(true); setHighlight(-1) }}
          onKeyDown={onKeyDown}
          aria-label="Query to add"
        />
        {showList ? (
          <div className="embed-editor_selector-suggest" ref={listRef} role="listbox" aria-label="Query suggestions">
            {filtered.map((s, i) => (
              <button
                key={`${s.kind}:${s.query}`}
                type="button"
                role="option"
                aria-selected={i === highlight}
                className={`embed-editor_suggest-item ${i === highlight ? 'is-active' : ''}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setHighlight(i)}
                onClick={() => submit(s.query)}
              >
                <span className="embed-editor_suggest-sel">{s.query}</span>
                <span className="embed-editor_suggest-kind">{s.kind}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function StyleCard({
  snapshot,
  selectedNames,
  selectedSelector,
  activePicked,
  onSelectNames,
  resolved,
  contexts,
  contextInfos,
  context,
  onContext,
  onAddQuery,
  querySuggestions,
  selectors,
  suggestions,
  activeSelector,
  onSelectActive,
  onDeselect,
  onAddSelector,
  sourceValue,
  sourceOptions,
  onSourceChange,
  sourceNote,
  nativeStyleName,
  loading,
  busy,
  pending,
  setProp,
  clearProp,
  liveSetProp,
  onSelectSelector,
  onAdd,
  rawOpen,
  onToggleRaw,
  onSaveRaw,
  onRemoveRule,
}: {
  snapshot: ElementSnapshot | undefined
  selectedNames: string[]
  selectedSelector: string
  activePicked: boolean
  onSelectNames: (names: string[]) => void
  resolved: ResolvedStyle
  contexts: StyleContext[]
  contextInfos: ContextInfo[]
  context: ContextKey
  onContext: (context: ContextKey) => void
  onAddQuery: (query: string, mode: 'wrap' | 'nest') => void
  querySuggestions: QuerySuggestion[]
  selectors: MatchedSelector[]
  suggestions: SelectorSuggestion[]
  activeSelector: string
  onSelectActive: (selector: string) => void
  onDeselect: () => void
  onAddSelector: (selector: string) => void
  sourceValue: string
  sourceOptions: SourceOption[]
  onSourceChange: (value: string) => void
  sourceNote: string | null
  nativeStyleName: string | null
  /** Still fetching embeds — show a spinner in place of the source picker. */
  loading: boolean
  busy: boolean
  pending: boolean
  setProp: (prop: string, value: string, important: boolean) => void
  clearProp: (prop: string | string[]) => void
  liveSetProp: (prop: string, value: string | null, important: boolean) => void
  onSelectSelector: (selector: string, prop?: string) => void
  onAdd: (prop: string, value: string, important: boolean) => void
  rawOpen: boolean
  onToggleRaw: () => void
  onSaveRaw: (rule: ParsedRule, css: string) => void
  onRemoveRule: (rule: ParsedRule) => void
}) {
  const selectedRule = resolved.selectedRule
  // Whether the "Add query" form is open (below the context dropdown).
  const [addingQuery, setAddingQuery] = useState(false)
  // The open provenance popover: which prop + the clicked label's rect (so the
  // popover anchors to the bottom of that label, not a fixed corner of the card).
  const [provenance, setProvenance] = useState<{ prop: string; rect: DOMRect } | null>(null)
  // When the popover is closed by pressing its own trigger label again, that
  // label's click must not re-open it — this holds that prop so openProvenance
  // skips the reopen once (toggle).
  const suppressProvenance = useRef<string | null>(null)
  const openProvenance = useCallback((prop: string, rect: DOMRect) => {
    if (suppressProvenance.current === prop) { suppressProvenance.current = null; return }
    suppressProvenance.current = null
    setProvenance({ prop, rect })
  }, [])
  const closeProvenance = useCallback(() => setProvenance(null), [])
  const suppressProvenanceReopen = useCallback((prop: string) => { suppressProvenance.current = prop }, [])
  const [rawDraft, setRawDraft] = useState('')

  const beginRaw = () => {
    if (!selectedRule) return
    setRawDraft(selectedRule.node.toString())
    onToggleRaw()
  }

  // Always show Layout + Size so the panel is consistent across elements, not
  // only those that already set a property in that section.
  const groups = groupProps([...resolved.props.keys()], ['flex-child', 'layout', 'position', 'spacing', 'size', 'typography', 'backgrounds', 'borders', 'effects', 'other'])
  const read = (prop: string) => resolved.props.get(prop)


  return (
    <div className="embed-editor_rule u-surface-surface">
      {/* The query/context selector leads the panel (and sticks to the top on
          scroll); its "Add query" option opens the form right below it. */}
      <div className="embed-editor_head">
      <div className="embed-editor_switchers">
        {/* Always shown (even with only "Base") for a stable panel layout. The last
            option opens a form to add a custom query to the current selector. */}
        {contexts.length > 0 ? (
          <Select
            className="embed-editor_context-select"
            value={context}
            options={[
              ...contexts.map((ctx) => ({
                value: ctx.key,
                label: ctx.label,
                icon: breakpointIcon(ctx.breakpoint),
                marked: contextInfos.find((info) => info.key === ctx.key)?.hasStyles ?? false,
              })),
              { value: ADD_QUERY, label: 'Add query', icon: <PlusIcon /> },
            ]}
            onChange={(next) => { if (next === ADD_QUERY) setAddingQuery(true); else onContext(next) }}
            ariaLabel="Style context"
          />
        ) : null}
      </div>
      {addingQuery ? (
        <AddQueryForm
          canNest={activeSelector.length > 0}
          suggestions={querySuggestions}
          onCancel={() => setAddingQuery(false)}
          onAdd={(query, mode) => { setAddingQuery(false); onAddQuery(query, mode) }}
        />
      ) : null}
      <div className="embed-editor_selector">
        <div className="embed-editor_selector-box">
          {snapshot ? (
            <ElementTokenPicker snapshot={snapshot} selected={selectedNames} onChange={(names) => onSelectNames(names)} />
          ) : (
            <div className="embed-editor_element-id is-empty">No element selected</div>
          )}
          {/* Right-aligned slot the save indicator portals into — sits on the
              `div.test` row (see SaveIndicator). */}
          <span id="embed-editor_save-slot" className="embed-editor_selector-save" />
        </div>
      </div>

      {/* Every selector that styles this element — click to edit it (like a combo
          class); the input adds a new one (native for a class[:state], embed for a
          complex selector). Replaces the old None/Hover/Focus/Active switch. */}
      <SelectorPicker
        selectors={selectors}
        suggestions={suggestions}
        activeSelector={activeSelector}
        activePicked={activePicked}
        busy={busy}
        onSelect={onSelectActive}
        onDeselect={onDeselect}
        onAdd={onAddSelector}
      />
      {/* Where edits go, as a compact text link: the Webflow class style or a
          specific embed (page embeds listed in cascade order). Sits under the
          selector input, mirroring the reference layout. */}
      <div className="embed-editor_selector-head">
        <div className="embed-editor_source-picker">
          <span className="embed-editor_source-prefix">Add custom styles in:</span>
          {/* Always rendered so it's openable while embeds are still fetching — it
              lists whatever's loaded so far (Webflow + page embeds); component
              embeds fill in as they arrive, flagged by the spinner beside it. */}
          <Select
            variant="link"
            searchable
            searchPlaceholder="Search embeds…"
            className="embed-editor_source-link"
            value={sourceValue}
            options={sourceOptions.map((opt) => ({
              value: opt.value,
              label: opt.label,
              marked: opt.heading ? false : (opt.marked ?? false),
              heading: opt.heading,
              indent: opt.indent,
              triggerLabel: opt.triggerLabel,
              icon: opt.heading ? <ComponentIcon /> : <EmbedIcon />,
              // Trigger tag: component embeds show the component icon in green,
              // page-level embeds the embed icon in blue.
              triggerIcon: opt.fromComponent ? <ComponentIcon /> : <EmbedIcon />,
              tone: opt.fromComponent ? 'component' : 'embed',
            }))}
            onChange={(next) => onSourceChange(next)}
            ariaLabel="Style source — the Webflow class or embed edits go to"
          />
          {loading ? (
            <span className="embed-editor_source-loading" title="Fetching embeds…" aria-live="polite">
              <svg className="embed-editor_source-spinner" viewBox="0 0 16 16" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
              </svg>
            </span>
          ) : null}
        </div>
        {pending ? (
          <span className="embed-editor_unsaved" title="Not yet saved — applies when you exit the component">Unsaved</span>
        ) : null}
      </div>
      </div>
      {sourceNote ? <p className="embed-editor_source-note">{sourceNote}</p> : null}

      {rawOpen && selectedRule ? (
        <div className="embed-editor_rule-edit">
          <CodeEditor
            value={rawDraft}
            language="css"
            ariaLabel={`CSS for ${selectedRule.selectorText}`}
            minHeight="90px"
            onChange={setRawDraft}
            className="embed-editor_rule-code"
          />
          <div className="embed-editor_rule-actions">
            <button className="u-button is-ghost is-small" type="button" onClick={onToggleRaw} disabled={busy}>Cancel</button>
            <button className="u-button is-primary is-small" type="button" onClick={() => onSaveRaw(selectedRule, rawDraft)} disabled={busy}>Save rule</button>
          </div>
        </div>
      ) : (
        <div className="embed-editor_decls">
          {groups.map((group) => (
            <SectionBlock
              key={group.def.id}
              label={group.def.label}
              defaultOpen={group.def.id !== 'flex-child'}
              headerAction={group.def.id === 'spacing'
                ? <SpacingCenterButton read={read} busy={busy} setProp={setProp} clearProp={clearProp} />
                : undefined}
            >
              {group.def.id === 'flex-child' ? (
                <FlexChildSection key={activeSelector} read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'size' ? (
                <SizeSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'position' ? (
                <PositionSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'borders' ? (
                <BordersSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'spacing' ? (
                <SpacingSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'backgrounds' ? (
                <BackgroundSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
              ) : group.def.id === 'typography' ? (
                <>
                  {/* Keyed by selector so the font/weight custom-mode state resets per element. */}
                  <TypographySection key={activeSelector} read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
                  {/* Typography props without a dedicated control (text-transform,
                      font-style, the text-decoration shorthand, …) fall through here. */}
                  {group.props.filter((prop) => !TYPOGRAPHY_CONTROL_PROPS.has(prop)).map((prop) => (
                    <ResolvedRow
                      key={prop}
                      prop={prop}
                      resolved={resolved.props.get(prop)!}
                      busy={busy}
                      setProp={setProp}
                      clearProp={clearProp}
                      liveSetProp={liveSetProp}
                      onProvenance={openProvenance}
                      onSelectSelector={onSelectSelector}
                    />
                  ))}
                </>
              ) : group.def.id === 'layout' ? (
                <>
                  {/* Display always shows (defaults to block); other layout props follow. */}
                  <DisplayRow resolved={read('display')} busy={busy} setProp={setProp} clearProp={clearProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
                  {/* Flex / Grid / Inline settings in collapsible disclosures that
                      auto-open for the current Display (never hidden). Gap lives inside. */}
                  <LayoutModeSections
                    read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp}
                    onProvenance={openProvenance} onSelectSelector={onSelectSelector} activeSelector={activeSelector}
                  />
                  {/* Generic layout props with no dedicated control fall through here; the
                      align + grid props are owned by the disclosures above (always). */}
                  {group.props.filter((prop) =>
                    !LAYOUT_CONTROL_PROPS.has(prop)
                    && !ALIGN_PROPS.has(prop)
                    && !GRID_CONTROL_PROPS.has(prop)
                  ).map((prop) => (
                    <ResolvedRow
                      key={prop}
                      prop={prop}
                      resolved={resolved.props.get(prop)!}
                      busy={busy}
                      setProp={setProp}
                      clearProp={clearProp}
                      liveSetProp={liveSetProp}
                      onProvenance={openProvenance}
                      onSelectSelector={onSelectSelector}
                    />
                  ))}
                </>
              ) : group.def.id === 'effects' ? (
                <>
                  <EffectsSection read={read} busy={busy} setProp={setProp} clearProp={clearProp} liveSetProp={liveSetProp} onProvenance={openProvenance} onSelectSelector={onSelectSelector} />
                  {/* Effects props without a dedicated control (transform-origin,
                      perspective, will-change, …) fall through here. */}
                  {group.props.filter((prop) => !EFFECTS_CONTROL_PROPS.has(prop)).map((prop) => (
                    <ResolvedRow
                      key={prop}
                      prop={prop}
                      resolved={resolved.props.get(prop)!}
                      busy={busy}
                      setProp={setProp}
                      clearProp={clearProp}
                      liveSetProp={liveSetProp}
                      onProvenance={openProvenance}
                      onSelectSelector={onSelectSelector}
                    />
                  ))}
                </>
              ) : (() => {
                // Variable-mode props are shown in their own section above; only the
                // remaining custom properties render here.
                const custom = group.props
                if (!custom.length) return <p className="embed-editor_decls-empty">No custom properties — add one below.</p>
                return custom.map((prop) => (
                  <ResolvedRow
                    key={prop}
                    prop={prop}
                    resolved={resolved.props.get(prop)!}
                    busy={busy}
                    setProp={setProp}
                    clearProp={clearProp}
                    liveSetProp={liveSetProp}
                    onProvenance={openProvenance}
                    onSelectSelector={onSelectSelector}
                  />
                ))
              })()}
            </SectionBlock>
          ))}
        </div>
      )}

      <div className="embed-editor_rule-foot">
        <AddPropertyRow busy={busy} onAdd={onAdd} />
      </div>

      {provenance && resolved.props.get(provenance.prop) ? (
        <ProvenancePopover prop={provenance.prop} anchor={provenance.rect} resolved={resolved.props.get(provenance.prop)!} onClose={closeProvenance} onAnchorReclick={suppressProvenanceReopen} onSelectSelector={onSelectSelector} />
      ) : null}
    </div>
  )
}

// ─────────────────────────── Main component ───────────────────────────

type Content = {
  scan: EmbedScan
  docs: EmbedDoc[]
  rules: ParsedRule[]
  errors: Array<{ label: string; message: string }>
  embedCount: number
  componentEmbedCount: number
  /** True for the page-only snapshot emitted before component embeds finish loading. */
  partial?: boolean
}

// Re-read every embed no more than this often when just switching selection.
const BG_REFRESH_THROTTLE_MS = 4000
// How often to poll the Designer for out-of-app edits (classes / attributes /
// native styles). The API has no change events, so we re-read on this cadence and
// apply only when a signature actually differs.
const DESIGNER_SYNC_INTERVAL_MS = 1500

// A fingerprint of the selected element's identity (tag + id + classes + attrs) —
// changes when a class or data attribute is added/removed in the Designer.
function snapshotSignature(snap: ElementSnapshot): string {
  return JSON.stringify([snap.tag, snap.id, snap.classes, snap.attributes])
}
// A fingerprint of the element's native Webflow class styles — changes when a
// style value is edited on a class (even without touching the element's classes).
function nativeSignature(model: NativeModel | null): string {
  if (!model) return ''
  return model.styles
    .map((style) => `${style.className}:${[...style.propsByContext]
      .map(([ctx, props]) => `${ctx}{${[...props].map(([prop, v]) => `${prop}=${v.value}${v.isVariable ? '~' : ''}`).join(';')}}`)
      .join('|')}`)
    .join('||')
}

// The selectors that carry styles for the element in a given context: embed
// selectors matching it there, plus native class-style selectors with values at
// the context's breakpoint. Sorted weakest → strongest. Shared by the chip picker
// and the on-context-switch auto-select.
// Depth of the applied class chain a selector's classes form a PREFIX of (1 = the
// base class `.test`, 2 = `.test.is-2`, …), or 0 when they aren't that prefix (a
// standalone/global class like `.is-2`). `classList` is the element's applied
// classes, primary first.
function chainPrefixDepth(classes: string[], classList: string[]): number {
  const k = classes.length
  if (!k || k > classList.length) return 0
  const set = new Set(classes)
  if (set.size !== k) return 0
  for (let i = 0; i < k; i += 1) if (!set.has(classList[i])) return 0
  return k
}

// The chip display order: tag → base class (`.test`) → its pseudos (`.test:hover`,
// `.test:is(:hover,:focus)`) → the applied combo chain (`.test.is-2` → `.test.is-2.ready`
// + pseudos) → standalone/global classes (`.is-2`) → data attributes → complex/nested
// selectors (`body > .test`). Returns a comparable [category, depth, pseudo] tuple.
function selectorOrder(text: string, classList: string[]): [number, number, number] {
  const canon = canonicalCompound(text)
  const classes = canon.tokens.filter((t) => t.startsWith('class:')).map((t) => t.slice('class:'.length))
  const hasTag = canon.tokens.some((t) => t.startsWith('tag:'))
  const hasAttr = canon.tokens.some((t) => t.startsWith('attr:'))
  const pseudo = text.includes(':') ? 1 : 0 // a pseudo variant sorts after its plain selector
  if (!canon.oneCompound) return [4, 0, 0] // complex / nested — last
  if (classes.length) {
    const depth = chainPrefixDepth(classes, classList)
    if (depth > 0) return [1, depth, pseudo] // element's own chain: base(1) → combos
    return [2, 0, pseudo] // standalone / global class
  }
  if (hasAttr) return [3, 0, pseudo] // data attributes
  if (hasTag) return [0, 0, 0] // a tag that has styles — first
  return [4, 0, 0]
}

function styledSelectorsFor(
  model: RuleModel | undefined,
  nativeModel: NativeModel | null,
  context: StyleContext,
): MatchedSelector[] {
  const byKey = new Map<string, MatchedSelector>()
  const add = (chip: MatchedSelector) => { if (!byKey.has(chip.key)) byKey.set(chip.key, chip) }
  if (model) {
    for (const sel of listMatchedSelectors(model, context.embedAtContext ?? ' native-only')) add(sel)
  }
  // Native class styles have no per-query context — only breakpoints. List them in
  // EVERY context (dimmed when the current one is a query they can't target — e.g. a
  // container query — or a breakpoint they aren't styled at). inContext holds only
  // when the context IS a breakpoint the selector is actually styled at.
  for (const ns of nativeSelectorChips(nativeModel, context.breakpoint ?? 'main')) {
    const key = selectorKey(ns.text)
    const inContext = context.breakpoint ? ns.inContext : false
    const existing = byKey.get(key)
    if (existing) { if (inContext) existing.inContext = true; continue }
    byKey.set(key, { text: ns.text, specificity: [0, ns.classDepth, 0] as Specificity, state: ns.state, simple: true, key, inContext })
  }
  return [...byKey.values()].sort(
    (a, b) => compareSpecificity(a.specificity, b.specificity) || a.text.localeCompare(b.text),
  )
}

// The last completed embed scan, kept at module scope so it survives the tool being
// closed and reopened (ToolHost unmounts EmbedEditor on close, dropping its refs).
// Without this, every reopen re-scans every embed and the custom-code selector chips
// reappear only after that scan finishes. Restored into the refs on mount so those
// chips render from cache immediately; a background refresh still runs to catch edits,
// and scanHasElement guards against a stale page/component before reuse.
let persistedScan: {
  content: Content
  docs: EmbedDoc[]
  pageDocs: EmbedDoc[]
  inComponent: boolean
  scanAt: number
} | null = null

// Cache the component embed SOURCES (the expensive part: the per-component tree
// DFS to find embeds) at module scope, reused across page switches and reopens.
// The CODE is re-read on every build, so external edits to a component embed are
// picked up (our own edits are saved, so a fresh read reflects them too). A forced
// Rescan re-DFSes to catch added/removed component embeds.
let cachedComponentSources: EmbedDoc['source'][] | null = null

// Native class styles are determined by an element's class signature, so cache the
// read NativeModel by that signature (module scope → survives reopen). A re-selected
// element serves instantly from here while a background re-read reconciles; cleared
// on any native edit, since a class change can affect every element that uses it.
const nativeModelCache = new Map<string, NativeModel>()

export default function EmbedEditor() {
  const selectedRef = useRef<unknown>(null)
  // Identity of the last element we reset the selection for — so a NEW element clears
  // the previous one's picked selector (the token signature isn't reliable: distinct
  // elements can share it, especially when classes aren't readable in a component).
  const selectedElementKeyRef = useRef('')
  // The panel root — used to focus a specific property's field by [data-prop].
  const rootRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<Content | null>(persistedScan?.content ?? null)
  const docsRef = useRef<EmbedDoc[]>(persistedScan?.docs ?? [])
  // Page-level embeds from the last full page scan — kept alive across the
  // enter/exit-component boundary so their rules still match (and stay editable)
  // while a component is open, then flushed on exit.
  const pageDocsRef = useRef<EmbedDoc[]>(persistedScan?.pageDocs ?? [])
  // The current page's component instances — used to enter a component when
  // navigating to one of its (globally-read) embeds from a provenance chip.
  const pageInstancesRef = useRef<unknown[]>([])
  const inComponentRef = useRef(persistedScan?.inComponent ?? false)
  const pendingKeysRef = useRef<Set<string>>(new Set())
  // Selected element's ordered classes — for recomputing query scaffolds on edit.
  const classListRef = useRef<string[]>([])
  const targetRef = useRef<MatchTarget | null>(null)
  const seqRef = useRef(0)
  // Monotonic ordering key so a slow partial render can never overwrite the
  // fuller result that followed it (key = seq * 2 + (partial ? 0 : 1)).
  const appliedKeyRef = useRef(-1)
  const refreshingRef = useRef(false)
  const busyRef = useRef(false)
  // Defer the VISIBLE busy state (which disables controls + spins the save indicator)
  // so a quick save — the common case — never flashes the panel disabled. The poll
  // gate (busyRef) still flips immediately; only the on-screen disable waits out this
  // delay, so a genuinely slow/stuck write still locks the controls to stop edits
  // piling up. Most single writes finish well under this, so they never disable.
  const busyTimerRef = useRef<number | null>(null)
  const lastScanAtRef = useRef(persistedScan?.scanAt ?? 0)

  const setBusyBoth = useCallback((value: boolean) => {
    busyRef.current = value // gate the external-sync poll immediately (before any await)
    if (value) {
      setSaveError(null) // a new save starts → clear the last error
      if (busyTimerRef.current == null) {
        busyTimerRef.current = window.setTimeout(() => { busyTimerRef.current = null; setBusy(true) }, 300)
      }
    } else {
      if (busyTimerRef.current != null) { window.clearTimeout(busyTimerRef.current); busyTimerRef.current = null }
      setBusy(false)
    }
  }, [])
  useEffect(() => () => { if (busyTimerRef.current != null) window.clearTimeout(busyTimerRef.current) }, [])

  const [phase, setPhase] = useState<Phase>('idle')
  const [scan, setScan] = useState<ScanState | null>(null)
  // A fast, scan-independent snapshot (tag + classes) read straight off the
  // selected element so the chips appear immediately, before the embed scan's
  // fuller rootSnapshot arrives.
  const [quickSnapshot, setQuickSnapshot] = useState<ElementSnapshot | null>(null)
  const [status, setStatus] = useState('Select an element to inspect its embed styles.')
  const [busy, setBusy] = useState(false)
  // Last save failure (surfaced by the header save indicator, not as body text).
  const [saveError, setSaveError] = useState<string | null>(null)
  // When a native (Webflow class) write can't apply and we fall back to an embed,
  // the reason — surfaced inline so the fallback isn't silent.
  const [nativeFallback, setNativeFallback] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  // True between showing page-level rules and the component embeds finishing.
  const [scanningMore, setScanningMore] = useState(false)
  const [rawRuleId, setRawRuleId] = useState<string | null>(null)
  // The tokens (tag / classes / attrs) chosen in the header ClassPicker, defaulted
  // to the element's classes and re-defaulted when the selected element changes.
  const [selectedTokens, setSelectedTokens] = useState<string[]>([])
  const tokenIdentityRef = useRef('')
  // Set when the element just changed, so once the model is ready we can upgrade the
  // raw all-classes default to the strongest selector actually STYLED in the current
  // context (cleared as soon as it's applied, or when the user picks something).
  const pendingDefaultRef = useRef(false)
  // The token names the default effect just picked (its raw default) — read by the
  // smart-default effect to check if that default is styled (can't read state there:
  // it hasn't re-rendered yet in the same commit).
  const defaultTokensRef = useRef<string[]>([])
  // The full selector currently being edited when it's picked from the matched-
  // selector chip list (or typed in) rather than composed from the token chips —
  // e.g. `.test:hover`, `.parent.is-active .test`, `:first-child`. Null → the
  // active selector is the token-composed one. `activeSelector` folds the two.
  const [selectedSelectorText, setSelectedSelectorText] = useState<string | null>(null)
  // The chosen style context (Base / a query) and interaction state (:hover, …).
  // stateKey follows the active selector's own pseudo-classes (see the selection
  // handlers) so native reads/writes target the right (breakpoint, pseudo).
  const [context, setContext] = useState<ContextKey>('')
  // The selected context's full object, remembered so the query stays selected when
  // the element changes (re-injected into the rebuilt list if the new element lacks it).
  const stickyContextRef = useRef<StyleContext | null>(null)
  const [stateKey, setStateKey] = useState<StateKey>('')
  // Keys of page-level embeds with edits that couldn't be written while a
  // component is open. Mirrored into pendingKeysRef for use inside callbacks.
  const [pendingKeys, setPendingKeys] = useState<Set<string>>(new Set())

  // Native Webflow class styles on the selected element (read via the Style API),
  // the layer being edited (Native/Embed), and the Designer's current breakpoint
  // (which defaults the context on load).
  const [nativeModel, setNativeModel] = useState<NativeModel | null>(null)
  // null = follow the smart default (Native when the class already has native
  // values, else Embed so pre-existing embed CSS stays editable); a value = the
  // user's explicit choice, kept until the selected element changes.
  // The chosen style source: 'native' (Webflow class) or a specific embed's key.
  // null = follow the default (Webflow when a class Style exists, else the first
  // embed). Reset when the selected element changes.
  // Restore the last-targeted embed so a chosen source (e.g. a global-CSS embed)
  // persists across reloads; effectiveSourceSel still falls back if it's unavailable.
  const [sourceSel, setSourceSel] = useState<string | null>(() => loadEmbedSource())
  // Auto-switch the "create styles in" source to the open component's embed while
  // inside a component, and restore the page pick on exit. Refs so the transition
  // effect reads live values without re-running on every source change.
  const sourceSelRef = useRef(sourceSel)
  useEffect(() => { sourceSelRef.current = sourceSel }, [sourceSel])
  const prevInCompRef = useRef(false)
  const pageSourceRef = useRef<string | null>(null) // page pick stashed while in a component
  const wantCompSourceRef = useRef(false) // pending switch until the component embed loads
  const [currentBreakpoint, setCurrentBreakpoint] = useState<BreakpointId>('main')
  const nativeModelRef = useRef<NativeModel | null>(null)
  // The element identity `nativeModel` was last read for. Native styles load via a
  // separate async effect that lags the embed model on an element switch, so this lets
  // selector-defaulting wait until nativeModel matches the current element (otherwise
  // the previous element's native selectors briefly leak into the styled list and get
  // auto-picked). See the smart-default effect.
  const nativeIdentityRef = useRef('')
  const stateKeyRef = useRef<StateKey>('')
  useEffect(() => { stateKeyRef.current = stateKey }, [stateKey])
  // The selector the user is editing, read at write time by the split-on-edit
  // helpers (they run inside memoized handlers that would otherwise capture a
  // stale value). Synced from `activeSelector` once it's computed below.
  const activeSelectorRef = useRef('')

  const markPending = useCallback((key: string) => {
    if (pendingKeysRef.current.has(key)) return
    const next = new Set(pendingKeysRef.current).add(key)
    pendingKeysRef.current = next
    setPendingKeys(next)
  }, [])
  const clearPending = useCallback((key: string) => {
    if (!pendingKeysRef.current.has(key)) return
    const next = new Set(pendingKeysRef.current)
    next.delete(key)
    pendingKeysRef.current = next
    setPendingKeys(next)
  }, [])

  const docByKey = useMemo(() => {
    const map = new Map<string, EmbedDoc>()
    docsRef.current.forEach((doc) => map.set(doc.source.key, doc))
    return map
  }, [scan])

  // The expensive part — walk the tree + read every embed. Cache the result.
  // Rules/counts are (re)derived in storeContent so they can fold in the
  // remembered page embeds; buildContent just does the raw scan + read.
  //
  // Two phases so results stream in: the page tree + page embeds (enough to
  // resolve ancestor chains and show page-level rules) render first via
  // onPartial, then component embeds fill in. Reads within each phase run
  // concurrently (bounded by the read limiter in webflow.ts).
  const buildContent = useCallback(async (onPartial?: (content: Content) => void, rescanComponents = false): Promise<Content> => {
    const page = await scanPage()
    pageInstancesRef.current = page.instances
    const pageScan: EmbedScan = {
      parentByKey: page.parentByKey,
      childrenByKey: page.childrenByKey,
      elementByKey: page.elementByKey,
      embeds: page.pageEmbeds,
      inComponentContext: page.inComponentContext,
    }
    // Stream: accumulate docs as each embed is read and render them right away,
    // rather than waiting for the whole batch. Emits are coalesced (≤ ~1/100ms)
    // so the re-resolve per partial can't thrash. Dedupe by key because a page and
    // component scan can surface the same embed.
    const streamed: EmbedDoc[] = []
    const streamedKeys = new Set<string>()
    let lastEmitAt = 0
    const onDoc = (doc: EmbedDoc) => {
      if (streamedKeys.has(doc.source.key)) return
      streamedKeys.add(doc.source.key)
      streamed.push(doc)
      if (!onPartial) return
      const now = Date.now()
      if (now - lastEmitAt < 100) return
      lastEmitAt = now
      onPartial({
        scan: pageScan,
        docs: [...streamed],
        rules: [],
        errors: [],
        embedCount: 0,
        componentEmbedCount: 0,
        partial: true,
      })
    }

    // Page and component embeds both re-read their CODE fresh so out-of-app edits
    // show up; only the component tree DFS (finding which embeds exist) is cached.
    const pagePromise = loadEmbedDocs(page.pageEmbeds, onDoc)
    const componentPromise = (async () => {
      // Warm cache (and not a forced rescan): skip the DFS, just re-read the known
      // component embeds' code — that's what catches external edits.
      if (cachedComponentSources && !rescanComponents) {
        return loadEmbedDocs(cachedComponentSources, onDoc)
      }
      // Cold / forced: DFS every component for its embeds (streamed) and cache the
      // sources for next time.
      const sources: EmbedDoc['source'][] = []
      const docs: EmbedDoc[] = []
      const errors: Content['errors'] = []
      await scanAllComponents(async (embeds) => {
        sources.push(...embeds)
        const res = await loadEmbedDocs(embeds, onDoc)
        docs.push(...res.docs)
        errors.push(...res.errors)
      })
      cachedComponentSources = sources
      return { docs, errors }
    })()
    const [pageResult, componentResult] = await Promise.all([pagePromise, componentPromise])

    const seenDocs = new Set<string>()
    const docs = [...pageResult.docs, ...componentResult.docs].filter((doc) => {
      if (seenDocs.has(doc.source.key)) return false
      seenDocs.add(doc.source.key)
      return true
    })
    const embeds = dedupeByKey(docs.map((doc) => doc.source))

    return {
      scan: { ...pageScan, embeds },
      docs,
      rules: [],
      errors: [...pageResult.errors, ...componentResult.errors],
      embedCount: 0,
      componentEmbedCount: 0,
      partial: false,
    }
  }, [])

  // While a component is open, the scan can only see that component's own embeds
  // — the page tree is out of scope (getAllElements/getRootElement are scoped to
  // the entered component). Fold in the page embeds remembered from the last full
  // page scan (dedup by key) so page rules still match.
  const composeDocs = useCallback((content: Content): EmbedDoc[] => {
    if (!content.scan.inComponentContext) return content.docs
    const seen = new Set(content.docs.map((d) => d.source.key))
    const remembered = pageDocsRef.current.filter((d) => !seen.has(d.source.key))
    return [...content.docs, ...remembered]
  }, [])

  const storeContent = useCallback((content: Content) => {
    // Only a complete (non-partial) page scan refreshes the remembered page
    // embeds; while in a component we keep the previous ones (they hold any
    // unsaved edits), and a partial snapshot must not clobber them either.
    if (!content.scan.inComponentContext && !content.partial) pageDocsRef.current = content.docs
    const active = composeDocs(content)
    content.rules = rebuildRules(active)
    content.embedCount = active.length
    content.componentEmbedCount = active.filter((d) => d.source.fromComponent).length
    contentRef.current = content
    docsRef.current = active
    inComponentRef.current = content.scan.inComponentContext
    lastScanAtRef.current = Date.now()
    // Persist completed scans so a reopen restores them (see persistedScan). Skip
    // partials — restoring a page-only snapshot would drop the component chips.
    if (!content.partial) {
      persistedScan = {
        content,
        docs: active,
        pageDocs: pageDocsRef.current,
        inComponent: content.scan.inComponentContext,
        scanAt: lastScanAtRef.current,
      }
    }
  }, [composeDocs])

  // Write out every page embed that was edited while a component was open, now
  // that the page is writable again. Best-effort: reported, then cleared.
  const flushPending = useCallback(async () => {
    const keys = [...pendingKeysRef.current]
    if (!keys.length) return
    const byKey = new Map(pageDocsRef.current.map((d) => [d.source.key, d]))
    let failed = 0
    for (const key of keys) {
      const doc = byKey.get(key)
      if (!doc) continue
      const res = await writeEmbedDoc(doc)
      if (!res.ok) failed += 1
    }
    pendingKeysRef.current = new Set()
    setPendingKeys(new Set())
    setStatus(failed
      ? `Saved your page-embed edits — ${failed} couldn't be written.`
      : 'Saved the page-embed edits you made inside the component.')
  }, [])

  // Rebuild content, flushing any deferred page-embed edits the moment we detect
  // the component was closed (so the fresh page read reflects them). onPartial
  // (foreground only) renders the page-level rules as soon as they're ready,
  // before component embeds finish loading.
  const rebuildAndStore = useCallback(async (onPartial?: (content: Content) => void, rescanComponents = false): Promise<Content> => {
    const wasInComponent = inComponentRef.current
    const emitPartial = onPartial
      ? (partial: Content) => {
          storeContent(partial)
          onPartial(partial)
        }
      : undefined
    let content = await buildContent(emitPartial, rescanComponents)
    if (wasInComponent && !content.scan.inComponentContext && pendingKeysRef.current.size) {
      await flushPending()
      content = await buildContent(undefined, rescanComponents)
    }
    storeContent(content)
    return content
  }, [buildContent, flushPending, storeContent])

  // The cheap part — resolve the selected element against cached content.
  const applyResolve = useCallback(async (element: unknown, content: Content, seq: number, silent = false) => {
    const { target, rootSnapshot } = await resolveTarget(element as never, content.scan)
    if (seq !== seqRef.current) return
    targetRef.current = target
    const model = await computeRuleModel(content.rules, target)
    if (seq !== seqRef.current) return
    // Don't let a lagging partial clobber the final (partials share seq*2+0, the
    // final is seq*2+1 so it always wins; a late partial after it is dropped). A
    // background refresh reuses the same seq and re-applies (equal key ⇒ proceeds).
    const key = seq * 2 + (content.partial ? 0 : 1)
    if (key < appliedKeyRef.current) return
    appliedKeyRef.current = key
    // Scaffolds come from the current context's own (writable) embeds — the
    // component's embeds while inside one, the page's otherwise.
    classListRef.current = rootSnapshot.classList
    setScan({
      rootSnapshot,
      model,
      placeholders: content.scan.inComponentContext
        ? computePlaceholders(content.docs, rootSnapshot.classList)
        : [],
      embedCount: content.embedCount,
      componentEmbedCount: content.componentEmbedCount,
      rememberedPageEmbedCount: content.scan.inComponentContext
        ? pageDocsRef.current.length
        : 0,
      errors: content.errors,
      inComponentContext: content.scan.inComponentContext,
    })
    setPhase('ready')
    setScanningMore(!!content.partial)
    if (!silent) {
      if (content.partial) {
        setStatus(model.matchedRuleCount > 0
          ? `${model.matchedRuleCount} matching rule${model.matchedRuleCount === 1 ? '' : 's'} so far — scanning components…`
          : 'Scanning component embeds…')
      } else {
        setStatus(
          model.matchedRuleCount > 0
            ? `${model.matchedRuleCount} matching rule${model.matchedRuleCount === 1 ? '' : 's'}.`
            : content.embedCount
              ? 'No embed styles target this element.'
              : 'No HTML embeds with <style> blocks found.',
        )
      }
    }
  }, [])

  // Rebuild content in the background (coalesced + throttled) to pick up embed
  // edits, then re-resolve the current selection — without blocking the UI.
  const backgroundRefresh = useCallback(async () => {
    if (refreshingRef.current || busyRef.current) return
    if (Date.now() - lastScanAtRef.current < BG_REFRESH_THROTTLE_MS) return
    refreshingRef.current = true
    setRefreshing(true)
    try {
      const content = await rebuildAndStore()
      const element = selectedRef.current
      if (element && scanHasElement(content.scan, element as never)) {
        await applyResolve(element, content, seqRef.current, true)
      }
    } catch {
      // Background failures are non-fatal — the cached view stays usable.
    } finally {
      refreshingRef.current = false
      setRefreshing(false)
    }
  }, [applyResolve, rebuildAndStore])

  // Poll the Designer for out-of-app edits to the SELECTED element — added/removed
  // classes or data attributes, and native class-style changes — and reflect them
  // (the API has no change events). Cheap in steady state: it reads + compares
  // signatures and only touches state when something actually differs. Embed-code
  // edits are picked up separately by the (throttled) backgroundRefresh.
  const lastSnapSigRef = useRef('')
  const syncFromDesigner = useCallback(async () => {
    if (busyRef.current || refreshingRef.current) return
    if (typeof document !== 'undefined' && document.hidden) return
    const element = selectedRef.current
    const content = contentRef.current
    if (!element || !content || !scanHasElement(content.scan, element as never)) return
    let target: MatchTarget
    let snap: ElementSnapshot
    let native: NativeModel
    try {
      const resolved = await resolveTarget(element as never, content.scan)
      target = resolved.target
      snap = resolved.rootSnapshot
      // Read from the RESOLVED identity element (as refreshNative and the load effect
      // do), NOT the raw selection — reading the raw element yields a different model
      // for in-component selections, so its signature would never match the displayed
      // one and the poll would re-render every tick.
      const identity = await resolveIdentityElement(element as never)
      native = await readNativeStyles(identity, STATES)
    } catch {
      return // transient read failure — try again next tick
    }
    if (busyRef.current || element !== selectedRef.current) return // a user edit / reselect began
    const snapSig = snapshotSignature(snap)
    // Compare against the model CURRENTLY DISPLAYED (nativeModelRef), not a separate
    // last-seen ref: every authoritative write (refreshNative) and the load effect
    // update nativeModelRef, so this stays in sync automatically. A stale ref here made
    // the poll re-apply an identical model — a redundant full-panel re-render (the
    // flicker) 0–1500ms after every value edit or reset.
    const snapChanged = snapSig !== lastSnapSigRef.current
    const nativeChanged = nativeSignature(native) !== nativeSignature(nativeModelRef.current)
    if (!snapChanged && !nativeChanged) return
    lastSnapSigRef.current = snapSig
    if (nativeChanged) {
      nativeModelRef.current = native
      setNativeModel(native)
    }
    if (snapChanged) {
      // Classes / attributes changed → selectors re-match; re-resolve against the
      // cached embeds and refresh the header identity.
      const model = await computeRuleModel(content.rules, target)
      if (busyRef.current || element !== selectedRef.current) return
      targetRef.current = target
      classListRef.current = snap.classList
      setScan((prev) => (prev ? {
        ...prev,
        rootSnapshot: snap,
        model,
        placeholders: content.scan.inComponentContext ? computePlaceholders(content.docs, snap.classList) : [],
      } : prev))
    }
  }, [])

  const refresh = useCallback(async (element: unknown | null, opts: { force?: boolean } = {}) => {
    const seq = ++seqRef.current
    selectedRef.current = element

    // A new element must not inherit the previous one's picked selector. Reset the
    // moment the SELECTED ELEMENT changes (not when its token signature does — those
    // can collide across elements), then the tokens effect re-defaults it.
    const elKey = element ? serializeElementId((element as { id?: unknown }).id) : ''
    if (elKey !== selectedElementKeyRef.current) {
      selectedElementKeyRef.current = elKey
      setSelectedSelectorText(null)
      setSelectedTokens([])
      setStateKey('')
      setQuickSnapshot(null) // drop the previous element's chips
      // The chips are derived from these two models, and both are refilled by
      // async reads. Left alone they keep listing the PREVIOUS element's
      // selectors until those land — the list looks stale for as long as the
      // scan takes. Blank them now: an empty well for a moment is honest,
      // another element's selectors are not. A cached native model comes
      // straight back in the identity effect, so that case barely blinks.
      setScan((prev) => (prev ? { ...prev, model: EMPTY_RULE_MODEL } : prev))
      setNativeModel(null)
      nativeModelRef.current = null
      nativeIdentityRef.current = ''
      // Force the tokens effect to re-default even if the new element shares the old
      // one's token signature (both classless divs, unreadable classes, …).
      tokenIdentityRef.current = ''
      pendingDefaultRef.current = true
    }

    if (!element) {
      setPhase('no-selection')
      setScan(null)
      setStatus('No element selected — type a selector to style it directly.')
      // The style panel does not depend on a canvas selection. Keep scanning embeds
      // so its source picker and custom-selector writes remain available, but project
      // them through an empty match model until the user types a selector.
      const showContent = (content: Content) => {
        if (seq !== seqRef.current || selectedRef.current) return
        setScan({
          rootSnapshot: undefined,
          model: EMPTY_RULE_MODEL,
          placeholders: [],
          embedCount: content.embedCount,
          componentEmbedCount: content.componentEmbedCount,
          rememberedPageEmbedCount: content.scan.inComponentContext ? pageDocsRef.current.length : 0,
          errors: content.errors,
          inComponentContext: content.scan.inComponentContext,
        })
        setScanningMore(!!content.partial)
      }
      const cached = contentRef.current
      if (cached) showContent(cached)
      setScanningMore(true)
      try {
        const content = await rebuildAndStore((partial) => showContent(partial), opts.force)
        showContent(content)
      } catch (error) {
        if (seq !== seqRef.current || selectedRef.current) return
        setScanningMore(false)
        setStatus(error instanceof Error ? error.message : String(error))
      }
      return
    }

    // Read a fast snapshot (tag + classes) straight off the element so the chips
    // render right away, before the (slower) embed scan produces the full model.
    void buildSnapshot(element as never)
      .then((snap) => { if (seq === seqRef.current) setQuickSnapshot(snap) })
      .catch(() => {})

    const cached = contentRef.current
    const canReuse = !opts.force && cached != null && scanHasElement(cached.scan, element as never)

    if (canReuse && cached) {
      // Instant: re-match against cached content, then refresh in the background.
      await applyResolve(element, cached, seq)
      void backgroundRefresh()
      return
    }

    // First load, a context switch, or a forced rescan → rebuild content.
    // Stream: render page-level rules as soon as the page scan finishes.
    setPhase('scanning')
    setStatus(cached ? 'Loading this view…' : 'Scanning embeds…')
    try {
      const content = await rebuildAndStore((partial) => {
        if (seq === seqRef.current) void applyResolve(element, partial, seq)
      }, opts.force)
      if (seq !== seqRef.current) return
      await applyResolve(element, content, seq)
      setRawRuleId(null)
    } catch (error) {
      if (seq !== seqRef.current) return
      setPhase('ready')
      setScanningMore(false)
      setStatus(error instanceof Error ? error.message : String(error))
    }
  }, [applyResolve, backgroundRefresh, rebuildAndStore])

  useEffect(() => {
    const api = webflowApi()
    if (!api?.getSelectedElement) {
      setPhase('unsupported')
      setStatus('The Webflow selection API is unavailable. Open this inside the Designer.')
      return
    }
    void api.getSelectedElement().then((el) => refresh(el))
    void getCurrentBreakpoint().then(setCurrentBreakpoint)
    const unsubscribe = api.subscribe?.('selectedelement', (el) => void refresh(el))
    const unsubBreakpoint = api.subscribe?.('mediaquery', (bp) =>
      setCurrentBreakpoint((typeof bp === 'string' ? bp : 'main') as BreakpointId),
    )
    return () => {
      seqRef.current += 1
      unsubscribe?.()
      unsubBreakpoint?.()
    }
  }, [refresh])

  // While an element is shown, poll for out-of-app edits and keep the panel in sync.
  useEffect(() => {
    if (phase !== 'ready') return
    const id = window.setInterval(() => {
      void syncFromDesigner() // classes / attributes / native styles
      void backgroundRefresh() // embed-code edits (self-throttled)
    }, DESIGNER_SYNC_INTERVAL_MS)
    return () => window.clearInterval(id)
  }, [phase, syncFromDesigner, backgroundRefresh])

  const refreshDerived = useCallback(async () => {
    const rules = rebuildRules(docsRef.current)
    if (contentRef.current) contentRef.current.rules = rules
    const target = targetRef.current
    if (!target) return
    const model = await computeRuleModel(rules, target)
    const placeholders = contentRef.current?.scan.inComponentContext
      ? computePlaceholders(contentRef.current.docs, classListRef.current)
      : []
    setScan((prev) => (prev ? { ...prev, model, placeholders } : prev))
  }, [])

  // An undo/redo rewrote a stylesheet and re-parsed its doc in place — re-resolve
  // so the fields show what the file now says.
  useEffect(() => onDocsReloaded(() => { void refreshDerived() }), [refreshDerived])

  // True when the active selector is ONE splittable member of a grouped rule
  // (`.a::before, .b::after { … }`) — i.e. an edit should be scoped to just that
  // selector rather than the whole comma-separated group. Complex grouped
  // selectors (shown as a single full-group chip) don't match any lone member and
  // so return false — they edit the whole rule.
  const isGroupedSplittable = useCallback((rule: ParsedRule): boolean => {
    const selectors = rule.node.selectors
    const active = activeSelectorRef.current
    if (!selectors || selectors.length <= 1 || !active) return false
    return selectors.some((s) => selectorsMatch(s, active) && canonicalCompound(s).splittable)
  }, [])
  // Isolate the active selector out of a grouped rule before editing so the change
  // only affects the selected chip, leaving the group's other selectors untouched.
  // Returns the rule to edit (the isolated clone, or the original when there's
  // nothing to split) plus a remapper from an original decl to its clone
  // counterpart (declarations are cloned in the same order) for decl-addressed edits.
  const splitForEdit = useCallback((rule: ParsedRule): {
    rule: ParsedRule
    remap: (decl: ParsedDeclaration) => ParsedDeclaration
  } => {
    const identity = { rule, remap: (d: ParsedDeclaration) => d }
    const selectors = rule.node.selectors
    const active = activeSelectorRef.current
    if (!selectors || selectors.length <= 1 || !active) return identity
    const index = selectors.findIndex((s) => selectorsMatch(s, active) && canonicalCompound(s).splittable)
    if (index < 0) return identity
    const origNodes: Declaration[] = []
    rule.node.walkDecls((d) => { origNodes.push(d) })
    const clone = splitRuleSelectorAt(rule.node, index)
    if (!clone) return identity
    const cloneNodes: Declaration[] = []
    clone.walkDecls((d) => { cloneNodes.push(d) })
    const editRule: ParsedRule = {
      ...rule,
      node: clone,
      selectorText: clone.selector,
      selectors: parseSelectorList(clone.selector),
      declarations: rule.declarations.map((d, i) => ({ ...d, node: cloneNodes[i] ?? d.node })),
    }
    const remap = (decl: ParsedDeclaration): ParsedDeclaration => {
      const i = origNodes.indexOf(decl.node)
      return i >= 0 ? editRule.declarations[i] : decl
    }
    return { rule: editRule, remap }
  }, [])

  // Run a synchronous AST mutation, refresh the model, then persist the embed.
  const applyEdit = useCallback(async (rule: ParsedRule, mutate: () => boolean | void) => {
    const doc = docByKey.get(rule.embedKey)
    if (!doc) { setStatus('Lost track of the source embed — try Rescan.'); return }
    setBusyBoth(true)
    setStatus('Saving…')
    // try/finally so `busy` ALWAYS clears — a throw here (e.g. materializing a complex
    // nested selector) must not leave the panel stuck busy, which disables every button.
    try {
      const result = mutate()
      if (result === false) { setStatus('Nothing to save.'); return }
      // Persist FIRST, then rebuild the panel's own model. The write is what the canvas
      // sees, and refreshDerived re-resolves every rule against the element — running it
      // first put a full model rebuild (and, for a <style> node, the page save behind it)
      // between the click and the canvas, so the edit showed up seconds late.
      const res = await writeEmbedDoc(doc)
      await refreshDerived()
      if (!res.ok) {
        // A page-level embed can't be written while a component is open. Keep the
        // in-memory edit and remember it — it flushes automatically on exit.
        if (inComponentRef.current && !doc.source.fromComponent) {
          markPending(doc.source.key)
          setStatus('Kept as unsaved — page embeds save when you exit the component.')
          return
        }
        setSaveError(res.error)
        return
      }
      clearPending(doc.source.key)
      setStatus(rule.fromComponent
        ? `Saved. This embed is shared by every instance of ${rule.componentName ?? 'the component'}.`
        : 'Saved to embed.')
    } finally {
      setBusyBoth(false)
    }
  }, [clearPending, docByKey, markPending, refreshDerived])

  const onCommitValue = useCallback((rule: ParsedRule, decl: ParsedDeclaration, value: string, important: boolean) => {
    void applyEdit(rule, () => setDeclarationValue(splitForEdit(rule).remap(decl), value, important))
  }, [applyEdit, splitForEdit])

  // Live (debounced) write while typing/scrubbing: push the value straight to the
  // AST node + embed so the canvas updates in real time. Deliberately skips the
  // busy flag (so the field stays editable) and the model refresh (values don't
  // change the cascade) — blur runs the authoritative commit via onCommitValue.
  const onLiveCommitValue = useCallback((rule: ParsedRule, decl: ParsedDeclaration, value: string, important: boolean) => {
    // A grouped-splittable selector must split first (on blur, via onCommitValue) so
    // a live write doesn't mutate the whole group. Skip the live preview for it.
    if (isGroupedSplittable(rule)) return
    const doc = docByKey.get(rule.embedKey)
    if (!doc) return
    decl.node.value = value
    decl.node.important = important
    void writeEmbedDoc(doc, true).then((res) => {
      if (!res.ok && inComponentRef.current && !doc.source.fromComponent) markPending(doc.source.key)
    })
  }, [docByKey, markPending, isGroupedSplittable])
  const onAdd = useCallback((rule: ParsedRule, prop: string, value: string, important: boolean) => {
    void applyEdit(rule, () => addDeclaration(splitForEdit(rule).rule, prop, value, important))
  }, [applyEdit, splitForEdit])
  const onRemove = useCallback((rule: ParsedRule, decl: ParsedDeclaration) => {
    void applyEdit(rule, () => {
      const { rule: editRule, remap } = splitForEdit(rule)
      removeDeclaration(remap(decl))
      removeRuleIfEmpty(editRule)
    })
  }, [applyEdit, splitForEdit])
  // Property-addressed writes for always-rendered controls. We look up nodes in
  // the live postcss AST (not rule.declarations) so these stay correct after a
  // live edit appended a node the model hasn't rebuilt yet — otherwise a blur
  // commit would double-add. Update-or-add on set; remove every match on clear.
  const lastDeclFor = (rule: ParsedRule, prop: string): Declaration | null => {
    const key = prop.toLowerCase()
    const matches = directDecls(rule.node).filter((d) => d.prop.trim().toLowerCase() === key)
    return matches.length ? matches[matches.length - 1] : null
  }
  const onSetProp = useCallback((rule: ParsedRule, prop: string, value: string, important: boolean) => {
    void applyEdit(rule, () => {
      const { rule: editRule } = splitForEdit(rule)
      const target = lastDeclFor(editRule, prop)
      if (target) { target.value = value; target.important = important; return }
      return addDeclaration(editRule, prop, value, important)
    })
  }, [applyEdit, splitForEdit])
  const onClearProp = useCallback((rule: ParsedRule, prop: string | string[]) => {
    const props = Array.isArray(prop) ? prop : [prop]
    void applyEdit(rule, () => {
      const { rule: editRule } = splitForEdit(rule)
      const targets: Declaration[] = []
      directDecls(editRule.node).forEach((decl) => { if (props.includes(decl.prop)) targets.push(decl) })
      if (!targets.length) return false
      targets.forEach((decl) => decl.remove())
      removeRuleIfEmpty(editRule)
    })
  }, [applyEdit, splitForEdit])
  // What a live write overwrote, per property — captured on the FIRST live write since
  // the last commit, so onRevertProp can put it back if the edit is abandoned (scrubbing
  // out of a dropdown without picking). `null` records "the property wasn't there".
  const liveOriginRef = useRef(new Map<string, { value: string; important: boolean } | null>())
  const declsFor = (rule: ParsedRule, prop: string): Declaration[] => {
    const key = prop.toLowerCase()
    return directDecls(rule.node).filter((d) => d.prop.trim().toLowerCase() === key)
  }
  // Live set while typing: mutate (or append) the AST node and write straight to
  // the embed so the canvas updates in real time — no busy flag, no model rebuild
  // (blur runs the authoritative onSetProp). Mirrors onLiveCommitValue.
  const onLiveSetProp = useCallback((rule: ParsedRule, prop: string, value: string, important: boolean) => {
    // Defer grouped-splittable edits to the blur commit (onSetProp splits first).
    if (isGroupedSplittable(rule)) return
    const doc = docByKey.get(rule.embedKey)
    if (!doc) return
    const matches = declsFor(rule, prop)
    const target = matches.length ? matches[matches.length - 1] : null
    if (!liveOriginRef.current.has(prop)) {
      liveOriginRef.current.set(prop, target ? { value: target.value, important: !!target.important } : null)
    }
    if (target) { target.value = value; target.important = important }
    else appendDecl(rule.node, prop, value, important)
    void writeEmbedDoc(doc, true).then((res) => {
      if (!res.ok && inComponentRef.current && !doc.source.fromComponent) markPending(doc.source.key)
    })
  }, [docByKey, markPending, isGroupedSplittable])
  // Undo the live writes for `prop` — restore the value they overwrote, or remove the
  // declaration again if there wasn't one. The rule itself is left alone even if that
  // empties it: an abandoned preview must not delete anything the user had.
  const onRevertProp = useCallback((rule: ParsedRule, prop: string) => {
    if (!liveOriginRef.current.has(prop)) return
    const origin = liveOriginRef.current.get(prop) ?? null
    liveOriginRef.current.delete(prop)
    const doc = docByKey.get(rule.embedKey)
    if (!doc) return
    const matches = declsFor(rule, prop)
    const target = matches.length ? matches[matches.length - 1] : null
    if (origin) {
      if (target) { target.value = origin.value; target.important = origin.important }
      else appendDecl(rule.node, prop, origin.value, origin.important)
    } else if (target) {
      target.remove()
    }
    void writeEmbedDoc(doc, true).then((res) => {
      if (!res.ok && inComponentRef.current && !doc.source.fromComponent) markPending(doc.source.key)
    })
  }, [docByKey, markPending])
  const onReorder = useCallback((rule: ParsedRule, ids: string[]) => {
    void applyEdit(rule, () => reorderDeclarations(splitForEdit(rule).rule, ids))
  }, [applyEdit, splitForEdit])
  const onRemoveRule = useCallback((rule: ParsedRule) => {
    void applyEdit(rule, () => removeRule(splitForEdit(rule).rule))
  }, [applyEdit, splitForEdit])
  const onSaveRaw = useCallback((rule: ParsedRule, css: string) => {
    void applyEdit(rule, () => {
      const result = replaceRuleCss(rule, css)
      if (!result.ok) { setSaveError(`Invalid CSS: ${result.error}`); return false }
      setRawRuleId(null)
      return true
    })
  }, [applyEdit])

  // Scaffold: create the rule inside its query, then persist — mirrors applyEdit's
  // optimistic-refresh + deferred-save-in-component behavior.
  const onAddToPlaceholder = useCallback((placeholder: Placeholder, prop: string, value: string, important: boolean) => {
    const doc = docByKey.get(placeholder.embedKey)
    if (!doc) { setStatus('Lost track of the source embed — try Rescan.'); return }
    void (async () => {
      setBusyBoth(true)
      setStatus('Saving…')
      try {
        if (!createRuleInAtRule(placeholder.atRuleNode, placeholder.selector, prop, value, important)) {
          setStatus('Nothing to save.')
          return
        }
        const res = await writeEmbedDoc(doc)
        await refreshDerived()
        if (!res.ok) {
          if (inComponentRef.current && !doc.source.fromComponent) {
            markPending(doc.source.key)
            setStatus('Kept as unsaved — page embeds save when you exit the component.')
            return
          }
          setSaveError(res.error)
          return
        }
        clearPending(doc.source.key)
        setStatus(`Added ${placeholder.selector} to ${placeholder.atContext[placeholder.atContext.length - 1] ?? 'the query'}.`)
      } finally {
        setBusyBoth(false)
      }
    })()
  }, [clearPending, docByKey, markPending, refreshDerived, setBusyBoth])

  // Select the source embed on the Webflow canvas (from a provenance embed chip).
  // Component embeds carry no page instance, so pass the current page's instances
  // for navigateToEmbed to find one to enter.
  const openEmbedByKey = useCallback((embedKey: string) => {
    const doc = docByKey.get(embedKey)
    if (!doc) { setStatus('Lost track of the source embed — try Rescan.'); return }
    void navigateToEmbed(doc.source, pageInstancesRef.current).then((res) => {
      if (!res.ok) setStatus(`Couldn't open it on the canvas: ${res.error}`)
    })
  }, [docByKey])

  const toggleRaw = useCallback((ruleId: string) => {
    setRawRuleId((cur) => (cur === ruleId ? null : ruleId))
  }, [])

  // Prefer the scan's full rootSnapshot; fall back to the fast quick snapshot so
  // the chips show while the scan is still running.
  const snapshot = scan?.rootSnapshot ?? quickSnapshot ?? undefined

  const model = scan?.model
  const tokens = useMemo(() => snapshotTokens(snapshot), [snapshot])

  // Autocomplete suggestions for the add-selector input: the element's tag, each
  // class, each data attribute (presence, then valued), then its combo class chains
  // (cumulative in applied order, like Webflow combos).
  const selectorSuggestions = useMemo<SelectorSuggestion[]>(() => {
    const out: SelectorSuggestion[] = []
    const tagTok = tokens.find((t) => t.kind === 'tag')
    if (tagTok) out.push({ selector: tagTok.label ?? tagTok.name, kind: 'tag' })
    const classNames = tokens
      .filter((t) => t.kind === 'class')
      .map((t) => t.label ?? t.name.slice('class:'.length))
    for (const cls of classNames) out.push({ selector: `.${cls}`, kind: 'class' })
    const attrNames = tokens
      .filter((t) => t.kind === 'attribute')
      .map((t) => t.label ?? t.name.slice('attr:'.length))
    for (const name of attrNames) out.push({ selector: `[${name}]`, kind: 'attribute' })
    for (const name of attrNames) {
      const value = snapshot?.attributes?.[name]
      if (value) out.push({ selector: `[${name}="${value}"]`, kind: 'attribute-value' })
    }
    for (let i = 2; i <= classNames.length; i += 1) {
      out.push({ selector: classNames.slice(0, i).map((c) => `.${c}`).join(''), kind: 'combo' })
    }
    return out
  }, [tokens, snapshot])

  // Re-default the picked selector when the element changes: all classes (the full
  // combo chain, like Webflow's default) → else last data attribute → else the tag.
  // Also reset context/state.
  useEffect(() => {
    const identity = tokens.map((token) => token.name).join('|')
    if (identity === tokenIdentityRef.current) return
    tokenIdentityRef.current = identity
    const classes = tokens.filter((token) => token.kind === 'class')
    const attrs = tokens.filter((token) => token.kind === 'attribute')
    const next = classes.length
      ? classes.map((token) => token.name)
      : attrs.length
        ? [attrs[attrs.length - 1].name]
        : tokens.length
          ? [tokens[0].name]
          : []
    setSelectedTokens(next)
    setSelectedSelectorText(null)
    defaultTokensRef.current = next
    pendingDefaultRef.current = true
    // Keep the current query (context) — switching elements stays on the same
    // breakpoint/query so you can style a different element within it. It only
    // changes when you pick a different query yourself.
    setStateKey('')
    // Keep the picked source embed too: switching elements shouldn't forget where
    // the user chose to add new styles. (It falls back to the first embed only if
    // that source isn't available for the new element — see effectiveSourceSel.)
    setNativeFallback(null)
  }, [tokens])

  // The element's identity (tag + classes + attrs) as a stable key — drives the
  // native-style read so it re-runs on selection or class changes, not on every
  // background embed refresh.
  const elementIdentity = useMemo(() => tokens.map((token) => token.name).join('|'), [tokens])

  // Read the selected element's native class styles across every Webflow breakpoint
  // AND every interaction state — the selector-chip picker lists stateful selectors
  // (`.test:hover`) regardless of the current view, so all states must be read.
  // Re-reads only on element / class change (not on state, which is now derived).
  useEffect(() => {
    const el = selectedRef.current
    if (!el) { setNativeModel(null); nativeModelRef.current = null; nativeIdentityRef.current = ''; return }
    // Instant: serve the cached model for this class-signature while re-reading in
    // the background, so re-selecting an element doesn't re-lag its native chips.
    const cached = nativeModelCache.get(elementIdentity)
    if (!cached && nativeModelRef.current) {
      // A class change on the same element: the model in hand describes the old
      // class list, so it can't stand in while the new one loads.
      nativeModelRef.current = null
      nativeIdentityRef.current = ''
      setNativeModel(null)
    }
    if (cached) {
      // Show the cached chips immediately, but do NOT advance nativeIdentityRef here:
      // setNativeModel is async, so the ref would outrun the model the smart-default
      // effect still sees this render and let it default off a stale nativeModel. The
      // ref only advances in the async read below, where it moves with the model.
      nativeModelRef.current = cached
      setNativeModel(cached)
    }
    let cancelled = false
    // On a cold read (no cache), stream each scan phase into the UI so the selected
    // element's class styles + selectors appear as they're found, not after the whole
    // scan. On a cache hit the shown model is already complete, so skip partials (they
    // would flash a less-complete model) and just swap in the fresh final model.
    const onPartial = cached ? undefined : (partial: NativeModel) => {
      if (cancelled) return
      // Update the ref too, so a write mid-scan targets what's shown. Leave
      // nativeIdentityRef to the final model, so the smart-default selection is picked
      // off the COMPLETE model rather than an early partial.
      nativeModelRef.current = partial
      setNativeModel(partial)
    }
    // Read native styles from the RESOLVED identity element (a component instance's
    // root), not the raw selection — the instance wrapper carries no classes of its
    // own, so reading it directly yields nothing outside the component.
    void resolveIdentityElement(el as never)
      .then((identity) => readNativeStyles(identity, STATES, onPartial))
      .then((model) => {
        if (cancelled) return
        nativeModelCache.set(elementIdentity, model)
        nativeModelRef.current = model
        nativeIdentityRef.current = elementIdentity
        setNativeModel(model)
      })
    return () => { cancelled = true }
  }, [elementIdentity])

  const selectedSelector = useMemo(() => tokensToSelector(selectedTokens, tokens), [selectedTokens, tokens])
  // The full selector currently being edited: an explicit chip/typed pick when set,
  // else the one composed from the token chips.
  const activeSelector = selectedSelectorText ?? selectedSelector
  useEffect(() => { activeSelectorRef.current = activeSelector }, [activeSelector])

  // With no canvas selection, a typed standalone class is still a complete native
  // target: look it up directly in the project's Style API so its values and state
  // styles can be shown and edited just like an applied class.
  const standaloneClass = phase === 'no-selection' ? standaloneNativeClass(activeSelector) : null
  useEffect(() => {
    if (phase !== 'no-selection') return
    if (!standaloneClass) {
      nativeModelRef.current = null
      nativeIdentityRef.current = ''
      setNativeModel(null)
      return
    }
    let cancelled = false
    void readNativeStyleByName(standaloneClass, STATES).then((next) => {
      if (cancelled) return
      nativeModelRef.current = next
      nativeIdentityRef.current = `standalone:${standaloneClass}`
      setNativeModel(next)
    })
    return () => { cancelled = true }
  }, [phase, standaloneClass])

  // Pick a simple selector via the element's token chips (always base state).
  const selectTokens = useCallback((names: string[]) => {
    pendingDefaultRef.current = false
    setSelectedTokens(names)
    setSelectedSelectorText(null)
    setStateKey('')
  }, [])
  // Pick any matched selector (a chip, an override-note jump, or a typed one) as the
  // edit target. Sync the token pick + interaction state so native editing (class +
  // pseudo) still resolves; a complex selector clears the tokens (embed-only) and
  // its rule is created in the selected embed on first edit.
  // Queries typed into the add-selector field that may not exist in an embed yet —
  // kept so they're selectable in the dropdown until the rule is created.
  const [typedContexts, setTypedContexts] = useState<string[]>([])
  // The nesting path from a typed selector (`.hero { @container { .title } }`), so the
  // first edit writes NESTED source into the embed rather than a flat selector.
  const typedPathRef = useRef<{ selector: string; ctx: string; path: NestStep[] } | null>(null)
  const selectActiveSelector = useCallback((text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return
    pendingDefaultRef.current = false
    typedPathRef.current = null // a manual pick cancels a typed nesting path
    setSelectedSelectorText(trimmed)
    const simple = canonicalCompound(trimmed).simple
    const matchedTokens = simple ? selectorToClassTokens(trimmed, tokens) : null
    const standalone = !selectedRef.current ? standaloneNativeClass(trimmed) : null
    setSelectedTokens(matchedTokens ?? (standalone ? [`class:${standalone}`] : []))
    setStateKey(stateForSelector(trimmed))
  }, [tokens])
  // Add a selector typed in the field — supports CSS nesting / a query, e.g.
  // `.hero { .title }`, `.hero { @container (width < 50em) { .title } }`, or
  // `.hero { @container (width < 50em) }`: resolve to the deepest selector + its query
  // context and select it there. A plain selector (no braces) is used as-is.
  const addTypedSelector = useCallback((input: string) => {
    const trimmed = input.trim()
    if (!trimmed) return
    if (trimmed.includes('{')) {
      const parsed = parseNestedInput(trimmed)
      if (parsed) {
        const ctxKey = parsed.atContext.join(' › ')
        if (ctxKey) {
          setTypedContexts((prev) => (prev.includes(ctxKey) ? prev : [...prev, ctxKey]))
          setContext(ctxKey)
        } else {
          setContext('')
        }
        selectActiveSelector(parsed.selector)
        // Remember the path so the first edit writes NESTED source, not a flat rule.
        if (parsed.path.length >= 2) typedPathRef.current = { selector: parsed.selector, ctx: ctxKey, path: parsed.path }
        return
      }
    }
    selectActiveSelector(trimmed)
  }, [selectActiveSelector])
  // Add a custom query (@media/@container/@supports) to the current selector from the
  // query dropdown's "Add query" form. `wrap` registers the query as a context and
  // switches to it — the first edit creates a new `@query { selector { … } }` block;
  // `nest` reuses the typed nesting path so the edit writes `selector { @query { … } }`
  // inside the selector's own rule. A bare `(…)` / condition defaults to `@media`.
  const onAddQuery = (raw: string, mode: 'wrap' | 'nest') => {
    const trimmed = raw.trim()
    if (!trimmed) return
    const query = trimmed.startsWith('@')
      ? trimmed
      : trimmed.startsWith('(') ? `@media ${trimmed}` : `@media (${trimmed})`
    if (mode === 'nest' && activeSelector) {
      const nestedInput = `${activeSelector} { ${query} }`
      addTypedSelector(nestedInput)
      // Scaffold the empty nested query block (`selector { @query {} }`) into the embed
      // now, so the query persists without waiting for the first property.
      const parsed = parseNestedInput(nestedInput)
      if (parsed && parsed.path.length) writeEmptyContext(parsed.path, null)
      return
    }
    typedPathRef.current = null
    setTypedContexts((prev) => (prev.includes(query) ? prev : [...prev, query]))
    setContext(query)
    // Scaffold the empty top-level query block (`@query {}`) into the embed now.
    writeEmptyContext(null, query)
  }
  // Deselect (click the active chip again): no selector is picked, so the panel
  // shows every property's cascade winner read-only. The first edit re-picks a
  // default target (see autoSelectForEdit).
  const deselect = useCallback(() => {
    pendingDefaultRef.current = false
    setSelectedTokens([])
    setSelectedSelectorText(null)
    setStateKey('')
  }, [])

  // A pending "focus this property's input" request — set when you click an override
  // tag, consumed once the newly-picked selector has rendered.
  const [focusProp, setFocusProp] = useState<string | null>(null)
  // Jump the pick to the selector that overrides the current value (e.g. click
  // `.test.is-2` in the override note) so you can edit whatever actually wins, then
  // focus that property's field.
  const onSelectSelector = useCallback((selectorText: string, prop?: string) => {
    selectActiveSelector(selectorText)
    if (prop) setFocusProp(prop)
  }, [selectActiveSelector])
  useEffect(() => {
    if (!focusProp) return
    // Wait a frame so the re-picked selector's fields have rendered, then focus.
    const raf = requestAnimationFrame(() => {
      const el = rootRef.current?.querySelector<HTMLElement>(`[data-prop="${focusProp}"]`)
      el?.focus()
      const field = el as HTMLInputElement | HTMLTextAreaElement | null
      if (field && typeof field.select === 'function') field.select()
      setFocusProp(null)
    })
    return () => cancelAnimationFrame(raf)
  }, [focusProp])
  // Every embed query the picked element could switch to: Base + each
  // @media/@container block in the embeds whose rules match this element.
  const allContextKeys = useMemo<ContextKey[]>(() => {
    const keys: ContextKey[] = ['']
    const seen = new Set<ContextKey>([''])
    if (model) {
      const matchedDocKeys = new Set([...model.base, ...model.conditional].map((m) => m.rule.embedKey))
      for (const [key, doc] of docByKey) {
        if (!matchedDocKeys.has(key)) continue
        for (const region of doc.regions) {
          for (const block of listAtRuleBlocks(region)) {
            const ctx = block.atContext.join(' › ')
            if (!seen.has(ctx)) { seen.add(ctx); keys.push(ctx) }
          }
        }
      }
    }
    // Queries typed into the add-selector field (may not exist in any embed yet).
    for (const ctx of typedContexts) { if (!seen.has(ctx)) { seen.add(ctx); keys.push(ctx) } }
    return keys
  }, [model, docByKey, typedContexts])

  // Suggestions for the "Add query" form: every @media/@container/@supports already
  // used ANYWHERE in the project's embeds (labeled "used"), then a curated set of
  // common queries — deduped (normalized), project ones first.
  const querySuggestions = useMemo<QuerySuggestion[]>(() => {
    const seen = new Set<string>()
    const out: QuerySuggestion[] = []
    const add = (query: string, kind: string) => {
      const norm = query.trim()
      const key = norm.replace(/\s+/g, ' ').toLowerCase()
      if (!norm || seen.has(key)) return
      seen.add(key)
      out.push({ query: norm, kind })
    }
    for (const doc of docByKey.values()) {
      for (const region of doc.regions) {
        for (const block of listAtRuleBlocks(region)) add(block.atContext.join(' › '), 'used')
      }
    }
    for (const c of COMMON_QUERIES) add(c.query, c.kind)
    return out
  }, [docByKey])

  // Embed queries where THIS element actually has styles — so custom @media /
  // @container (and up-breakpoints) only appear in the dropdown when used. The
  // current context is kept so viewing an empty query doesn't hide itself.
  const styledEmbedContexts = useMemo(() => {
    const set = new Set<string>()
    if (model) for (const info of indexContexts(model, allContextKeys)) if (info.hasStyles) set.add(info.key)
    if (context) set.add(context)
    return set
  }, [model, allContextKeys, context])

  // The unified context list: Base + the default Webflow breakpoints (always) +
  // breakpoints/queries the element uses. Drives the dropdown and which breakpoint
  // native reads/writes target.
  const styleContexts = useMemo<StyleContext[]>(() => {
    const list = buildStyleContexts(allContextKeys, nativeModel, currentBreakpoint, styledEmbedContexts)
    // Keep the manually-selected query available on any element — even one with no
    // styles there yet — so switching elements stays on it and you can add a style.
    // Only needed for custom @media/@container (breakpoints are always built).
    const sticky = stickyContextRef.current
    if (context && sticky && sticky.key === context && !list.some((c) => c.key === context)) list.push(sticky)
    return list
  }, [allContextKeys, nativeModel, currentBreakpoint, styledEmbedContexts, context])
  const currentContext = useMemo<StyleContext>(
    () => styleContexts.find((entry) => entry.key === context)
      ?? styleContexts[0]
      ?? { key: '', label: 'Base', breakpoint: 'main', embedAtContext: '' },
    [styleContexts, context],
  )
  // Remember the selected context object so it survives an element switch (the list
  // rebuilds per element; a custom query the new element lacks gets re-injected above).
  useEffect(() => {
    if (currentContext.key === context) stickyContextRef.current = currentContext
  }, [currentContext, context])

  // Which native class style the picked class tokens map to (if any), whether the
  // Native layer is available, and the layer actually in effect (Native falls back
  // to Embed for the tag / attributes / complex selectors that have no class Style).
  const nativeIndex = useMemo(() => selectedNativeIndexFor(nativeModel, selectedTokens), [nativeModel, selectedTokens])
  const nativeAvailable = nativeIndex != null
  // A single class with no class Style yet (e.g. one that exists only as a combo,
  // like `is-2`) can still be edited natively — we create its base class on the
  // first edit. `creatableClass` is that class's display name.
  const creatableClass = useMemo<string | null>(() => {
    if (nativeIndex != null || selectedTokens.length !== 1) return null
    const token = selectedTokens[0]
    return token.startsWith('class:') ? token.slice('class:'.length) : null
  }, [nativeIndex, selectedTokens])
  // …but only when a native styling system exists. Without one (a plain CSS
  // project) every property is authored into the stylesheet instead, or the
  // first edit on an unstyled class would route to a native write that cannot
  // happen and fail silently.
  const canNative = nativeStylingAvailable() && (nativeAvailable || creatableClass != null)

  // Every embed that could style this element, in page/cascade order — later embeds
  // win (their CSS is injected after Webflow's stylesheet and after earlier embeds).
  const embedList = useMemo(
    () => [...docByKey.values()].sort((a, b) => a.source.order - b.source.order),
    [docByKey],
  )

  // The dropdown picks the fallback embed only — Webflow is never a choice. Styles
  // always try to apply natively first; whatever the class can't take natively
  // lands in the selected embed. The user's pick (sourceSel) overrides the default
  // (first embed in page order) and persists across element switches.
  const sourceKeys = useMemo(() => embedList.map((doc) => doc.source.key), [embedList])
  // The source dropdown only picks where NEW styles are created — it does not scope
  // which existing rule is editable. So it just tracks the user's pick, defaulting to
  // the first embed in page order.
  const effectiveSourceSel = sourceSel && sourceKeys.includes(sourceSel) ? sourceSel : (sourceKeys[0] ?? '')
  // Open a component → point the source at that component's own embed; close it →
  // restore the page pick. The switch is in-memory only (persistence stays the page
  // pick). Component embeds stream in after the page tree, so a pending switch waits
  // for the component embed to appear rather than firing once on the transition.
  const inComponentContext = scan?.inComponentContext ?? false
  useEffect(() => {
    const componentSourceKey = embedList.find((doc) => doc.source.fromComponent)?.source.key ?? null
    if (inComponentContext !== prevInCompRef.current) {
      prevInCompRef.current = inComponentContext
      if (inComponentContext) {
        pageSourceRef.current = sourceSelRef.current // stash the page pick to restore on exit
        wantCompSourceRef.current = true
      } else {
        wantCompSourceRef.current = false
        setSourceSel(pageSourceRef.current)
      }
    }
    // Fulfill a pending switch once the open component's embed has loaded.
    if (inComponentContext && wantCompSourceRef.current && componentSourceKey) {
      wantCompSourceRef.current = false
      setSourceSel(componentSourceKey)
    }
  }, [inComponentContext, embedList])
  // Webflow's native style system only supports its own breakpoints (Base/Tablet/…)
  // and interaction states — NOT a custom `@media`/`@container` the user added (those
  // have no `breakpoint`). Editing in a custom query must go to the embed, or the
  // native write silently lands on Base instead of the query.
  const nativeContextOk = currentContext.breakpoint != null
  // Native is the primary layer whenever the selection can carry a class Style AND the
  // context is native-capable; otherwise (tag / attribute / complex selector, or a
  // custom query) the embed is the only target.
  const effectiveSource: SourceKey = canNative && nativeContextOk ? 'native' : 'embed'
  // The chosen embed: always the fallback target, and the editable layer for props
  // the native class doesn't set.
  const selectedEmbedKey = effectiveSourceSel || null
  const selectedNativeIndex = canNative && nativeContextOk ? nativeIndex : null

  // Native contributions for the current context + state, folded into the model.
  const nativeContribs = useMemo(
    () => nativeContribsFor(nativeModel, currentContext, stateKey),
    [nativeModel, currentContext, stateKey],
  )

  const resolved = useMemo(
    () => resolveStyle(
      model ?? EMPTY_RULE_MODEL,
      currentContext.embedAtContext ?? ' native-only',
      activeSelector,
      {
        source: effectiveSource,
        contribs: nativeContribs,
        selectedIndex: selectedNativeIndex,
        selectedEmbedKey,
        currentTier: currentContext.breakpoint ? breakpointTier(currentContext.breakpoint) : undefined,
      },
    ),
    [model, currentContext, activeSelector, effectiveSource, nativeContribs, selectedNativeIndex, selectedEmbedKey],
  )

  // The stylesheet the active selector's rule already lives in. resolveStyle
  // picks selectedRule by selector identity and explicitly does NOT scope it to
  // the source dropdown, so reading it here can't feed back into itself.
  const homeEmbedKey = resolved.selectedRule?.embedKey ?? null

  // Selecting an element points "Add custom styles in" at the file that already
  // defines its selector, so a new declaration joins the rule that's there
  // instead of landing in whichever stylesheet happens to be first in page
  // order. An explicit pick still wins: the effect only re-runs when the element
  // or the selector's home changes, not on every render. Left alone inside a
  // component, where the source is pinned to that component's own embed.
  useEffect(() => {
    if (!homeEmbedKey || inComponentContext) return
    setSourceSel((prev) => (prev === homeEmbedKey ? prev : homeEmbedKey))
  }, [elementIdentity, activeSelector, homeEmbedKey, inComponentContext])

  // Every selector (with styles) that targets this element in the current context —
  // the element's own classes, stateful, and complex/ancestor selectors — for the
  // chip picker. Include the active selector even when it has no rule yet (a fresh
  // pick/typed one) so it shows as selected while you add its first property.
  const selectorChips = useMemo<MatchedSelector[]>(() => {
    // Show EVERY selector that styles this element in any query. The picker dims the
    // ones not styled in the current query (inContext === false) rather than hiding
    // them — so switching queries keeps the full list visible instead of dropping
    // selectors that only have styles elsewhere.
    const ownTokens = new Set(tokens.map((t) => t.name))
    const list = styledSelectorsFor(model, nativeModel, currentContext)
    // Show the active selector as a pending (dashed/outlined) chip while it has no rule
    // yet, so a freshly typed/picked selector stays visible until its first property
    // lands (then it becomes a solid styled chip). We show it for a complex/typed
    // selector always, and for the element's OWN classes only when the user explicitly
    // typed or picked one (`selectedSelectorText` set) — the AUTO-composed default
    // (`.card`, `div`) stays hidden since its token chip already indicates the pick.
    // Switching elements/selectors clears `selectedSelectorText` + the active selector,
    // so the pending chip disappears on its own when you move on without adding styles.
    if (activeSelector && !list.some((s) => selectorsMatch(s.text, activeSelector))) {
      const canon = canonicalCompound(activeSelector)
      const own = canon.simple && canon.tokens.every((tok) => ownTokens.has(tok))
      if (!own || selectedSelectorText != null) {
        list.push({ text: activeSelector, specificity: [0, 0, 0], state: stateForSelector(activeSelector), simple: canon.simple, key: `active:${activeSelector}`, pending: true, inContext: true })
      }
    }
    // Order for readability: tag → base class + pseudos → applied combo chain + pseudos
    // → standalone/global classes → data attributes → complex selectors.
    const classList = snapshot?.classList ?? []
    return list
      .map((s) => ({ s, rank: selectorOrder(s.text, classList) }))
      .sort((a, b) =>
        a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] ||
        compareSpecificity(a.s.specificity, b.s.specificity) ||
        (a.s.order != null && b.s.order != null ? a.s.order - b.s.order : 0) ||
        a.s.text.localeCompare(b.s.text))
      .map((entry) => {
        const s = entry.s
        // In a query context, show the display with an `@` at the query position;
        // on Base / other contexts show the plain nested display.
        const inQuery = !!currentContext.embedAtContext && s.inContext !== false && !!s.queryDisplay
        return inQuery ? { ...s, display: s.queryDisplay } : s
      })
  }, [model, nativeModel, currentContext, activeSelector, selectedSelectorText, tokens, snapshot])

  // Per-context dropdown info: embed hasStyles/combos (for the dot + auto-highlight)
  // plus whether the breakpoint carries native values.
  const contextInfos = useMemo<ContextInfo[]>(() => {
    const projectedModel = model ?? EMPTY_RULE_MODEL
    const embedKeys = [...new Set(styleContexts.map((c) => c.embedAtContext).filter((k): k is string => k != null))]
    const embedByKey = new Map(indexContexts(projectedModel, embedKeys).map((info) => [info.key, info]))
    return styleContexts.map((sc) => {
      const embed = sc.embedAtContext != null ? embedByKey.get(sc.embedAtContext) : undefined
      const nativeHas = sc.breakpoint ? nativeHasValues(nativeModel, sc.breakpoint) : false
      return {
        key: sc.key,
        hasStyles: (embed?.hasStyles ?? false) || nativeHas,
        styledCombos: embed?.styledCombos ?? [],
        bestTokens: embed?.bestTokens ?? null,
      }
    })
  }, [model, styleContexts, nativeModel])

  // Switching context auto-selects a selector that has styles in the new query:
  // keep the current pick if it's styled there, otherwise jump to the strongest.
  const onContextChange = useCallback((next: ContextKey) => {
    pendingDefaultRef.current = false
    setContext(next)
    const nextContext = styleContexts.find((entry) => entry.key === next)
    if (!nextContext || !model) return
    // Only selectors with styles IN this context (drop the dimmed other-context ones).
    const styled = styledSelectorsFor(model, nativeModel, nextContext).filter((s) => s.inContext !== false)
    if (!styled.length) return
    if (activeSelector && styled.some((s) => selectorsMatch(s.text, activeSelector))) return
    selectActiveSelector(styled[styled.length - 1].text)
  }, [styleContexts, model, nativeModel, activeSelector, selectActiveSelector])

  // On selecting a new element, upgrade the raw all-classes default to the strongest
  // selector actually STYLED in the current context — so if `.media_card_title` is
  // styled in `@container (…)` but the full combo isn't, we land on `.media_card_title`.
  // Runs once the model is ready for the new element; skips if you already picked.
  useEffect(() => {
    if (!pendingDefaultRef.current || !model) return
    // Wait until nativeModel is the CURRENT element's — it loads via a separate async
    // effect and lags the embed model on a switch. Defaulting off a stale nativeModel
    // would pick the previous element's native selectors (and clobber pendingDefaultRef),
    // leaving that selector stuck as a pending chip. Re-runs when nativeModel catches up.
    if (nativeIdentityRef.current !== elementIdentity) return
    const cur = styleContexts.find((entry) => entry.key === context)
    if (!cur) return
    const styled = styledSelectorsFor(model, nativeModel, cur).filter((s) => s.inContext !== false)
    // Nothing styled yet — likely mid-scan (embeds still streaming). Leave the default
    // armed so we retry as they arrive, instead of committing to the unstyled combo.
    if (!styled.length) return
    pendingDefaultRef.current = false
    // Use the FRESH default the effect just set (not `activeSelector`, which is still
    // the previous element's here). Keep it if it's already styled, else pick the strongest.
    const defaultSel = tokensToSelector(defaultTokensRef.current, tokens)
    if (defaultSel && styled.some((s) => selectorsMatch(s.text, defaultSel))) return
    // Fall back to the FIRST applied class that has styles (the primary block class in
    // Lumos) rather than styled[last] — utility classes (u-*) sort last by name and
    // shouldn't win the default just because their specificity ties the base class.
    const primaryStyled = defaultTokensRef.current
      .flatMap((tok) => {
        const found = styled.find((s) => selectorsMatch(s.text, tokensToSelector([tok], tokens)))
        return found ? [found] : []
      })[0]
    // Otherwise the FIRST selector in chip display order after the tag — the element's
    // own class/nesting selector (`.hero_component > .hero_paragraph`), not the highest-
    // specificity one (a foreign `:not(…) > :is(…)` shouldn't win the default).
    const classList = snapshot?.classList ?? []
    const inChipOrder = [...styled]
      .map((s) => ({ s, rank: selectorOrder(s.text, classList) }))
      .sort((a, b) =>
        a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2] ||
        compareSpecificity(a.s.specificity, b.s.specificity) || a.s.text.localeCompare(b.s.text))
      .map((e) => e.s)
    const firstAfterTag = inChipOrder.find((s) => selectorOrder(s.text, classList)[0] > 0)
    selectActiveSelector((primaryStyled ?? firstAfterTag ?? inChipOrder[0] ?? styled[styled.length - 1]).text)
  }, [model, nativeModel, context, styleContexts, tokens, elementIdentity, snapshot, selectActiveSelector])

  // ── Native (Webflow class style) writes ──
  const refreshNative = useCallback(async () => {
    const el = selectedRef.current
    if (!el) {
      const className = standaloneNativeClass(activeSelectorRef.current)
      if (!className) return
      const next = await readNativeStyleByName(className, STATES)
      nativeModelRef.current = next
      nativeIdentityRef.current = `standalone:${className}`
      setNativeModel(next)
      return
    }
    nativeModelCache.clear() // a class edit can change any element that uses it
    const identity = await resolveIdentityElement(el as never)
    const model = await readNativeStyles(identity, STATES)
    nativeModelRef.current = model
    setNativeModel(model)
  }, [])

  // Sync back edits made in the Designer itself — adding/removing a class, changing
  // a value in Webflow's native style panel, or editing another embed. Webflow fires
  // no event for these, so re-read the current selection whenever the panel regains
  // focus (the user returns to it after acting on the canvas / native panel). refresh
  // re-reads the element's classes + embeds (class changes flow through to the native
  // read via elementIdentity); refreshNative catches native value edits that leave the
  // class set unchanged.
  useEffect(() => {
    const api = webflowApi()
    if (!api?.getSelectedElement) return
    let timer: number | null = null
    const resync = () => {
      // Don't fight an in-progress write or an active edit inside the panel.
      if (busyRef.current) return
      const active = document.activeElement as HTMLElement | null
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
      if (timer != null) return
      timer = window.setTimeout(() => {
        timer = null
        void api.getSelectedElement?.().then((el) => {
          if (!el || busyRef.current) return
          void refresh(el)
          void refreshNative()
        })
      }, 150)
    }
    const onVisible = () => { if (!document.hidden) resync() }
    window.addEventListener('focus', resync)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer != null) window.clearTimeout(timer)
      window.removeEventListener('focus', resync)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [refresh, refreshNative])
  // Serialize native writes. Each write does read-handle → setProperties → commit →
  // refresh; `busy` clears before the refresh finishes, so a rapid second edit (e.g.
  // overflow-x then overflow-y) could overlap the first and clobber it via racing
  // setStyles commits. Chaining every op guarantees strict ordering.
  const nativeOpChain = useRef<Promise<unknown>>(Promise.resolve())
  const runNativeOp = useCallback(<T,>(op: () => Promise<T>): Promise<T> => {
    const next = nativeOpChain.current.then(op, op)
    nativeOpChain.current = next.catch(() => {})
    return next
  }, [])
  // Build the write target for the native style at `index`: applied combos write
  // by their getStyles position; standalone (attribute-only) classes have no such
  // position, so they resolve by name via getStyleByName.
  const nativeWriteTargetAt = useCallback((index: number): NativeWriteTarget => {
    const style = nativeModelRef.current?.styles[index]
    return { namePath: style?.namePath ?? [], index: style && style.applied ? index : null }
  }, [])
  const nativeClearAt = useCallback((index: number, props: string[], options?: NativeStyleOptions) =>
    runNativeOp(async () => {
      let ok = true
      try {
        setBusyBoth(true)
        setStatus('Saving…')
        const res = await removeNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), props, options)
        ok = res.ok
      } finally {
        setBusyBoth(false)
      }
      await refreshNative()
      setStatus(ok ? 'Removed from the Webflow class style.' : 'Couldn’t remove from the Webflow class style.')
    }), [refreshNative, setBusyBoth, nativeWriteTargetAt, runNativeOp])
  // Live scrub: Webflow updates the canvas itself; skip the model refresh (blur commits).
  const nativeLiveSet = useCallback((handle: unknown, prop: string, value: string, options?: NativeStyleOptions) => {
    // Serialize live writes through the native op chain (like commits do). Firing
    // several setProperty calls on one style in a single tick — the four linked
    // border-radius corners, or linked gap's row/column longhands — races inside
    // Webflow's API and only the last sticks; chaining applies each in order.
    void runNativeOp(async () => { await liveSetNativeProperty(handle, prop, value, options) })
  }, [runNativeOp])

  // Writes target the picked selector's rule in the current context/state, and
  // create that rule on the first edit when it doesn't exist yet.
  const selectedRule = resolved?.selectedRule ?? null
  const createSelectedRule = (prop: string, value: string, important: boolean, selectorOverride?: string) => {
    // A Webflow-breakpoint context with no equivalent embed query yet writes into a
    // synthesized @media block; otherwise the embed's base or existing query block.
    const embedCtx = currentContext.embedAtContext
    const bpMedia = embedCtx == null && currentContext.breakpoint && currentContext.breakpoint !== 'main'
      ? mediaParamsForBreakpoint(currentContext.breakpoint)
      : null
    // Write into the chosen embed when one is selected; otherwise the embed of a
    // matching rule in this context (or the first embed). The region is the anchor
    // rule's block when it lives in the target doc, else that doc's first block.
    const matched = model ? [...model.base, ...model.conditional].map((entry) => entry.rule) : []
    const inCtx = (rule: ParsedRule) => contextKeyOf(rule) === (embedCtx ?? '')
    const anchor = selectedEmbedKey
      ? (matched.find((rule) => rule.embedKey === selectedEmbedKey && inCtx(rule))
          ?? matched.find((rule) => rule.embedKey === selectedEmbedKey))
      : (matched.find(inCtx) ?? matched[0])
    const doc = selectedEmbedKey
      ? docByKey.get(selectedEmbedKey)
      : (anchor ? docByKey.get(anchor.embedKey) : [...docByKey.values()][0])
    const region = anchor && doc && anchor.embedKey === doc.source.key
      ? doc.regions[anchor.regionIndex]
      : doc?.regions[0]
    if (!doc || !region) { setStatus('No embed here to write to — add an HTML embed first.'); return }
    const fullSelector = selectorOverride ?? activeSelector
    void (async () => {
      setBusyBoth(true)
      setStatus('Saving…')
      // try/finally so `busy` always clears even if creating the rule / writing throws
      // (a stuck busy would disable every button in the panel).
      try {
      let ok: boolean
      const typed = typedPathRef.current
      if (typed && typed.selector === fullSelector && typed.ctx === (embedCtx ?? '')) {
        // Typed nested syntax → write real nested source into the embed.
        ok = createNestedRule(region, typed.path, prop, value, important)
        typedPathRef.current = null
      } else if (bpMedia) {
        ok = createRuleInMedia(region, bpMedia, fullSelector, prop, value, important)
      } else if (!embedCtx) {
        ok = createRuleAtRoot(region, fullSelector, prop, value, important)
      } else {
        const block = listAtRuleBlocks(region).find((b) => b.atContext.join(' › ') === embedCtx)
        ok = block
          ? createRuleInAtRule(block.node, fullSelector, prop, value, important)
          : createRuleInQuery(region, embedCtx, fullSelector, prop, value, important)
      }
      if (!ok) { setStatus('Nothing to save.'); return }
      const res = await writeEmbedDoc(doc)
      await refreshDerived()
      if (!res.ok) {
        if (inComponentRef.current && !doc.source.fromComponent) {
          markPending(doc.source.key)
          setStatus('Kept as unsaved — page embeds save when you exit the component.')
          return
        }
        setSaveError(res.error)
        return
      }
      clearPending(doc.source.key)
      setStatus(`Added ${fullSelector}.`)
      } finally {
        setBusyBoth(false)
      }
    })()
  }
  // Add a just-typed query to the embed IMMEDIATELY as an empty block, so it persists and
  // reads back as a real context without waiting for the first property. `ctxKey` (wrap)
  // scaffolds a top-level `@query {}`; `path` (nest) scaffolds `selector { @query {} }`.
  // Targets the same embed createSelectedRule would; if there's no embed to write into
  // yet, it no-ops and the query stays a pending local context until the first edit.
  const writeEmptyContext = (path: NestStep[] | null, ctxKey: string | null) => {
    const matched = model ? [...model.base, ...model.conditional].map((entry) => entry.rule) : []
    const anchor = selectedEmbedKey
      ? matched.find((rule) => rule.embedKey === selectedEmbedKey)
      : matched[0]
    const doc = selectedEmbedKey
      ? docByKey.get(selectedEmbedKey)
      : (anchor ? docByKey.get(anchor.embedKey) : [...docByKey.values()][0])
    const region = anchor && doc && anchor.embedKey === doc.source.key
      ? doc.regions[anchor.regionIndex]
      : doc?.regions[0]
    if (!doc || !region) return // no embed here yet — keep it as a pending local context
    void (async () => {
      setBusyBoth(true)
      setStatus('Adding query…')
      // try/finally so a throw while scaffolding the query block can't leave `busy` stuck
      // true — that would wrongly disable every add button (transforms, shadows, …).
      try {
        const ok = path ? ensureNestPath(region, path) : ctxKey ? ensureQueryBlock(region, ctxKey) : false
        if (!ok) { setStatus('Couldn’t add the query.'); return }
        await refreshDerived()
        const res = await writeEmbedDoc(doc)
        if (!res.ok) {
          if (inComponentRef.current && !doc.source.fromComponent) {
            markPending(doc.source.key)
            setStatus('Kept as unsaved — page embeds save when you exit the component.')
            return
          }
          setSaveError(res.error)
          return
        }
        clearPending(doc.source.key)
        setStatus('Query added.')
      } finally {
        setBusyBoth(false)
      }
    })()
  }
  // Write a property to the embed for the picked selector — its existing rule, or a
  // new one. Also the fallback target when a native value won't apply.
  const writeEmbedProp = (prop: string, value: string, important: boolean) => {
    if (selectedRule) onSetProp(selectedRule, prop, value, important)
    else createSelectedRule(prop, value, important)
  }

  // Native edits go to the picked class style. Webflow accepts nearly any
  // property/value (storing unsupported ones as custom properties), so "regular"
  // and "custom property" are one call; we verify it actually applied and, if not,
  // move the property to custom code (an embed) — the try-native-else-custom-code chain.
  const nativeHandle = () => (nativeModel && selectedNativeIndex != null ? nativeModel.styles[selectedNativeIndex].style : null)
  // Where a property's edit goes: the layer that currently holds its editable
  // value (native when the class sets it, the picked embed when it fell back);
  // a brand-new property defaults to native-first when the selection allows it.
  const propLayer = (prop: string): SourceKey => {
    // Transitions have no native Designer API — always write them to the embed.
    if (EMBED_ONLY_PROPS.has(prop)) return 'embed'
    // A custom query can't be written natively — always target the embed there.
    if (!nativeContextOk) return 'embed'
    const r = resolved?.props.get(prop)
    if (r?.source === 'selected' && r.selectedOrigin) return r.selectedOrigin
    return canNative ? 'native' : 'embed'
  }
  const nativeSetOrFallback = (index: number, prop: string, value: string, important: boolean) => {
    void runNativeOp(async () => {
      let applied = false
      let reason = ''
      setNativeFallback(null) // clear any prior fallback notice as this edit begins
      try {
        setBusyBoth(true)
        setStatus('Saving…')
        const res = await applyNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), prop, value, optionsFor(currentContext, stateKey))
        applied = res.applied
        reason = res.error ?? ''
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
      } finally {
        // The busy flag disables every control — it must always clear, even if the
        // Designer call hangs or throws, or the panel freezes.
        setBusyBoth(false)
      }
      if (applied) { await refreshNative(); setStatus('Saved to Webflow class style.'); return }
      // The failed native write may have left a COERCED value on the class — Webflow
      // stores an unparseable calc()/function as `0` rather than nothing — which would
      // shadow the embed value we're about to write (e.g. width stuck at 0px). Clear it
      // first so only the embed declaration applies. Best-effort: a no-op when Webflow
      // stored nothing (the common drop case).
      try {
        setBusyBoth(true)
        await removeNativePropertyAt(selectedRef.current, nativeWriteTargetAt(index), [prop], optionsFor(currentContext, stateKey))
      } catch { /* best-effort cleanup */ } finally {
        setBusyBoth(false)
      }
      setStatus(`Couldn’t set ${prop} as a Webflow style${reason ? ` (${reason})` : ''} — moving it to an embed.`)
      // The status line isn't rendered, so surface the reason inline — otherwise the
      // fall-through to an embed is invisible and looks like "it always writes code".
      setNativeFallback(`Webflow wouldn’t apply ${prop} to this class natively${reason ? ` (${reason})` : ''} — saved it to the embed instead.`)
      writeEmbedProp(prop, value, important)
    })
  }
  // First edit on a class that has no base Style yet: create the base class in
  // Webflow, write the property, then refresh (subsequent edits use the normal
  // native path once the style resolves). Falls back to an embed if creation fails.
  const nativeCreateAndSet = (className: string, prop: string, value: string, important: boolean) => {
    void runNativeOp(async () => {
      let applied = false
      let created = false
      let reason = ''
      setNativeFallback(null)
      try {
        setBusyBoth(true)
        setStatus('Creating Webflow class…')
        const res = await applyNativeToNewBaseClass(selectedRef.current, className, prop, value, optionsFor(currentContext, stateKey))
        applied = res.applied
        created = res.applied
        reason = res.error ?? ''
        // The class already exists — almost always because the edit landed before the
        // native scan finished, so we didn't yet know `.className` was a real Webflow
        // class (nativeIndex was null → it looked creatable). Recover by re-reading and
        // writing to the existing base class instead of wrongly spilling into an embed.
        if (!applied && /duplicate/i.test(reason)) {
          await refreshNative()
          const idx = nativeModelRef.current?.styles.findIndex(
            (s) => !s.isCombo && s.namePath.length === 1 && s.className === className) ?? -1
          if (idx >= 0) {
            const retry = await applyNativePropertyAt(selectedRef.current, nativeWriteTargetAt(idx), prop, value, optionsFor(currentContext, stateKey))
            applied = retry.applied
            created = false
            reason = retry.error ?? ''
          }
        }
      } catch (error) {
        reason = error instanceof Error ? error.message : String(error)
      } finally {
        setBusyBoth(false)
      }
      if (applied) {
        await refreshNative()
        setStatus(created ? `Created Webflow class .${className}.` : 'Saved to Webflow class style.')
        return
      }
      setStatus(`Couldn’t create .${className} as a Webflow class${reason ? ` (${reason})` : ''} — moving it to an embed.`)
      setNativeFallback(`Webflow wouldn’t create .${className} as a class${reason ? ` (${reason})` : ''} — saved it to the embed instead.`)
      writeEmbedProp(prop, value, important)
    })
  }
  // First edit with no chip selected: pick a default target — the element's first
  // applied Webflow class (edit it natively), else its tag (edit it in an embed) —
  // select it for the UI and return the route to write THIS edit to (state won't
  // update in time). null → nothing to style.
  const autoSelectForEdit = (): { native: number } | { embedSelector: string } | null => {
    const model = nativeModelRef.current
    const base = model?.styles.find((style) => style.applied)
    if (base) {
      selectActiveSelector(`.${base.className}`)
      return { native: model!.styles.indexOf(base) }
    }
    const tag = snapshot?.tag
    if (tag) {
      selectActiveSelector(tag)
      return { embedSelector: tag }
    }
    return null
  }
  const setProp = (prop: string, value: string, important: boolean) => {
    // Webflow's native API rejects hsl()/hsla() — normalize every write to rgb/rgba.
    value = hslaToRgba(value)
    // A commit is the new baseline: whatever a live write overwrote on the way here is
    // no longer what "revert" should restore.
    liveOriginRef.current.delete(prop)
    if (!activeSelector) {
      const route = autoSelectForEdit()
      if (route && 'native' in route) { nativeSetOrFallback(route.native, prop, value, important); return }
      if (route && 'embedSelector' in route) { createSelectedRule(prop, value, important, route.embedSelector); return }
      setStatus('Nothing to style here — add a class in Webflow first.')
      return
    }
    if (propLayer(prop) === 'native') {
      if (selectedNativeIndex != null) { nativeSetOrFallback(selectedNativeIndex, prop, value, important); return }
      if (creatableClass) { nativeCreateAndSet(creatableClass, prop, value, important); return }
    }
    writeEmbedProp(prop, value, important)
  }
  const clearProp = (prop: string | string[]) => {
    const props = Array.isArray(prop) ? prop : [prop]
    props.forEach((p) => liveOriginRef.current.delete(p)) // clearing is a commit too
    const nativeProps = props.filter((p) => propLayer(p) === 'native')
    const embedProps = props.filter((p) => propLayer(p) === 'embed')
    if (nativeProps.length && selectedNativeIndex != null) {
      void nativeClearAt(selectedNativeIndex, nativeProps, optionsFor(currentContext, stateKey))
    }
    if (embedProps.length && selectedRule) onClearProp(selectedRule, embedProps)
  }
  // Abandon the live writes for `prop` and put back what they overwrote — the dropdown
  // hover-scrub's counterpart to liveSetProp (closing the list without picking).
  const revertProp = (prop: string) => {
    if (propLayer(prop) === 'native' || !selectedRule) return
    onRevertProp(selectedRule, prop)
  }
  const liveSetProp = (prop: string, value: string | null, important: boolean) => {
    // `null` = abandon this property's live writes and put back what they overwrote —
    // the hover-scrub's counterpart (a dropdown closed without picking, a field's edit
    // cancelled). Nothing to undo if no live write happened.
    if (value === null) { revertProp(prop); return }
    // Normalize hsl()/hsla() → rgb/rgba first (Webflow's native API rejects hsl*).
    value = hslaToRgba(value)
    // Don't push half-typed / invalid values live: Webflow's native API errors on
    // them and gets stuck. Keep the last valid value applied until a complete valid
    // one is typed; the blur commit still runs authoritatively.
    if (!isSupportedCssValue(prop, value)) return
    if (!activeSelector) {
      // Select the default target so the blur commit + later edits land on it; live-
      // preview natively when it's a class (an embed rule doesn't exist yet to scrub).
      const route = autoSelectForEdit()
      if (route && 'native' in route) {
        const handle = nativeModelRef.current?.styles[route.native]?.style
        if (handle) nativeLiveSet(handle, prop, value, optionsFor(currentContext, stateKey))
      }
      return
    }
    if (propLayer(prop) === 'native') {
      const handle = nativeHandle()
      if (handle) { nativeLiveSet(handle, prop, value, optionsFor(currentContext, stateKey)); return }
    }
    if (selectedRule) onLiveSetProp(selectedRule, prop, value, important)
  }

  // The name to badge when editing a native class style.
  const nativeStyleName = effectiveSource === 'native'
    ? (selectedNativeIndex != null && nativeModel
        ? (nativeModel.styles[selectedNativeIndex].displayName || nativeModel.styles[selectedNativeIndex].className)
        : creatableClass)
    : null
  const sourceNote: string | null = null

  // Which embeds carry a rule for this element in the current context (dropdown dot).
  const embedsWithRules = useMemo(() => {
    const set = new Set<string>()
    if (!model || currentContext.embedAtContext == null) return set
    for (const m of [...model.base, ...model.conditional]) {
      if (contextKeyOf(m.rule) === currentContext.embedAtContext) set.add(m.rule.embedKey)
    }
    return set
  }, [model, currentContext])

  // The source dropdown: every embed in page order (later embeds win the cascade).
  // Webflow isn't a choice — styles apply natively first and fall back to the
  // picked embed. This just chooses which embed catches that fallback. Page-level
  // embeds lead; component embeds are grouped under a component subheader so it's
  // clear which embeds belong to which component.
  const sourceOptions = useMemo<SourceOption[]>(() => {
    const embedOpt = (doc: EmbedDoc, indent = false): SourceOption => ({
      value: doc.source.key,
      label: doc.source.label,
      marked: embedsWithRules.has(doc.source.key),
      fromComponent: doc.source.fromComponent,
      indent,
    })
    const opts: SourceOption[] = []
    for (const doc of embedList) if (!doc.source.fromComponent) opts.push(embedOpt(doc))
    const byComponent = new Map<string, EmbedDoc[]>()
    for (const doc of embedList) {
      if (!doc.source.fromComponent) continue
      const name = doc.source.componentName ?? 'Component'
      byComponent.set(name, [...(byComponent.get(name) ?? []), doc])
    }
    for (const [name, docs] of byComponent) {
      opts.push({ value: `__component__${name}`, label: name, heading: true })
      docs.forEach((doc, i) => {
        // List row: group-scoped "Embed #1"; closed trigger: full "Global Styles #1".
        const triggerName = docs.length > 1 ? `${name} #${i + 1}` : name
        opts.push({
          ...embedOpt(doc, true),
          triggerLabel: `${triggerName}${embedSourceClassSuffix(doc.source)}`,
        })
      })
    }
    return opts
  }, [embedList, embedsWithRules])

  // The full embed label per key (e.g. "Global Styles #1" for a component embed),
  // matching the source dropdown's trigger — used by provenance chips.
  const embedLabelByKey = useMemo(() => {
    const map = new Map<string, string>()
    for (const opt of sourceOptions) {
      if (opt.heading) continue
      map.set(opt.value, opt.triggerLabel ?? opt.label)
    }
    return map
  }, [sourceOptions])

  // Provided to every ProvenanceList so its embed chips can name (full label) and
  // navigate to the source embed on the canvas.
  const embedNav = useMemo(
    () => ({ open: openEmbedByKey, labelFor: (key: string) => embedLabelByKey.get(key) ?? key }),
    [openEmbedByKey, embedLabelByKey],
  )

  const nativeHasAny = (nativeModel?.styles.some((style) => style.propsByContext.size > 0)) ?? false

  return (
    <ProvenanceEmbedNav.Provider value={embedNav}>
    <div className="embed-editor_root" ref={rootRef}>
      {/* Save/context state lives in the header (spinner / check / error /
          in-component warning) — hover the header icon for details, no body text. */}
      <SaveIndicator
        busy={busy}
        error={saveError}
        pending={
          pendingKeys.size
            ? `${pendingKeys.size} change${pendingKeys.size === 1 ? '' : 's'} save when you exit the component`
            : null
        }
      />

      {pendingKeys.size ? (
        <p className="embed-editor_pending-note">
          {pendingKeys.size} unsaved page-embed change{pendingKeys.size === 1 ? '' : 's'} — will save when you exit the component.
        </p>
      ) : null}

      {nativeFallback ? (
        <p className="embed-editor_fallback-note" role="status">
          {nativeFallback}
          <button type="button" className="embed-editor_fallback-dismiss" aria-label="Dismiss" onClick={() => setNativeFallback(null)}>✕</button>
        </p>
      ) : null}

      {/* The panel is always usable once Webflow responds, including when no canvas
          element is selected. Embeds and native class values fill in as they load. */}
      {phase === 'scanning' || phase === 'ready' || phase === 'no-selection' ? (
        <section className="embed-editor_section">
          <div className="embed-editor_list">
            <StyleCard
              snapshot={snapshot}
              selectedNames={selectedTokens}
              selectedSelector={activeSelector}
              activePicked={selectedSelectorText != null}
              onSelectNames={selectTokens}
              resolved={resolved ?? EMPTY_RESOLVED}
              contexts={styleContexts}
              contextInfos={contextInfos}
              context={context}
              onContext={onContextChange}
              onAddQuery={onAddQuery}
              querySuggestions={querySuggestions}
              selectors={selectorChips}
              suggestions={selectorSuggestions}
              activeSelector={activeSelector}
              onSelectActive={selectActiveSelector}
              onDeselect={deselect}
              onAddSelector={addTypedSelector}
              sourceValue={effectiveSourceSel}
              sourceOptions={sourceOptions}
              onSourceChange={(value) => { setSourceSel(value); saveEmbedSource(value) }}
              sourceNote={sourceNote}
              nativeStyleName={nativeStyleName}
              loading={phase === 'scanning' || scanningMore}
              busy={busy}
              pending={selectedRule ? pendingKeys.has(selectedRule.embedKey) : false}
              setProp={setProp}
              clearProp={clearProp}
              liveSetProp={liveSetProp}
              onSelectSelector={onSelectSelector}
              onAdd={setProp}
              rawOpen={selectedRule != null && rawRuleId === selectedRule.ruleId}
              onToggleRaw={() => selectedRule && toggleRaw(selectedRule.ruleId)}
              onSaveRaw={onSaveRaw}
              onRemoveRule={onRemoveRule}
            />
          </div>
        </section>
      ) : null}

      {phase === 'ready' && !scanningMore && model && model.matchedRuleCount === 0 && !nativeHasAny ? (
        <div className="embed-editor_empty">
          {scan?.embedCount
            ? `Scanned ${scan.embedCount} embed${scan.embedCount === 1 ? '' : 's'}${scan.componentEmbedCount ? ` (${scan.componentEmbedCount} in components)` : ''}, but none target this element.`
            : 'No HTML embeds with <style> blocks were found on this page.'}
        </div>
      ) : null}
    </div>
    </ProvenanceEmbedNav.Provider>
  )
}
