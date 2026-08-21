import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { panelBounds } from '../lib/panel-box'
import { endDragNotes, hoverNote } from '../../ui/sound.js'

export type SelectOption<T extends string> = {
  value: T
  /** Plain-text label — also used for type-ahead matching. */
  label: string
  /** Optional leading icon (e.g. a preset glyph). */
  icon?: ReactNode
  /** Show a trailing status dot (white on the selected row, accent otherwise). */
  marked?: boolean
  /** Render as a non-selectable group subheader — skipped by keyboard nav,
   *  type-ahead, and selection. Its `value` just needs to be unique. */
  heading?: boolean
  /** Indent the option to show it nests under the preceding heading. */
  indent?: boolean
  /** Text for the closed trigger when this option is selected — use when the
   *  list label is context-scoped (e.g. "Embed #1" under a group) but the trigger
   *  needs the full name ("Global Styles #1"). Falls back to `label`. */
  triggerLabel?: string
  /** Icon for the closed trigger when this option is selected. Falls back to
   *  `icon` — use when the trigger icon differs from the list-row icon. */
  triggerIcon?: ReactNode
  /** Opaque tone token exposed on the trigger as `data-tone` when this option is
   *  selected, so the consumer can color the trigger per option (via its CSS). */
  tone?: string
  /** A control on the row itself — an edit pencil, say. Pressing it closes the
   *  menu and runs `onSelect` WITHOUT choosing the option: it acts on the option
   *  rather than picking it. Shown on the hovered/active row only. */
  action?: { icon: ReactNode; label: string; onSelect: () => void }
}

type Props<T extends string> = {
  value: T
  onChange: (value: T) => void
  options: SelectOption<T>[]
  ariaLabel?: string
  /** id of an external element that labels this control (aria-labelledby). */
  labelId?: string
  className?: string
  disabled?: boolean
  id?: string
  /** When provided, the trigger renders this editable field in place of the
   *  value label; the chevron still opens the option list. Turns the closed
   *  control into an input+arrow chip (mirroring the Display control's custom
   *  mode). The field owns its own value/commit logic. */
  customInput?: ReactNode
  /** 'default' renders the pill trigger; 'link' renders a compact text-link
   *  trigger (label + small chevron, no fill) that still opens the same list. */
  variant?: 'default' | 'link'
  /** Show a filter input pinned to the top of the open list — matches option
   *  labels (substring, case-insensitive) and keeps a group heading only when one
   *  of its options matches. Arrow/Enter/Escape still drive the list while typing. */
  searchable?: boolean
  /** Placeholder for the search input (searchable only). */
  searchPlaceholder?: string
  /** Render the closed trigger with its label only, even when the selected option
   *  has an icon (the icons still show in the open list). */
  hideTriggerIcon?: boolean
  /** Live-preview the highlighted option while the list is open (Webflow's hover
   *  scrub): called with a value as the pointer / arrow keys land on it, and with
   *  `null` when the list closes WITHOUT a pick — meaning put the original back.
   *  Highlighting the already-selected row re-emits its value, so scrubbing back
   *  over it restores what was there. A pick fires `onChange` instead, and never a
   *  trailing `null`: the commit is the value. */
  onPreview?: (value: T | null) => void
}

/**
 * Custom listbox dropdown modeled on the clip-path preset picker: a pill button
 * showing the current value (optional icon + label + chevron) that opens a
 * floating, rounded option list. Full keyboard support (arrows / Home / End /
 * Enter / Escape / Tab / type-ahead), click-outside to close, and auto flip-up
 * when there isn't room below. Reusable across tools. Optionally searchable.
 */
export default function Select<T extends string>({
  value,
  onChange,
  options,
  ariaLabel,
  labelId,
  className,
  disabled,
  id,
  customInput,
  variant = 'default',
  searchable = false,
  searchPlaceholder = 'Search…',
  hideTriggerIcon = false,
  onPreview,
}: Props<T>) {
  const baseId = useId()
  const rootRef = useRef<HTMLDivElement>(null)
  const buttonRef = useRef<HTMLButtonElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const typeahead = useRef('')
  const typeaheadTimer = useRef<number | null>(null)

  const [open, setOpen] = useState(false)
  const [dropUp, setDropUp] = useState(false)
  // Distinguishes the open transition from in-list navigation (drives the one-time
  // "scroll the selected option near the top" on open).
  const wasOpenRef = useRef(false)
  const [query, setQuery] = useState('')

  // The trigger always reflects the real selected value, independent of any filter.
  const selectedOption = useMemo(
    () => options.find((option) => !option.heading && option.value === value) ?? options.find((option) => !option.heading),
    [options, value],
  )

  // The rows shown in the open list — filtered while searching. A row shows when the
  // query matches its GROUP HEADING (e.g. the component name) — in which case the
  // whole group shows — or the row's own label. The heading is included whenever any
  // of its rows show. This lets you search by component name even when every embed
  // in a group has the same label ("Embed", "Embed #1", …).
  const displayed = useMemo(() => {
    if (!searchable || !query.trim()) return options
    const q = query.trim().toLowerCase()
    const out: SelectOption<T>[] = []
    let heading: SelectOption<T> | null = null
    let headingMatches = false
    let headingPushed = false
    for (const option of options) {
      if (option.heading) {
        heading = option
        headingMatches = option.label.toLowerCase().includes(q)
        headingPushed = false
        if (headingMatches) { out.push(option); headingPushed = true }
        continue
      }
      if (headingMatches || option.label.toLowerCase().includes(q)) {
        if (heading && !headingPushed) { out.push(heading); headingPushed = true }
        out.push(option)
      }
    }
    return out
  }, [options, query, searchable])

  // Headings are non-selectable — resolve the selected/first/last real rows.
  const firstSelectable = Math.max(0, displayed.findIndex((option) => !option.heading))
  const lastSelectable = (() => {
    for (let i = displayed.length - 1; i >= 0; i -= 1) if (!displayed[i].heading) return i
    return 0
  })()
  const found = displayed.findIndex((option) => !option.heading && option.value === value)
  const selectedIndex = found >= 0 ? found : firstSelectable
  const [activeIndex, setActiveIndex] = useState(selectedIndex)

  const optionId = (index: number) => `${baseId}-opt-${index}`

  // ── Hover preview ──────────────────────────────────────────────────────────
  // Read the callback through a ref: consumers pass an inline arrow, so depending on
  // its identity would re-run the emit effect (and re-emit) on every render.
  const onPreviewRef = useRef(onPreview)
  onPreviewRef.current = onPreview
  // The value the preview last emitted — seeded with the committed value on open, so the
  // first emit only happens once the highlight moves off the selected row.
  const shownRef = useRef<T | null>(null)
  // Whether anything was previewed this session. The revert is driven off THIS, not off a
  // comparison with `value`: a live preview write can be picked up by the panel's periodic
  // rescan, which moves `value` onto the previewed value — and then a comparison would
  // conclude there was nothing to undo and leave the preview applied. The consumer knows
  // what the preview overwrote, so asking it to restore is always safe.
  const emittedRef = useRef(false)
  const cancelPreview = useCallback(() => {
    shownRef.current = null
    if (!emittedRef.current) return
    emittedRef.current = false
    onPreviewRef.current?.(null)
  }, [])
  // Close without picking — Escape, Tab, click-outside, or toggling the trigger — puts
  // the original value back.
  const cancelMenu = useCallback(() => {
    setOpen(false)
    cancelPreview()
  }, [cancelPreview])

  // Emit as the highlight moves. Headings can't be highlighted, so anything landed on
  // is a real option; re-emitting the committed value is exactly how scrubbing back to
  // the selected row undoes the preview.
  useEffect(() => {
    if (!open || !onPreviewRef.current) return
    const option = displayed[activeIndex]
    if (!option || option.heading) return
    if (shownRef.current === null) shownRef.current = value // baseline for this session
    if (option.value === shownRef.current) return
    shownRef.current = option.value
    emittedRef.current = true
    onPreviewRef.current(option.value)
  }, [open, activeIndex, displayed, value])

  // The highlight moving is a sound, pitched by how far down the list it is: the
  // first row is the top of the scale, the last is the bottom. Driven off the
  // highlight rather than off the pointer, so arrowing through a menu sounds
  // the same as running down it with the mouse — it is the same movement.
  //
  // Not on the way in: opening a menu already parks the highlight on the
  // selected row, and a note for a highlight nobody moved would sound like the
  // menu answering a question that hadn't been asked.
  const placedRef = useRef(false)
  useEffect(() => {
    if (!open) {
      // Only on the way closed, never merely WHILE closed. `displayed` is a new
      // array each render, so this effect runs on every render of every Select
      // in the panel — and the panel is full of them. Resetting from here
      // unconditionally meant a closed dropdown wiped the note the open one had
      // just played, and the open one then played the same row again: two notes
      // for one row, from a control nobody was touching.
      if (placedRef.current) {
        placedRef.current = false
        endDragNotes() // the next menu sounds its first row, wherever it opens
      }
      return
    }
    if (!placedRef.current) {
      placedRef.current = true
      return
    }
    if (displayed[activeIndex]) hoverNote(activeIndex, displayed.length)
  }, [open, activeIndex, displayed])

  // A preview must never outlive the menu: revert if this control unmounts (the section
  // collapsed, the selection changed) while one is showing.
  useEffect(() => () => { if (emittedRef.current) onPreviewRef.current?.(null) }, [])

  const openMenu = useCallback(
    (index = selectedIndex) => {
      if (disabled) return
      let idx = clampIndex(index, displayed.length)
      // Never park the highlight on a heading — hop to the next real option.
      if (displayed[idx]?.heading) {
        for (let k = 1; k <= displayed.length; k += 1) {
          const i = (idx + k) % displayed.length
          if (!displayed[i].heading) { idx = i; break }
        }
      }
      setActiveIndex(idx)
      setOpen(true)
      window.requestAnimationFrame(() => (searchable ? searchRef.current : listRef.current)?.focus({ preventScroll: true }))
    },
    [disabled, displayed, selectedIndex, searchable],
  )

  const choose = useCallback(
    (index: number) => {
      const option = displayed[index]
      if (!option || option.heading) return
      shownRef.current = null // committed — the pick replaces the preview, no revert
      emittedRef.current = false
      onChange(option.value)
      setOpen(false)
      window.requestAnimationFrame(() => buttonRef.current?.focus({ preventScroll: true }))
    },
    [displayed, onChange],
  )

  // Move the highlight `dir` steps, skipping heading rows and wrapping around.
  const move = useCallback(
    (from: number, dir: number) => {
      const n = displayed.length
      if (n === 0) return
      for (let k = 1; k <= n; k += 1) {
        const i = (((from + dir * k) % n) + n) % n
        if (!displayed[i].heading) { setActiveIndex(i); return }
      }
    },
    [displayed],
  )

  const runTypeahead = useCallback(
    (key: string): boolean => {
      if (key.length !== 1 || !/\S/.test(key)) return false
      if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current)
      const q = `${typeahead.current}${key}`.toLowerCase()
      typeahead.current = q
      typeaheadTimer.current = window.setTimeout(() => {
        typeahead.current = ''
        typeaheadTimer.current = null
      }, 500)
      // On the first keystroke, start searching after the active option so
      // repeated presses cycle; while a query is building, match from it.
      const start = (activeIndex + (q.length === 1 ? 1 : 0)) % displayed.length
      for (let i = 0; i < displayed.length; i += 1) {
        const index = (start + i) % displayed.length
        if (!displayed[index].heading && displayed[index].label.toLowerCase().startsWith(q)) {
          setActiveIndex(index)
          return true
        }
      }
      return false
    },
    [activeIndex, displayed],
  )

  // Keep the highlighted option in sync with the selected value while closed.
  useEffect(() => {
    if (!open) setActiveIndex(selectedIndex)
  }, [selectedIndex, open])

  // Reset the filter when the menu closes so the next open shows the full list.
  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  // Re-highlight the first match whenever the query changes (deps intentionally just
  // `query`: firstSelectable is read from this render's filtered list).
  useEffect(() => {
    if (open && searchable) setActiveIndex(firstSelectable)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(
    () => () => {
      if (typeaheadTimer.current !== null) window.clearTimeout(typeaheadTimer.current)
    },
    [],
  )

  // Close when clicking outside the control.
  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return
      cancelMenu()
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [open, cancelMenu])

  // Flip above the button when there isn't room below; keep the active option
  // visible; and clamp horizontally so the menu never overflows the panel.
  useLayoutEffect(() => {
    const list = listRef.current
    if (!open) { wasOpenRef.current = false; return }
    const trigger = rootRef.current
    const opening = !wasOpenRef.current // true only on the open→(measure) transition
    wasOpenRef.current = true
    if (trigger && list) {
      const rect = trigger.getBoundingClientRect()
      const listHeight = list.offsetHeight
      const spaceBelow = window.innerHeight - rect.bottom
      const spaceAbove = rect.top
      setDropUp(spaceBelow < listHeight + 8 && spaceAbove > spaceBelow)
      // Clamp horizontally ONLY for the link variant — its menu is fixed-width and
      // anchored to the trigger's left, so it can run off the panel edge. The default
      // variant stretches to the trigger's own width (left:0/right:0) and is already
      // inside the panel, so it must NOT be nudged. Applied imperatively — a state-driven
      // transform paints the menu at its natural position for a frame first (a jump). x is
      // derived from the TRIGGER (stable) + the menu's width, not the just-mounted list's
      // rect (which measured wrong on the first open). Bounds = the app's scroll container
      // (the panel can be a sub-region of a wider Designer window).
      if (variant === 'link') {
        const margin = 8
        const bounds = panelBounds(trigger)
        const naturalLeft = rect.left // menu is anchored left:0 to the trigger
        const naturalRight = rect.left + list.offsetWidth
        const next = naturalRight > bounds.right - margin ? (bounds.right - margin) - naturalRight
          : naturalLeft < bounds.left + margin ? (bounds.left + margin) - naturalLeft
            : 0
        list.style.transform = next ? `translateX(${next}px)` : ''
      }
    }
    // Vertical scroll — only the LIST's own overflow (never scrollIntoView, whose inline
    // axis would slide the whole panel sideways). On OPEN, bring the selected option's
    // group heading right under the (sticky) search so the selection sits near the top;
    // while navigating, just keep the active option in view.
    const active = list?.querySelector<HTMLElement>('[data-active="true"]')
    if (list && active) {
      const searchH = list.querySelector<HTMLElement>('.u-select-search')?.offsetHeight ?? 0
      if (opening) {
        let node = active.previousElementSibling as HTMLElement | null
        while (node && !node.classList.contains('u-select-heading')) node = node.previousElementSibling as HTMLElement | null
        const anchor = node ?? active
        list.scrollTop = Math.max(0, anchor.offsetTop - searchH)
      } else {
        const lr = list.getBoundingClientRect()
        const ar = active.getBoundingClientRect()
        if (ar.top < lr.top + searchH) list.scrollTop -= (lr.top + searchH) - ar.top
        else if (ar.bottom > lr.bottom) list.scrollTop += ar.bottom - lr.bottom
      }
    }
  }, [open, activeIndex, query])

  const onButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    switch (event.key) {
      case 'ArrowDown':
      case 'Enter':
      case ' ':
        event.preventDefault()
        openMenu()
        return
      case 'ArrowUp':
      case 'End':
        event.preventDefault()
        openMenu(lastSelectable)
        return
      case 'Home':
        event.preventDefault()
        openMenu(firstSelectable)
        return
      default:
        if (!searchable && runTypeahead(event.key)) {
          event.preventDefault()
          setOpen(true)
          window.requestAnimationFrame(() => listRef.current?.focus({ preventScroll: true }))
        }
    }
  }

  // Nav keys shared by the list (non-searchable) and the search input (searchable).
  const onNavKey = (event: KeyboardEvent<HTMLElement>): boolean => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault(); move(activeIndex, 1); return true
      case 'ArrowUp':
        event.preventDefault(); move(activeIndex, -1); return true
      case 'Home':
        event.preventDefault(); setActiveIndex(firstSelectable); return true
      case 'End':
        event.preventDefault(); setActiveIndex(lastSelectable); return true
      case 'Enter':
      case ' ':
        event.preventDefault(); choose(activeIndex); return true
      case 'Escape':
        event.preventDefault(); cancelMenu(); buttonRef.current?.focus({ preventScroll: true }); return true
      case 'Tab':
        cancelMenu(); return true
      default:
        return false
    }
  }

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === ' ') { event.preventDefault(); choose(activeIndex); return } // list has no text input
    if (onNavKey(event)) return
    if (runTypeahead(event.key)) event.preventDefault()
  }

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // Enter/Space handling: Space types into the input, so only Enter selects.
    if (event.key === ' ') return
    onNavKey(event)
  }

  const triggerLabel = selectedOption ? (selectedOption.triggerLabel ?? selectedOption.label) : ''
  const triggerIcon = selectedOption?.triggerIcon ?? selectedOption?.icon

  return (
    <div ref={rootRef} className={['u-select', variant === 'link' ? 'is-link' : '', open ? 'is-open' : '', disabled ? 'is-disabled' : '', className].filter(Boolean).join(' ')}>
      {customInput != null ? (
        <div className="u-select-button is-custom">
          {customInput}
          <button
            ref={buttonRef}
            id={id}
            type="button"
            className="u-select-chevron-btn"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label={ariaLabel}
            aria-labelledby={labelId}
            disabled={disabled}
            onClick={() => (open ? cancelMenu() : openMenu())}
            onKeyDown={onButtonKeyDown}
          >
            <svg className="u-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4.2 6.2 8 10l3.8-3.8" />
            </svg>
          </button>
        </div>
      ) : variant === 'link' ? (
        <button
          ref={buttonRef}
          id={id}
          type="button"
          className="u-select-link"
          data-tone={selectedOption?.tone}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          disabled={disabled}
          onClick={() => (open ? cancelMenu() : openMenu())}
          onKeyDown={onButtonKeyDown}
        >
          {!hideTriggerIcon && triggerIcon != null ? <span className="u-select-icon">{triggerIcon}</span> : null}
          <span className="u-select-label">{triggerLabel}</span>
          <svg className="u-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.2 6.2 8 10l3.8-3.8" />
          </svg>
        </button>
      ) : (
        <button
          ref={buttonRef}
          id={id}
          type="button"
          className="u-select-button"
          data-tone={selectedOption?.tone}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          disabled={disabled}
          onClick={() => (open ? cancelMenu() : openMenu())}
          onKeyDown={onButtonKeyDown}
        >
          <span className="u-select-value">
            {!hideTriggerIcon && triggerIcon != null ? <span className="u-select-icon">{triggerIcon}</span> : null}
            <span className="u-select-label">{triggerLabel}</span>
          </span>
          <svg className="u-select-chevron" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M4.2 6.2 8 10l3.8-3.8" />
          </svg>
        </button>
      )}

      {open ? (
        <div
          ref={listRef}
          className={['u-select-list', dropUp ? 'is-up' : ''].filter(Boolean).join(' ')}
          role="listbox"
          tabIndex={-1}
          aria-label={ariaLabel}
          aria-labelledby={labelId}
          aria-activedescendant={optionId(activeIndex)}
          onKeyDown={searchable ? undefined : onListKeyDown}
        >
          {searchable ? (
            <div className="u-select-search">
              <input
                ref={searchRef}
                type="text"
                className="u-select-search-input"
                placeholder={searchPlaceholder}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={onSearchKeyDown}
                aria-label={ariaLabel ? `Search ${ariaLabel}` : 'Search'}
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          ) : null}
          {displayed.length === 0 ? (
            <div className="u-select-empty" role="presentation">No matches</div>
          ) : (
            displayed.map((option, index) => {
              if (option.heading) {
                return (
                  <div key={option.value} className="u-select-heading" role="presentation">
                    {option.icon != null ? <span className="u-select-icon">{option.icon}</span> : null}
                    <span className="u-select-heading-label">{option.label}</span>
                  </div>
                )
              }
              const isSelected = option.value === value
              const isActive = index === activeIndex
              return (
                <div
                  key={option.value}
                  id={optionId(index)}
                  className={['u-select-option', isActive ? 'is-active' : '', isSelected ? 'is-selected' : '', option.indent ? 'is-indented' : ''].filter(Boolean).join(' ')}
                  role="option"
                  aria-selected={isSelected}
                  data-active={isActive || undefined}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => choose(index)}
                >
                  <span className="u-select-check" aria-hidden="true">
                    {isSelected ? (
                      <svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M13.5 4.5 6.5 11.5 3 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
                    ) : null}
                  </span>
                  {option.icon != null ? <span className="u-select-icon">{option.icon}</span> : null}
                  <span className="u-select-label">{option.label}</span>
                  {option.marked ? <span className="u-select-dot" aria-hidden="true" /> : null}
                  {option.action ? (
                    <button
                      type="button"
                      className="u-select-action"
                      title={option.action.label}
                      aria-label={option.action.label}
                      // The listbox owns arrow-key focus; this is reached with the
                      // pointer (and by name from a screen reader), not by tabbing
                      // out of the list mid-navigation.
                      tabIndex={-1}
                      // The menu closes on an outside pointerdown and picks on click;
                      // this row is inside it, so only the click needs stopping — and
                      // it has to stop before `choose` runs, or acting on an option
                      // would also select it.
                      onClick={(event) => {
                        event.stopPropagation()
                        const run = option.action!.onSelect
                        cancelMenu()
                        run()
                      }}
                    >
                      {option.action.icon}
                    </button>
                  ) : null}
                </div>
              )
            })
          )}
        </div>
      ) : null}
    </div>
  )
}

function clampIndex(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.min(length - 1, Math.max(0, index))
}
